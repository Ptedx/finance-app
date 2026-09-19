import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccounts } from '../contexts/AccountsContext';
import { useBudget } from '../contexts/BudgetContext';
import { useDebts } from '../contexts/DebtsContext';
import { useRecurringTransactions } from '../contexts/RecurringTransactionsContext';
import { usePeriod } from '../contexts/PeriodContext';
import { useTransactions } from '../contexts/TransactionsContext';
import {
	getMonthlyAccountActivity,
	getMonthlyCategoryTotals,
	getMonthlyTransferActivity,
	getTransactionsForAccounts,
	initDatabase,
	type MonthAccountActivityRow,
	type MonthCategoryTotalRow,
	type MonthTransferActivityRow,
} from '../database/database';
import type { CardEntry } from '../utils/cardMath';
import { monthKeyOf, monthsBetweenKeys, shiftMonthKey, todayISO } from '../utils/dateUtils';
import { type DebtsSummary, type DebtVerdict, debtMonthLines, debtStateOn, effectiveRateBp, termsOf, worthPayingOff } from '../utils/debt';
import { buildHealthIndicators, type HealthIndicator } from '../utils/healthScore';
import { buildDebtInsights, buildGoalInsights, type Insight, mergeInsights, type WealthMetrics } from '../utils/insights';
import { FULL_BASIS_POINTS } from '../utils/metrics';
import {
	averageClosedMonths,
	averageReserveCapitalCents,
	type CategoryRankRow,
	type CommittedMonth,
	committedMonths,
	type DuplicateIncome,
	buildMonthSeries,
	findDuplicateIncomes,
	type IncomeComposition,
	incomeComposition,
	type MonthKey,
	type MonthPoint,
	monthElapsedBp,
	monthKeysEnding,
	monthRangeOf,
	rankCategories,
	rankSpendSources,
	realizedYield12mCents,
	type SpendSourceRow,
	toCardEntry,
} from '../utils/reportSeries';
import {
	buildRetirementReadModel,
	contributionForHorizon,
	retirementContributionPlan,
	DEFAULT_EXPECTED_YIELD_BP,
	monthlyRate,
	monthsToReachStepped,
	type ProjectionPoint,
	projectCapitalStepped,
	type RetirementGoal,
	type RetirementReadModel,
} from '../utils/retirement';
import {
	buildReserveReadModel,
	contributionDelayMonths,
	essentialMonthlyCostCents,
	essentialShareBp,
	type ReserveReadModel,
	resolveMonthlyCost,
} from '../utils/emergencyReserve';
import { buildPriorities, type PriorityItem } from '../utils/priorities';
import { useReserveGoal } from './useReserveGoal';
import { useWealthMetrics } from './useWealthMetrics';

/**
 * Tudo o que a tela de Relatórios mostra, calculado de uma vez.
 *
 * Molde de `useWealthMetrics`: lê o que os contextos já têm, faz poucas consultas
 * agregadas (uma por tabela, para 13 meses) e deixa o resto para `useMemo` sobre módulos
 * puros. Trocar o recorte de 3/6/12 meses ou editar a meta não volta ao banco.
 *
 * As consultas recarregam quando o mês selecionado muda ou quando o `AccountsContext`
 * termina uma recarga (ele já reage a cada mudança no livro e entrega um `cardSummaries`
 * novo) — assim os relatórios só recalculam depois que as contas estão consistentes.
 */

export type TrendRange = 3 | 6 | 12;

export const TREND_RANGES: TrendRange[] = [3, 6, 12];

/** 12 meses de tendência mais um anterior, para a variação de categoria do primeiro. */
const HISTORY_MONTHS = 13;

/** O aporte médio olha meio ano: um mês bom ou ruim não muda a data de chegada. */
const CONTRIBUTION_WINDOW_MONTHS = 6;

/** Renda e gasto médios olham o trimestre fechado. */
const AVERAGE_WINDOW_MONTHS = 3;

/** "Quanto da renda a meta pede" é calculado para chegar em 20 anos. */
const NEEDED_HORIZON_MONTHS = 20 * 12;

interface ReportsRaw {
	months: MonthKey[];
	activity: MonthAccountActivityRow[];
	transfers: MonthTransferActivityRow[];
	categoryRows: MonthCategoryTotalRow[];
	cardEntries: Map<string, CardEntry[]>;
}

/** Uma dívida na seção dos Relatórios. */
export interface DebtReportItem {
	id: string;
	name: string;
	balanceCents: number;
	installmentCents: number;
	payoffDate: string | null;
	rateBp: number;
	verdict: DebtVerdict;
}

/**
 * O cenário "quitei e a parcela virou aporte": a projeção com o aporte subindo no mês
 * seguinte a cada quitação. É cenário, não promessa — a linha principal segue o aporte real.
 */
