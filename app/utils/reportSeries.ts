/**
 * As séries dos relatórios: o quadro do mês repetido para vários meses, os rankings de
 * categoria e de origem do gasto, o que já está comprometido para os próximos meses e a
 * proteção contra receita contada duas vezes.
 *
 * Recebe o que o banco já somou por mês (lançamentos por conta, transferências por conta,
 * despesas por categoria) e as linhas dos cartões, e compõe com `buildMonthOverview` — a
 * mesma função da Home, para que "Gastou" em setembro nos Relatórios seja o mesmo
 * número do "Este mês" de setembro. O gasto de cartão num mês passado é a fatura que
 * **fecha** nele (`invoicesClosingBetween`), não as compras datadas nele.
 *
 * Puro: nada de React Native, nada de banco.
 */

import type { Account, Category, Transaction, Transfer } from '../database/schema';
import { type CardEntry, type CardSummary, invoicesClosingBetween } from './cardMath';
import type { DebtMonthLine } from './debt';
import { lastDayOfMonth, monthKeyOf, monthKeyRange, shiftMonthKey } from './dateUtils';
import { type CategoryTotal, categoryDeltas, FULL_BASIS_POINTS } from './metrics';
import type { Cents } from './money';
import { type AccountMonthActivity, buildMonthOverview, type MonthOverview } from './monthOverview';
import type { YieldBasis } from './yield';

export type MonthKey = string;

/** Receita e despesa de uma conta num mês, como o banco devolve (`accountId` nulo = sem conta). */
export interface MonthAccountRow {
	month: MonthKey;
	accountId: string | null;
	incomeCents: Cents;
	expenseCents: Cents;
	passThroughCents: Cents;
}

/** O que entrou e saiu de uma conta por transferência num mês. */
export interface MonthTransferRow {
	month: MonthKey;
	accountId: string;
	inCents: Cents;
	outCents: Cents;
}

export interface MonthCategoryRow {
	month: MonthKey;
	categoryId: string;
	totalCents: Cents;
}

/** Quanto da receita de uma conta num mês é rendimento de investimento. */
export interface MonthInvestmentIncomeRow {
	month: MonthKey;
	accountId: string;
	cents: Cents;
}

/**
 * As categorias de receita que contam como rendimento de investimento.
 *
 * É a `investment` ("Investment"/Rendimentos) semeada em `DEFAULT_CATEGORIES`: a única do
 * app cujo significado é "o dinheiro guardado rendeu". Qualquer outra receita que caia numa
 * conta de reserva (`gift`, `refund`, `salary`…) é receita comum do mês — o Pix de um amigo
 * que cai na poupança não é rentabilidade. Uma categoria de rendimento criada à mão pelo
 * usuário precisa ser passada em `investmentIncomeRows`, que aceita o conjunto de ids.
 */
export const INVESTMENT_INCOME_CATEGORY_IDS: ReadonlySet<string> = new Set(['investment']);

/** A parte de rendimento da receita de cada conta, por mês, a partir das linhas do livro. */
export const investmentIncomeRows = (
	transactions: Pick<Transaction, 'accountId' | 'date' | 'isIncome' | 'amountCents' | 'category'>[],
	categoryIds: ReadonlySet<string> = INVESTMENT_INCOME_CATEGORY_IDS
): MonthInvestmentIncomeRow[] => {
	const byKey = new Map<string, MonthInvestmentIncomeRow>();
	for (const transaction of transactions) {
		if (!transaction.isIncome || !transaction.accountId || !categoryIds.has(transaction.category)) continue;
		const month = monthKeyOf(transaction.date);
		const key = `${month}|${transaction.accountId}`;
		const row = byKey.get(key) ?? { month, accountId: transaction.accountId, cents: 0 };
		row.cents += transaction.amountCents;
		byKey.set(key, row);
	}
	return [...byKey.values()];
};

/**
 * A data do último rendimento **lançado** em cada conta. Conta sem nenhum fica fora do mapa.
 *
 * Mesmo critério de `investmentIncomeRows` e do mesmo conjunto de categorias, de propósito:
 * é daqui que a estimativa do CDI sabe até onde o livro já respondeu, e dois critérios
 * diferentes para "rendimento lançado" fariam o período ser contado duas vezes ou nenhuma
 * (ver `notBefore` em `utils/yield.ts`).
 */
