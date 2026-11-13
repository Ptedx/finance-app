import { getPendingCaptures } from '../database/captures';
import {
	getMonthlyAccountActivity,
	getMonthlyCategoryTotals,
	getMonthlyTransferActivity,
	getTransactionsForAccounts,
	getTransfersByDateRange,
	type MonthAccountActivityRow,
	type MonthCategoryTotalRow,
	type MonthTransferActivityRow,
} from '../database/database';
import {
	type Account,
	type Category,
	DEFAULT_RESERVE_MONTHS,
	type ReserveGoalRow,
	type RetirementGoalRow,
	type Transfer,
} from '../database/schema';
import { provisionalEntriesByAccount } from './accountMath';
import type { CardEntry, CardSummary } from './cardMath';
import {
	buildReserveReadModel,
	contributionDelayMonths,
	essentialMonthlyCostCents,
	essentialShareBp,
	type ReserveReadModel,
	resolveMonthlyCost,
} from './emergencyReserve';
import { buildHealthIndicators, type HealthIndicator, type PaceWindow, spendingPaceWindows } from './healthScore';
import { FULL_BASIS_POINTS } from './metrics';
import {
	averageClosedMonths,
	averageReserveCapitalCents,
	buildMonthSeries,
	type MonthInvestmentIncomeRow,
	type MonthKey,
	type MonthPoint,
	investmentIncomeRows,
	monthElapsedBp,
	monthKeysEnding,
	monthRangeOf,
	paceSpendToDate,
	toCardEntry,
	type withProvisionalActivity,
	yield12m,
} from './reportSeries';
import {
	buildRetirementReadModel,
	contributionForHorizon,
	DEFAULT_EXPECTED_YIELD_BP,
	monthlyRate,
	type RetirementGoal,
	type RetirementReadModel,
} from './retirement';

/**
 * As contas dos Relatórios e do Patrimônio, tiradas de `useReportsData` (SPD-163b) para que o
 * Mirai responda com os mesmos números: cada função aqui é o corpo de um `useMemo` (ou da carga)
 * do hook, sem mudança nenhuma. O hook continua memorizando pedaço a pedaço; as ferramentas do
 * Mirai (`utils/mirai/tools`) chamam as mesmas funções na mesma ordem.
 */

/** 12 meses de tendência mais um anterior, para a variação de categoria do primeiro. */
export const HISTORY_MONTHS = 13;

/** O aporte médio olha meio ano: um mês bom ou ruim não muda a data de chegada. */
export const CONTRIBUTION_WINDOW_MONTHS = 6;

/** Renda e gasto médios olham o trimestre fechado. */
export const AVERAGE_WINDOW_MONTHS = 3;

/** "Quanto da renda a meta pede" é calculado para chegar em 20 anos. */
export const NEEDED_HORIZON_MONTHS = 20 * 12;

export interface ReportsRaw {
	months: MonthKey[];
	activity: MonthAccountActivityRow[];
	transfers: MonthTransferActivityRow[];
	categoryRows: MonthCategoryTotalRow[];
	cardEntries: Map<string, CardEntry[]>;
	/** As transferências do histórico, linha a linha: só elas dizem de qual conta o dinheiro veio. */
	transferLines: Transfer[];
	/** A parte de rendimento da receita de cada conta de reserva, mês a mês. */
	investmentIncome: MonthInvestmentIncomeRow[];
	/**
	 * As compras da caixa de entrada que já contam como provisórias, por conta — a mesma
	 * regra da Home (`provisionalEntriesByAccount`). `activity` e `cardEntries` são só o livro.
	 */
	provisional: Map<string, CardEntry[]>;
	/**
	 * O ritmo de gastos: o mês selecionado e os anteriores, cada um do dia 1 ao mesmo dia D
	 * (`spendingPaceWindows`), com as somas do livro só até o corte. Nulo em mês futuro.
	 */
	pace: { window: PaceWindow; activity: MonthAccountActivityRow[]; transfers: MonthTransferActivityRow[] }[] | null;
}

/**
 * A carga dos Relatórios: 13 meses terminando em `selectedKey`, em poucas consultas agregadas.
 * `accounts` é a lista do `AccountsContext` (com as apagadas, que saem aqui).
 */
