/**
 * Fatura quitada com crédito de estorno aparece "Paga" (SPD-125, dúvida do SPD-120). O cartão
 * fecha dia 10 e vence dia 17; foi informado em 30/09 sem nada devido. A fatura de outubro é o
 * ciclo de 10/09 a 09/10, a de novembro o de 10/10 a 09/11, a de dezembro o de 10/11 a 09/12.
 *
 * Quando um estorno cobre a fatura — maior que as compras dela, ou junto com o pagamento ou com o
 * crédito que veio das anteriores —, nada falta pagar, mas o chip dizia "fechada" (ou "Fechada ·
 * venceu …"): a regra só olhava o valor da fatura com o saldo anterior, sem o crédito, e só
 * chamava de paga a fatura com valor positivo. Agora a fatura que cobrou alguma coisa (compra,
 * encargo, valor informado ou saldo anterior) e não deixa nada a pagar é paga. "Falta pagar",
 * lembrete e Relatórios seguem no mesmo `invoiceDueCents`, sem mudança.
 */

import { cardInvoicesDue } from '../billReminders';
import {
	buildCardSummary,
	type CardEntry,
	type CardMovement,
	type CardSettings,
	type CardSummary,
	type InvoiceView,
	invoiceDueCents,
	invoiceStatusOf,
} from '../cardMath';
import { committedMonths } from '../reportSeries';

/** Fecha dia 10, vence dia 17; informado em 30/09 com R$ 0. */
const card = (overrides: Partial<CardSettings> = {}): CardSettings => ({
	closingDay: 10,
	closingDaysBefore: 7,
	dueDay: 17,
	creditLimitCents: 500_000,
	openingBalanceCents: 0,
	openingBalanceDate: '2026-09-30',
	...overrides,
});

let seq = 0;
const entry = (date: string, amountCents: number, isIncome: boolean): CardEntry => ({
	id: `e${++seq}`,
	amountCents,
	isIncome,
	date,
	note: isIncome ? 'Estorno' : 'Compra',
	category: 'shopping',
	installmentGroup: null,
	installmentIndex: null,
	installmentCount: null,
});
const purchase = (date: string, amountCents: number) => entry(date, amountCents, false);
const refund = (date: string, amountCents: number) => entry(date, amountCents, true);
const payment = (date: string, amountCents: number): CardMovement => ({ date, amountCents, inbound: true });

const invoiceOf = (summary: CardSummary, key: string): InvoiceView => {
	const invoice = summary.invoices.find((item) => item.cycle.key === key);
	if (!invoice) throw new Error(`sem a fatura ${key}`);
	return invoice;
};

/** O que o lembrete anunciaria para a fatura `key`. */
const reminderOf = (summary: CardSummary, key: string): number | undefined =>
	cardInvoicesDue(summary).find((due) => due.invoice === key)?.amountCents;

/** O que os Relatórios põem do cartão no mês `month` (o do vencimento). */
const reportOf = (summary: CardSummary, month: string): number => {
	const [year, monthNumber] = month.split('-').map(Number);
	const before = monthNumber === 1 ? `${year - 1}-12` : `${year}-${String(monthNumber - 1).padStart(2, '0')}`;
	return committedMonths([{ id: 'card', name: 'Cartão', summary }], 0, before, 1)[0].cardCents;
};