export const lastInvestmentIncomeDateByAccount = (
	transactions: Pick<Transaction, 'accountId' | 'date' | 'isIncome' | 'amountCents' | 'category'>[],
	categoryIds: ReadonlySet<string> = INVESTMENT_INCOME_CATEGORY_IDS
): Map<string, string> => {
	const byAccount = new Map<string, string>();
	for (const transaction of transactions) {
		if (!transaction.isIncome || !transaction.accountId || !categoryIds.has(transaction.category)) continue;
		const current = byAccount.get(transaction.accountId);
		if (current === undefined || transaction.date > current) byAccount.set(transaction.accountId, transaction.date);
	}
	return byAccount;
};

/**
 * Quanto cada conta sua recebeu de contas `external` em cada mês, por `mês|contaId`.
 *
 * É o lado de quem recebe do contrato do papel `external`: o pró-labore que a PJ manda para
 * a principal é transferência no livro e receita no mês. Transferência entre duas contas
 * suas não entra (não é renda nova), nem de uma externa para outra externa (nada disso é
 * seu), nem de fora do app (`fromAccountId` nulo não diz de quem é o dinheiro).
 */
export const externalIncomeTransfers = (
	transfers: Pick<Transfer, 'date' | 'fromAccountId' | 'toAccountId' | 'amountCents'>[],
	accounts: Pick<Account, 'id' | 'role'>[]
): Array<{ month: MonthKey; toAccountId: string; amountCents: Cents }> => {
	const roleById = new Map(accounts.map((account) => [account.id, account.role]));
	const found: Array<{ month: MonthKey; toAccountId: string; amountCents: Cents }> = [];
	for (const transfer of transfers) {
		const { fromAccountId, toAccountId } = transfer;
		if (!fromAccountId || !toAccountId) continue;
		if (roleById.get(fromAccountId) !== 'external') continue;
		const toRole = roleById.get(toAccountId);
		if (toRole === undefined || toRole === 'external') continue;
		found.push({ month: monthKeyOf(transfer.date), toAccountId, amountCents: transfer.amountCents });
	}
	return found;
};

/** O mesmo, somado por `mês|contaId`, que é como o quadro do mês lê. */
export const externalTransfersInByMonth = (
	transfers: Pick<Transfer, 'date' | 'fromAccountId' | 'toAccountId' | 'amountCents'>[],
	accounts: Pick<Account, 'id' | 'role'>[]
): Map<string, Cents> => {
	const byKey = new Map<string, Cents>();
	for (const entry of externalIncomeTransfers(transfers, accounts)) {
		const key = `${entry.month}|${entry.toAccountId}`;
		byKey.set(key, (byKey.get(key) ?? 0) + entry.amountCents);
	}
	return byKey;
};

export interface MonthPoint {
	month: MonthKey;
	overview: MonthOverview;
	/** O mês de hoje: ainda está acontecendo, então fica fora das médias. */
	isCurrent: boolean;
	/**
	 * Um mês que ainda não começou. O seletor de período oferece os meses futuros do ano
	 * corrente, e sem esta marca eles entravam nas médias como **meses fechados** — gasto
	 * de parcela já comprada e poupança zero —, derrubando o custo essencial, a meta da
	 * reserva e o aporte médio que dimensiona a aposentadoria.
	 */
	isFuture: boolean;
}

/** `count` chaves de mês terminando em `end`, da mais antiga para a mais nova. */
export const monthKeysEnding = (end: MonthKey, count: number): MonthKey[] =>
	Array.from({ length: Math.max(0, count) }, (_, index) => shiftMonthKey(end, index - (count - 1)));

/** Do primeiro dia do primeiro mês ao último dia do último. */
export const monthRangeOf = (keys: MonthKey[]): { startDate: string; endDate: string } => ({
	startDate: monthKeyRange(keys[0]).startDate,
	endDate: monthKeyRange(keys[keys.length - 1]).endDate,
});

/** Uma linha do livro no formato que o cálculo de fatura lê. */
export const toCardEntry = (transaction: Transaction): CardEntry => ({
	id: transaction.id,
	amountCents: transaction.amountCents,
	isIncome: transaction.isIncome,
	date: transaction.date,
	note: transaction.note,
	category: transaction.category,
	installmentGroup: transaction.installmentGroup,
	installmentIndex: transaction.installmentIndex,
	installmentCount: transaction.installmentCount,
	cardLast4: transaction.cardLast4,
});

