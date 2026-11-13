import { loadCachedCdi } from '../../../api/cdi';
import { getBillPayments, getBills, getDebts, getRetirementGoal } from '../../../database/database';
import { billsOfMonth, overdueBills } from '../../billRules';
import { monthKeyOf, shiftMonthKey } from '../../dateUtils';
import { comparisonYield, debtStateOn, effectiveRateBp, monthlyRateBpOf, summarizeDebts, termsOf, worthPayingOff } from '../../debt';
import { retirementGoalOf } from '../../reportsModel';
import { merchantOf, type PrivacyContext } from '../privacy';
import { assertPeriod, MiraiInputError } from './validate';

/** Até quantos meses `get_bills` percorre numa chamada (dois anos). */
export const MAX_BILL_MONTHS = 24;

/**
 * `get_bills`: as Contas a pagar dos meses do período — cada mês por `billsOfMonth`, a mesma
 * função da tela ao trocar de mês (o mês atual é o `monthBills` do contexto, que é ela com o
 * mês de hoje) — e só as linhas com vencimento dentro de `from`–`to`. O atraso de meses
 * anteriores (`overdueBills`) é o aviso que a tela põe em cima do mês atual.
 */
export const getBillsTool = async (input: { from: string; to: string }, today: string, privacy: PrivacyContext) => {
	assertPeriod(input.from, input.to);
	const first = monthKeyOf(input.from);
	const last = monthKeyOf(input.to);
	const months: string[] = [];
	for (let month = first; month <= last; month = shiftMonthKey(month, 1)) {
		months.push(month);
		if (months.length > MAX_BILL_MONTHS) throw new MiraiInputError(`período maior que ${MAX_BILL_MONTHS} meses`);
	}
	const [bills, payments] = await Promise.all([getBills(), getBillPayments()]);

	const rows = [];
	const totals = { toPayCents: 0, variableToPayCount: 0, lateCount: 0, paidCount: 0, skippedCount: 0 };
	for (const month of months) {
		for (const row of billsOfMonth(bills, month, today, payments).rows) {
			if (row.dueDate < input.from || row.dueDate > input.to) continue;
			const payment = payments.find((item) => !item.deletedAt && item.billId === row.bill.id && item.month === month);
			rows.push({
				billId: row.bill.id,
				name: merchantOf(row.bill.name, false, null, privacy),
				month,
				dueDate: row.dueDate,
				/** Nulo: valor que varia (a conta de celular). */
				amountCents: row.bill.amountCents,
				status: row.status,
				paidCents: payment?.status === 'paid' ? payment.amountCents : null,
				accountId: row.bill.accountId,
				debtId: row.bill.debtId,
			});
			if (row.status === 'paid') totals.paidCount += 1;
			else if (row.status === 'skipped') totals.skippedCount += 1;
			else {
				if (row.status === 'late') totals.lateCount += 1;
				if (row.bill.amountCents === null) totals.variableToPayCount += 1;
				else totals.toPayCents += row.bill.amountCents;
			}
		}
	}
	const overdue = overdueBills(bills, monthKeyOf(today), payments);
	return {
		from: input.from,
		to: input.to,
		bills: rows,
		totals,
		overdueBeforeThisMonth: {
			cents: overdue.cents,
			billCount: overdue.billCount,
			variableCount: overdue.variableCount,
			oldestMonth: overdue.oldestMonth,
		},
	};
};

/**
 * `get_debts`: a lista de Dívidas e o quadro do Patrimônio. Cada dívida pelo estado de hoje
 * (`debtStateOn`, o mesmo da linha e do detalhe), a taxa ao mês pela conta do detalhe
 * (`monthlyRateBpOf`), o veredito "quitar ou investir" pelo custo efetivo contra o rendimento
 * de comparação (`comparisonYield`: a meta de aposentadoria, senão o CDI guardado) e o quadro
 * das não arquivadas (`summarizeDebts`), como o `DebtsContext`.
 */
export const getDebtsTool = async (today: string) => {
	const [debts, retirementRow, cdi] = await Promise.all([
		getDebts(),
		getRetirementGoal(),
		loadCachedCdi(),
	]);
	const goal = retirementGoalOf(retirementRow);
	const comparison = comparisonYield({ goalYieldBp: goal?.expectedYieldBp, cdiAnnualBp: cdi?.annualBp });
	const active = debts.filter((debt) => !debt.archived);
	const summary = summarizeDebts(
		active.map((debt) => ({ id: debt.id, name: debt.name, terms: termsOf(debt) })),
		today
	);
	return {
		debts: debts.map((debt) => {
			const terms = termsOf(debt);
			const state = debtStateOn(terms, today);
			const paidOff = debt.archived || state.settled;
			const costBp = effectiveRateBp(terms, today);
			return {
				id: debt.id,
				name: debt.name,
				kind: debt.kind,
				system: debt.system,
				paidOff,
				archived: debt.archived,
				balanceCents: state.balanceCents,
				installmentCents: paidOff ? null : (state.next?.installmentCents ?? debt.installmentCents),
				nextDueDate: paidOff ? null : (state.next?.date ?? null),
				remainingInstallments: state.remaining,
				totalInstallments: debt.installmentsTotal,
				paidInstallments: Math.max(0, debt.installmentsTotal - state.remaining),
				payoffDate: state.payoffDate,
				interestAheadCents: state.interestAheadCents,
				/** Juros do contrato (no consórcio, o reajuste), ao ano e ao mês. */
				rateYearBp: debt.rateBp,
				rateMonthBp: monthlyRateBpOf(debt.rateBp),
				/** Com seguro e tarifas: o que antecipar deixa de pagar, ao ano. */
				effectiveRateYearBp: costBp,
				verdict: paidOff ? null : worthPayingOff({ debtRateBp: costBp, investmentYieldBp: comparison.yieldBp }).verdict,
			};
		}),
		summary: {
			balanceCents: summary.balanceCents,
			monthlyCents: summary.monthlyCents,
			weightedRateYearBp: summary.weightedRateBp,
			lastPayoffDate: summary.lastPayoffDate,
		},
		comparisonYield: { yearBp: comparison.yieldBp, source: comparison.source },
	};
};

/** Todo arquivo sob app/ é rota para o expo-router; o export default só satisfaz essa exigência. */
export default { getBillsTool, getDebtsTool };
