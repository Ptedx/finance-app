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
	getTransfersByDateRange,
	initDatabase,
	type MonthAccountActivityRow,
	type MonthCategoryTotalRow,
	type MonthTransferActivityRow,
} from '../database/database';
import { getPendingCaptures } from '../database/captures';
import type { Transfer } from '../database/schema';
import { provisionalEntriesByAccount } from '../utils/accountMath';
import type { CardEntry } from '../utils/cardMath';
import { monthKeyOf, monthsBetweenKeys, shiftMonthKey, todayISO } from '../utils/dateUtils';
import { type DebtsSummary, type DebtVerdict, debtMonthLines, debtStateOn, effectiveRateBp, termsOf, worthPayingOff } from '../utils/debt';
import { buildHealthIndicators, type HealthIndicator, type PaceWindow, spendingPaceWindows } from '../utils/healthScore';
import {
	buildDebtInsights,
	buildFixedCostInsights,
	buildGoalInsights,
	buildSavingsRateInsights,
	FIXED_COST_INSIGHT_IDS,
	type Insight,
	mergeInsights,
	SAVINGS_RATE_INSIGHT_IDS,
	type WealthMetrics,
} from '../utils/insights';
import { fixedCostShare, FULL_BASIS_POINTS } from '../utils/metrics';
import {
	averageClosedMonths,
	averageReserveCapitalCents,
	type CategoryRankRow,
	type CommittedMonth,
	committedMonths,
	type DuplicateIncome,
	buildMonthSeries,
	externalIncomeTransfers,
	findDuplicateIncomes,
	findRecurringDoubleCharges,
	type IncomeComposition,
	investmentIncomeRows,
	type MonthInvestmentIncomeRow,
	type MonthKey,
	type MonthPoint,
	monthElapsedBp,
	monthIncomeComposition,
	monthKeysEnding,
	monthRangeOf,
	paceSpendToDate,
	rankCategories,
	rankSpendSources,
	savingsRateDropsEnding,
	type SpendSourceRow,
	toCardEntry,
	withProvisionalActivity,
	yield12m,
} from '../utils/reportSeries';
import { type ProvisionalPart, provisionalPart } from '../utils/monthOverview';
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
	const { selectedMonth, selectedYear } = usePeriod();
	const { accounts, balances, overview, cardSummaries, cardsTotals, debitCards, creditCards, accruedYield12m, isLoading: accountsLoading, refresh: refreshAccounts } = useAccounts();
	const { currentBudgetCents } = useBudget();
	const { goal: reserveGoal } = useReserveGoal();
	const { categories, currentPeriodTransactions, refreshData } = useTransactions();
	const { metrics, insights: wealthInsights } = useWealthMetrics();
	const { activeDebts, summary: debtsSummary } = useDebts();
	const { transactions: recurring } = useRecurringTransactions();

	const todayKey = monthKeyOf(todayISO());
	// Ancorado em hoje, o mês escolhido na Home não mexe aqui (ver `ReportsAnchor`).
	const selectedKey = anchor === 'today' ? todayKey : `${selectedYear}-${String(selectedMonth).padStart(2, '0')}`;

	const [raw, setRaw] = useState<ReportsRaw | null>(null);

	// `cardSummaries` está nas dependências como gatilho: é um Map novo a cada recarga do
	// AccountsContext, que por sua vez roda a cada mudança no livro.
	useEffect(() => {
		let cancelled = false;
		const months = monthKeysEnding(selectedKey, HISTORY_MONTHS);
		const { startDate, endDate } = monthRangeOf(months);
		const live = accounts.filter((account) => !account.deletedAt);
		const cardIds = live.filter((account) => account.kind === 'credit_card').map((account) => account.id);
		// As contas de reserva vêm na mesma consulta porque delas o quadro do mês precisa saber
		// quanto da receita é rendimento de investimento — o que as somas por conta não dizem.
		const reserveIds = live.filter((account) => account.kind !== 'credit_card' && account.role === 'reserve').map((account) => account.id);

		const load = async () => {
			try {
				await initDatabase();
				const [activity, transfers, categoryRows, ledgerTransactions, transferLines, pendingCaptures] = await Promise.all([
					getMonthlyAccountActivity(startDate, endDate),
					getMonthlyTransferActivity(startDate, endDate),
					getMonthlyCategoryTotals(startDate, endDate, 'expense'),
					getTransactionsForAccounts([...cardIds, ...reserveIds]),
					getTransfersByDateRange(startDate, endDate),
					getPendingCaptures(),
				]);
				// Oito consultas pequenas de totais: o mês selecionado e os três anteriores, só até o dia D.
				const windows = spendingPaceWindows(selectedKey, todayISO());
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
				if (cancelled) return;

				const isCard = new Set(cardIds);
				const cardEntries = new Map<string, CardEntry[]>();
				for (const transaction of ledgerTransactions) {
					if (!transaction.accountId || !isCard.has(transaction.accountId)) continue;
					const list = cardEntries.get(transaction.accountId) ?? [];
					list.push(toCardEntry(transaction));
					cardEntries.set(transaction.accountId, list);
				}
				setRaw({
					months,
					activity,
					transfers,
					categoryRows,
					cardEntries,
					transferLines,
					investmentIncome: investmentIncomeRows(ledgerTransactions),
					provisional: provisionalEntriesByAccount(pendingCaptures, live),
					pace,
				});
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
	const fullSeries = useMemo<MonthPoint[]>(() => {
		if (!raw || !merged) return [];
		return buildMonthSeries({
			months: raw.months,
			accounts: liveAccounts,
			activity: merged.activity,
			transfers: raw.transfers,
			cardEntries: merged.cardEntries,
			transferLines: raw.transferLines,
			investmentIncome: raw.investmentIncome,
			currentMonth: todayKey,
		});
	}, [raw, merged, liveAccounts, todayKey]);

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
	const paceSpend = useMemo(() => {
		if (!raw?.pace) return null;
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
	}, [raw, liveAccounts, todayKey]);

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

	/**
	 * O rendimento que o app **estimou** para as contas de reserva nos últimos 12 meses (o
	 * acréscimo do CDI, que não é lançado no livro). Entra no "rendeu nos últimos 12 meses"
	 * ao lado do lançado: sem ele a tela afirmava "rendeu 0% ao ano" num CDB de 120% do CDI.
	 */
	const estimatedYield12mCents = useMemo(() => {
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
	}, [liveAccounts, accruedYield12m]);

	const retirement = useMemo<RetirementReadModel | null>(() => {
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
			averageCapital12mCents: averageReserveCapitalCents(history, overview.savedCents),
			asOfMonth: todayKey,
			contributionDelayMonths: contributionDelayMonths(reserve),
		});
	}, [goal, fullSeries, overview.savedCents, averageSavedCents, todayKey, selectedKey, reserve, estimatedYield12mCents]);

	// A fatia de custo fixo também sai do quadro do mês: a receita crua do período não vê o
	// que a PJ transferiu para a principal, e o indicador acusava "custo fixo acima de 50% da
	// renda" num mês de R$ 12.000 de pró-labore. Um número só, lido pela grade de saúde e pelo
	// insight "fixed-cost-heavy" — antes o insight dizia 300% onde a grade dizia 23%.
	const fixedCostBp = selected ? fixedCostShare({ monthlyFixedCents: metrics.monthlyFixedCents, incomeCents: selected.overview.incomeCents }) : metrics.fixedCostBasisPoints;

	const health = useMemo<HealthIndicator[]>(() => {
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
			elapsedBp: monthElapsedBp(selectedKey, todayISO()),
			previousSpendToDate: paceSpend?.previous ?? null,
			reserve:
				reserve.monthlyCostCents === null
					? null
					: { reserveCents: reserve.split.reserveCents, monthlyCostCents: reserve.monthlyCostCents, targetMonths: reserve.targetMonths },
		});
	}, [retirement, goal, averageIncomeCents, averageSpendCents, cardSummaries, selected, overview, fixedCostBp, cardsTotals, selectedKey, reserve, paceSpend]);

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
	// trocado (abaixo, `fixedCostInsights`); os outros insights de riqueza (fôlego, 50/30/20,
	// categoria que saltou) continuam vindo de lá.
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
		() => buildFixedCostInsights({ monthlyFixedCents: metrics.monthlyFixedCents, basisPoints: fixedCostBp }),
		[metrics.monthlyFixedCents, fixedCostBp]
	);

	const insights = useMemo(
		() =>
			mergeInsights(
				buildGoalInsights(retirement, health, duplicates, doubleCharges),
				debtInsights,
				savingsRateInsights,
				fixedCostInsights,
				wealthInsights.filter((insight) => !SAVINGS_RATE_INSIGHT_IDS.includes(insight.id) && !FIXED_COST_INSIGHT_IDS.includes(insight.id))
			),
		[retirement, health, duplicates, debtInsights, savingsRateInsights, fixedCostInsights, wealthInsights]
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
