import AsyncStorage from '@react-native-async-storage/async-storage';
import { MIRAI_NAME_MAX_LENGTH } from './contract';

/**
 * O que o Mirai guarda no aparelho (SPD-163). Fica só aqui: não sobe no sync nem vai no backup.
 *
 * - **A escolha da ativação (D6).** Vem desligado: sem escolha, o botão aparece e o primeiro
 *   toque abre a tela de ativação. "Ativar" grava `on`. "Agora não" e desligar em Configurações
 *   gravam `off`: o botão some, e ligar de novo é em Configurações, passando pela ativação.
 * - **O último `GET /status`** de cada conta, para o botão continuar sem rede: aí ele abre o
 *   aviso "Mirai precisa de internet" (§3), em vez de sumir.
 * - **O dia da meta** (§7.1): o dia em que a reserva ficou completa, para o botão mostrar
 *   `goal` até o fim daquele dia, sem chamar a API.
 * - **Como a pessoa quer ser chamada** (SPD-163e), por conta. Uma conta com registro já
 *   respondeu à pergunta do app, mesmo com "Agora não" (nome nulo): ela não volta a aparecer.
 *   Sai com "Apagar todos os dados".
 */

export type MiraiChoice = 'on' | 'off';

export const MIRAI_STORAGE_KEYS = {
	choice: '@spendr_mirai_choice',
	status: '@spendr_mirai_status',
	goal: '@spendr_mirai_goal',
	name: '@spendr_mirai_name',
} as const;

/** Teto do apelido, o mesmo do servidor (`MIRAI_NAME_MAX_LENGTH` do contrato). */
export const MIRAI_NAME_LIMIT = MIRAI_NAME_MAX_LENGTH;

/** O apelido como vai para o servidor: sem quebra de linha, espaços juntados, até o teto. */
export const cleanMiraiName = (value: string): string | null => {
	// Caractere de controle (quebra de linha inclusive), aspas e barra viram espaço: o nome vai
	// para uma mensagem de sistema entre aspas.
	const clean = Array.from(value, (char) => {
		const code = char.charCodeAt(0);
		return code < 32 || (code >= 127 && code <= 159) || char === '"' || char === '\\' ? ' ' : char;
	})
		.join('')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, MIRAI_NAME_LIMIT)
		.trim();
	return clean.length > 0 ? clean : null;
};

/** O primeiro nome da conta, sugerido na pergunta do app ("Vinicius" de "Vinicius Costa"). */
export const firstNameOf = (accountName: string | null | undefined): string => {
	const first = (accountName ?? '').trim().split(/\s+/)[0] ?? '';
	return cleanMiraiName(first) ?? '';
};

/** O que se sabe do apelido de uma conta: `asked` falso é "o app ainda não perguntou". */
export interface MiraiNameState {
	asked: boolean;
	name: string | null;
}

const readNames = async (): Promise<Record<string, unknown>> => {
	const stored = await AsyncStorage.getItem(MIRAI_STORAGE_KEYS.name);
	const parsed: unknown = stored ? JSON.parse(stored) : null;
	return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
};

export const getMiraiName = async (userId: string): Promise<MiraiNameState> => {
	try {
		const names = await readNames();
		if (!Object.hasOwn(names, userId)) return { asked: false, name: null };
		const value = names[userId];
		return { asked: true, name: typeof value === 'string' ? cleanMiraiName(value) : null };
	} catch {
		return { asked: false, name: null };
	}
};

/** Grava o apelido da conta; nulo é "Agora não" ou "tirar o nome" (o app não pergunta de novo). */
export const setMiraiName = async (userId: string, name: string | null): Promise<void> => {
	try {
		let names: Record<string, unknown> = {};
		try {
			names = await readNames();
		} catch {
			// Registro estragado: começa de novo.
		}
		names[userId] = name === null ? null : cleanMiraiName(name);
		await AsyncStorage.setItem(MIRAI_STORAGE_KEYS.name, JSON.stringify(names));
	} catch {
		// Sem armazenamento, o nome vale até o app fechar.
	}
};

