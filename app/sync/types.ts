import type { CategoryType } from '../database/schema';

/**
 * O formato que trafega entre o app e a API.
 *
 * É deliberadamente igual nas duas direções — o que o pull entrega é exatamente o que o
 * push aceita —, e igual às colunas do SQLite. Sincronizar aqui é copiar, não converter:
 * qualquer tradução no caminho seria mais um lugar onde um centavo pode se perder.
 *
 * Espelha `backend/src/schemas/sync.ts`. Mudou lá, muda aqui.
 */

interface WireMeta {
	updatedAt: string;
	deletedAt: string | null;
}

export interface WireCategory extends WireMeta {
	id: string;
	name: string;
	color: string;
	icon: string;
	type: CategoryType;
}

export interface WireTransaction extends WireMeta {
	id: string;
	amountCents: number;
	category: string;
	date: string;
	note: string | null;
	isIncome: boolean;
}

export interface WireRecurringTransaction extends WireMeta {
	id: string;
	amountCents: number;
	isIncome: boolean;
	note: string | null;
	category: string;
	recurrenceType: 'weekly' | 'monthly' | 'yearly';
	day: number | null;
	month: number | null;
	weekday: number | null;
	lastProcessed: string | null;
	nextDue: string | null;
	active: boolean;
}

export interface WireBudget extends WireMeta {
	id: string;
	year: number;
	month: number;
	amountCents: number;
}

export interface SyncChanges {
	categories: WireCategory[];
	transactions: WireTransaction[];
	recurringTransactions: WireRecurringTransaction[];
	budgets: WireBudget[];
}

/**
 * Cursor do pull: a última `serverSeq` recebida de cada coleção.
 *
 * Não é um horário. `updatedAt` vem do relógio de quem editou, e um aparelho que passou
 * dias offline envia linhas datadas no passado — um cursor por tempo passaria por cima
 * delas e este aparelho nunca as veria. A `serverSeq` é atribuída pelo Postgres na ordem
 * de gravação, então nada escapa entre duas páginas.
 */
export interface SyncCursor {
	categories: number;
	transactions: number;
	recurringTransactions: number;
	budgets: number;
}

export const EMPTY_CURSOR: SyncCursor = {
	categories: 0,
	transactions: 0,
	recurringTransactions: 0,
	budgets: 0,
};

export interface PullResponse {
	serverTime: string;
	cursor: SyncCursor;
	hasMore: boolean;
	changes: SyncChanges;
}

export interface PushResponse {
	serverTime: string;
	applied: number;
	rejected: Array<{ collection: keyof SyncChanges; id: string; reason: 'stale' }>;
}

export interface SyncStatusResponse {
	/** Se a conta já tem dados próprios. Decide o fluxo do primeiro login. */
	hasData: boolean;
	counts: {
		transactions: number;
		recurringTransactions: number;
		budgets: number;
		customCategories: number;
	};
}

export const EMPTY_CHANGES = (): SyncChanges => ({
	categories: [],
	transactions: [],
	recurringTransactions: [],
	budgets: [],
});

export const countChanges = (changes: SyncChanges): number =>
	changes.categories.length +
	changes.transactions.length +
	changes.recurringTransactions.length +
	changes.budgets.length;

/**
 * Todo arquivo sob app/ e tratado como rota pelo expo-router, e uma rota sem export
 * default e um modulo quebrado do ponto de vista dele. Este export existe so para
 * satisfazer essa exigencia — nada navega para ca. Mesma convencao de database.ts,
 * money.ts e dos demais utilitarios do projeto.
 */
export default { EMPTY_CURSOR, EMPTY_CHANGES, countChanges };
