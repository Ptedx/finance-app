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

import type { Account, Category, Transaction } from '../database/schema';
import { type CardEntry, type CardSummary, invoicesClosingBetween } from './cardMath';
import type { DebtMonthLine } from './debt';
import { lastDayOfMonth, monthKeyOf, monthKeyRange, shiftMonthKey } from './dateUtils';
import { type CategoryTotal, categoryDeltas, FULL_BASIS_POINTS } from './metrics';
import type { Cents } from './money';
import { type AccountMonthActivity, buildMonthOverview, type MonthOverview } from './monthOverview';

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

export interface MonthPoint {
	month: MonthKey;
	overview: MonthOverview;
	/** O mês de hoje: ainda está acontecendo, então fica fora das médias. */
	isCurrent: boolean;
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
	currentMonth: MonthKey;
}

/**
 * Um quadro do mês por chave, na ordem de `months`. Conta arquivada vira externa, conta
 * desconhecida é descartada e `accountId` nulo vira "sem conta" — as mesmas regras do
 * `AccountsContext`.
 */
export const buildMonthSeries = (input: MonthSeriesInput): MonthPoint[] => {
	const byId = new Map(input.accounts.map((account) => [account.id, account]));
	const activityBy = new Map<string, MonthAccountRow>();
	for (const row of input.activity) activityBy.set(`${row.month}|${row.accountId ?? ''}`, row);
	const transfersBy = new Map<string, MonthTransferRow>();
	for (const row of input.transfers) transfersBy.set(`${row.month}|${row.accountId}`, row);

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
				role: account.archived ? 'external' : account.role,
				incomeCents: rows?.incomeCents ?? 0,
				expenseCents: rows?.expenseCents ?? 0,
				passThroughCents: rows?.passThroughCents ?? 0,
				transfersInCents: transfers?.inCents ?? 0,
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

		return { month, overview, isCurrent: month === input.currentMonth };
	});
};

/** Média de `pick` nos últimos `k` meses fechados; nula sem nenhum. */
export const averageClosedMonths = (series: MonthPoint[], pick: (overview: MonthOverview) => Cents, k: number): Cents | null => {
	const closed = series.filter((point) => !point.isCurrent).slice(-Math.max(1, k));
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
		if (account.archived || account.role !== 'main') continue;
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
 * parcelas já compradas, menos o que já foi pago), o custo fixo das recorrências e as
 * parcelas das dívidas. Uma parcela que já tem recorrência cadastrada aparece, mas não soma
 * de novo — ela já está no custo fixo.
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
					.reduce((sum, invoice) => sum + Math.max(0, invoice.amountCents - invoice.paidCents), 0),
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

/** Rendimento captado nas reservas nos últimos 12 meses da série. */
export const realizedYield12mCents = (series: MonthPoint[]): Cents => series.slice(-12).reduce((sum, point) => sum + point.overview.yieldCents, 0);

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

/** A renda do período como a tela conta: entradas, repasses e o líquido. */
export const incomeComposition = (transactions: Pick<Transaction, 'amountCents' | 'isIncome' | 'category'>[], passThroughCategoryIds: Set<string>): IncomeComposition => {
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
	return { grossCents, passThroughCents, netCents: grossCents - passThroughCents, incomeCount, passThroughCount };
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

/**
 * Todo arquivo sob app/ é tratado como rota pelo expo-router, e uma rota sem export
 * default é um módulo quebrado do ponto de vista dele. Este export existe só para
 * satisfazer essa exigência — nada navega para cá.
 */
export default { buildMonthSeries, rankCategories, rankSpendSources, committedMonths, findDuplicateIncomes };
