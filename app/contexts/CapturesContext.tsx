import type React from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import {
	addCaptureListener,
	drainCaptures,
	isCaptureEnabled,
	isCaptureSupported,
	openCaptureSettings,
} from '../../modules/spendr-captures';
import {
	countPendingCaptures,
	getPendingCaptures,
	getResolvedCaptures,
	pruneResolvedCaptures,
} from '../database/captures';
import type { Capture } from '../database/schema';
import {
	answerCaptureDuplicate,
	answerCaptureTransfer,
	confirmCapture,
	dismissCapture,
	ingestRawCaptures,
	markCaptureTransfer,
	revertCapture,
} from '../utils/captureActions';
import { useAuth } from './AuthContext';
import { useTransactions } from './TransactionsContext';

/**
 * A caixa de entrada de notificações bancárias, para as telas.
 *
 * Esvazia a fila nativa em três momentos — ao montar, quando o app volta ao primeiro
 * plano e quando o serviço avisa que chegou notificação nova — e expõe as respostas
 * do usuário. Cada resposta guarda um "último ato" desfazível por alguns segundos:
 * um toque errado não pode custar um lançamento.
 */

export type UndoableKind = 'confirm' | 'dismiss' | 'transfer' | 'duplicate';

export interface UndoableAction {
	kind: UndoableKind;
	/** Os itens a reverter. Uma transferência pode envolver duas pernas. */
	ids: string[];
	at: number;
}

interface CapturesContextType {
	/** Se esta build tem o serviço nativo (Android). */
	supported: boolean;
	/** Se o acesso a notificações está ligado nas configurações do sistema. */
	enabled: boolean;
	pending: Capture[];
	/** O que já saiu da fila, mais recente primeiro, para histórico e "reverter". */
	resolved: Capture[];
	pendingCount: number;
	isLoading: boolean;
	lastAction: UndoableAction | null;

	refresh: () => Promise<void>;
	openSettings: () => void;
	confirm: (id: string, categoryId: string) => Promise<void>;
	dismiss: (id: string) => Promise<void>;
	markTransfer: (id: string) => Promise<void>;
	answerDuplicate: (id: string, same: boolean) => Promise<void>;
	answerTransfer: (id: string, isTransfer: boolean) => Promise<void>;
	revert: (id: string) => Promise<void>;
	undo: () => Promise<void>;
	clearUndo: () => void;
}

const CapturesContext = createContext<CapturesContextType | undefined>(undefined);

const HISTORY_LIMIT = 60;
const HISTORY_RETENTION_DAYS = 90;