export interface MonthSeriesInput {
	months: MonthKey[];
	/** Contas vivas (o banco já filtra as apagadas). */
	accounts: Account[];
	activity: MonthAccountRow[];
	transfers: MonthTransferRow[];
	/** Todas as linhas de cada cartão, por id: as faturas de vários meses saem daqui. */
	cardEntries: Map<string, CardEntry[]>;
	/**
	 * As transferências do período, linha a linha. Só as somas por conta não dizem **de
	 * quem** o dinheiro veio, e é disso que depende saber se a entrada é renda da PJ.
	 */
	transferLines?: Pick<Transfer, 'date' | 'fromAccountId' | 'toAccountId' | 'amountCents'>[];
	/** A parte de rendimento da receita de cada conta de reserva (`investmentIncomeRows`). */
	investmentIncome?: MonthInvestmentIncomeRow[];
	currentMonth: MonthKey;
}

/**
 * Um quadro do mês por chave, na ordem de `months`. Conta desconhecida é descartada e
 * `accountId` nulo vira "sem conta".
 *
 * O papel usado é sempre o papel **de verdade** da conta, inclusive na arquivada. Trocá-lo
 * por `external` reescrevia o passado: arquivar um cartão antigo apagava as faturas dele de
 * todos os meses fechados, arquivar uma reserva zerava a poupança daqueles meses, e média
 * de gasto, taxa de poupança histórica e projeção da meta passavam a usar meses que não
 * aconteceram daquele jeito. `archived` tira a conta dos totais de hoje (`summarizeAccounts`),
 * nunca de um mês que já fechou.
 */
export const buildMonthSeries = (input: MonthSeriesInput): MonthPoint[] => {
	const byId = new Map(input.accounts.map((account) => [account.id, account]));
	const activityBy = new Map<string, MonthAccountRow>();
	for (const row of input.activity) activityBy.set(`${row.month}|${row.accountId ?? ''}`, row);
	const transfersBy = new Map<string, MonthTransferRow>();
	for (const row of input.transfers) transfersBy.set(`${row.month}|${row.accountId}`, row);
	const fromExternalBy = externalTransfersInByMonth(input.transferLines ?? [], input.accounts);
	const investmentBy = new Map((input.investmentIncome ?? []).map((row) => [`${row.month}|${row.accountId}`, row.cents]));

	return input.months.map((month) => {
		const { startDate, endDate } = monthKeyRange(month);
		const accounts: AccountMonthActivity[] = [];

		for (const account of byId.values()) {
			const rows = activityBy.get(`${month}|${account.id}`);
			const transfers = transfersBy.get(`${month}|${account.id}`);
			const isCard = account.kind === 'credit_card';
			accounts.push({
				accountId: account.id,
				name: account.name,
				kind: account.kind,
				role: account.role,
				incomeCents: rows?.incomeCents ?? 0,
				investmentIncomeCents: investmentBy.get(`${month}|${account.id}`) ?? 0,
				expenseCents: rows?.expenseCents ?? 0,
				passThroughCents: rows?.passThroughCents ?? 0,
				transfersInCents: transfers?.inCents ?? 0,
				transfersInFromExternalCents: fromExternalBy.get(`${month}|${account.id}`) ?? 0,
				transfersOutCents: transfers?.outCents ?? 0,
				invoiceCents: isCard ? invoicesClosingBetween(account, input.cardEntries.get(account.id) ?? [], startDate, endDate) : undefined,
				envelopeMonthlyCents: account.envelopeMonthlyCents,
			});
		}

		const unassignedRow = activityBy.get(`${month}|`);
		const overview = buildMonthOverview({
			accounts,
			unassigned: {
				incomeCents: unassignedRow?.incomeCents ?? 0,
				expenseCents: unassignedRow?.expenseCents ?? 0,
				passThroughCents: unassignedRow?.passThroughCents ?? 0,
			},
		});

		return { month, overview, isCurrent: month === input.currentMonth, isFuture: month > input.currentMonth };
	});
};

/**
 * Há quantos meses seguidos a taxa de poupança cai, terminando no último mês da série.
 *
 * O mesmo substrato de `consecutiveSavingsRateDrops` em `metrics.ts`, mas lido do quadro do
 * mês em vez da soma crua do período — é a base única da tela de Relatórios. Mês sem receita
 * corta a sequência: não se sabe se a taxa caiu ou se aquele mês simplesmente não tem taxa.
 */
