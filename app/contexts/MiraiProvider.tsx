import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { generateUniqueId } from '../utils/categoryEditUtils';
import { todayISO } from '../utils/dateUtils';
import type {
	MiraiLocale,
	MiraiMessage,
	MiraiQuestionContext,
	MiraiToolName,
} from '../utils/mirai/contract';
import {
	askMirai,
	failureOf,
	httpTransport,
	type MiraiFailure,
	type MiraiTransport,
} from '../utils/mirai/loop';
import {
	cleanMiraiName,
	firstNameOf,
	getCachedEnabled,
	getGoalState,
	getMiraiChoice,
	getMiraiName,
	type MiraiChoice,
	type MiraiNameState,
	nextGoalState,
	setCachedEnabled,
	setGoalState,
	setMiraiChoice,
	setMiraiName,
} from '../utils/mirai/preferences';
import { executeMiraiTool } from '../utils/mirai/tools';
import { useAuth } from './AuthContext';
import { useLanguage } from './LanguageContext';
import {
	MIRAI_FULL_CONVERSATION,
	MIRAI_LONG_CONVERSATION,
	MiraiContext,
	type MiraiContextValue,
	type MiraiConversationSize,
	type MiraiEntry,
	type MiraiSheet,
} from './MiraiContext';

/**
 * O histórico que passa disto fica `full` mesmo antes das 20 perguntas: o servidor aceita até
 * 512 kB por pedido, e o raciocínio e os resultados das consultas vão juntos.
 */
export const MIRAI_FULL_HISTORY_CHARS = 350_000;

/** O tamanho da conversa pelas perguntas que ficaram nela e pelo peso do histórico. */
export const conversationSizeOf = (
	questions: number,
	historyChars: number
): MiraiConversationSize => {
	if (questions >= MIRAI_FULL_CONVERSATION || historyChars >= MIRAI_FULL_HISTORY_CHARS)
		return 'full';
	return questions >= MIRAI_LONG_CONVERSATION ? 'long' : 'ok';
};

/** As falhas em que tentar de novo pode dar certo (as outras não mudam com outro toque). */
const RETRYABLE: ReadonlySet<MiraiFailure> = new Set(['offline', 'unavailable', 'unknown']);

/**
 * O Mirai no app (SPD-163c): se ele está ligado para esta conta, a escolha da ativação, a
 * conversa aberta e o dia da meta. O desenho (botão, folhas) mora em `components/mirai`; o
 * ciclo de rodadas, em `utils/mirai/loop.ts`.
 *
 * A conversa vive só aqui, em memória (D5, SPD-171): fechar a folha só a esconde, e ela some
 * quando o app fecha, quando a conta muda (sair, trocar, login expirado) e em "Nova conversa". O
 * servidor não guarda nada. Uma pergunta em andamento continua com a folha fechada; "Parar" e
 * "Nova conversa" a abandonam, e o resultado dela não volta para a conversa.
 */

const LOCALES: readonly MiraiLocale[] = ['pt', 'en', 'it'];

