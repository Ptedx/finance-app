import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAccounts } from '../contexts/AccountsContext';
import { useBills } from '../contexts/BillsContext';
import { useBudget } from '../contexts/BudgetContext';
import { useDebts } from '../contexts/DebtsContext';
import { usePeriod } from '../contexts/PeriodContext';
import { useTransactions } from '../contexts/TransactionsContext';
import { initDatabase } from '../database/database';
import { monthKeyOf, monthsBetweenKeys, shiftMonthKey, todayISO } from '../utils/dateUtils';
import {
	comparisonYield,
	type DebtsSummary,
	type DebtVerdict,
	debtMonthLines,
	debtStateOn,
	effectiveRateBp,
	termsOf,
	worthPayingOff,
} from '../utils/debt';
import type { HealthIndicator } from '../utils/healthScore';
import {
	buildCategoryJumpInsights,
	buildDebtInsights,
	buildFixedCostInsights,
	buildGoalInsights,
	buildSavingsRateInsights,
	CATEGORY_INSIGHT_IDS,
	FIXED_COST_INSIGHT_IDS,
	type Insight,
	mergeInsights,
	SAVINGS_RATE_INSIGHT_IDS,
	type WealthMetrics,
} from '../utils/insights';
import { categoryDeltas, fixedCostShare, monthlyBillsCents } from '../utils/metrics';
import {
	type CategoryRankRow,
	type CommittedMonth,
	committedMonths,
	type DuplicateIncome,
	buildMonthSeries,
	cardChargesCategory,
	externalIncomeTransfers,
	findDuplicateIncomes,
	findRecurringDoubleCharges,
	type IncomeComposition,
	type MonthKey,
	type MonthPoint,
	monthIncomeComposition,
	rankCategories,
	rankSpendSources,
	savingsRateDropsEnding,
	separateCardBookkeeping,
	type SpendSourceRow,
	withProvisionalActivity,
} from '../utils/reportSeries';
import { type ProvisionalPart, provisionalPart } from '../utils/monthOverview';
import {
	retirementContributionPlan,
	monthlyRate,
	monthsToReachStepped,
	type ProjectionPoint,
	projectCapitalStepped,
	type RetirementGoal,
	type RetirementReadModel,
} from '../utils/retirement';
import type { ReserveReadModel } from '../utils/emergencyReserve';
import { buildPriorities, type PriorityItem } from '../utils/priorities';
import {
	averageIncomeOf,
	averageSavedOf,
	averageSpendOf,
	computedReserveCostOf,
	estimatedYield12mOf,
	fullSeriesOf,
	healthOf,
	loadReportsRaw,
	paceSpendOf,
	type ReportsRaw,
	reserveModelOf,
	retirementModelOf,
} from '../utils/reportsModel';
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

/**
 * Em que mês a série termina.
 *
 * `selected` é o mês do seletor, que é o que a tela de Relatórios responde ("como foi
 * setembro?"). `today` é para quem fala do presente: o Patrimônio mistura médias com os
 * saldos de **hoje** (a cascata da reserva, o capital, o saldo das dívidas), e seguir o mês
 * escolhido em outra tela mudava a meta da reserva, o "em quantos meses enche" e a data da
 * aposentadoria sem que nada tivesse mudado no dinheiro — selecionar dezembro bastava.
 */
export type ReportsAnchor = 'selected' | 'today';

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
	/** Quanto da receita e do "Gastou" do mês selecionado vem de compras ainda a revisar. */
	provisional: ProvisionalPart;
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