export const savingsRateDropsEnding = (series: MonthPoint[]): number => {
	let drops = 0;
	for (let index = series.length - 1; index > 0; index -= 1) {
		const current = series[index].overview.savingsRateBp;
		const previous = series[index - 1].overview.savingsRateBp;
		if (current === null || previous === null || current >= previous) break;
		drops += 1;
	}
	return drops;
};

/**
 * Média de `pick` nos últimos `k` meses fechados; nula sem nenhum. Mês futuro não é mês
 * fechado: com dezembro selecionado, os meses que ainda não aconteceram entravam na média
 * com poupança zero e puxavam o aporte médio para baixo.
 */
export const averageClosedMonths = (series: MonthPoint[], pick: (overview: MonthOverview) => Cents, k: number): Cents | null => {
	const closed = series.filter((point) => !point.isCurrent && !point.isFuture).slice(-Math.max(1, k));
	if (closed.length === 0) return null;
	return Math.round(closed.reduce((sum, point) => sum + pick(point.overview), 0) / closed.length);
};

// ---------------------------------------------------------------------------
// Onde foi o dinheiro
// ---------------------------------------------------------------------------

export interface CategoryRankRow {
	categoryId: string;
	name: string | null;
	color: string | null;
	currentCents: Cents;
	previousCents: Cents;
	deltaCents: Cents;
	/** Variação relativa; nula quando a categoria não existia no mês anterior. */
	pct: number | null;
	/** Fatia do gasto por categoria do mês, em pontos-base. */
	shareBp: number;
}

/**
 * As categorias do mês, da maior para a menor, com a variação contra o mês anterior.
 * Repasse fica de fora: nem chegou a ser gasto.
 */
export const rankCategories = (
	current: MonthCategoryRow[],
	previous: MonthCategoryRow[],
	categories: Pick<Category, 'id' | 'name' | 'color' | 'nature'>[]
): CategoryRankRow[] => {
	const byId = new Map(categories.map((category) => [category.id, category]));
	const isSpend = (row: MonthCategoryRow) => byId.get(row.categoryId)?.nature !== 'passthrough';
	const totals = (rows: MonthCategoryRow[]): CategoryTotal[] => rows.filter(isSpend).map((row) => ({ categoryId: row.categoryId, totalCents: row.totalCents }));

	const deltas = categoryDeltas(totals(current), totals(previous)).filter((delta) => delta.currentCents > 0);
	const total = deltas.reduce((sum, delta) => sum + delta.currentCents, 0);

	return deltas
		.map((delta) => ({
			...delta,
			name: byId.get(delta.categoryId)?.name ?? null,
			color: byId.get(delta.categoryId)?.color ?? null,
			shareBp: total > 0 ? Math.round((delta.currentCents * FULL_BASIS_POINTS) / total) : 0,
		}))
		.sort((a, b) => b.currentCents - a.currentCents || a.categoryId.localeCompare(b.categoryId));
};

export type SpendSourceKind = 'card' | 'debit' | 'pix' | 'envelope' | 'unassigned';

export interface SpendSourceRow {
	key: string;
	kind: SpendSourceKind;
	accountId: string | null;
	/** Só em cartões de débito: o final que fez a compra. */
	last4: string | null;
	/** Nome da conta, ou o apelido do cartão de débito; nulo em "sem conta". */
	name: string | null;
	cents: Cents;
	shareBp: number;
}

export interface DebitCardSpend {
	accountId: string;
	last4: string;
	name: string | null;
	periodSpentCents: Cents;
}

/**
 * De onde saiu o gasto do mês: cada cartão de crédito (a fatura), cada cartão de débito
 * (por final), o Pix da conta principal (o que sobrou depois do débito), cada envelope e
 * o que não tem conta. É o "qual cartão gasta mais".
 *
 * Segue a regra do quadro do mês (`buildMonthOverview`), para que as origens somem o
 * "Gastou": a despesa lançada numa reserva é gasto, no mesmo bolso do Pix e do débito da
 * principal, e a conta arquivada conta pelo papel de verdade (ver `buildMonthSeries`). Antes
 * só a principal viva entrava, e o ranking somava metade do "Gastou".
 */