export const loadReportsRaw = async (selectedKey: MonthKey, accounts: Account[], today: string): Promise<ReportsRaw> => {
	const months = monthKeysEnding(selectedKey, HISTORY_MONTHS);
	const { startDate, endDate } = monthRangeOf(months);
	const live = accounts.filter((account) => !account.deletedAt);
	const cardIds = live.filter((account) => account.kind === 'credit_card').map((account) => account.id);
	// As contas de reserva vêm na mesma consulta porque delas o quadro do mês precisa saber
	// quanto da receita é rendimento de investimento — o que as somas por conta não dizem.
	const reserveIds = live.filter((account) => account.kind !== 'credit_card' && account.role === 'reserve').map((account) => account.id);

	const [activity, transfers, categoryRows, ledgerTransactions, transferLines, pendingCaptures] = await Promise.all([
		getMonthlyAccountActivity(startDate, endDate),
		getMonthlyTransferActivity(startDate, endDate),
		getMonthlyCategoryTotals(startDate, endDate, 'expense'),
		getTransactionsForAccounts([...cardIds, ...reserveIds]),
		getTransfersByDateRange(startDate, endDate),
		getPendingCaptures(),
	]);
	// Oito consultas pequenas de totais: o mês selecionado e os três anteriores, só até o dia D.
	const windows = spendingPaceWindows(selectedKey, today);
	const pace =
		windows === null
			? null
			: await Promise.all(
					[windows.current, ...windows.previous].map(async (window) => {
						const [windowActivity, windowTransfers] = await Promise.all([
							getMonthlyAccountActivity(window.startDate, window.cutoffDate),
							getMonthlyTransferActivity(window.startDate, window.cutoffDate),
						]);
						return { window, activity: windowActivity, transfers: windowTransfers };
					})
				);

	const isCard = new Set(cardIds);
	const cardEntries = new Map<string, CardEntry[]>();
	for (const transaction of ledgerTransactions) {
		if (!transaction.accountId || !isCard.has(transaction.accountId)) continue;
		const list = cardEntries.get(transaction.accountId) ?? [];
		list.push(toCardEntry(transaction));
		cardEntries.set(transaction.accountId, list);
	}
	return {
		months,
		activity,
		transfers,
		categoryRows,
		cardEntries,
		transferLines,
		investmentIncome: investmentIncomeRows(ledgerTransactions),
		provisional: provisionalEntriesByAccount(pendingCaptures, live),
		pace,
	};
};

/** A série inteira (13 meses), com as provisórias já somadas (`merged`). */
export const fullSeriesOf = (
	raw: ReportsRaw,
	merged: ReturnType<typeof withProvisionalActivity>,
	liveAccounts: Account[],
	todayKey: MonthKey
): MonthPoint[] =>
	buildMonthSeries({
		months: raw.months,
		accounts: liveAccounts,
		activity: merged.activity,
		transfers: raw.transfers,
		cardEntries: merged.cardEntries,
		transferLines: raw.transferLines,
		investmentIncome: raw.investmentIncome,
		currentMonth: todayKey,
	});

/** O ritmo de gastos: o mês até hoje contra os anteriores até o mesmo dia (SPD-034). */
export const paceSpendOf = (raw: ReportsRaw, liveAccounts: Account[], todayKey: MonthKey) => {
	if (!raw.pace) return null;
	return paceSpendToDate({
		windows: raw.pace.map(({ window, activity, transfers }) => ({
			month: window.month,
			cutoffDate: window.cutoffDate,
			activity,
			transfers,
			hasData: raw.activity.some((row) => row.month === window.month) || raw.transfers.some((row) => row.month === window.month),
		})),
		accounts: liveAccounts,
		cardEntries: raw.cardEntries,
		provisional: raw.provisional,
		transferLines: raw.transferLines,
		currentMonth: todayKey,
	});
};

export type PaceSpend = ReturnType<typeof paceSpendOf>;

/** Gasto e renda médios do trimestre fechado e o aporte médio do semestre. */
export const averageSpendOf = (fullSeries: MonthPoint[]) => averageClosedMonths(fullSeries, (o) => o.totalSpendCents, AVERAGE_WINDOW_MONTHS);
export const averageIncomeOf = (fullSeries: MonthPoint[]) => averageClosedMonths(fullSeries, (o) => o.incomeCents, AVERAGE_WINDOW_MONTHS);
export const averageSavedOf = (fullSeries: MonthPoint[]) => averageClosedMonths(fullSeries, (o) => o.savedCents, CONTRIBUTION_WINDOW_MONTHS) ?? 0;

