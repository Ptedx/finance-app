import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccounts } from '../contexts/AccountsContext';
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
import { monthKeyOf, shiftMonthKey, todayISO } from '../utils/dateUtils';
import { buildHealthIndicators, type HealthIndicator } from '../utils/healthScore';
import { buildGoalInsights, type Insight, mergeInsights, type WealthMetrics } from '../utils/insights';
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
import { buildRetirementReadModel, contributionForHorizon, monthlyRate, type RetirementGoal, type RetirementReadModel } from '../utils/retirement';
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
	/** Verdadeiro até a primeira leva de dados desta combinação de mês e contas chegar. */
	isLoading: boolean;
	refresh: () => Promise<void>;
}

export const useReportsData = (range: TrendRange, goal: RetirementGoal | null): ReportsData => {
	const { selectedMonth, selectedYear } = usePeriod();
	const { accounts, overview, cardSummaries, cardsTotals, debitCards, creditCards, isLoading: accountsLoading, refresh: refreshAccounts } = useAccounts();
	const { categories, currentPeriodTransactions, refreshData } = useTransactions();
	const { metrics, insights: wealthInsights } = useWealthMetrics();

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

	const retirement = useMemo<RetirementReadModel | null>(() => {
		if (!goal) return null;
		// O rendimento observado anda para trás a partir do saldo de hoje, então só faz
		// sentido quando a série termina no mês de hoje.
		const history = selectedKey === todayKey ? fullSeries.slice(-12) : [];
		return buildRetirementReadModel({
			goal,
			trackedCapitalCents: overview.savedCents,
			monthlyContributionCents: averageSavedCents,
			realizedYield12mCents: history.length > 0 ? realizedYield12mCents(history) : null,
			averageCapital12mCents: averageReserveCapitalCents(history, overview.savedCents),
			asOfMonth: todayKey,
		});
	}, [goal, fullSeries, overview.savedCents, averageSavedCents, todayKey, selectedKey]);

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
		});
	}, [retirement, goal, averageIncomeCents, averageSpendCents, cardSummaries, selected, overview, metrics.fixedCostBasisPoints, cardsTotals, selectedKey]);

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

	const committed = useMemo(
		() =>
			committedMonths(
				creditCards.flatMap((card) => {
					const summary = cardSummaries.get(card.id);
					return summary ? [{ id: card.id, name: card.name, summary }] : [];
				}),
				metrics.monthlyFixedCents,
				todayKey
			),
		[creditCards, cardSummaries, metrics.monthlyFixedCents, todayKey]
	);

	const passThroughIds = useMemo(() => new Set(categories.filter((category) => category.nature === 'passthrough').map((category) => category.id)), [categories]);
	const income = useMemo(() => incomeComposition(currentPeriodTransactions, passThroughIds), [currentPeriodTransactions, passThroughIds]);
	const duplicates = useMemo(() => findDuplicateIncomes(currentPeriodTransactions), [currentPeriodTransactions]);

	const insights = useMemo(() => mergeInsights(buildGoalInsights(retirement, health, duplicates), wealthInsights), [retirement, health, duplicates, wealthInsights]);

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
