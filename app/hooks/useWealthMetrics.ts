import { useEffect, useMemo, useState } from 'react';
import { usePeriod } from '../contexts/PeriodContext';
import { useRecurringTransactions } from '../contexts/RecurringTransactionsContext';
import { useAccounts } from '../contexts/AccountsContext';
import { useTransactions } from '../contexts/TransactionsContext';
import {
	getPeriodSummary,
	getTotalByCategory,
	initDatabase,
	type PeriodSummary,
} from '../database/database';
import { getCurrentYear, getMonthRange } from '../utils/dateUtils';
import {
	buildInsights,
	computeWealthMetrics,
	type Insight,
	type WealthMetrics,
	type WealthSnapshot,
} from '../utils/insights';
import type { CategoryTotal, ExpenseTotalsByNature } from '../utils/metrics';

/**
 * As métricas de riqueza do período selecionado.
 *
 * Selector fino sobre o que os contextos já carregam — `periodTotals`, `balanceCents`,
 * `monthlyData`, `categoryTotals` e as recorrências — em vez de mais estado dentro do
 * `TransactionsContext`. Só o mês anterior é lido do banco aqui, porque nenhum contexto
 * o mantém e ele é o que dá sentido à seta ao lado da taxa de poupança.
 *
 * O cálculo em si mora em `utils/insights.ts` e `utils/metrics.ts`, puros e testados;
 * este arquivo só junta os insumos e memoriza o resultado.
 */

/** O período anterior, quando já foi lido do banco. */
interface PreviousPeriod {
	totals: PeriodSummary;
	categoryTotals: CategoryTotal[];
}

/** Mês anterior ao selecionado, atravessando a virada do ano. */
const previousMonthRange = (month: number, year: number) =>
	month === 1 ? getMonthRange(12, year - 1) : getMonthRange(month - 1, year);

export interface WealthMetricsResult {
	metrics: WealthMetrics;
	insights: Insight[];
	/** Verdadeiro enquanto o mês anterior ainda não chegou: a seta só aparece depois. */
	isComparisonLoading: boolean;
}

export const useWealthMetrics = (): WealthMetricsResult => {
	const { periodTotals, balanceCents, monthlyData, categoryTotals, categories } = useTransactions();
	// Com contas cadastradas, a reserva é o caixa delas (âncoras do banco + movimento),
	// não a soma cega dos lançamentos; sem contas, o saldo do livro continua valendo.
	const { activeAccounts, overview } = useAccounts();
	// O fôlego conta com a reserva: ela fica fora do "Em caixa" porque não paga a fatura do
	// mês, mas é exatamente o dinheiro que sustentaria os custos fixos se a renda parasse.
	const liquidCents = activeAccounts.length > 0 ? overview.cashCents + overview.savedCents : balanceCents;
	const { transactions: recurring } = useRecurringTransactions();
	const { selectedMonth, selectedYear } = usePeriod();

	const [previous, setPrevious] = useState<PreviousPeriod | null>(null);
	const [isComparisonLoading, setIsComparisonLoading] = useState(true);

	// `periodTotals` está nas dependências como gatilho de recarga: ele é substituído a
	// cada `refreshData`, então editar um lançamento também atualiza a comparação.
	useEffect(() => {
		let cancelled = false;
		const { startDate, endDate } = previousMonthRange(selectedMonth, selectedYear);

		const load = async () => {
			setIsComparisonLoading(true);
			try {
				// O card da Home monta junto com os providers, então esta também é uma
				// consulta precoce. `initDatabase` é single-flight: só espera.
				await initDatabase();

				const [totals, totalsByCategory] = await Promise.all([
					getPeriodSummary(startDate, endDate),
					getTotalByCategory(startDate, endDate, 'expense'),
				]);

				if (!cancelled) setPrevious({ totals, categoryTotals: totalsByCategory });
			} catch (error) {
				// Sem o mês anterior o resto das métricas continua válido; só a seta some.
				console.error('Error loading the previous period:', error);
				if (!cancelled) setPrevious(null);
			} finally {
				if (!cancelled) setIsComparisonLoading(false);
			}
		};

		load();

		return () => {
			cancelled = true;
		};
	}, [selectedMonth, selectedYear, periodTotals]);

	/** Despesas do período repartidas pela natureza da categoria que as recebeu. */
	const expenseTotalsByNature = useMemo<ExpenseTotalsByNature>(() => {
		const natureById = new Map(categories.map((category) => [category.id, category.nature]));

		return categoryTotals.expenses.reduce<ExpenseTotalsByNature>(
			(split, total) => {
				// Categoria desconhecida — apagada, por exemplo — conta como supérflua, o
				// mesmo padrão da coluna: uma despesa não classificada não vira necessidade.
				if (natureById.get(total.categoryId) === 'essential') {
					split.essentialCents += total.totalCents;
				} else {
					split.discretionaryCents += total.totalCents;
				}
				return split;
			},
			{ essentialCents: 0, discretionaryCents: 0 }
		);
	}, [categoryTotals.expenses, categories]);

	const categoryNameById = useMemo(
		() => Object.fromEntries(categories.map((category) => [category.id, category.name])),
		[categories]
	);

	const snapshot = useMemo<WealthSnapshot>(
		() => ({
			// `monthlyData` cobre o ano corrente. Com um mês de outro ano selecionado a
			// série continua sendo a deste ano, então a sequência de quedas é lida até
			// dezembro em vez de até um mês que não pertence a ela.
			month: selectedYear === getCurrentYear() ? selectedMonth : 12,
			periodTotals,
			previousPeriodTotals: previous?.totals ?? null,
			liquidCents,
			recurring,
			expenseTotalsByNature,
			categoryTotals: categoryTotals.expenses,
			previousCategoryTotals: previous?.categoryTotals ?? [],
			monthlyIncome: monthlyData.incomes,
			monthlyExpense: monthlyData.expenses,
			categoryNameById,
		}),
		[
			selectedMonth,
			selectedYear,
			periodTotals,
			previous,
			liquidCents,
			recurring,
			expenseTotalsByNature,
			categoryTotals.expenses,
			monthlyData.incomes,
			monthlyData.expenses,
			categoryNameById,
		]
	);

	const metrics = useMemo(() => computeWealthMetrics(snapshot), [snapshot]);
	const insights = useMemo(() => buildInsights(metrics, snapshot), [metrics, snapshot]);

	return { metrics, insights, isComparisonLoading };
};

/**
 * Todo arquivo sob app/ e tratado como rota pelo expo-router, e uma rota sem export
 * default e um modulo quebrado do ponto de vista dele. Este export existe so para
 * satisfazer essa exigencia — nada navega para ca.
 */
export default useWealthMetrics;