export interface DebtScenario {
	projection: ProjectionPoint[];
	/** Meses até a meta nesse cenário; nulo se nem assim chega. */
	months: number | null;
	/** `YYYY-MM` de chegada nesse cenário. */
	month: string | null;
	/** Quantos meses antes do ritmo de hoje; nulo sem comparação. */
	monthsEarlier: number | null;
}

export interface ReportsData {
	/** Os últimos `range` meses, o selecionado por último. */
	series: MonthPoint[];
	selected: MonthPoint | null;
	health: HealthIndicator[];
	/** Nulo sem meta definida. */
	retirement: RetirementReadModel | null;
	categories: CategoryRankRow[];
	sources: SpendSourceRow[];
	committed: CommittedMonth[];
	insights: Insight[];
	metrics: WealthMetrics;
	/** A renda do mês selecionado como a tela conta: entradas, repasses e o líquido. */
	income: IncomeComposition;
	duplicates: DuplicateIncome[];
	debts: { summary: DebtsSummary; items: DebtReportItem[] };
	/** Nulo sem meta ou sem dívida que quite. */
	debtScenario: DebtScenario | null;
	/** A reserva de emergência: custo essencial, meta, a cascata e quanto falta. */
	reserve: ReserveReadModel;
	/** O custo essencial que o app calcula (sem o valor à mão), para a folha da reserva. */
	reserveComputedCostCents: number | null;
	/** "Por onde começar": reserva mínima → dívida cara → reserva cheia → aposentadoria. */
	priorities: PriorityItem[];
	/** Verdadeiro até a primeira leva de dados desta combinação de mês e contas chegar. */
	isLoading: boolean;
	refresh: () => Promise<void>;
}