export const CapturesProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
	const { account } = useAuth();
	const { categories, refreshData } = useTransactions();

	const [enabled, setEnabled] = useState<boolean>(() => isCaptureEnabled());
	const [pending, setPending] = useState<Capture[]>([]);
	const [resolved, setResolved] = useState<Capture[]>([]);
	const [pendingCount, setPendingCount] = useState(0);
	const [isLoading, setIsLoading] = useState(true);
	const [lastAction, setLastAction] = useState<UndoableAction | null>(null);

	const supported = useMemo(() => isCaptureSupported(), []);
	const draining = useRef(false);
	const rerun = useRef(false);

	// Refs para o que o funil precisa ler no momento em que roda. O listener nativo e o
	// AppState são registrados uma vez só; `refreshData` do TransactionsContext é uma
	// função nova a cada render, e usá-la como dependência de efeito recarregaria a
	// caixa de entrada em laço.
	const categoriesRef = useRef(categories);
	categoriesRef.current = categories;
	const ownNamesRef = useRef<string[]>([]);
	ownNamesRef.current = account?.name ? [account.name] : [];
	const refreshDataRef = useRef(refreshData);
	refreshDataRef.current = refreshData;

	const reloadLedger = useCallback(async () => {
		await refreshDataRef.current();
	}, []);

	const load = useCallback(async () => {
		const [nextPending, nextResolved, count] = await Promise.all([
			getPendingCaptures(),
			getResolvedCaptures(HISTORY_LIMIT),
			countPendingCaptures(),
		]);
		setPending(nextPending);
		setResolved(nextResolved);
		setPendingCount(count);
	}, []);

	/**
	 * Esvazia a fila nativa e recarrega. Uma execução por vez: uma segunda chamada
	 * durante a primeira só pede uma repetição, para nada ser interpretado duas vezes.
	 *
	 * Sem categorias carregadas a fila fica onde está: interpretar agora sugeriria
	 * "sem categoria" para tudo. O efeito abaixo volta aqui assim que elas chegam.
	 */
	const drainAndLoad = useCallback(async () => {
		if (draining.current) {
			rerun.current = true;
			return;
		}
		draining.current = true;

		try {
			if (supported && categoriesRef.current.length > 0) {
				const raws = drainCaptures();
				if (raws.length > 0) {
					const summary = await ingestRawCaptures(raws, {
						ownNames: ownNamesRef.current,
						categories: categoriesRef.current,
					});
					if (summary.autoConfirmed > 0) await reloadLedger();
				}
			}
			await load();
		} catch (error) {
			console.error('Error processing captured notifications:', error);
		} finally {
			draining.current = false;
			setIsLoading(false);
			if (rerun.current) {
				rerun.current = false;
				void drainAndLoad();
			}
		}
	}, [supported, load, reloadLedger]);

	const refresh = useCallback(async () => {
		setEnabled(isCaptureEnabled());
		await drainAndLoad();
	}, [drainAndLoad]);

	// Ao montar, ao voltar ao primeiro plano e quando o serviço avisa.
	useEffect(() => {
		void refresh();

		const cutoff = new Date(Date.now() - HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
		pruneResolvedCaptures(cutoff).catch(() => {});

		const appState = AppState.addEventListener('change', (state) => {
			if (state === 'active') void refresh();
		});
		const native = addCaptureListener(() => {
			void drainAndLoad();
		});

		return () => {
			appState.remove();
			native.remove();
		};
	}, [refresh, drainAndLoad]);

	// As categorias chegam depois do primeiro esvaziamento na abertura do app.
	const hasCategories = categories.length > 0;
	useEffect(() => {
		if (hasCategories) void drainAndLoad();
	}, [hasCategories, drainAndLoad]);

	const remember = useCallback((kind: UndoableKind, ids: string[]) => {
		setLastAction({ kind, ids, at: Date.now() });
	}, []);

	const confirm = useCallback(
		async (id: string, categoryId: string) => {
			const result = await confirmCapture(id, categoryId, categoriesRef.current);
			if (result) remember('confirm', [id]);
			await Promise.all([load(), reloadLedger()]);
		},
		[load, reloadLedger, remember]
	);

	const dismiss = useCallback(
		async (id: string) => {
			await dismissCapture(id);
			remember('dismiss', [id]);
			await load();
		},
		[load, remember]
	);

	const markTransfer = useCallback(
		async (id: string) => {
			const related = pending.find((c) => c.id === id)?.relatedId;
			await markCaptureTransfer(id);
			remember('transfer', related ? [id, related] : [id]);
			await Promise.all([load(), reloadLedger()]);
		},
		[pending, load, reloadLedger, remember]
	);

	const answerDuplicate = useCallback(
		async (id: string, same: boolean) => {
			await answerCaptureDuplicate(id, same);
			if (same) remember('duplicate', [id]);
			await load();
		},
		[load, remember]
	);

	const answerTransfer = useCallback(
		async (id: string, isTransfer: boolean) => {
			const related = pending.find((c) => c.id === id)?.relatedId;
			await answerCaptureTransfer(id, isTransfer);
			if (isTransfer) remember('transfer', related ? [id, related] : [id]);
			await Promise.all([load(), reloadLedger()]);
		},
		[pending, load, reloadLedger, remember]
	);

	const revert = useCallback(
		async (id: string) => {
			await revertCapture(id);
			setLastAction((current) => (current?.ids.includes(id) ? null : current));
			await Promise.all([load(), reloadLedger()]);
		},
		[load, reloadLedger]
	);

	const undo = useCallback(async () => {
		const action = lastAction;
		if (!action) return;
		setLastAction(null);
		for (const id of action.ids) await revertCapture(id);
		await Promise.all([load(), reloadLedger()]);
	}, [lastAction, load, reloadLedger]);

	const clearUndo = useCallback(() => setLastAction(null), []);

	const value = useMemo<CapturesContextType>(
		() => ({
			supported,
			enabled,
			pending,
			resolved,
			pendingCount,
			isLoading,
			lastAction,
			refresh,
			openSettings: openCaptureSettings,
			confirm,
			dismiss,
			markTransfer,
			answerDuplicate,
			answerTransfer,
			revert,
			undo,
			clearUndo,
		}),
		[
			supported,
			enabled,
			pending,
			resolved,
			pendingCount,
			isLoading,
			lastAction,
			refresh,
			confirm,
			dismiss,
			markTransfer,
			answerDuplicate,
			answerTransfer,
			revert,
			undo,
			clearUndo,
		]
	);

	return <CapturesContext.Provider value={value}>{children}</CapturesContext.Provider>;
};

export const useCaptures = (): CapturesContextType => {
	const context = useContext(CapturesContext);
	if (!context) throw new Error('useCaptures must be used within a CapturesProvider');
	return context;
};

export default CapturesProvider;
