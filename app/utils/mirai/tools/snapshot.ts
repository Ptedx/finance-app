import { type CdiRate, loadCachedCdi } from '../../../api/cdi';
import { budgetForMonth } from '../../../contexts/BudgetContext';
import { getBills, getBudgets, getCategories, getDebts, getReserveGoal, getRetirementGoal } from '../../../database/database';
import type { Account, Bill, Category, Debt } from '../../../database/schema';
import { type AccountsOverview, summarizeAccounts } from '../../accountMath';
import {
	type AccountsState,
	accruedYield12mByAccount,
	accruedYieldByAccount,
	activeAccountsOf,
	balancesWithAccruedYield,
	type CardsTotals,
	cardsTotalsOf,
	loadAccountsState,
} from '../../accountsLoad';
import { monthKeyOf, monthKeyRange } from '../../dateUtils';
import { type DebtsSummary, debtInstallmentsMonthlyCents, summarizeDebts, termsOf } from '../../debt';
import type { ReserveReadModel } from '../../emergencyReserve';
import type { HealthIndicator } from '../../healthScore';
import { cardInstallmentsMonthlyCents, fixedCostShare, monthlyFixedCommitmentsCents } from '../../metrics';
import { type MonthPoint, separateCardBookkeeping, withProvisionalActivity } from '../../reportSeries';
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
	type ReserveGoal,
	reserveGoalOf,
	reserveModelOf,
	retirementGoalOf,
	retirementModelOf,
} from '../../reportsModel';
import type { RetirementGoal, RetirementReadModel } from '../../retirement';

/**
 * O que as telas têm na memória, montado a partir do banco com as mesmas funções que os
 * contextos e os hooks usam (`utils/accountsLoad.ts`, `utils/reportsModel.ts`).
 *
 * - `loadAccountsToday`: o `AccountsContext` com o período no mês de hoje (o padrão do app):
 *   saldos com o rendimento estimado no CDI guardado, "Em caixa", cartões.
 * - `loadReportsToday`: o `useReportsData` ancorado em hoje, como o Patrimônio o usa: a série
 *   de 13 meses, a reserva, a meta de aposentadoria, a saúde, as contas a pagar e as dívidas.
 *
 * O CDI é o guardado (`loadCachedCdi`): a ferramenta não vai à internet; é a mesma taxa que o
 * app usou na última vez que abriu.
 */

export interface AccountsToday {
	today: string;
	todayKey: string;
	state: AccountsState;
	cdi: CdiRate | null;
	/** O saldo de hoje de cada conta, com o rendimento estimado (o `balances` do contexto). */
	balances: Map<string, number>;
	accruedYield: Map<string, number>;
	accruedYield12m: Map<string, number>;
	/** As vivas (com as arquivadas): o `accounts` do contexto. */
	accounts: Account[];
	bankAccounts: Account[];
	creditCards: Account[];
	overview: AccountsOverview;
	cardsTotals: CardsTotals;
}

export const loadAccountsToday = async (today: string): Promise<AccountsToday> => {
	const todayKey = monthKeyOf(today);
	const { startDate, endDate } = monthKeyRange(todayKey);
	const [state, cdi] = await Promise.all([loadAccountsState(startDate, endDate, today), loadCachedCdi()]);
	const cdiAnnualBp = cdi?.annualBp ?? null;
	const accruedYield = accruedYieldByAccount(state.yieldInputs, cdiAnnualBp, today);
	const accruedYield12m = accruedYield12mByAccount(state.yieldInputs, cdiAnnualBp, today);
	const balances = balancesWithAccruedYield(state.balances, accruedYield);
	const active = activeAccountsOf(state.list);
	const creditCards = active.filter((account) => account.kind === 'credit_card');
	return {
		today,
		todayKey,
		state,
		cdi,
		balances,
		accruedYield,
		accruedYield12m,
		accounts: state.list,
		bankAccounts: active.filter((account) => account.kind !== 'credit_card'),
		creditCards,
		overview: summarizeAccounts(state.list, balances, state.unassignedNetCents),
		cardsTotals: cardsTotalsOf(creditCards, state.cardSummaries),
	};
};