/**
 * O custo essencial da reserva que o app calcula: dos meses fechados; sem nenhum, do
 * orçamento do mês. O valor à mão (`reserveModelOf`) vence os dois.
 */
export const computedReserveCostOf = (
	spendCategoryRows: MonthCategoryTotalRow[],
	fullSeries: MonthPoint[],
	natureById: Map<string, Category['nature']>,
	currentBudgetCents: number | null,
	todayKey: MonthKey
) =>
	resolveMonthlyCost({
		customCents: null,
		historyCents: essentialMonthlyCostCents(fullSeries, spendCategoryRows, natureById),
		budgetCents: currentBudgetCents,
		currentShareBp: essentialShareBp(
			spendCategoryRows.filter((row) => row.month === todayKey),
			natureById
		),
	});

/** A meta da reserva: quantos meses e o custo à mão (nulo é "o app calcula"). */
export interface ReserveGoal {
	targetMonths: number;
	customMonthlyCostCents: number | null;
}

export const DEFAULT_RESERVE_GOAL: ReserveGoal = { targetMonths: DEFAULT_RESERVE_MONTHS, customMonthlyCostCents: null };

/** A linha gravada da meta da reserva; sem linha vale o padrão. */
export const reserveGoalOf = (row: ReserveGoalRow | null): ReserveGoal =>
	row ? { targetMonths: row.targetMonths, customMonthlyCostCents: row.customMonthlyCostCents } : DEFAULT_RESERVE_GOAL;

/** A linha gravada da meta de aposentadoria; sem linha, sem meta. */
export const retirementGoalOf = (row: RetirementGoalRow | null): RetirementGoal | null =>
	row
		? {
				targetMonthlyCents: row.targetMonthlyCents,
				reinvestBp: row.reinvestBp,
				expectedYieldBp: row.expectedYieldBp,
				outsideCapitalCents: row.outsideCapitalCents,
			}
		: null;

/** A reserva de emergência: custo essencial, meta, a cascata e quanto falta. */
export const reserveModelOf = ({
	reserveGoal,
	computedCost,
	liveAccounts,
	balances,
	averageSavedCents,
	goal,
}: {
	reserveGoal: ReserveGoal;
	computedCost: ReturnType<typeof resolveMonthlyCost>;
	liveAccounts: Account[];
	balances: Map<string, number>;
	averageSavedCents: number;
	goal: RetirementGoal | null;
}): ReserveReadModel => {
	const custom = reserveGoal.customMonthlyCostCents;
	const cost = custom !== null && custom > 0 ? { cents: custom, source: 'custom' as const } : computedCost;
	return buildReserveReadModel({
		accounts: liveAccounts
			.filter((account) => !account.archived && account.kind !== 'credit_card' && account.role === 'reserve')
			.map((account) => ({
				balanceCents: balances.get(account.id) ?? account.openingBalanceCents,
				purpose: account.reservePurpose === 'investment' ? 'investment' : null,
			})),
		targetMonths: reserveGoal.targetMonths,
		cost,
		monthlyContributionCents: averageSavedCents,
		monthlyRate: monthlyRate(goal?.expectedYieldBp ?? DEFAULT_EXPECTED_YIELD_BP),
	});
};

/**
 * O rendimento que o app **estimou** para as contas de reserva nos últimos 12 meses (o
 * acréscimo do CDI, que não é lançado no livro). Entra no "rendeu nos últimos 12 meses"
 * ao lado do lançado: sem ele a tela afirmava "rendeu 0% ao ano" num CDB de 120% do CDI.
 */
export const estimatedYield12mOf = (liveAccounts: Account[], accruedYield12m: Map<string, number>): number | null => {
	let total = 0;
	let found = false;
	for (const account of liveAccounts) {
		if (account.archived || account.kind === 'credit_card' || account.role !== 'reserve') continue;
		const cents = accruedYield12m.get(account.id);
		if (cents === undefined) continue;
		found = true;
		total += cents;
	}
	return found ? total : null;
};

