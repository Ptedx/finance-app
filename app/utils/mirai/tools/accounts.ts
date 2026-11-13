import { getAccountBalances, getUnassignedNet } from '../../../database/database';
import { netWorth, owedCents } from '../../accountMath';
import { monthKeyRange, shiftMonthKey } from '../../dateUtils';
import { summarizeDebts, termsOf } from '../../debt';
import type { AccountsToday, ReportsToday } from './snapshot';

/**
 * `get_accounts`: a tela de Contas — o saldo de cada conta ativa (o `balances` do
 * `AccountsContext`, já com o rendimento estimado e as compras a revisar) e "Em caixa" /
 * "Depois das faturas" (`overview`).
 */
export const getAccountsTool = (snapshot: AccountsToday) => ({
	accounts: snapshot.bankAccounts.map((account) => ({
		id: account.id,
		name: account.name,
		kind: account.kind,
		role: account.role,
		bank: account.bankName,
		balanceCents: snapshot.balances.get(account.id) ?? account.openingBalanceCents,
		/** Parte do saldo que é rendimento estimado (CDI), não lançado. */
		estimatedYieldCents: snapshot.accruedYield.get(account.id) ?? 0,
		/** Parte do saldo que vem de compras ainda na caixa de entrada. */
		pendingReviewCents: snapshot.state.provisionalBalances.get(account.id) ?? 0,
		yieldCdiBp: account.yieldCdiBp ?? null,
		reservePurpose: account.role === 'reserve' ? (account.reservePurpose ?? null) : null,
		envelopeMonthlyCents: account.role === 'envelope' ? account.envelopeMonthlyCents : null,
	})),
	totals: {
		cashCents: snapshot.overview.cashCents,
		savedCents: snapshot.overview.savedCents,
		cardsOwedCents: snapshot.overview.cardsOwedCents,
		afterCardsCents: snapshot.overview.netCents,
	},
});

/** Quantas parcelas em andamento de cada cartão saem; o resto vira a contagem. */
const MAX_INSTALLMENT_PLANS = 20;

/**
 * `get_cards`: a tela de Cartões — o resumo de cada cartão ativo (`cardSummaries`, o mesmo
 * que o cartão mostra) e as somas do topo (`cardsTotals`).
 */
export const getCardsTool = (snapshot: AccountsToday) => ({
	cards: snapshot.creditCards.map((card) => {
		const summary = snapshot.state.cardSummaries.get(card.id);
		if (!summary) return { id: card.id, name: card.name, last4: card.last4, configured: false };
		return {
			id: card.id,
			name: card.name,
			last4: card.last4,
			bank: card.bankName,
			configured: summary.configured,
			closingDay: card.closingDay,
			dueDay: card.dueDay,
			openInvoice: summary.openCycle
				? {
						closingDate: summary.openCycle.closingDate,
						dueDate: summary.openCycle.dueDate,
						amountCents: summary.openInvoiceCents,
						daysToClosing: summary.daysToClosing,
					}
				: null,
			closedInvoice: summary.closedCycle
				? {
						closingDate: summary.closedCycle.closingDate,
						dueDate: summary.closedCycle.dueDate,
						amountCents: summary.closedInvoiceCents,
						toPayCents: summary.toPayCents,
						paidSinceClosingCents: summary.paidSinceClosingCents,
						status: summary.closedStatus,
						daysToDue: summary.daysToDue,
					}
				: null,
			owedCents: summary.owedCents,
			creditCents: summary.creditCents,
			futureInstallmentsCents: summary.futureCommittedCents,
			limitCents: summary.limitCents,
			limitUsedCents: summary.limitUsedCents,
			limitAvailableCents: summary.limitAvailableCents,
			limitUsagePercent: summary.limitUsagePercent,
			bestPurchaseDate: summary.bestPurchaseDate,
			pendingReviewCents: summary.pendingReviewCents,
			installments: summary.installmentPlans.slice(0, MAX_INSTALLMENT_PLANS).map((plan) => ({
				description: plan.note,
				parcelCents: plan.parcelCents,
				remainingCount: plan.remainingCount,
				totalCount: plan.totalCount,
				/** As que já entraram em faturas: sem isso, o Mirai lia a próxima como a primeira (SPD-170). */
				chargedCount: plan.totalCount - plan.remainingCount,
				/** O número da parcela de `nextDate` (a 4 de 6); nulo quando não falta nenhuma. */
				nextNumber: plan.remainingCount > 0 ? plan.totalCount - plan.remainingCount + 1 : null,
				remainingCents: plan.remainingCents,
				nextDate: plan.nextDate,
				lastDate: plan.lastDate,
			})),
			installmentPlansCount: summary.installmentPlans.length,
		};
	}),
	totals: snapshot.cardsTotals,
});