describe('estorno maior que as compras (SPD-125)', () => {
	// Novembro: R$ 100 de compra e R$ 300 de estorno — a fatura é −R$ 200, nada a pagar.
	const entries = [purchase('2026-10-20', 10_000), refund('2026-11-05', 30_000)];

	it('fechada (12/11): "Paga", e não "Fechada · vence 17/11"; nada a pagar em lugar nenhum', () => {
		const summary = buildCardSummary(card(), entries, [], '2026-11-12');
		const nov = invoiceOf(summary, '2026-11');
		expect(nov.offset).toBe(-1);
		expect(nov.amountCents).toBe(-20_000);
		expect(summary.toPayCents).toBe(0);
		expect(summary.closedStatus).toBe('paid');
		expect(invoiceStatusOf(nov, summary, '2026-11-12')).toEqual({ kind: 'paid' });
		expect(invoiceDueCents(nov, summary)).toBe(0);
		expect(reminderOf(summary, '2026-11')).toBeUndefined();
		expect(reportOf(summary, '2026-11')).toBe(0);
	});

	it('anterior à fechada (20/12): "Paga", e não "Fechada · venceu 17/11"', () => {
		const summary = buildCardSummary(card(), entries, [], '2026-12-20');
		const nov = invoiceOf(summary, '2026-11');
		expect(nov.offset).toBe(-2);
		expect(nov.leftOpenCents).toBe(0);
		expect(invoiceStatusOf(nov, summary, '2026-12-20')).toEqual({ kind: 'paid' });
	});

	it('o crédito que sobra vai para a de dezembro uma vez só: abate a compra dela, sem virar pagamento antecipado', () => {
		const withDecember = [...entries, purchase('2026-11-11', 5_000)];
		const summary = buildCardSummary(card(), withDecember, [], '2026-11-12');
		const dec = invoiceOf(summary, '2026-12');
		expect(dec.amountCents).toBe(5_000);
		expect(dec.creditAppliedCents).toBe(5_000);
		expect(dec.paidCents).toBe(0);
		expect(invoiceDueCents(dec, summary)).toBe(0);
		expect(reminderOf(summary, '2026-12')).toBeUndefined();
		// Dos R$ 200, R$ 50 cobrem dezembro; R$ 150 são crédito do cartão.
		expect(summary.creditCents).toBe(15_000);
	});
});

describe('estorno junto com o pagamento (SPD-125)', () => {
	it('fechada de R$ 500 com estorno de R$ 100 nela e pagamento de R$ 400: paga, como antes', () => {
		const entries = [purchase('2026-10-20', 50_000), refund('2026-11-05', 10_000)];
		const summary = buildCardSummary(card(), entries, [payment('2026-11-12', 40_000)], '2026-11-13');
		const nov = invoiceOf(summary, '2026-11');
		expect(nov.amountCents).toBe(40_000);
		expect(nov.paidCents).toBe(40_000);
		expect(summary.toPayCents).toBe(0);
		expect(invoiceStatusOf(nov, summary, '2026-11-13')).toEqual({ kind: 'paid' });
		const later = buildCardSummary(card(), entries, [payment('2026-11-12', 40_000)], '2026-12-20');
		expect(invoiceStatusOf(invoiceOf(later, '2026-11'), later, '2026-12-20')).toEqual({ kind: 'paid' });
	});

	it('crédito de outubro (estorno maior que as compras) mais pagamento quitam novembro: "Paga" também depois do vencimento', () => {
		// Outubro: R$ 100 de compra e R$ 300 de estorno → R$ 200 de crédito para novembro.
		// Novembro: R$ 500 de compra; o banco cobra R$ 300 e o dono paga R$ 300.
		const entries = [purchase('2026-10-01', 10_000), refund('2026-10-05', 30_000), purchase('2026-10-20', 50_000)];
		const movements = [payment('2026-11-12', 30_000)];

		const closed = buildCardSummary(card(), entries, movements, '2026-11-13');
		const novClosed = invoiceOf(closed, '2026-11');
		expect(novClosed).toMatchObject({ amountCents: 50_000, creditAppliedCents: 20_000, paidCents: 30_000 });
		expect(closed.toPayCents).toBe(0);
		expect(invoiceStatusOf(novClosed, closed, '2026-11-13')).toEqual({ kind: 'paid' });

		// Depois do vencimento, novembro é anterior à fechada: dizia "Fechada · venceu 17/11".
		const later = buildCardSummary(card(), entries, movements, '2026-12-20');
		const nov = invoiceOf(later, '2026-11');
		expect(nov.offset).toBe(-2);
		expect(nov).toMatchObject({ amountCents: 50_000, creditAppliedCents: 20_000, paidCents: 30_000, leftOpenCents: 0 });
		expect(invoiceStatusOf(nov, later, '2026-12-20')).toEqual({ kind: 'paid' });
		// Outubro: a compra de R$ 100 foi coberta pelo estorno.
		expect(invoiceStatusOf(invoiceOf(later, '2026-10'), later, '2026-12-20')).toEqual({ kind: 'paid' });
		expect(later.toPayCents).toBe(0);
		expect(invoiceDueCents(nov, later)).toBe(0);
	});

	it('saldo anterior coberto por estorno: outubro deixou R$ 200, novembro tem R$ 100 de compra e R$ 300 de estorno', () => {
		const entries = [purchase('2026-10-01', 50_000), purchase('2026-10-20', 10_000), refund('2026-11-05', 30_000)];
		const movements = [payment('2026-10-12', 30_000)];
		const summary = buildCardSummary(card(), entries, movements, '2026-11-12');
		const nov = invoiceOf(summary, '2026-11');
		expect(nov).toMatchObject({ amountCents: -20_000, previousUnpaidCents: 20_000 });
		expect(summary.toPayCents).toBe(0);
		expect(summary.closedStatus).toBe('paid');
		expect(invoiceStatusOf(nov, summary, '2026-11-12')).toEqual({ kind: 'paid' });
		expect(invoiceDueCents(nov, summary)).toBe(0);
		expect(reminderOf(summary, '2026-11')).toBeUndefined();
		expect(reportOf(summary, '2026-11')).toBe(0);
	});
});