/** A meta de aposentadoria lida contra o dinheiro de hoje; nula sem meta. */
export const retirementModelOf = ({
	goal,
	fullSeries,
	savedCents,
	averageSavedCents,
	todayKey,
	selectedKey,
	reserve,
	estimatedYield12mCents,
}: {
	goal: RetirementGoal | null;
	fullSeries: MonthPoint[];
	/** `overview.savedCents` do `AccountsContext`. */
	savedCents: number;
	averageSavedCents: number;
	todayKey: MonthKey;
	selectedKey: MonthKey;
	reserve: ReserveReadModel;
	estimatedYield12mCents: number | null;
}): RetirementReadModel | null => {
	if (!goal) return null;
	// O rendimento observado anda para trás a partir do saldo de hoje, então só faz
	// sentido quando a série termina no mês de hoje.
	const history = selectedKey === todayKey ? fullSeries.slice(-12) : [];
	const yielded = yield12m(history, history.length > 0 ? estimatedYield12mCents : null);
	return buildRetirementReadModel({
		goal,
		// A cascata: só o que passa da reserva de emergência é capital da meta, e o aporte
		// vem para a meta depois que a reserva enche.
		trackedCapitalCents: reserve.split.investmentCents,
		monthlyContributionCents: averageSavedCents,
		// Nulo é "não dá para responder", e é o que vale sem lançamento e sem estimativa:
		// antes esta linha devolvia centavos (nunca nulo) e a tela afirmava zero.
		realizedYield12mCents: yielded.cents,
		realizedYieldBasis: yielded.basis,
		averageCapital12mCents: averageReserveCapitalCents(history, savedCents),
		asOfMonth: todayKey,
		contributionDelayMonths: contributionDelayMonths(reserve),
	});
};

/** A grade de saúde financeira dos Relatórios. */
export const healthOf = ({
	retirement,
	goal,
	averageIncomeCents,
	averageSpendCents,
	cardSummaries,
	selected,
	overview,
	fixedCostBp,
	cardsTotals,
	selectedKey,
	reserve,
	paceSpend,
	today,
}: {
	retirement: RetirementReadModel | null;
	goal: RetirementGoal | null;
	averageIncomeCents: number | null;
	averageSpendCents: number | null;
	cardSummaries: Map<string, CardSummary>;
	selected: MonthPoint | null;
	overview: { cashCents: number; savedCents: number };
	fixedCostBp: number | null;
	cardsTotals: { toPayCents: number; openInvoicesCents: number };
	selectedKey: MonthKey;
	reserve: ReserveReadModel;
	paceSpend: PaceSpend;
	today: string;
}): HealthIndicator[] => {
	let neededSavingsRateBp: number | null = null;
	if (retirement && goal && averageIncomeCents !== null && averageIncomeCents > 0) {
		const needed = contributionForHorizon({
			capitalCents: retirement.capitalCents,
			requiredCapitalCents: retirement.requiredCapitalCents,
			monthlyRate: monthlyRate(goal.expectedYieldBp),
			months: NEEDED_HORIZON_MONTHS,
			// "Reserva primeiro" também aqui: os primeiros meses vão para a reserva, então a
			// fatia da renda que a meta pede é maior do que a conta sem atraso dizia.
			delayMonths: retirement.contributionDelayMonths,
		});
		neededSavingsRateBp = needed === null ? null : Math.round((needed * FULL_BASIS_POINTS) / averageIncomeCents);
	}
	let limitUsagePercent: number | null = null;
	for (const summary of cardSummaries.values()) {
		if (summary.limitUsagePercent !== null) limitUsagePercent = Math.max(limitUsagePercent ?? 0, summary.limitUsagePercent);
	}
	return buildHealthIndicators({
		savingsRateBp: selected?.overview.savingsRateBp ?? null,
		neededSavingsRateBp,
		liquidCents: overview.cashCents + overview.savedCents,
		averageMonthlySpendCents: averageSpendCents,
		fixedCostBp,
		cardOwedCents: cardsTotals.toPayCents + cardsTotals.openInvoicesCents,
		averageMonthlyIncomeCents: averageIncomeCents,
		limitUsagePercent,
		currentSpendCents: paceSpend?.currentCents ?? selected?.overview.totalSpendCents ?? 0,
		elapsedBp: monthElapsedBp(selectedKey, today),
		previousSpendToDate: paceSpend?.previous ?? null,
		reserve:
			reserve.monthlyCostCents === null
				? null
				: { reserveCents: reserve.split.reserveCents, monthlyCostCents: reserve.monthlyCostCents, targetMonths: reserve.targetMonths },
	});
};

/** Todo arquivo sob app/ é rota para o expo-router; o export default só satisfaz essa exigência. */
export default { loadReportsRaw, fullSeriesOf, paceSpendOf, reserveModelOf, retirementModelOf, healthOf };