export const useReportsData = (range: TrendRange, goal: RetirementGoal | null): ReportsData => {
	const { selectedMonth, selectedYear } = usePeriod();
	const { accounts, balances, overview, cardSummaries, cardsTotals, debitCards, creditCards, isLoading: accountsLoading, refresh: refreshAccounts } = useAccounts();
	const { currentBudgetCents } = useBudget();
	const { goal: reserveGoal } = useReserveGoal();
	const { categories, currentPeriodTransactions, refreshData } = useTransactions();
	const { metrics, insights: wealthInsights } = useWealthMetrics();
	const { activeDebts, summary: debtsSummary } = useDebts();
	const { transactions: recurring } = useRecurringTransactions();

	const selectedKey = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}`;
	const todayKey = monthKeyOf(todayISO());

	const [raw, setRaw] = useState<ReportsRaw | null>(null);

	// `cardSummaries` está nas dependências como gatilho: é um Map novo a cada recarga do
	// AccountsContext, que por sua vez roda a cada mudança no livro.
	useEffect(() => {
		let cancelled = false;
		const months = monthKeysEnding(selectedKey, HISTORY_MONTHS);
		const { startDate, endDate } = monthRangeOf(months);
		const cardIds = accounts.filter((account) => account.kind === 'credit_card' && !account.deletedAt).map((account) => account.id);

		const load = async () => {
			try {
				await initDatabase();
				const [activity, transfers, categoryRows, cardTransactions] = await Promise.all([
					getMonthlyAccountActivity(startDate, endDate),
					getMonthlyTransferActivity(startDate, endDate),
					getMonthlyCategoryTotals(startDate, endDate, 'expense'),
					getTransactionsForAccounts(cardIds),
				]);
				if (cancelled) return;

				const cardEntries = new Map<string, CardEntry[]>();
				for (const transaction of cardTransactions) {
					if (!transaction.accountId) continue;
					const list = cardEntries.get(transaction.accountId) ?? [];
					list.push(toCardEntry(transaction));
					cardEntries.set(transaction.accountId, list);
				}
				setRaw({ months, activity, transfers, categoryRows, cardEntries });
			} catch (error) {
				console.error('Error loading the reports history:', error);
			}
		};

		void load();
		return () => {
			cancelled = true;
		};
	}, [selectedKey, accounts, cardSummaries]);

	const liveAccounts = useMemo(() => accounts.filter((account) => !account.deletedAt), [accounts]);

	const fullSeries = useMemo<MonthPoint[]>(
		() => (raw ? buildMonthSeries({ months: raw.months, accounts: liveAccounts, activity: raw.activity, transfers: raw.transfers, cardEntries: raw.cardEntries, currentMonth: todayKey }) : []),
		[raw, liveAccounts, todayKey]
	);

	const series = useMemo(() => fullSeries.slice(-range), [fullSeries, range]);
	const selected = fullSeries.length > 0 ? fullSeries[fullSeries.length - 1] : null;

	const averageSpendCents = useMemo(() => averageClosedMonths(fullSeries, (o) => o.totalSpendCents, AVERAGE_WINDOW_MONTHS), [fullSeries]);
	const averageIncomeCents = useMemo(() => averageClosedMonths(fullSeries, (o) => o.incomeCents, AVERAGE_WINDOW_MONTHS), [fullSeries]);
	const averageSavedCents = useMemo(() => averageClosedMonths(fullSeries, (o) => o.savedCents, CONTRIBUTION_WINDOW_MONTHS) ?? 0, [fullSeries]);

	// Reserva de emergência. O custo essencial sai dos meses fechados; sem nenhum, do
	// orçamento do mês; o valor à mão vence os dois.
	const natureById = useMemo(() => new Map(categories.map((category) => [category.id, category.nature])), [categories]);
	const computedCost = useMemo(() => {
		const rows = raw?.categoryRows ?? [];
		return resolveMonthlyCost({
			customCents: null,
			historyCents: essentialMonthlyCostCents(fullSeries, rows, natureById),
			budgetCents: currentBudgetCents,
			currentShareBp: essentialShareBp(
				rows.filter((row) => row.month === todayKey),
				natureById
			),
		});
	}, [raw, fullSeries, natureById, currentBudgetCents, todayKey]);

	const reserve = useMemo<ReserveReadModel>(() => {
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
	}, [reserveGoal, computedCost, liveAccounts, balances, averageSavedCents, goal]);

	const retirement = useMemo<RetirementReadModel | null>(() => {
		if (!goal) return null;
		// O rendimento observado anda para trás a partir do saldo de hoje, então só faz
		// sentido quando a série termina no mês de hoje.
		const history = selectedKey === todayKey ? fullSeries.slice(-12) : [];
		return buildRetirementReadModel({
			goal,
			// A cascata: só o que passa da reserva de emergência é capital da meta, e o aporte
			// vem para a meta depois que a reserva enche.
			trackedCapitalCents: reserve.split.investmentCents,
			monthlyContributionCents: averageSavedCents,
			realizedYield12mCents: history.length > 0 ? realizedYield12mCents(history) : null,
			averageCapital12mCents: averageReserveCapitalCents(history, overview.savedCents),
			asOfMonth: todayKey,
			contributionDelayMonths: contributionDelayMonths(reserve),
		});
	}, [goal, fullSeries, overview.savedCents, averageSavedCents, todayKey, selectedKey, reserve]);

	const health = useMemo<HealthIndicator[]>(() => {
		let neededSavingsRateBp: number | null = null;
		if (retirement && goal && averageIncomeCents !== null && averageIncomeCents > 0) {
			const needed = contributionForHorizon({
				capitalCents: retirement.capitalCents,
				requiredCapitalCents: retirement.requiredCapitalCents,
				monthlyRate: monthlyRate(goal.expectedYieldBp),
				months: NEEDED_HORIZON_MONTHS,
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
			fixedCostBp: metrics.fixedCostBasisPoints,
			cardOwedCents: cardsTotals.toPayCents + cardsTotals.openInvoicesCents,
			averageMonthlyIncomeCents: averageIncomeCents,
			limitUsagePercent,
			currentSpendCents: selected?.overview.totalSpendCents ?? 0,
			elapsedBp: monthElapsedBp(selectedKey, todayISO()),
			reserve:
				reserve.monthlyCostCents === null
					? null
					: { reserveCents: reserve.split.reserveCents, monthlyCostCents: reserve.monthlyCostCents, targetMonths: reserve.targetMonths },
		});
	}, [retirement, goal, averageIncomeCents, averageSpendCents, cardSummaries, selected, overview, metrics.fixedCostBasisPoints, cardsTotals, selectedKey, reserve]);

	const rankedCategories = useMemo(() => {
		if (!raw) return [];
		const previousKey = shiftMonthKey(selectedKey, -1);
		return rankCategories(
			raw.categoryRows.filter((row) => row.month === selectedKey),
			raw.categoryRows.filter((row) => row.month === previousKey),
			categories
		);
	}, [raw, selectedKey, categories]);

	const sources = useMemo(
		() =>
			selected && raw
				? rankSpendSources(
						selected,
						liveAccounts,
						debitCards.map((card) => ({ accountId: card.account.id, last4: card.last4, name: card.name, periodSpentCents: card.periodSpentCents })),
						raw.activity
					)
				: [],
		[selected, raw, liveAccounts, debitCards]
	);

	const debtInputs = useMemo(() => activeDebts.map((debt) => ({ id: debt.id, name: debt.name, terms: termsOf(debt) })), [activeDebts]);

	const committed = useMemo(() => {
		const months = [1, 2, 3].map((offset) => shiftMonthKey(todayKey, offset));
		return committedMonths(
			creditCards.flatMap((card) => {
				const summary = cardSummaries.get(card.id);
				return summary ? [{ id: card.id, name: card.name, summary }] : [];
			}),
			metrics.monthlyFixedCents,
			todayKey,
			3,
			debtMonthLines(debtInputs, months, todayISO(), recurring)
		);
	}, [creditCards, cardSummaries, metrics.monthlyFixedCents, todayKey, debtInputs, recurring]);

	// O rendimento contra o qual a dívida é comparada: o da meta, ou 10% ao ano sem meta.
	const investmentYieldBp = goal?.expectedYieldBp ?? DEFAULT_EXPECTED_YIELD_BP;

	const debtItems = useMemo<DebtReportItem[]>(
		() =>
			activeDebts.map((debt) => {
				const state = debtStateOn(termsOf(debt), todayISO());
				return {
					id: debt.id,
					name: debt.name,
					balanceCents: state.balanceCents,
					installmentCents: state.next?.installmentCents ?? debt.installmentCents,
					payoffDate: state.payoffDate,
					rateBp: debt.rateBp,
					verdict: worthPayingOff({ debtRateBp: effectiveRateBp(termsOf(debt), todayISO()), investmentYieldBp }).verdict,
				};
			}),
		[activeDebts, investmentYieldBp]
	);

	const debtScenario = useMemo<DebtScenario | null>(() => {
		if (!retirement || !goal || debtsSummary.releases.length === 0) return null;
		// O aporte de base segue a regra da reserva primeiro; cada quitação soma a parcela.
		const plan = retirementContributionPlan(retirement.monthlyContributionCents, retirement.contributionDelayMonths);
		const steps = [
			...plan.steps,
			...debtsSummary.releases.map((release) => ({ fromMonth: Math.max(1, monthsBetweenKeys(todayKey, release.fromMonth)), addCents: release.cents })),
		];
		const input = { capitalCents: retirement.capitalCents, contributionCents: plan.contributionCents, monthlyRate: monthlyRate(goal.expectedYieldBp), steps };
		const months = monthsToReachStepped({ ...input, requiredCapitalCents: retirement.requiredCapitalCents });
		const baseMonths = retirement.reach.kind === 'eta' ? retirement.reach.months : null;
		const horizon = retirement.projection[retirement.projection.length - 1]?.monthOffset ?? 0;
		return {
			projection: horizon > 0 ? projectCapitalStepped({ ...input, months: horizon }) : [],
			months,
			month: months === null ? null : shiftMonthKey(todayKey, months),
			monthsEarlier: months !== null && baseMonths !== null ? baseMonths - months : null,
		};
	}, [retirement, goal, debtsSummary.releases, todayKey]);

	const passThroughIds = useMemo(() => new Set(categories.filter((category) => category.nature === 'passthrough').map((category) => category.id)), [categories]);
	const income = useMemo(() => incomeComposition(currentPeriodTransactions, passThroughIds), [currentPeriodTransactions, passThroughIds]);
	const duplicates = useMemo(() => findDuplicateIncomes(currentPeriodTransactions), [currentPeriodTransactions]);

	const debtInsights = useMemo(
		() =>
			buildDebtInsights(
				activeDebts.map((debt) => {
					const costBp = effectiveRateBp(termsOf(debt), todayISO());
					return { id: debt.id, name: debt.name, rateBp: costBp, ...worthPayingOff({ debtRateBp: costBp, investmentYieldBp }) };
				})
			),
		[activeDebts, investmentYieldBp]
	);

	const insights = useMemo(
		() => mergeInsights(buildGoalInsights(retirement, health, duplicates), debtInsights, wealthInsights),
		[retirement, health, duplicates, debtInsights, wealthInsights]
	);

	const priorities = useMemo(
		() =>
			buildPriorities({
				reserve,
				hasDebts: debtItems.length > 0,
				expensiveDebtCents: debtItems.filter((item) => item.verdict === 'pay').reduce((sum, item) => sum + item.balanceCents, 0),
				retirement: retirement ? { capitalCents: retirement.capitalCents, requiredCapitalCents: retirement.requiredCapitalCents } : null,
			}),
		[reserve, debtItems, retirement]
	);

	const refresh = useCallback(async () => {
		await Promise.all([refreshData(), refreshAccounts()]);
	}, [refreshData, refreshAccounts]);

	return {
		series,
		selected,
		health,
		retirement,
		categories: rankedCategories,
		sources,
		committed,
		insights,
		metrics,
		income,
		duplicates,
		debts: { summary: debtsSummary, items: debtItems },
		debtScenario,
		reserve,
		reserveComputedCostCents: computedCost?.cents ?? null,
		priorities,
		isLoading: accountsLoading || raw === null,
		refresh,
	};
};

/**
 * Todo arquivo sob app/ é tratado como rota pelo expo-router, e uma rota sem export
 * default é um módulo quebrado do ponto de vista dele. Este export existe só para
 * satisfazer essa exigência — nada navega para cá.
 */
export default useReportsData;
