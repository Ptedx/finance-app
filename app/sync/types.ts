import type { Capture, CategoryNature, CategoryType, MerchantRule } from '../database/schema';

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
	/** v16: quanto do CDI a conta rende, em pontos-base. */
	yieldCdiBp?: number | null;
	/** v17. */
	reservePurpose?: 'investment' | null;
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

/** A meta da reserva de emergência (v17): uma linha só, de id fixo. */
export interface WireReserveGoal extends WireMeta {
	id: string;
	targetMonths: number;
	customMonthlyCostCents: number | null;
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
	/** v16: seguro e tarifas dentro da parcela. */
	feeCents?: number;
	adminFeeBp: number | null;
	accountId: string | null;
	category: string | null;
	archived: boolean;
	sortOrder: number;
}

/**
 * Uma notificação capturada, como ela viaja entre aparelhos.
 *
 * **A identidade aqui é o `fingerprint`, não o id local.** O mesmo aviso do banco
 * capturado em dois aparelhos nasce com dois ids aleatórios e um único fingerprint — e a
 * coluna é UNIQUE. Se o id local viajasse, o segundo aparelho receberia uma linha que não
 * cabe na tabela dele. Então o `id` desta linha **é** o fingerprint; o id local nunca sai
 * do aparelho, e quem aplica casa pelo fingerprint e mantém o id que já tinha.
 *
 * Pela mesma razão `relatedId` viaja como o **fingerprint** do item relacionado: o id
 * local dele não significa nada do outro lado.
 */
export interface WireCapture extends WireMeta {
	/** O `fingerprint` da captura. É a identidade da linha no servidor. */
	id: string;
	packageName: string;
	appLabel: string;
	title: string;
	text: string;
	postedAt: string;
	amountCents: number;
	direction: Capture['direction'];
	kind: string;
	counterparty: string | null;
	merchantKey: string | null;
	cardLast4: string | null;
	status: Capture['status'];
	question: Capture['question'];
	/** O fingerprint do item relacionado, nulo quando ele não é conhecido deste lado. */
	relatedFingerprint: string | null;
	suggestedCategory: string | null;
	transactionId: string | null;
	autoConfirmed: boolean;
	reason: string | null;
	accountId: string | null;
	transferId: string | null;
	installments: number | null;
	createdAt: string;
}

/**
 * Uma regra aprendida ("o iFood é alimentação", "isto é conta minha", "ignore isto").
 *
 * A identidade é a própria chave do estabelecimento, que os dois aparelhos derivam do
 * mesmo texto — então duas aprendizagens do mesmo lugar convergem por `updatedAt`, sem
 * conflito de id. É o que faz esta coleção ser a mais simples de todas.
 */
export interface WireMerchantRule extends WireMeta {
	/** O `merchantKey`. */
	id: string;
	categoryId: string | null;
	treatAs: MerchantRule['treatAs'];
	confirmations: number;
}

/**
 * Uma conta a pagar (v20). Mesmos nomes de `Bill` (`database/schema.ts`), e a identidade
 * é o `id`, como em debts. `amountCents` nulo é "o valor varia"; `paidThrough` é o
 * último mês pago, `YYYY-MM`.
 */
export interface WireBill extends WireMeta {
	id: string;
	name: string;
	/** 1–31; em mês curto vale o último dia. */
	dueDay: number;
	amountCents: number | null;
	accountId: string | null;
	category: string | null;
	/** Palavras separadas por vírgula; nulo = usa o nome. */
	matchHint: string | null;
	debtId: string | null;
	paidThrough: string | null;
	paidByRef: string | null;
	active: boolean;
	sortOrder: number;
}

/**
 * Uma preferência (v21): moeda, idioma, taxa do CDI, lembretes ligados. A identidade é a
 * chave do AsyncStorage, que é a mesma em todo aparelho — então duas escolhas da mesma
 * preferência convergem por `updatedAt`, como as regras aprendidas.
 *
 * `value` é o texto que o AsyncStorage guarda, sem tradução (a moeda e o idioma são JSON).
 * A lápide leva o último valor: o servidor valida a linha inteira, viva ou apagada.
 */
