import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { generateUniqueId } from '../utils/categoryEditUtils';
import { todayISO } from '../utils/dateUtils';
import type { MiraiLocale, MiraiMessage, MiraiToolName } from '../utils/mirai/contract';
import {
	askMirai,
	failureOf,
	httpTransport,
	type MiraiFailure,
	type MiraiTransport,
} from '../utils/mirai/loop';
import {
	getCachedEnabled,
	getGoalState,
	getMiraiChoice,
	type MiraiChoice,
	nextGoalState,
	setCachedEnabled,
	setGoalState,
	setMiraiChoice,
} from '../utils/mirai/preferences';
import { executeMiraiTool } from '../utils/mirai/tools';
import { useAuth } from './AuthContext';
import { useLanguage } from './LanguageContext';
import {
	MiraiContext,
	type MiraiContextValue,
	type MiraiEntry,
	type MiraiSheet,
} from './MiraiContext';

/**
 * O Mirai no app (SPD-163c): se ele está ligado para esta conta, a escolha da ativação, a
 * conversa aberta e o dia da meta. O desenho (botão, folhas) mora em `components/mirai`; o
 * ciclo de rodadas, em `utils/mirai/loop.ts`.
 *
 * A conversa vive só aqui, em memória (D5): fechar a folha apaga tudo, e o servidor não guarda
 * nada. Uma pergunta em andamento quando a folha fecha é abandonada: o resultado dela não volta
 * para uma conversa nova.
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

	// O que o ciclo lê na hora: o histórico da API, a conversa, a tela e qual conversa está valendo.
	const history = useRef<MiraiMessage[]>([]);
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
		conversationId.current = newId();
		busyRef.current = false;
		setEntries([]);
		setBusy(false);
		setCurrentTool(null);
		setDraft('');
	}, [newId]);

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
		resetConversation();
	}, [resetConversation]);

	const clear = useCallback(() => {
		resetConversation();
	}, [resetConversation]);

	const ask = useCallback(
		async (text?: string) => {
			const question = (text ?? draft).trim();
			if (!question || busyRef.current) return;
			const mine = generation.current;
			const current = () => mine === generation.current;
			const questionEntry: MiraiEntry = { id: newId(), role: 'user', text: question };
			busyRef.current = true;
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
						runTool ?? ((name, input) => executeMiraiTool(name, input, { ownNames: [accountName] })),
					onTool: (name) => {
						if (current()) setCurrentTool(name);
					},
					isCancelled: () => !current(),
				});
				if (!current()) return;
				history.current = result.history;
				const { answer } = result;
				setEntries((list) => [
					...list,
					{
						id: newId(),
						role: 'mirai',
						kind: answer.refused ? 'refusal' : answer.incomplete ? 'incomplete' : 'answer',
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
					{ id: newId(), role: 'error', failure },
				]);
				setDraft(question);
				if (failure === 'not_enabled') setEnabled(false);
			} finally {
				if (current()) {
					busyRef.current = false;
					setBusy(false);
					setCurrentTool(null);
				}
			}
		},
		[draft, locale, newId, transport, runTool, accountName]
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
			noteReserveReady,
		]
	);

	return <MiraiContext.Provider value={value}>{children}</MiraiContext.Provider>;
};

export default MiraiProvider;