export const MiraiProvider: React.FC<{
	children: React.ReactNode;
	/** Para os testes: as rotas falsas, as ferramentas falsas e os ids previsíveis. */
	transport?: MiraiTransport;
	runTool?: (name: MiraiToolName, input: unknown) => Promise<string>;
	newId?: () => string;
}> = ({ children, transport = httpTransport, runTool, newId = generateUniqueId }) => {
	const { account } = useAuth();
	const { currentLanguage } = useLanguage();
	const locale: MiraiLocale = (LOCALES as readonly string[]).includes(currentLanguage.code)
		? (currentLanguage.code as MiraiLocale)
		: 'pt';
	const userId = account?.id ?? null;
	// O nome da conta também vira "você" na saída das ferramentas (o de Ajustes elas leem sozinhas).
	const accountName = account?.name ?? null;

	const [enabled, setEnabled] = useState(false);
	const [choice, setChoice] = useState<MiraiChoice | null>(null);
	const [sheet, setSheet] = useState<MiraiSheet>('none');
	const [entries, setEntries] = useState<MiraiEntry[]>([]);
	const [busy, setBusy] = useState(false);
	const [currentTool, setCurrentTool] = useState<MiraiToolName | null>(null);
	const [draft, setDraft] = useState('');
	const [goalDay, setGoalDay] = useState<string | null>(null);
	const [conversationSize, setConversationSize] = useState<MiraiConversationSize>('ok');
	const [remainingToday, setRemainingToday] = useState<number | null>(null);
	const [screenName, setScreenName] = useState<string | null>(null);
	const [nameState, setNameState] = useState<MiraiNameState | null>(null);

	// O que o ciclo lê na hora: o histórico da API, a conversa, a tela e qual conversa está valendo.
	const history = useRef<MiraiMessage[]>([]);
	const contexts = useRef<MiraiQuestionContext[]>([]);
	/** A pergunta em andamento, para o "Parar" devolver o texto ao campo. */
	const pending = useRef<{ id: string; text: string } | null>(null);
	const nameRef = useRef<string | null>(null);
	nameRef.current = nameState?.name ?? null;
	const conversationId = useRef('');
	if (!conversationId.current) conversationId.current = newId();
	const screen = useRef<string | null>(null);
	const generation = useRef(0);
	const busyRef = useRef(false);

	useEffect(() => {
		let alive = true;
		getMiraiChoice().then((stored) => {
			if (alive) setChoice(stored);
		});
		getGoalState().then((stored) => {
			if (alive) setGoalDay(stored.goalDay);
		});
		return () => {
			alive = false;
		};
	}, []);

	/**
	 * Pergunta ao servidor se o Mirai está ligado para a conta. Sem rede, vale o último que ele
	 * disse; `not_enabled` desliga. Devolve a falha, para quem abriu a conversa avisar.
	 */
	const refreshStatus = useCallback(
		async (owner: string): Promise<MiraiFailure | null> => {
			try {
				const status = await transport.status();
				setEnabled(status.enabled);
				setRemainingToday(status.remainingToday);
				await setCachedEnabled(owner, status.enabled);
				return null;
			} catch (error) {
				const failure = failureOf(error);
				if (failure === 'not_enabled') {
					setEnabled(false);
					await setCachedEnabled(owner, false);
				}
				return failure;
			}
		},
		[transport]
	);

	useEffect(() => {
		if (!userId) {
			setEnabled(false);
			return;
		}
		let alive = true;
		(async () => {
			const cached = await getCachedEnabled(userId);
			if (!alive) return;
			setEnabled(cached ?? false);
			await refreshStatus(userId);
		})();
		return () => {
			alive = false;
		};
	}, [userId, refreshStatus]);

	const resetConversation = useCallback(() => {
		generation.current += 1;
		history.current = [];
		contexts.current = [];
		pending.current = null;
		conversationId.current = newId();
		busyRef.current = false;
		setEntries([]);
		setBusy(false);
		setCurrentTool(null);
		setDraft('');
		setConversationSize('ok');
	}, [newId]);

	// A conversa é da conta: sair, trocar de conta ou perder o login (token expirado) a apaga.
	useEffect(() => {
		resetConversation();
		setRemainingToday(null);
		setNameState(null);
		if (!userId) return;
		let alive = true;
		getMiraiName(userId).then((stored) => {
			if (alive) setNameState(stored);
		});
		return () => {
			alive = false;
		};
	}, [userId, resetConversation]);

	const saveName = useCallback(
		(name: string | null) => {
			const clean = name === null ? null : cleanMiraiName(name);
			setNameState({ asked: true, name: clean });
			if (userId) setMiraiName(userId, clean);
		},
		[userId]
	);

	const openChat = useCallback(() => {
		setSheet('chat');
		if (!userId) return;
		// Confere de novo ao abrir: sem rede, a conversa já abre com o aviso.
		refreshStatus(userId).then((failure) => {
			if (failure === 'offline')
				setEntries((current) =>
					current.some((entry) => entry.role === 'error' && entry.failure === 'offline')
						? current
						: [...current, { id: newId(), role: 'error', failure: 'offline' }]
				);
			else if (failure === 'not_enabled') setSheet('none');
		});
	}, [userId, refreshStatus, newId]);

	const openFromButton = useCallback(
		(from: string | null) => {
			screen.current = from;
			setScreenName(from);
			if (choice === 'on') openChat();
			else setSheet('activation');
		},
		[choice, openChat]
	);

	const activate = useCallback(() => {
		setChoice('on');
		setMiraiChoice('on');
		openChat();
	}, [openChat]);

	const decline = useCallback(() => {
		// O botão some; ligar de novo é em Configurações.
		setChoice('off');
		setMiraiChoice('off');
		setSheet('none');
	}, []);

	const setTurnedOn = useCallback((on: boolean) => {
		if (on) {
			screen.current = null;
			setSheet('activation');
			return;
		}
		setChoice('off');
		setMiraiChoice('off');
	}, []);

	const close = useCallback(() => {
		setSheet('none');
	}, []);

	const clear = useCallback(() => {
		resetConversation();
	}, [resetConversation]);

	const ask = useCallback(
		async (text?: string) => {
			const question = (text ?? draft).trim();
			if (!question || busyRef.current) return;
			if (
				conversationSizeOf(contexts.current.length, JSON.stringify(history.current).length) ===
				'full'
			)
				return;
			const mine = generation.current;
			const current = () => mine === generation.current;
			const questionEntry: MiraiEntry = { id: newId(), role: 'user', text: question };
			busyRef.current = true;
			pending.current = { id: questionEntry.id, text: question };
			setBusy(true);
			setDraft('');
			// O aviso de erro anterior sai quando a pessoa tenta de novo.
			setEntries((list) => [...list.filter((entry) => entry.role !== 'error'), questionEntry]);
			try {
				const result = await askMirai({
					history: history.current,
					question,
					conversationId: conversationId.current,
					screen: screen.current,
					locale,
					newId,
					transport,
					runTool:
						runTool ??
						((name, input) => executeMiraiTool(name, input, { ownNames: [accountName] })),
					onTool: (name) => {
						if (current()) setCurrentTool(name);
					},
					isCancelled: () => !current(),
					contexts: contexts.current,
					name: nameRef.current,
				});
				if (!current()) return;
				history.current = result.history;
				contexts.current = result.contexts;
				setRemainingToday(result.remainingToday);
				setConversationSize(
					conversationSizeOf(result.contexts.length, JSON.stringify(result.history).length)
				);
				const { answer } = result;
				setEntries((list) => [
					...list,
					{
						id: newId(),
						role: 'mirai',
						kind: answer.refused
							? 'refusal'
							: answer.incomplete
								? 'incomplete'
								: answer.cut
									? 'cut'
									: 'answer',
						text: answer.text,
						expression: answer.expression,
					},
				]);
			} catch (error) {
				if (!current()) return;
				const failure = failureOf(error);
				// Não foi respondida: a pergunta volta para o campo, para mandar de novo.
				setEntries((list) => [
					...list.filter((entry) => entry.id !== questionEntry.id),
					{
						id: newId(),
						role: 'error',
						failure,
						...(RETRYABLE.has(failure) ? { question } : {}),
					},
				]);
				setDraft(question);
				if (failure === 'not_enabled') setEnabled(false);
				if (failure === 'daily_limit') setRemainingToday(0);
			} finally {
				if (current()) {
					pending.current = null;
					busyRef.current = false;
					setBusy(false);
					setCurrentTool(null);
				}
			}
		},
		[draft, locale, newId, transport, runTool, accountName]
	);

	const stop = useCallback(() => {
		const asked = pending.current;
		if (!busyRef.current || !asked) return;
		// Como "Nova conversa", mas só para esta pergunta: o resultado dela não entra, e o histórico
		// fica o de antes dela. O que já foi pedido ao servidor conta no limite do dia.
		generation.current += 1;
		pending.current = null;
		busyRef.current = false;
		setBusy(false);
		setCurrentTool(null);
		setEntries((list) => list.filter((entry) => entry.id !== asked.id));
		setDraft(asked.text);
	}, []);

	const retry = useCallback(
		(entryId: string) => {
			const failed = entries.find((entry) => entry.id === entryId);
			if (failed?.role === 'error' && failed.question) ask(failed.question);
		},
		[entries, ask]
	);

	const noteReserveReady = useCallback((ready: boolean) => {
		(async () => {
			const previous = await getGoalState();
			const next = nextGoalState(previous, ready, todayISO());
			if (next.reserveReady === previous.reserveReady && next.goalDay === previous.goalDay) return;
			await setGoalState(next);
			setGoalDay(next.goalDay);
		})();
	}, []);

	const value = useMemo<MiraiContextValue>(
		() => ({
			enabled,
			choice,
			sheet,
			entries,
			busy,
			currentTool,
			draft,
			setDraft,
			goalDay,
			openFromButton,
			activate,
			decline,
			setTurnedOn,
			ask,
			clear,
			close,
			stop,
			retry,
			conversationSize,
			remainingToday,
			screen: screenName,
			name: nameState?.name ?? null,
			nameAsked: nameState ? nameState.asked : null,
			suggestedName: firstNameOf(accountName),
			saveName,
			noteReserveReady,
		}),
		[
			enabled,
			choice,
			sheet,
			entries,
			busy,
			currentTool,
			draft,
			goalDay,
			openFromButton,
			activate,
			decline,
			setTurnedOn,
			ask,
			clear,
			close,
			stop,
			retry,
			conversationSize,
			remainingToday,
			screenName,
			nameState,
			accountName,
			saveName,
			noteReserveReady,
		]
	);

	return <MiraiContext.Provider value={value}>{children}</MiraiContext.Provider>;
};

export default MiraiProvider;