export interface WirePreference extends WireMeta {
	/** A chave do AsyncStorage (`STORAGE_KEYS`). */
	id: string;
	value: string;
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
	/** Coleção do v17, idem. */
	reserveGoals?: WireReserveGoal[];
	/**
	 * Coleções do v19, idem. A caixa de entrada era local por desenho, e desinstalar o app
	 * levava embora o que estava esperando revisão: logado numa conta, isso é perda de dado.
	 */
	captures?: WireCapture[];
	merchantRules?: WireMerchantRule[];
	/** Coleção do v20 (contas a pagar), idem. */
	bills?: WireBill[];
	/** Coleção do v21 (preferências), idem. */
	preferences?: WirePreference[];
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
	reserveGoals: number;
	captures: number;
	merchantRules: number;
	bills: number;
	preferences: number;
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
	reserveGoals: 0,
	captures: 0,
	merchantRules: 0,
	bills: 0,
	preferences: 0,
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
	reserveGoals: 17,
	captures: 19,
	merchantRules: 19,
	bills: 20,
	preferences: 21,
};

/**
 * Só o que o servidor conhece. Um servidor mais antigo que o app descarta em silêncio as
 * coleções que não conhece (o zod tira chaves desconhecidas) e responde como se tivesse
 * gravado — e o app marcava essas linhas como enviadas, perdidas para sempre. As coleções
 * que o servidor conhece são as do cursor que ele devolve no pull; o resto fica fora da
 * remessa e continua marcado para subir quando ele passar a conhecer.
 *
 * Sem nenhum pull ainda (`known` nulo), tudo vai, como antes.
 */
export const onlyKnownCollections = (changes: SyncChanges, known: Set<string> | null): SyncChanges => {
	if (!known) return changes;
	const filtered = { ...changes } as Record<string, unknown[] | undefined>;
	for (const key of Object.keys(filtered)) {
		if (!known.has(key)) filtered[key] = [];
	}
	return filtered as unknown as SyncChanges;
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
 * - `invalid`: a linha não passou na validação — um valor acima do teto, por exemplo —
 *   ou o banco do servidor a recusou na gravação. Antes, um caso desses derrubava a
 *   remessa inteira (400 na validação, 500 na gravação) e travava o sync do aparelho;
 *   agora só aquela linha fica de fora.
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
	/**
	 * As linhas vivas de cada coleção de dado do usuário. As quatro primeiras são as de
	 * sempre; as outras entraram quando o status passou a enxergar todas as coleções, e
	 * um servidor anterior a isso não as manda — por isso opcionais na chegada. As
	 * preferências não estão aqui de propósito: juntam chave a chave pelo carimbo, e um
	 * aparelho que só escolheu o idioma não pode fazer o login perguntar.
	 */
	counts: {
		transactions: number;
		recurringTransactions: number;
		budgets: number;
		customCategories: number;
		accounts?: number;
		transfers?: number;
		debts?: number;
		retirementGoals?: number;
		reserveGoals?: number;
		captures?: number;
		merchantRules?: number;
		bills?: number;
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
	reserveGoals: [],
	captures: [],
	merchantRules: [],
	bills: [],
	preferences: [],
});

export const countChanges = (changes: SyncChanges): number =>
	changes.categories.length +
	changes.transactions.length +
	changes.recurringTransactions.length +
	changes.budgets.length +
	(changes.accounts?.length ?? 0) +
	(changes.transfers?.length ?? 0) +
	(changes.retirementGoals?.length ?? 0) +
	(changes.debts?.length ?? 0) +
	(changes.reserveGoals?.length ?? 0) +
	// Sem estas duas, uma remessa que só tem caixa de entrada é contada como zero
	// mudanças — e quem decide se vale enviar nunca envia. A coleção existe justamente
	// porque perder a caixa de entrada é perder dado.
	(changes.captures?.length ?? 0) +
	(changes.merchantRules?.length ?? 0) +
	(changes.bills?.length ?? 0) +
	(changes.preferences?.length ?? 0);

/**
 * Todo arquivo sob app/ e tratado como rota pelo expo-router, e uma rota sem export
 * default e um modulo quebrado do ponto de vista dele. Este export existe so para
 * satisfazer essa exigencia — nada navega para ca. Mesma convencao de database.ts,
 * money.ts e dos demais utilitarios do projeto.
 */
export default { EMPTY_CURSOR, EMPTY_CHANGES, countChanges };