export const useReportsData = (range: TrendRange, goal: RetirementGoal | null, anchor: ReportsAnchor = 'selected'): ReportsData => {
	const { t } = useTranslation();
	const { selectedMonth, selectedYear } = usePeriod();
	const { accounts, balances, overview, cardSummaries, cardsTotals, debitCards, creditCards, accruedYield12m, cdi, isLoading: accountsLoading, refresh: refreshAccounts } = useAccounts();
	const { currentBudgetCents } = useBudget();
	const { goal: reserveGoal } = useReserveGoal();
	const { categories, currentPeriodTransactions, refreshData } = useTransactions();
	const { metrics, insights: wealthInsights } = useWealthMetrics();
	const { activeDebts, summary: debtsSummary } = useDebts();
	const { bills } = useBills();

	const todayKey = monthKeyOf(todayISO());
	// Ancorado em hoje, o mês escolhido na Home não mexe aqui (ver `ReportsAnchor`).
	const selectedKey = anchor === 'today' ? todayKey : `${selectedYear}-${String(selectedMonth).padStart(2, '0')}`;

	const [raw, setRaw] = useState<ReportsRaw | null>(null);

	// `cardSummaries` está nas dependências como gatilho: é um Map novo a cada recarga do
	// AccountsContext, que por sua vez roda a cada mudança no livro. A carga mora em
	// `utils/reportsModel.ts` (SPD-163b): o Mirai lê dela os mesmos números.
	useEffect(() => {
		let cancelled = false;

		const load = async () => {
			try {
				await initDatabase();
				const next = await loadReportsRaw(selectedKey, accounts, todayISO());
				if (cancelled) return;
				setRaw(next);
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

	// As compras ainda na caixa de entrada entram como na Home: nas linhas de cada conta e
	// nas faturas. Sem isto o "Gastou" daqui ficava abaixo do da Home pelo que está a revisar.
	const merged = useMemo(() => (raw ? withProvisionalActivity(raw.activity, raw.cardEntries, raw.provisional, raw.months) : null), [raw]);
	const fullSeries = useMemo<MonthPoint[]>(() => (raw && merged ? fullSeriesOf(raw, merged, liveAccounts, todayKey) : []), [raw, merged, liveAccounts, todayKey]);

	const series = useMemo(() => fullSeries.slice(-range), [fullSeries, range]);
	const selected = fullSeries.length > 0 ? fullSeries[fullSeries.length - 1] : null;

	// A parte "a revisar" do mês selecionado: o mesmo mês só com o livro, e a diferença.
	const provisional = useMemo<ProvisionalPart>(() => {
		if (!raw || !selected || raw.provisional.size === 0) return { incomeCents: 0, spendCents: 0 };
		const [ledgerOnly] = buildMonthSeries({
			months: [selected.month],
			accounts: liveAccounts,
			activity: raw.activity,
			transfers: raw.transfers,
			cardEntries: raw.cardEntries,
			transferLines: raw.transferLines,
			investmentIncome: raw.investmentIncome,
			currentMonth: todayKey,
		});
		return provisionalPart(selected.overview, ledgerOnly.overview);
	}, [raw, selected, liveAccounts, todayKey]);

	// O ritmo de gastos: o mês até hoje contra os anteriores até o mesmo dia (SPD-034).
	const paceSpend = useMemo(() => (raw ? paceSpendOf(raw, liveAccounts, todayKey) : null), [raw, liveAccounts, todayKey]);

	const averageSpendCents = useMemo(() => averageSpendOf(fullSeries), [fullSeries]);
	const averageIncomeCents = useMemo(() => averageIncomeOf(fullSeries), [fullSeries]);
	const averageSavedCents = useMemo(() => averageSavedOf(fullSeries), [fullSeries]);

	// As categorias sem o ajuste com a fatura do banco e com os encargos do cartão numa linha
	// própria (SPD-092): o ajuste não é gasto de categoria nenhuma, e o encargo diluído em
	// "Other Expense" ninguém via. O ranking, a categoria que saltou e o custo da reserva leem daqui.
	const spendCategoryRows = useMemo(() => (raw ? separateCardBookkeeping(raw.categoryRows, raw.cardEntries.values()) : []), [raw]);

	// Reserva de emergência. O custo essencial sai dos meses fechados; sem nenhum, do
	// orçamento do mês; o valor à mão vence os dois.
	const natureById = useMemo(() => new Map(categories.map((category) => [category.id, category.nature])), [categories]);
	const computedCost = useMemo(
		() => computedReserveCostOf(spendCategoryRows, fullSeries, natureById, currentBudgetCents, todayKey),
		[spendCategoryRows, fullSeries, natureById, currentBudgetCents, todayKey]
	);

	const reserve = useMemo<ReserveReadModel>(
		() => reserveModelOf({ reserveGoal, computedCost, liveAccounts, balances, averageSavedCents, goal }),
		[reserveGoal, computedCost, liveAccounts, balances, averageSavedCents, goal]
	);

	/**
	 * O rendimento que o app **estimou** para as contas de reserva nos últimos 12 meses
	 * (`estimatedYield12mOf`): entra no "rendeu nos últimos 12 meses" ao lado do lançado.
	 */
	const estimatedYield12mCents = useMemo(() => estimatedYield12mOf(liveAccounts, accruedYield12m), [liveAccounts, accruedYield12m]);

	const retirement = useMemo<RetirementReadModel | null>(
		() =>
			retirementModelOf({
				goal,
				fullSeries,
				savedCents: overview.savedCents,
				averageSavedCents,
				todayKey,
				selectedKey,
				reserve,
				estimatedYield12mCents,
			}),
		[goal, fullSeries, overview.savedCents, averageSavedCents, todayKey, selectedKey, reserve, estimatedYield12mCents]
	);

	// A fatia de custo fixo também sai do quadro do mês: a receita crua do período não vê o
	// que a PJ transferiu para a principal, e o indicador acusava "custo fixo acima de 50% da
	// renda" num mês de R$ 12.000 de pró-labore. Um número só, lido pela grade de saúde e pelo
	// insight "fixed-cost-heavy" — antes o insight dizia 300% onde a grade dizia 23%.
	//
	// O custo fixo em si é o de `useWealthMetrics`: as contas a pagar e as parcelas das dívidas
	// (`monthlyFixedCommitmentsCents`). A tela de recorrências saiu (SPD-079), o que vence todo
	// mês mora nas contas a pagar, e as regras antigas não entram mais (SPD-122).
	const monthlyFixedCents = metrics.monthlyFixedCents;
	const fixedCostBp = fixedCostShare({ monthlyFixedCents, incomeCents: selected ? selected.overview.incomeCents : metrics.savingsRate.incomeCents });

	const health = useMemo<HealthIndicator[]>(
		() =>
			healthOf({
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
				today: todayISO(),
			}),
		[retirement, goal, averageIncomeCents, averageSpendCents, cardSummaries, selected, overview, fixedCostBp, cardsTotals, selectedKey, reserve, paceSpend]
	);

	const rankingCategories = useMemo(() => [...categories, cardChargesCategory(t('cards.charges.reportLine'))], [categories, t]);

	const rankedCategories = useMemo(() => {
		if (!raw) return [];
		const previousKey = shiftMonthKey(selectedKey, -1);
		return rankCategories(
			spendCategoryRows.filter((row) => row.month === selectedKey),
			spendCategoryRows.filter((row) => row.month === previousKey),
			rankingCategories
		);
	}, [raw, spendCategoryRows, selectedKey, rankingCategories]);

	// A categoria que saltou na mesma base do ranking. A de `useWealthMetrics` sai dos totais
	// crus do período, que contam o ajuste como gasto.
	const categoryInsights = useMemo(() => {
		const previousKey = shiftMonthKey(selectedKey, -1);
		const spendOf = (month: MonthKey) =>
			spendCategoryRows
				.filter((row) => row.month === month && natureById.get(row.categoryId) !== 'passthrough')
				.map((row) => ({ categoryId: row.categoryId, totalCents: row.totalCents }));
		const nameById = Object.fromEntries(rankingCategories.map((category) => [category.id, category.name]));
		return buildCategoryJumpInsights(categoryDeltas(spendOf(selectedKey), spendOf(previousKey)), nameById);
	}, [spendCategoryRows, selectedKey, natureById, rankingCategories]);

	const sources = useMemo(
		() =>
			selected && merged
				? rankSpendSources(
						selected,
						liveAccounts,
						debitCards.map((card) => ({ accountId: card.account.id, last4: card.last4, name: card.name, periodSpentCents: card.periodSpentCents })),
						// Com as provisórias, como o quadro: as origens somam o mesmo "Gastou".
						merged.activity
					)
				: [],
		[selected, merged, liveAccounts, debitCards]
	);

	/**
	 * As dívidas que ainda estão sendo pagas: a quitada no prazo sai daqui.
	 *
	 * Só a amortização confirmada arquiva a dívida, então quem terminou as 48 parcelas no
	 * prazo continuava na lista com a parcela da âncora, o chip "Amortize" e uma frase
	 * recomendando antecipar uma dívida que não existe mais. Nada é apagado nem arquivado:
	 * a dívida segue cadastrada e visível no Patrimônio como quitada.
	 */
	const payingDebts = useMemo(() => activeDebts.filter((debt) => !debtStateOn(termsOf(debt), todayISO()).settled), [activeDebts]);

	const debtInputs = useMemo(() => payingDebts.map((debt) => ({ id: debt.id, name: debt.name, terms: termsOf(debt) })), [payingDebts]);

	const committed = useMemo(() => {
		const months = [1, 2, 3].map((offset) => shiftMonthKey(todayKey, offset));
		return committedMonths(
			creditCards.flatMap((card) => {
				const summary = cardSummaries.get(card.id);
				return summary ? [{ id: card.id, name: card.name, summary }] : [];
			}),
			// Os fixos sem as parcelas: elas vêm linha a linha logo abaixo. Sem as regras antigas
			// (SPD-122), nenhuma parcela fica "já no custo fixo": a lista das regras vai vazia.
			monthlyBillsCents(bills),
			todayKey,
			3,
			debtMonthLines(debtInputs, months, todayISO(), [])
		);
	}, [creditCards, cardSummaries, bills, todayKey, debtInputs]);

	// O rendimento contra o qual a dívida é comparada: o da meta; sem meta, o CDI em uso; sem
	// CDI, 10% ao ano — o mesmo da tela da dívida.
	const investmentYieldBp = comparisonYield({ goalYieldBp: goal?.expectedYieldBp, cdiAnnualBp: cdi?.annualBp }).yieldBp;

	const debtItems = useMemo<DebtReportItem[]>(
		() =>
			payingDebts.map((debt) => {
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
		[payingDebts, investmentYieldBp]
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
	// A "renda considerada" do herói é a receita do quadro do mês: somar todo `isIncome` do
	// período punha na renda o estorno do cartão, o rendimento da reserva e a devolução no
	// envelope (R$ 5.280 contra R$ 5.000 do quadro).
	const income = useMemo(
		() =>
			monthIncomeComposition(
				selected?.overview ?? null,
				currentPeriodTransactions,
				liveAccounts,
				passThroughIds,
				externalIncomeTransfers(raw?.transferLines ?? [], liveAccounts).filter((transfer) => transfer.month === selectedKey)
			),
		[selected, currentPeriodTransactions, passThroughIds, raw, liveAccounts, selectedKey]
	);
	const duplicates = useMemo(() => findDuplicateIncomes(currentPeriodTransactions), [currentPeriodTransactions]);
	// A assinatura cadastrada como recorrente e cobrada no cartão entra duas vezes: a
	// recorrente lança no dia combinado e a notificação lança a compra na fatura.
	const doubleCharges = useMemo(() => findRecurringDoubleCharges(currentPeriodTransactions), [currentPeriodTransactions]);

	const debtInsights = useMemo(
		() =>
			buildDebtInsights(
				payingDebts.map((debt) => {
					const costBp = effectiveRateBp(termsOf(debt), todayISO());
					return { id: debt.id, name: debt.name, rateBp: costBp, ...worthPayingOff({ debtRateBp: costBp, investmentYieldBp }) };
				})
			),
		[payingDebts, investmentYieldBp]
	);

	// Uma base só para a taxa de poupança nesta tela: a do quadro do mês, a mesma que a grade
	// de saúde usa. Os insights de `useWealthMetrics` saem da soma crua do período (fatura
	// paga em vez de fatura que fecha, envelope pelo que foi gasto lá dentro, reserva
	// contada), e a tela se contradizia num mesmo scroll — "taxa de poupança 4%" na grade e
	// "54% da sua renda virou poupança" no insight logo abaixo. O de custo fixo também é
	// trocado (abaixo, `fixedCostInsights`), e o da categoria que saltou (`categoryInsights`,
	// SPD-092 — o de lá conta o ajuste de fatura como gasto); os outros insights de riqueza
	// (fôlego, 50/30/20) continuam vindo de lá.
	const savingsRateInsights = useMemo(() => {
		if (!selected) return [];
		const { incomeCents, leftoverCents, savingsRateBp } = selected.overview;
		return buildSavingsRateInsights(
			{ incomeCents, netCents: leftoverCents, basisPoints: savingsRateBp },
			savingsRateDropsEnding(fullSeries)
		);
	}, [selected, fullSeries]);

	// O custo fixo na mesma base da grade de saúde (`fixedCostBp`, receita do quadro do mês).
	const fixedCostInsights = useMemo(
		() => buildFixedCostInsights({ monthlyFixedCents, basisPoints: fixedCostBp }),
		[monthlyFixedCents, fixedCostBp]
	);

	const insights = useMemo(
		() =>
			mergeInsights(
				buildGoalInsights(retirement, health, duplicates, doubleCharges),
				debtInsights,
				savingsRateInsights,
				fixedCostInsights,
				wealthInsights.filter(
					(insight) =>
						!SAVINGS_RATE_INSIGHT_IDS.includes(insight.id) && !FIXED_COST_INSIGHT_IDS.includes(insight.id) && !CATEGORY_INSIGHT_IDS.includes(insight.id)
				),
				categoryInsights
			),
		[retirement, health, duplicates, debtInsights, savingsRateInsights, fixedCostInsights, wealthInsights, categoryInsights]
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
		provisional,
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
