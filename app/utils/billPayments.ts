/**
 * Os meses das contas a pagar (SPD-146): a linha de `bill_payments` de cada mês pulado, pago
 * fora de ordem ou quitado.
 *
 * Folha de propósito — só data e id, sem as regras da conta —, para `billReminders`,
 * `billRules` e `billMatcher` poderem usá-la sem import circular.
 */

import type { BillPayment, BillPaymentDraft, BillPaymentStatus } from '../database/schema';
import { occurrenceId } from './recurrence';

/**
 * O id do registro do mês: sai da conta e do mês, como o lançamento do "Já paguei"
 * (`markPaidTransactionId`). Dois aparelhos que marcam o mesmo mês gravam a mesma linha, e o
 * servidor a junta numa só.
 */
export const billPaymentId = (billId: string, month: string): string =>
	occurrenceId(`bill-payment:${billId}`, month);

/** O registro vivo (não desfeito) do mês de uma conta, se houver. */
export const paymentFor = <P extends Pick<BillPayment, 'billId' | 'month' | 'deletedAt'>>(
	payments: readonly P[],
	billId: string,
	month: string
): P | undefined =>
	payments.find(
		(payment) => payment.billId === billId && payment.month === month && !payment.deletedAt
	);

/** O registro vivo cujo lançamento é `transactionId`, se houver. */
export const paymentByTransaction = (
	payments: readonly BillPayment[],
	transactionId: string | null
): BillPayment | undefined =>
	transactionId
		? payments.find((payment) => payment.transactionId === transactionId && !payment.deletedAt)
		: undefined;

/** O registro de um mês, pronto para gravar. */
export const billPaymentDraft = (
	billId: string,
	month: string,
	status: BillPaymentStatus,
	transactionId: string | null = null,
	amountCents: number | null = null
): BillPaymentDraft => ({
	id: billPaymentId(billId, month),
	billId,
	month,
	status,
	transactionId: status === 'skipped' ? null : transactionId,
	amountCents: status === 'skipped' ? null : amountCents,
});