export const rankSpendSources = (point: MonthPoint, accounts: Account[], debitCards: DebitCardSpend[], activity: MonthAccountRow[]): SpendSourceRow[] => {
	const rows: SpendSourceRow[] = [];
	const { overview } = point;

	for (const card of overview.cards) {
		rows.push({ key: `card:${card.accountId}`, kind: 'card', accountId: card.accountId, last4: null, name: card.name, cents: card.spendCents, shareBp: 0 });
	}
	for (const envelope of overview.envelopes) {
		rows.push({ key: `envelope:${envelope.accountId}`, kind: 'envelope', accountId: envelope.accountId, last4: null, name: envelope.name, cents: envelope.costCents, shareBp: 0 });
	}

	const activityOf = new Map(activity.filter((row) => row.month === point.month).map((row) => [row.accountId ?? '', row]));
	for (const account of accounts) {
		if (account.role !== 'main' && account.role !== 'reserve') continue;
		const row = activityOf.get(account.id);
		let remaining = (row?.expenseCents ?? 0) - (row?.passThroughCents ?? 0);
		for (const debit of debitCards) {
			if (debit.accountId !== account.id || debit.periodSpentCents <= 0) continue;
			rows.push({ key: `debit:${account.id}:${debit.last4}`, kind: 'debit', accountId: account.id, last4: debit.last4, name: debit.name ?? account.name, cents: debit.periodSpentCents, shareBp: 0 });
			remaining -= debit.periodSpentCents;
		}
		rows.push({ key: `pix:${account.id}`, kind: 'pix', accountId: account.id, last4: null, name: account.name, cents: remaining, shareBp: 0 });
	}

	const unassigned = activityOf.get('');
	if (unassigned) {
		rows.push({ key: 'unassigned', kind: 'unassigned', accountId: null, last4: null, name: null, cents: unassigned.expenseCents - unassigned.passThroughCents, shareBp: 0 });
	}

	const kept = rows.filter((row) => row.cents > 0);
	const total = kept.reduce((sum, row) => sum + row.cents, 0);
	return kept
		.map((row) => ({ ...row, shareBp: total > 0 ? Math.round((row.cents * FULL_BASIS_POINTS) / total) : 0 }))
		.sort((a, b) => b.cents - a.cents || a.key.localeCompare(b.key));
};

// ---------------------------------------------------------------------------
// Já comprometido
// ---------------------------------------------------------------------------

export interface CommittedMonth {
	month: MonthKey;
	cards: Array<{ accountId: string; name: string; cents: Cents }>;
	cardCents: Cents;
	/** As parcelas das dívidas no mês, todas — inclusive as que já estão no custo fixo. */
	debts: Array<{ debtId: string; name: string; cents: Cents; inFixedCost: boolean }>;
	/** Só as parcelas que o custo fixo ainda não conta: é isso que soma ao total. */
	debtCents: Cents;
	fixedCents: Cents;
	totalCents: Cents;
}

/**
 * Os próximos `count` meses depois de `fromMonth`: o que vence de fatura em cada um (as
 * parcelas já compradas, menos o crédito que chega de faturas anteriores e o que já foi
 * pago), o custo fixo das recorrências e as parcelas das dívidas. Uma parcela que já tem
 * recorrência cadastrada aparece, mas não soma de novo — ela já está no custo fixo.
 *
 * O crédito conta porque é o que o banco faz: estornar a compra parcelada inteira deixa a
 * fatura do estorno negativa, e esse crédito cobre as parcelas seguintes — que, sem ele,
 * apareciam aqui como R$ 100 por mês de uma compra devolvida.
 */
export const committedMonths = (
	cards: Array<{ id: string; name: string; summary: CardSummary }>,
	fixedCents: Cents,
	fromMonth: MonthKey,
	count = 3,
	debtLines: DebtMonthLine[] = []
): CommittedMonth[] =>
	Array.from({ length: count }, (_, index) => {
		const month = shiftMonthKey(fromMonth, index + 1);
		const perCard = cards
			.map((card) => ({
				accountId: card.id,
				name: card.name,
				cents: card.summary.invoices
					.filter((invoice) => invoice.offset >= -1 && monthKeyOf(invoice.cycle.dueDate) === month)
					.reduce((sum, invoice) => sum + Math.max(0, invoice.amountCents - invoice.creditAppliedCents - invoice.paidCents), 0),
			}))
			.filter((card) => card.cents > 0);
		const cardCents = perCard.reduce((sum, card) => sum + card.cents, 0);
		const fixed = Math.max(0, fixedCents);
		const debts = debtLines
			.filter((line) => line.month === month)
			.map((line) => ({ debtId: line.debtId, name: line.name, cents: line.cents, inFixedCost: line.inFixedCost }));
		const debtCents = debts.filter((line) => !line.inFixedCost).reduce((sum, line) => sum + line.cents, 0);
		return { month, cards: perCard, cardCents, debts, debtCents, fixedCents: fixed, totalCents: cardCents + fixed + debtCents };
	});