export const getMiraiChoice = async (): Promise<MiraiChoice | null> => {
	try {
		const value = await AsyncStorage.getItem(MIRAI_STORAGE_KEYS.choice);
		return value === 'on' || value === 'off' ? value : null;
	} catch {
		return null;
	}
};

export const setMiraiChoice = async (choice: MiraiChoice): Promise<void> => {
	try {
		await AsyncStorage.setItem(MIRAI_STORAGE_KEYS.choice, choice);
	} catch {
		// Sem armazenamento a escolha vale até o app fechar.
	}
};

/** O último status conhecido de uma conta. Só o `enabled`: as perguntas restantes mudam a cada uma. */
export const getCachedEnabled = async (userId: string): Promise<boolean | null> => {
	try {
		const stored = await AsyncStorage.getItem(MIRAI_STORAGE_KEYS.status);
		const parsed: unknown = stored ? JSON.parse(stored) : null;
		if (typeof parsed !== 'object' || parsed === null) return null;
		const { userId: owner, enabled } = parsed as { userId?: unknown; enabled?: unknown };
		return owner === userId && typeof enabled === 'boolean' ? enabled : null;
	} catch {
		return null;
	}
};

export const setCachedEnabled = async (userId: string, enabled: boolean): Promise<void> => {
	try {
		await AsyncStorage.setItem(MIRAI_STORAGE_KEYS.status, JSON.stringify({ userId, enabled }));
	} catch {
		// Sem cache, sem rede o botão some: é o pior caso, e não quebra nada.
	}
};

/**
 * O que se sabe da reserva: se estava completa na última vez que o app olhou, e o dia em que
 * ela passou a estar. `reserveReady` nulo é "nunca olhou".
 */
export interface MiraiGoalState {
	reserveReady: boolean | null;
	goalDay: string | null;
}

export const EMPTY_GOAL_STATE: MiraiGoalState = { reserveReady: null, goalDay: null };

/**
 * A reserva foi vista agora, completa ou não. Só a **passagem** de incompleta para completa
 * marca o dia: a primeira leitura é o ponto de partida (uma reserva que já estava cheia antes
 * do Mirai não comemora nada), e reserva que continua cheia não remarca.
 */
export const nextGoalState = (
	previous: MiraiGoalState,
	reserveReady: boolean,
	today: string
): MiraiGoalState => ({
	reserveReady,
	goalDay: previous.reserveReady === false && reserveReady ? today : previous.goalDay,
});

export const getGoalState = async (): Promise<MiraiGoalState> => {
	try {
		const stored = await AsyncStorage.getItem(MIRAI_STORAGE_KEYS.goal);
		const parsed: unknown = stored ? JSON.parse(stored) : null;
		if (typeof parsed !== 'object' || parsed === null) return EMPTY_GOAL_STATE;
		const { reserveReady, goalDay } = parsed as { reserveReady?: unknown; goalDay?: unknown };
		return {
			reserveReady: typeof reserveReady === 'boolean' ? reserveReady : null,
			goalDay: typeof goalDay === 'string' ? goalDay : null,
		};
	} catch {
		return EMPTY_GOAL_STATE;
	}
};

export const setGoalState = async (state: MiraiGoalState): Promise<void> => {
	try {
		await AsyncStorage.setItem(MIRAI_STORAGE_KEYS.goal, JSON.stringify(state));
	} catch {
		// Perder o dia da meta só tira a comemoração.
	}
};

/**
 * Todo arquivo sob app/ é tratado como rota pelo expo-router, e uma rota sem export
 * default é um módulo quebrado do ponto de vista dele. Este export existe só para
 * satisfazer essa exigência — nada navega para cá.
 */
export default {
	getMiraiName,
	setMiraiName,
	cleanMiraiName,
	firstNameOf,
	getMiraiChoice,
	setMiraiChoice,
	getCachedEnabled,
	setCachedEnabled,
	nextGoalState,
	getGoalState,
	setGoalState,
};
