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
	getIgnoredApps,
	getLastNotificationPostedAt,
	getPendingCaptures,
	getResolvedCaptures,
	type IgnoredApp,
	pruneResolvedCaptures,
} from '../database/captures';
import type { Capture } from '../database/schema';
import { useAfterPull } from '../hooks/useAfterPull';
import { getBusinessFeeds } from '../utils/businessFeedPreference';
import {
	answerCaptureDuplicate,
	answerCaptureTransfer,
	confirmCapture,
	dismissCapture,
	ingestRawCaptures,
	markCaptureTransfer,
	revertCapture,
	stopIgnoringApp,
} from '../utils/captureActions';
import { APP_IGNORE_THRESHOLD } from '../utils/captureMatcher';
import { ownNamesOf } from '../utils/ownName';
import { getOwnBankName } from '../utils/ownNamePreference';
import { pickAndImportOfx, type StatementImportResult } from '../utils/statementImport';
import { useAccounts } from './AccountsContext';
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
	/** Apps que não são banco e que o usuário ensinou a ignorar, com "desfazer" (SPD-022). */
	ignoredApps: IgnoredApp[];
	/**
	 * A notificação mais recente da tabela inteira (ISO), para o aviso de captura parada.
	 * `resolved` não serve: um extrato grande o enche de linhas `ofx:` (SPD-112).
	 */
	lastNotificationAt: string | null;
	isLoading: boolean;
	lastAction: UndoableAction | null;

	refresh: () => Promise<void>;
	openSettings: () => void;
	/** `accountId`: a conta escolhida na revisão (SPD-111); sem ela, fica a do aviso. */
	confirm: (id: string, categoryId: string, accountId?: string | null) => Promise<void>;
	dismiss: (id: string) => Promise<void>;
	markTransfer: (id: string) => Promise<void>;
	answerDuplicate: (id: string, same: boolean) => Promise<void>;
	answerTransfer: (id: string, isTransfer: boolean) => Promise<void>;
	revert: (id: string) => Promise<void>;
	/** Os avisos daquele app voltam para a revisão. */
	unignoreApp: (packageName: string) => Promise<void>;
	undo: () => Promise<void>;
	clearUndo: () => void;
	/** Abre o seletor de arquivos e importa um extrato OFX. `null` se cancelado. */
	importStatement: () => Promise<StatementImportResult | null>;
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
	const [ignoredApps, setIgnoredApps] = useState<IgnoredApp[]>([]);
	const [lastNotificationAt, setLastNotificationAt] = useState<string | null>(null);
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
	const accountNameRef = useRef<string | null>(null);
	accountNameRef.current = account?.name ?? null;
	// Os nomes do usuário: o da conta logada e o "seu nome como aparece no banco" de Ajustes
	// (SPD-115). Sem login, só o segundo existe. Lido a cada lote: o nome pode ter acabado de
	// mudar em Ajustes, ou chegado pelo sync. A captura recebe o de Ajustes à parte, para o
	// diário dizer qual dos dois conferiu; o import de extrato, os dois juntos.
	const refreshDataRef = useRef(refreshData);
	refreshDataRef.current = refreshData;
	// Transferências e âncoras de saldo não passam por `transactions`, então os saldos
	// são recarregados explicitamente depois de cada ação que pode tê-los mudado.
	const { refresh: refreshAccounts } = useAccounts();
	const refreshAccountsRef = useRef(refreshAccounts);
	refreshAccountsRef.current = refreshAccounts;

	const reloadLedger = useCallback(async () => {
		await refreshDataRef.current();
		await refreshAccountsRef.current();
	}, []);

	const load = useCallback(async () => {
		const [nextPending, nextResolved, count, nextIgnored, nextLastNotification] = await Promise.all([
			getPendingCaptures(),
			getResolvedCaptures(HISTORY_LIMIT),
			countPendingCaptures(),
			getIgnoredApps(APP_IGNORE_THRESHOLD),
			getLastNotificationPostedAt(),
		]);
		setPending(nextPending);
		setResolved(nextResolved);
		setPendingCount(count);
		setIgnoredApps(nextIgnored);
		setLastNotificationAt(nextLastNotification);
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
						ownNames: ownNamesOf([accountNameRef.current]),
						bankName: await getOwnBankName(),
						categories: categoriesRef.current,
						// Lida a cada lote: a escolha pode ter mudado agora, ou chegado pelo sync.
						businessFeeds: await getBusinessFeeds(),
					});
					// Qualquer item novo muda cartões e contas: a compra pendente já aparece na fatura
					// como "a revisar", e uma conta ou cartão pode ter nascido agora.
					if (summary.autoConfirmed > 0) await reloadLedger();
					else if (summary.inserted > 0) await refreshAccountsRef.current();
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

		// A poda do histórico é **lápide** desde o v19, não DELETE: a tabela sincroniza, e
		// apagar de verdade faria a linha voltar inteira no próximo pull. A falha é
		// ignorada de propósito — a caixa de entrada abre do mesmo jeito.
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

	// O banco mudou por fora — o pull trouxe a caixa de entrada de outro aparelho, ou o
	// "Apagar todos os dados" a esvaziou: a fila e a contagem da tela inicial releem.
	useAfterPull(() =>
		load().catch((error) => console.error('Error reloading captured notifications:', error))
	);

	// As categorias chegam depois do primeiro esvaziamento na abertura do app.
	const hasCategories = categories.length > 0;
	useEffect(() => {
		if (hasCategories) void drainAndLoad();
	}, [hasCategories, drainAndLoad]);

	const remember = useCallback((kind: UndoableKind, ids: string[]) => {
		setLastAction({ kind, ids, at: Date.now() });
	}, []);

	const confirm = useCallback(
		async (id: string, categoryId: string, accountId?: string | null) => {
			const result = await confirmCapture(id, categoryId, categoriesRef.current, accountId);
			if (result) remember('confirm', [id]);
			await Promise.all([load(), reloadLedger()]);
		},
		[load, reloadLedger, remember]
	);

	const dismiss = useCallback(
		async (id: string) => {
			await dismissCapture(id);
			remember('dismiss', [id]);
			// Uma compra pendente descartada sai da fatura, onde aparecia como "a revisar".
			await Promise.all([load(), refreshAccountsRef.current()]);
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
			await Promise.all([load(), refreshAccountsRef.current()]);
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

	const unignoreApp = useCallback(
		async (packageName: string) => {
			await stopIgnoringApp(packageName);
			await load();
		},
		[load]
	);

	const undo = useCallback(async () => {
		const action = lastAction;
		if (!action) return;
		setLastAction(null);
		for (const id of action.ids) await revertCapture(id);
		await Promise.all([load(), reloadLedger()]);
	}, [lastAction, load, reloadLedger]);

	const clearUndo = useCallback(() => setLastAction(null), []);

	const importStatement = useCallback(async () => {
		const result = await pickAndImportOfx({
			ownNames: ownNamesOf([accountNameRef.current, await getOwnBankName()]),
			categories: categoriesRef.current,
		});
		if (result) {
			// O import cria ou ancora contas mesmo sem lançar nada: recarrega sempre.
			await Promise.all([load(), reloadLedger()]);
		}
		return result;
	}, [load, reloadLedger]);

	const value = useMemo<CapturesContextType>(
		() => ({
			supported,
			enabled,
			pending,
			resolved,
			pendingCount,
			ignoredApps,
			lastNotificationAt,
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
			unignoreApp,
			undo,
			clearUndo,
			importStatement,
		}),
		[
			supported,
			enabled,
			pending,
			resolved,
			pendingCount,
			ignoredApps,
			lastNotificationAt,
			isLoading,
			lastAction,
			refresh,
			confirm,
			dismiss,
			markTransfer,
			answerDuplicate,
			answerTransfer,
			revert,
			unignoreApp,
			undo,
			clearUndo,
			importStatement,
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