// ---------------------------------------------------------------------------
// Reserva ao longo do tempo
// ---------------------------------------------------------------------------

/**
 * Saldo médio das reservas nos últimos 12 meses, andando para trás a partir do saldo de
 * hoje: cada mês anterior fecha com o de hoje menos o que entrou (guardado e rendimento)
 * depois dele. Nulo com menos de três meses de histórico.
 */
export const averageReserveCapitalCents = (series: MonthPoint[], currentSavedCents: Cents): Cents | null => {
	if (series.length < 3) return null;
	const ends: Cents[] = new Array(series.length);
	ends[series.length - 1] = currentSavedCents;
	for (let index = series.length - 2; index >= 0; index -= 1) {
		const next = series[index + 1].overview;
		ends[index] = ends[index + 1] - (next.savedCents + next.yieldCents);
	}
	const window = ends.slice(-12).map((value) => Math.max(0, value));
	return Math.round(window.reduce((sum, value) => sum + value, 0) / window.length);
};

/** Rendimento **lançado** nas reservas nos últimos 12 meses da série. */
export const realizedYield12mCents = (series: MonthPoint[]): Cents => series.slice(-12).reduce((sum, point) => sum + point.overview.yieldCents, 0);

export interface Yield12m {
	/** Nulo quando não há nem lançamento nem estimativa: "não dá para responder". */
	cents: Cents | null;
	/** De onde o número veio; nulo junto com ele. */
	basis: YieldBasis | null;
}

/**
 * O rendimento dos últimos 12 meses: o que o livro registrou mais o que o app estimou
 * para o período que nenhum lançamento cobre (`estimatedCents`, de `utils/yield.ts`).
 *
 * O indicador **não pode afirmar 0%** quando o app tem uma estimativa. Antes, só o
 * lançado contava: num CDB de 120% do CDI, em que o acréscimo é estimado em memória e
 * nada é lançado no livro, a tela anunciava "rendeu 0% ao ano" e o insight sugeria trocar
 * de investimento. Sem lançamento e sem estimativa o valor é nulo — não zero —, e a
 * `basis` diz à tela que o número é estimativa e ao insight que não é base para
 * recomendar nada.
 */
export const yield12m = (series: MonthPoint[], estimatedCents: Cents | null): Yield12m => {
	const posted = realizedYield12mCents(series);
	const estimated = estimatedCents ?? 0;
	if (posted <= 0 && estimated <= 0) return { cents: null, basis: null };
	if (estimated <= 0) return { cents: posted, basis: 'posted' };
	if (posted <= 0) return { cents: estimated, basis: 'estimated' };
	return { cents: posted + estimated, basis: 'mixed' };
};

/** Quanto do mês já passou, em pontos-base: 0 num mês futuro, 10.000 num mês fechado. */
export const monthElapsedBp = (month: MonthKey, today: string): number => {
	const todayMonth = monthKeyOf(today);
	if (todayMonth > month) return FULL_BASIS_POINTS;
	if (todayMonth < month) return 0;
	const [year, monthNumber] = month.split('-').map(Number);
	const day = Number(today.slice(8, 10));
	return Math.round((day * FULL_BASIS_POINTS) / lastDayOfMonth(year, monthNumber));
};

// ---------------------------------------------------------------------------
// Renda: o que está sendo contado, e o que pode estar contado duas vezes
// ---------------------------------------------------------------------------

export interface IncomeComposition {
	grossCents: Cents;
	passThroughCents: Cents;
	netCents: Cents;
	incomeCount: number;
	passThroughCount: number;
}

/**
 * A renda do período como a tela conta: entradas, repasses e o líquido.
 *
 * As transferências que vieram de uma conta `external` entram como entradas: para quem
 * recebe pela PJ elas **são** a renda do mês, e sem elas a tela anunciava "renda considerada
 * R$ 0,00" logo abaixo de um quadro do mês que dizia R$ 12.000.
 */
