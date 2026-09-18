import type { CategoryNature, CategoryType } from '../database/schema';

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
	/**
	 * Nulo é aceito na chegada, nunca produzido na saída.
	 *
	 * A coluna é mais nova que o protocolo: um servidor ainda sem ela, ou uma linha que
	 * ele recebeu de um aparelho numa versão anterior, chega sem `nature`. Quem aplica
	 * resolve para o padrão em vez de recusar a linha — perder a categoria inteira por
	 * causa de um campo que o app sabe preencher sozinho seria o pior dos dois erros.
	 */
	nature: CategoryNature | null;
}

export interface WireTransaction extends WireMeta {
	id: string;
	amountCents: number;
	category: string;
	date: string;
	note: string | null;
	isIncome: boolean;
	/** Campos do v7. Nulos numa linha anterior a eles, e opcionais na chegada por isso. */
	accountId?: string | null;
	installmentGroup?: string | null;
	installmentIndex?: number | null;
	installmentCount?: number | null;
	/** v13; opcional na chegada de um servidor anterior. */
	cardLast4?: string | null;
}

export interface WireAccount extends WireMeta {
	id: string;
	name: string;
	kind: 'checking' | 'savings' | 'investment' | 'cash' | 'credit_card';
	/** Campos do v8; opcionais na chegada de um servidor anterior a eles. */
	role?: 'main' | 'card' | 'envelope' | 'reserve' | 'external' | null;
	envelopeMonthlyCents?: number | null;
	/** v9; opcional na chegada de um servidor anterior. */
	network?: string | null;
	bankName: string | null;
	color: string;
	last4: string | null;
	closingDay: number | null;
	dueDay: number | null;
	/** v10; opcional na chegada de um servidor anterior. */
	closingDaysBefore?: number | null;
	creditLimitCents: number | null;
	/** v13: nomes dos cartões por final, em JSON. */
	cardNames?: string | null;
	packageName: string | null;
	accountKey: string | null;
	openingBalanceCents: number;
	openingBalanceDate: string;
	sortOrder: number;
	archived: boolean;
}

export interface WireTransfer extends WireMeta {
	id: string;
	fromAccountId: string | null;
	toAccountId: string | null;
	amountCents: number;
	date: string;
	note: string | null;
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

/** A meta de aposentadoria: uma linha só, de id fixo. */
export interface WireRetirementGoal extends WireMeta {
	id: string;
	targetMonthlyCents: number;
	reinvestBp: number;
	expectedYieldBp: number;
	outsideCapitalCents: number;
}

/** Uma dívida (v15). */
export interface WireDebt extends WireMeta {
	id: string;
	name: string;
	kind: 'financing' | 'consortium' | 'loan';
	system: 'price' | 'sac' | 'none';
	openingBalanceCents: number;
	openingBalanceDate: string;
	installmentCents: number;
	remainingAtOpening: number;
	installmentsTotal: number;
	dueDay: number;
	rateBp: number;
	adminFeeBp: number | null;
	accountId: string | null;
	category: string | null;
	archived: boolean;
	sortOrder: number;
}

export interface SyncChanges {
	categories: WireCategory[];
	transactions: WireTransaction[];
	recurringTransactions: WireRecurringTransaction[];
	budgets: WireBudget[];
	/** Coleções do v7. Opcionais na chegada: um servidor anterior a elas não as manda. */
	accounts?: WireAccount[];
	transfers?: WireTransfer[];
	/** Coleção do v14, opcional pelo mesmo motivo. */
	retirementGoals?: WireRetirementGoal[];
	/** Coleção do v15, idem. */
	debts?: WireDebt[];
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
	accounts: number;
	transfers: number;
	retirementGoals: number;
	debts: number;
}

export const EMPTY_CURSOR: SyncCursor = {
	categories: 0,
	transactions: 0,
	recurringTransactions: 0,
	budgets: 0,
	accounts: 0,
	transfers: 0,
	retirementGoals: 0,
	debts: 0,
};

/**
 * Em que versão do banco cada coleção entrou. Serve ao cursor por versão: um app antigo
 * avança o cursor de coleções que não conhece sem gravar as linhas, então o cursor dele
 * não vale para elas.
 */
export const COLLECTION_SINCE_SCHEMA: Record<keyof SyncCursor, number> = {
	categories: 3,
	transactions: 3,
	recurringTransactions: 3,
	budgets: 4,
	accounts: 7,
	transfers: 7,
	retirementGoals: 14,
	debts: 15,
};

/**
 * O cursor herdado da versão anterior: vale para as coleções que ela conhecia; as que
 * entraram depois começam do zero (pull completo delas, idempotente).
 */
export const inheritCursor = (legacy: SyncCursor, legacySchema: number): SyncCursor => {
	const cursor = { ...EMPTY_CURSOR };
	for (const key of Object.keys(EMPTY_CURSOR) as Array<keyof SyncCursor>) {
		cursor[key] = COLLECTION_SINCE_SCHEMA[key] <= legacySchema ? legacy[key] : 0;
	}
	return cursor;
};

export interface PullResponse {
	serverTime: string;
	cursor: SyncCursor;
	hasMore: boolean;
	changes: SyncChanges;
}

/**
 * Por que o servidor não gravou uma linha.
 *
 * - `stale`: ele já tem uma versão mais nova. Nada a fazer aqui — o pull seguinte
 *   traz a vencedora.
 * - `unknown_category`: o lançamento aponta para uma categoria que o servidor não
 *   conhece. Em vez de gravar reancorado (e divergir deste aparelho para sempre), ele
 *   devolve a linha, e cabe a quem enviou subir a categoria junto na próxima remessa.
 * - `invalid`: a linha não passou na validação — um valor acima do teto, por exemplo.
 *   Antes, um caso desses derrubava a remessa inteira com 400 e travava o sync do
 *   aparelho; agora só aquela linha fica de fora.
 */
export type RejectionReason = 'stale' | 'unknown_category' | 'invalid';

export interface RejectedRow {
	collection: keyof SyncChanges;
	id: string;
	reason: RejectionReason;
	/** A categoria que faltou, quando `reason` é `unknown_category`. */
	category?: string;
	/** O que a validação reclamou, quando `reason` é `invalid`. */
	message?: string;
}

export interface PushResponse {
	serverTime: string;
	applied: number;
	rejected: RejectedRow[];
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
	accounts: [],
	transfers: [],
	retirementGoals: [],
	debts: [],
});

export const countChanges = (changes: SyncChanges): number =>
	changes.categories.length +
	changes.transactions.length +
	changes.recurringTransactions.length +
	changes.budgets.length +
	(changes.accounts?.length ?? 0) +
	(changes.transfers?.length ?? 0) +
	(changes.retirementGoals?.length ?? 0) +
	(changes.debts?.length ?? 0);

/**
 * Todo arquivo sob app/ e tratado como rota pelo expo-router, e uma rota sem export
 * default e um modulo quebrado do ponto de vista dele. Este export existe so para
 * satisfazer essa exigencia — nada navega para ca. Mesma convencao de database.ts,
 * money.ts e dos demais utilitarios do projeto.
 */
export default { EMPTY_CURSOR, EMPTY_CHANGES, countChanges };