export interface ReportsToday {
	accounts: AccountsToday;
	fullSeries: MonthPoint[];
	selected: MonthPoint | null;
	categories: Category[];
	reserveGoal: ReserveGoal;
	goal: RetirementGoal | null;
	reserve: ReserveReadModel;
	retirement: RetirementReadModel | null;
	health: HealthIndicator[];
	bills: Bill[];
	/** As dívidas vivas (o `debts` do `DebtsContext`) e as não arquivadas (`activeDebts`). */
	debts: Debt[];
	activeDebts: Debt[];
	debtsSummary: DebtsSummary;
}

export const loadReportsToday = async (accounts: AccountsToday): Promise<ReportsToday> => {
	const { today, todayKey, state, balances, overview, cardsTotals, creditCards } = accounts;
	// O Patrimônio usa `useReportsData(3, goal, 'today')`: o mês selecionado é o de hoje.
	const selectedKey = todayKey;
	const [raw, categories, reserveRow, retirementRow, budgets, bills, debts] = await Promise.all([
		loadReportsRaw(selectedKey, state.list, today),
		getCategories(),
		getReserveGoal(),
		getRetirementGoal(),
		getBudgets(),
		getBills(),
		getDebts(),
	]);
	const reserveGoal = reserveGoalOf(reserveRow);
	const goal = retirementGoalOf(retirementRow);
	const [year, month] = todayKey.split('-').map(Number);
	const currentBudgetCents = budgetForMonth(budgets, year, month)?.amountCents ?? null;

	const liveAccounts = state.list.filter((account) => !account.deletedAt);
	const merged = withProvisionalActivity(raw.activity, raw.cardEntries, raw.provisional, raw.months);
	const fullSeries = fullSeriesOf(raw, merged, liveAccounts, todayKey);
	const selected = fullSeries.length > 0 ? fullSeries[fullSeries.length - 1] : null;
	const paceSpend = paceSpendOf(raw, liveAccounts, todayKey);
	const averageSpendCents = averageSpendOf(fullSeries);
	const averageIncomeCents = averageIncomeOf(fullSeries);
	const averageSavedCents = averageSavedOf(fullSeries);
	const spendCategoryRows = separateCardBookkeeping(raw.categoryRows, raw.cardEntries.values());
	const natureById = new Map(categories.map((category) => [category.id, category.nature]));
	const computedCost = computedReserveCostOf(spendCategoryRows, fullSeries, natureById, currentBudgetCents, todayKey);
	const reserve = reserveModelOf({ reserveGoal, computedCost, liveAccounts, balances, averageSavedCents, goal });
	const estimatedYield12mCents = estimatedYield12mOf(liveAccounts, accounts.accruedYield12m);
	const retirement = retirementModelOf({
		goal,
		fullSeries,
		savedCents: overview.savedCents,
		averageSavedCents,
		todayKey,
		selectedKey,
		reserve,
		estimatedYield12mCents,
	});

	// O custo fixo de `useWealthMetrics` (`computeWealthMetrics`): as contas a pagar, as parcelas
	// das dívidas e as das compras parceladas nos cartões ativos.
	const activeDebts = debts.filter((debt) => !debt.archived);
	const monthlyFixedCents = monthlyFixedCommitmentsCents({
		bills,
		debtInstallmentsCents: debtInstallmentsMonthlyCents(
			activeDebts.map((debt) => ({ terms: termsOf(debt) })),
			today,
			[]
		),
		cardInstallmentsCents: cardInstallmentsMonthlyCents(
			creditCards.flatMap((card) => state.cardSummaries.get(card.id)?.installmentPlans ?? [])
		),
	});
	// Com a série carregada, `selected` existe: a receita é a do quadro do mês.
	const fixedCostBp = fixedCostShare({ monthlyFixedCents, incomeCents: selected ? selected.overview.incomeCents : 0 });
	const health = healthOf({
		retirement,
		goal,
		averageIncomeCents,
		averageSpendCents,
		cardSummaries: state.cardSummaries,
		selected,
		overview,
		fixedCostBp,
		cardsTotals,
		selectedKey,
		reserve,
		paceSpend,
		today,
	});

	return {
		accounts,
		fullSeries,
		selected,
		categories,
		reserveGoal,
		goal,
		reserve,
		retirement,
		health,
		bills,
		debts,
		activeDebts,
		debtsSummary: summarizeDebts(
			activeDebts.map((debt) => ({ id: debt.id, name: debt.name, terms: termsOf(debt) })),
			today
		),
	};
};

/** Todo arquivo sob app/ é rota para o expo-router; o export default só satisfaz essa exigência. */
export default { loadAccountsToday, loadReportsToday };