export const incomeComposition = (
	transactions: Pick<Transaction, 'amountCents' | 'isIncome' | 'category'>[],
	passThroughCategoryIds: Set<string>,
	externalTransfersIn: Pick<Transfer, 'amountCents'>[] = []
): IncomeComposition => {
	let grossCents = 0;
	let passThroughCents = 0;
	let incomeCount = 0;
	let passThroughCount = 0;
	for (const transaction of transactions) {
		if (transaction.isIncome) {
			grossCents += transaction.amountCents;
			incomeCount += 1;
		} else if (passThroughCategoryIds.has(transaction.category)) {
			passThroughCents += transaction.amountCents;
			passThroughCount += 1;
		}
	}
	for (const transfer of externalTransfersIn) {
		grossCents += transfer.amountCents;
		incomeCount += 1;
	}
	return { grossCents, passThroughCents, netCents: grossCents - passThroughCents, incomeCount, passThroughCount };
};

/**
 * A renda do mês **do quadro do mês**, com as contagens das linhas que ele de fato conta.
 *
 * `incomeComposition` soma todo `isIncome` do período, e o quadro não: o estorno no cartão
 * abate a fatura, o rendimento da reserva é rendimento, a devolução no envelope reduz o gasto
 * dele, e nada do que acontece dentro de uma conta `external` é seu. O herói dos Relatórios
 * anunciava "renda considerada R$ 5.280" sobre um quadro que dizia R$ 5.000. Aqui os valores
 * são os do quadro (`incomeCents`, `grossIncomeCents`, `passThroughCents`), e as contagens
 * vêm só das linhas que ele soma: receita na principal, sem conta, ou na reserva fora das
 * categorias de rendimento; repasse na principal, na reserva ou sem conta; e o que chegou
 * de uma conta `external`. Sem quadro (ainda carregando), os valores saem dessas linhas.
 */
export const monthIncomeComposition = (
	overview: Pick<MonthOverview, 'incomeCents' | 'grossIncomeCents' | 'passThroughCents'> | null,
	transactions: Pick<Transaction, 'accountId' | 'amountCents' | 'isIncome' | 'category'>[],
	accounts: Pick<Account, 'id' | 'role'>[],
	passThroughCategoryIds: Set<string>,
	externalTransfersIn: Pick<Transfer, 'amountCents'>[] = [],
	investmentCategoryIds: ReadonlySet<string> = INVESTMENT_INCOME_CATEGORY_IDS
): IncomeComposition => {
	const roleById = new Map(accounts.map((account) => [account.id, account.role]));
	const counted = transactions.filter((transaction) => {
		// Sem conta conta como se fosse da principal; conta desconhecida o quadro descarta.
		if (!transaction.accountId) return true;
		const role = roleById.get(transaction.accountId);
		if (role === 'main') return true;
		if (role === 'reserve') return !(transaction.isIncome && investmentCategoryIds.has(transaction.category));
		return false;
	});
	const lines = incomeComposition(counted, passThroughCategoryIds, externalTransfersIn);
	if (!overview) return lines;
	return {
		...lines,
		grossCents: overview.grossIncomeCents,
		passThroughCents: overview.passThroughCents,
		netCents: overview.incomeCents,
	};
};

/** Abaixo disto duas receitas iguais são coincidência comum (duas gorjetas), não duplicata. */
export const MIN_DUPLICATE_INCOME_CENTS = 50_000;

/** Até quantos dias de distância duas receitas iguais são suspeitas. */
export const DUPLICATE_INCOME_WINDOW_DAYS = 2;

export interface DuplicateIncome {
	amountCents: Cents;
	accountId: string | null;
	ids: [string, string];
	dates: [string, string];
}

const daysApart = (a: string, b: string): number => Math.abs(Date.UTC(Number(a.slice(0, 4)), Number(a.slice(5, 7)) - 1, Number(a.slice(8, 10))) - Date.UTC(Number(b.slice(0, 4)), Number(b.slice(5, 7)) - 1, Number(b.slice(8, 10)))) / 86_400_000;

/**
 * Receitas que parecem a mesma contada duas vezes: mesmo valor, mesma conta, poucos dias
 * de distância. Um salário que cai em dois Pix de valores diferentes não dispara; o mesmo
 * Pix capturado pela notificação e pelo extrato, ou lançado à mão e pela recorrência, sim.
 */