/**
 * `get_net_worth`: o Patrimônio, somado como a tela soma (`WealthScreen`): caixa, reserva e
 * investido (a cascata da reserva), o que está fora do app (da meta de aposentadoria), o que
 * os cartões devem com as parcelas que ainda vão cair, e o saldo das dívidas.
 *
 * A série é dos meses fechados: o saldo de todas as contas vivas no último dia do mês
 * (inclusive as encerradas — o dinheiro estava lá), mais os "Sem conta", menos o que os
 * cartões deviam naquele dia, mais o de fora do app, menos o saldo das dívidas naquela data. É
 * a medida que os testes do SPD-144 usam para o patrimônio passado; o app não tem tela para
 * ela. O último ponto é o mês de hoje, igual ao total.
 */
export const getNetWorthTool = async (input: { months: number | null }, reports: ReportsToday) => {
	const { overview, state, todayKey } = reports.accounts;
	let cardsCents = 0;
	for (const card of state.cardSummaries.values()) cardsCents += card.owedCents + card.futureCommittedCents;
	const outsideCents = reports.goal?.outsideCapitalCents ?? 0;
	const parts = {
		cashCents: overview.cashCents,
		reserveCents: reports.reserve.split.reserveCents,
		investedCents: overview.savedCents - reports.reserve.split.reserveCents,
		outsideCents,
		cardsCents,
		debtsCents: reports.debtsSummary.balanceCents,
	};
	const worth = netWorth({ ...parts, savedCents: overview.savedCents });

	let series: { month: string; netCents: number }[] | null = null;
	if (input.months !== null) {
		series = [];
		const debts = reports.activeDebts.map((debt) => ({ id: debt.id, name: debt.name, terms: termsOf(debt) }));
		for (let back = input.months - 1; back >= 1; back -= 1) {
			const month = shiftMonthKey(todayKey, -back);
			const end = monthKeyRange(month).endDate;
			const [atEnd, unassigned] = await Promise.all([getAccountBalances(end), getUnassignedNet(end)]);
			let total = unassigned + outsideCents - summarizeDebts(debts, end).balanceCents;
			for (const account of state.list) {
				if (account.role === 'external') continue;
				const balance = atEnd.get(account.id) ?? 0;
				total += account.kind === 'credit_card' ? -owedCents(balance) : balance;
			}
			series.push({ month, netCents: total });
		}
		series.push({ month: todayKey, netCents: worth.netCents });
	}

	return {
		netCents: worth.netCents,
		assetsCents: worth.assetsCents,
		liabilitiesCents: worth.liabilitiesCents,
		parts,
		series,
		seriesBasis:
			series === null
				? null
				: 'meses fechados: saldos no último dia do mês, cartões pelo que deviam (sem parcelas futuras) e dívidas na data; o último ponto é o total de hoje',
	};
};

/** Todo arquivo sob app/ é rota para o expo-router; o export default só satisfaz essa exigência. */
export default { getAccountsTool, getCardsTool, getNetWorthTool };