describe('o que não muda', () => {
	it('sem estorno: fechada não paga é "a pagar"; paga é "Paga"', () => {
		const entries = [purchase('2026-10-20', 50_000)];
		const unpaid = buildCardSummary(card(), entries, [], '2026-11-12');
		expect(invoiceStatusOf(invoiceOf(unpaid, '2026-11'), unpaid, '2026-11-12')).toEqual({ kind: 'toPay', amountCents: 50_000 });
		const paid = buildCardSummary(card(), entries, [payment('2026-11-12', 50_000)], '2026-11-13');
		expect(invoiceStatusOf(invoiceOf(paid, '2026-11'), paid, '2026-11-13')).toEqual({ kind: 'paid' });
	});

	it('estorno na aberta não abate a fechada: R$ 500, pagamento de R$ 400 e estorno de R$ 100 depois do fechamento — falta R$ 100', () => {
		const entries = [purchase('2026-10-20', 50_000), refund('2026-11-11', 10_000)];
		const summary = buildCardSummary(card(), entries, [payment('2026-11-12', 40_000)], '2026-11-13');
		const nov = invoiceOf(summary, '2026-11');
		expect(summary.toPayCents).toBe(10_000);
		expect(invoiceStatusOf(nov, summary, '2026-11-13')).toEqual({ kind: 'toPay', amountCents: 10_000 });
		expect(invoiceDueCents(nov, summary)).toBe(10_000);
		expect(reminderOf(summary, '2026-11')).toBe(10_000);
	});

	it('fatura só com estorno, sem compra nem saldo anterior: nada foi cobrado, segue "fechada"', () => {
		const summary = buildCardSummary(card(), [refund('2026-11-05', 10_000)], [], '2026-11-12');
		const nov = invoiceOf(summary, '2026-11');
		expect(summary.closedStatus).toBe('none');
		expect(invoiceStatusOf(nov, summary, '2026-11-12')).toEqual({ kind: 'closedUpcoming' });
		const later = buildCardSummary(card(), [refund('2026-11-05', 10_000)], [], '2026-12-20');
		expect(invoiceStatusOf(invoiceOf(later, '2026-11'), later, '2026-12-20')).toEqual({ kind: 'closedPast' });
	});

	it('fechada vazia: "vence", e não "Paga"', () => {
		const summary = buildCardSummary(card(), [purchase('2026-11-11', 5_000)], [], '2026-11-12');
		expect(invoiceStatusOf(invoiceOf(summary, '2026-11'), summary, '2026-11-12')).toEqual({ kind: 'closedUpcoming' });
	});

	it('anterior paga em parte segue "ficou em aberto"', () => {
		const entries = [purchase('2026-10-20', 50_000), refund('2026-11-05', 10_000)];
		const summary = buildCardSummary(card(), entries, [payment('2026-11-12', 30_000)], '2026-12-20');
		expect(invoiceStatusOf(invoiceOf(summary, '2026-11'), summary, '2026-12-20')).toEqual({ kind: 'leftOpen', amountCents: 10_000 });
	});
});
