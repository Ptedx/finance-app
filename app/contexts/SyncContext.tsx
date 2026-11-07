import type React from 'react';
import { createContext, useContext, useEffect, useState } from 'react';
import { countDirtyRows, countUnsyncedRows } from '../database/database';
import { startDiaryUploads } from '../diagnostics/upload';
import { getLastSyncedAt } from '../sync/engine';
import * as syncQueue from '../sync/queue';
import { startRemoteWipes } from '../sync/remoteWipe';

interface SyncContextType {
	status: syncQueue.SyncStatus;
	/**
	 * Quantas linhas ainda não subiram, lápides incluídas. Zero com status 'idle' significa
	 * tudo salvo. Lido do banco a cada mudança da fila, na mesma leitura de `unsynced`.
	 */
	pending: number;
	/**
	 * Quantas linhas **vivas** ainda não subiram: o "só existe neste aparelho" da tela da
	 * conta. Nunca maior que `pending` — a diferença são as remoções esperando para subir,
	 * que não são dado em risco. `null` enquanto não foi lido (ou a leitura falhou).
	 */
	unsynced: number | null;
	lastError: string | null;
	lastSyncedAt: string | null;
	/** Sync manual, do botão nas Configurações e do puxar-para-atualizar. */
	syncNow: () => void;
}

/** Como o estado do sync aparece, em texto completo e curto, e o tom que vai com ele. */
export interface SyncSummary {
	tone: 'ok' | 'pending' | 'offline' | 'error' | 'syncing';
	/** O texto da tela da conta. */
	label: { key: string; count: number };
	/** O mesmo estado, curto, para a linha da conta em Ajustes. */
	short: { key: string; count: number };
}

/**
 * O que dizer sobre o sync, para as duas telas que falam dele (E2E-36).
 *
 * A linha da conta em Ajustes tinha "Tudo salvo" fixo no texto: dizia isso offline e com
 * três alterações presas, enquanto a tela da conta dizia o contrário. As duas leem daqui
 * agora — o mesmo `status` e o mesmo `pending` do contexto, com um texto mais curto para
 * caber na linha.
 */
export const describeSync = (status: syncQueue.SyncStatus, pending: number): SyncSummary => {
	if (status === 'syncing') {
		return {
			tone: 'syncing',
			label: { key: 'account.statusSyncing', count: pending },
			short: { key: 'account.statusSyncing', count: pending },
		};
	}
	if (status === 'offline') {
		return {
			tone: 'offline',
			label: { key: pending > 0 ? 'account.statusOffline' : 'account.statusOfflineNone', count: pending },
			short: { key: 'account.rowOffline', count: pending },
		};
	}
	if (status === 'error') {
		return {
			tone: 'error',
			label: { key: 'account.statusError', count: pending },
			short: { key: 'account.rowError', count: pending },
		};
	}
	if (pending > 0) {
		return {
			tone: 'pending',
			label: { key: 'account.statusPending', count: pending },
			short: { key: 'account.rowPending', count: pending },
		};
	}
	return {
		tone: 'ok',
		label: { key: 'account.statusSynced', count: 0 },
		short: { key: 'account.statusSynced', count: 0 },
	};
};

const SyncContext = createContext<SyncContextType | undefined>(undefined);

export const SyncProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
	const [state, setState] = useState(syncQueue.getState);
	const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
	const [counts, setCounts] = useState<{ pending: number; unsynced: number } | null>(null);

	useEffect(() => {
		/**
		 * As duas contagens saem do banco juntas, a cada mudança da fila. O `pending` da fila
		 * é o da última rodada que terminou bem: uma edição feita sem rede não entrava nele, e
		 * a tela da conta mostrava "3 alterações" ao lado de "4 itens ainda só existem neste
		 * aparelho" — o 4 era o banco, lido depois. Só a leitura mais recente vale.
		 */
		let reading = 0;
		let alive = true;
		const recount = () => {
			reading += 1;
			const mine = reading;
			Promise.all([countDirtyRows(), countUnsyncedRows()])
				.then(([pending, unsynced]) => {
					if (alive && mine === reading) setCounts({ pending, unsynced });
				})
				.catch(() => {
					// Na dúvida não afirma nada: fica o número da fila, e o "só existe aqui" some.
					if (alive && mine === reading) setCounts(null);
				});
		};

		// A fila é um módulo, não um hook: ela precisa sobreviver a remontagens e ser
		// chamada de dentro dos contexts de dados, que não podem depender de React.
		const unsubscribe = syncQueue.subscribe((next) => {
			setState(next);
			recount();
			if (next.status === 'idle') {
				getLastSyncedAt().then(setLastSyncedAt).catch(() => {});
			}
		});

		// O diário de diagnóstico sobe junto com o sync (SPD-016): depois de um sync que deu
		// certo e ao voltar ao primeiro plano, só com sessão e no máximo a cada 6 h.
		const stopDiaryUploads = startDiaryUploads();

		// Quem apaga este aparelho quando a conta foi apagada em outro (SPD-083). Registrado
		// aqui, que monta antes de o AuthProvider ligar a fila: sem o registro, o sync que
		// descobre o apagar falha em vez de seguir sem apagar.
		const stopRemoteWipes = startRemoteWipes();

		return () => {
			alive = false;
			unsubscribe();
			stopDiaryUploads();
			stopRemoteWipes();
		};
	}, []);

	const value: SyncContextType = {
		status: state.status,
		pending: counts?.pending ?? state.pending,
		unsynced: counts?.unsynced ?? null,
		lastError: state.lastError,
		lastSyncedAt,
		syncNow: syncQueue.syncImmediately,
	};

	return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
};

export const useSync = () => {
	const context = useContext(SyncContext);
	if (context === undefined) {
		throw new Error('useSync must be used within a SyncProvider');
	}
	return context;
};

export default SyncContext;
