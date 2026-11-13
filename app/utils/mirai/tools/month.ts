import { budgetForMonth } from '../../../contexts/BudgetContext';
import { getBudgets } from '../../../database/database';
import { loadAccountsState } from '../../accountsLoad';
import { monthKeyRange } from '../../dateUtils';

/**
 * `get_month_overview`: o card "Este mês" da tela inicial para o mês pedido — o `month` e o
 * `provisionalMonth` do `AccountsContext` com aquele mês no seletor (`loadAccountsState`), e o
 * orçamento da barra (`budgetForMonth`, do `BudgetContext`).
 */
export const getMonthOverview = async (input: { month: string }, today: string) => {
	const { startDate, endDate } = monthKeyRange(input.month);
	const [{ month, provisionalMonth }, budgets] = await Promise.all([loadAccountsState(startDate, endDate, today), getBudgets()]);
	const [year, monthNumber] = input.month.split('-').map(Number);
	// O orçamento da barra do card: o do mês ou o herdado do último mês com orçamento.
	const budget = budgetForMonth(budgets, year, monthNumber);
	return {
		month: input.month,
		incomeCents: month.incomeCents,
		grossIncomeCents: month.grossIncomeCents,
		passThroughCents: month.passThroughCents,
		spend: {
			totalCents: month.totalSpendCents,
			cardsCents: month.cardSpendCents,
			pixAndDebitCents: month.mainSpendCents,
			envelopesCents: month.envelopeFundingCents,
		},
		leftoverCents: month.leftoverCents,
		savingsRateBp: month.savingsRateBp,
		savedCents: month.savedCents,
		yieldCents: month.yieldCents,
		pendingReview: provisionalMonth,
		budgetCents: budget?.amountCents ?? null,
		cards: month.cards.map((card) => ({
			accountId: card.accountId,
			name: card.name,
			spendCents: card.spendCents,
			purchasesCents: card.purchasesCents,
			spendIs: card.invoiceBased ? 'invoice_closing_this_month' : 'purchases_this_month',
		})),
		envelopes: month.envelopes.map((envelope) => ({
			accountId: envelope.accountId,
			name: envelope.name,
			costCents: envelope.costCents,
			spentCents: envelope.spentCents,
			targetCents: envelope.targetCents,
			remainingCents: envelope.remainingCents,
		})),
		reserves: month.reserves.map((reserve) => ({
			accountId: reserve.accountId,
			name: reserve.name,
			savedCents: reserve.savedCents,
			yieldCents: reserve.yieldCents,
		})),
	};
};

/** Todo arquivo sob app/ é rota para o expo-router; o export default só satisfaz essa exigência. */
export default { getMonthOverview };