export const findDuplicateIncomes = (transactions: Pick<Transaction, 'id' | 'amountCents' | 'isIncome' | 'accountId' | 'date'>[]): DuplicateIncome[] => {
	const incomes = transactions
		.filter((transaction) => transaction.isIncome && transaction.amountCents >= MIN_DUPLICATE_INCOME_CENTS)
		.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
	const found: DuplicateIncome[] = [];
	const used = new Set<string>();

	for (let i = 0; i < incomes.length; i += 1) {
		const a = incomes[i];
		if (used.has(a.id)) continue;
		for (let j = i + 1; j < incomes.length; j += 1) {
			const b = incomes[j];
			if (used.has(b.id)) continue;
			if (daysApart(a.date, b.date) > DUPLICATE_INCOME_WINDOW_DAYS) break;
			if (b.amountCents !== a.amountCents || (b.accountId ?? null) !== (a.accountId ?? null)) continue;
			found.push({ amountCents: a.amountCents, accountId: a.accountId ?? null, ids: [a.id, b.id], dates: [a.date, b.date] });
			used.add(a.id);
			used.add(b.id);
			break;
		}
	}
	return found;
};

/** Marca que `processRecurringTransactions` põe na nota do que ela mesma lançou. */
export const AUTO_NOTE_PREFIX = '[Auto] ';

/** Até quantos dias de distância a recorrente e a cobrança de verdade são a mesma coisa. */
export const DOUBLE_CHARGE_WINDOW_DAYS = 5;

export interface RecurringDoubleCharge {
	amountCents: Cents;
	note: string;
	ids: [string, string];
	dates: [string, string];
}

/**
 * A recorrente e a cobrança de verdade, as duas no mesmo mês.
 *
 * Uma assinatura cadastrada como recorrente **e** cobrada no cartão entra duas vezes: a
 * recorrente lança no dia combinado, sem conta, e a notificação do banco lança a compra
 * na fatura. O gasto do mês e o "já comprometido" ficam inflados pelo valor de toda
 * assinatura — justamente o caso mais comum de recorrente.
 *
 * O par é preciso porque um dos lados tem de ser lançamento da própria recorrente
 * (`[Auto]`) e o outro não: duas compras iguais na semana não disparam. Isto **avisa**,
 * não apaga: qual dos dois sai é decisão de quem lançou, e o app não tem como saber se a
 * cobrança do mês realmente aconteceu.
 */
export const findRecurringDoubleCharges = (
	transactions: Pick<Transaction, 'id' | 'amountCents' | 'isIncome' | 'date' | 'note'>[]
): RecurringDoubleCharge[] => {
	const expenses = transactions
		.filter((transaction) => !transaction.isIncome)
		.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
	const isAuto = (note: string): boolean => note.startsWith(AUTO_NOTE_PREFIX);
	const found: RecurringDoubleCharge[] = [];
	const used = new Set<string>();

	for (let i = 0; i < expenses.length; i += 1) {
		const a = expenses[i];
		if (used.has(a.id)) continue;
		for (let j = i + 1; j < expenses.length; j += 1) {
			const b = expenses[j];
			if (used.has(b.id)) continue;
			if (daysApart(a.date, b.date) > DOUBLE_CHARGE_WINDOW_DAYS) break;
			if (b.amountCents !== a.amountCents) continue;
			// Um dos dois é da recorrente e o outro não: é o que separa a cobrança dobrada de
			// duas compras de mesmo valor na mesma semana.
			if (isAuto(a.note) === isAuto(b.note)) continue;
			const auto = isAuto(a.note) ? a : b;
			found.push({
				amountCents: a.amountCents,
				note: auto.note.slice(AUTO_NOTE_PREFIX.length),
				ids: [a.id, b.id],
				dates: [a.date, b.date],
			});
			used.add(a.id);
			used.add(b.id);
			break;
		}
	}
	return found;
};

/**
 * Todo arquivo sob app/ é tratado como rota pelo expo-router, e uma rota sem export
 * default é um módulo quebrado do ponto de vista dele. Este export existe só para
 * satisfazer essa exigência — nada navega para cá.
 */
export default {
	buildMonthSeries,
	externalIncomeTransfers,
	externalTransfersInByMonth,
	investmentIncomeRows,
	lastInvestmentIncomeDateByAccount,
	yield12m,
	rankCategories,
	rankSpendSources,
	committedMonths,
	findDuplicateIncomes,
	findRecurringDoubleCharges,
};
