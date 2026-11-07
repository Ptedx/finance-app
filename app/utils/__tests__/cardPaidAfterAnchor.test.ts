/**
 * Pagamento feito depois da âncora e antes do fechamento, com a fatura anterior zerada (SPD-120,
 * DEC-37). O cartão fecha dia 10 e vence dia 17; foi informado em 01/11 sem nada devido, e a
 * fatura de outubro (fechou 10/10) é zero. Em 03/11 e 04/11 entram R$ 300 de compras, da fatura
 * de novembro; em 05/11 o dono paga R$ 300. O pagamento cai na janela da fatura de outubro, que
 * não cobra nada: ele é da fatura seguinte, e ela aparece paga — na tela, no lembrete e nos
 * Relatórios, que leem o mesmo `invoiceDueCents`. Antes, o devido abatia, mas a fatura de
 * novembro nunca dizia "Paga": fechada, sem "Pago R$ 300"; anterior, só "fechada".
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

/** Fecha dia 10, vence dia 17; informado em 01/11 com R$ 0. */
const card = (overrides: Partial<CardSettings> = {}): CardSettings => ({
	closingDay: 10,
	closingDaysBefore: 7,
	dueDay: 17,
	creditLimitCents: 500_000,
	openingBalanceCents: 0,
	openingBalanceDate: '2026-11-01',
	...overrides,
});

let seq = 0;
const purchase = (date: string, amountCents: number): CardEntry => ({
	id: `e${++seq}`,
	amountCents,
	isIncome: false,
	date,
	note: 'Compra',
	category: 'shopping',
	installmentGroup: null,
	installmentIndex: null,
	installmentCount: null,
});

const payment = (date: string, amountCents: number): CardMovement => ({ date, amountCents, inbound: true });

/** R$ 300 na fatura de novembro (ciclo de 10/10 a 09/11). */
const PURCHASES = [purchase('2026-11-03', 10_000), purchase('2026-11-04', 20_000)];

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

describe('pagamento depois da âncora com a fatura anterior zerada (SPD-120)', () => {
	const movements = [payment('2026-11-05', 30_000)];

	it('ainda aberta (07/11): o pagamento é antecipado da de novembro e nada falta pagar', () => {
		const summary = buildCardSummary(card(), PURCHASES, movements, '2026-11-07');
		const nov = invoiceOf(summary, '2026-11');
		expect(nov.offset).toBe(0);
		expect(nov.amountCents).toBe(30_000);
		expect(nov.paidCents).toBe(30_000);
		expect(invoiceDueCents(nov, summary)).toBe(0);
		expect(reminderOf(summary, '2026-11')).toBeUndefined();
		expect(reportOf(summary, '2026-11')).toBe(0);
	});

	it('fechada (12/11): "Pago R$ 300", status paga, nada a pagar no lembrete nem nos Relatórios', () => {
		const summary = buildCardSummary(card(), PURCHASES, movements, '2026-11-12');
		const nov = invoiceOf(summary, '2026-11');
		expect(nov.offset).toBe(-1);
		expect(nov.cycle.dueDate).toBe('2026-11-17');
		expect(summary.toPayCents).toBe(0);
		expect(nov.paidCents).toBe(30_000);
		expect(invoiceStatusOf(nov, summary, '2026-11-12')).toEqual({ kind: 'paid' });
		expect(invoiceDueCents(nov, summary)).toBe(0);
		expect(reminderOf(summary, '2026-11')).toBeUndefined();
		expect(reportOf(summary, '2026-11')).toBe(0);
		// O pagamento não sobra para a de dezembro: foi inteiro para a de novembro.
		expect(invoiceOf(summary, '2026-12').paidCents).toBe(0);
	});

	it('anterior à fechada (20/12): continua "Paga", e não só "fechada"', () => {
		const summary = buildCardSummary(card(), PURCHASES, movements, '2026-12-20');
		const nov = invoiceOf(summary, '2026-11');
		expect(nov.offset).toBe(-2);
		expect(nov.paidCents).toBe(30_000);
		expect(nov.leftOpenCents).toBe(0);
		expect(invoiceStatusOf(nov, summary, '2026-12-20')).toEqual({ kind: 'paid' });
	});

	it('paga em parte (R$ 200): "Pago R$ 200" e falta R$ 100 na tela, no lembrete e nos Relatórios', () => {
		const partial = [payment('2026-11-05', 20_000)];
		const closed = buildCardSummary(card(), PURCHASES, partial, '2026-11-12');
		const nov = invoiceOf(closed, '2026-11');
		expect(nov.paidCents).toBe(20_000);
		expect(closed.toPayCents).toBe(10_000);
		expect(invoiceDueCents(nov, closed)).toBe(10_000);
		expect(invoiceStatusOf(nov, closed, '2026-11-12')).toEqual({ kind: 'toPay', amountCents: 10_000 });
		expect(reminderOf(closed, '2026-11')).toBe(10_000);
		expect(reportOf(closed, '2026-11')).toBe(10_000);

		// Venceu sem o resto: os R$ 100 passam para a de dezembro, como qualquer fatura.
		const later = buildCardSummary(card(), PURCHASES, partial, '2026-12-20');
		const novLater = invoiceOf(later, '2026-11');
		expect(novLater.paidCents).toBe(20_000);
		expect(novLater.leftOpenCents).toBe(10_000);
		expect(invoiceStatusOf(novLater, later, '2026-12-20')).toEqual({ kind: 'leftOpen', amountCents: 10_000 });
		expect(invoiceOf(later, '2026-12').previousUnpaidCents).toBe(10_000);
		expect(later.toPayCents).toBe(10_000);
	});

	it('um pagamento antes e outro depois do fechamento: os dois contam na de novembro', () => {
		const both = [payment('2026-11-05', 20_000), payment('2026-11-12', 10_000)];
		const summary = buildCardSummary(card(), PURCHASES, both, '2026-11-13');
		const nov = invoiceOf(summary, '2026-11');
		expect(nov.paidCents).toBe(30_000);
		expect(summary.toPayCents).toBe(0);
		expect(invoiceStatusOf(nov, summary, '2026-11-13')).toEqual({ kind: 'paid' });
		expect(invoiceOf(summary, '2026-12').paidCents).toBe(0);
	});
});

describe('os casos vizinhos', () => {
	it('pagamento até a âncora (SPD-102): já está no valor informado e não paga nada', () => {
		// Informado em 01/11 com R$ 500 na de novembro; o pagamento de 31/10 já está nesse valor.
		const settings = card({ openingBalanceCents: -50_000 });
		const movements = [payment('2026-10-31', 50_000), payment('2026-11-01', 5_000)];
		const summary = buildCardSummary(settings, PURCHASES, movements, '2026-11-12');
		const nov = invoiceOf(summary, '2026-11');
		expect(nov.amountCents).toBe(80_000);
		expect(nov.paidCents).toBe(0);
		expect(nov.coveredPayments).toEqual([
			{ date: '2026-10-31', amountCents: 50_000 },
			{ date: '2026-11-01', amountCents: 5_000 },
		]);
		expect(summary.toPayCents).toBe(80_000);
		expect(invoiceStatusOf(nov, summary, '2026-11-12')).toEqual({ kind: 'toPay', amountCents: 80_000 });
		expect(reminderOf(summary, '2026-11')).toBe(80_000);
	});

	it('pagamento maior que a fatura seguinte: ela fica paga e a sobra é antecipado da aberta, como na janela da fechada', () => {
		const movements = [payment('2026-11-05', 50_000)];
		// Aberta: os R$ 500 inteiros são antecipado dela, como antes; o devido vira crédito.
		const open = buildCardSummary(card(), PURCHASES, movements, '2026-11-07');
		expect(invoiceOf(open, '2026-11').paidCents).toBe(50_000);
		expect(open.creditCents).toBe(20_000);

		// Fechada: paga até os R$ 300 dela; os R$ 200 que sobram abatem a de dezembro.
		const december = [...PURCHASES, purchase('2026-11-15', 15_000)];
		const summary = buildCardSummary(card(), december, movements, '2026-11-20');
		const nov = invoiceOf(summary, '2026-11');
		const dec = invoiceOf(summary, '2026-12');
		expect(nov.paidCents).toBe(30_000);
		expect(invoiceStatusOf(nov, summary, '2026-11-20')).toEqual({ kind: 'paid' });
		expect(dec.paidCents).toBe(20_000);
		expect(invoiceDueCents(dec, summary)).toBe(0);
		expect(reminderOf(summary, '2026-12')).toBeUndefined();
		expect(reportOf(summary, '2026-12')).toBe(0);
		// O que sobra depois de dezembro é o crédito do cartão, como antes.
		expect(summary.creditCents).toBe(5_000);
	});

	it('pagamento depois do fechamento paga a fatura fechada, como antes', () => {
		const summary = buildCardSummary(card(), PURCHASES, [payment('2026-11-12', 30_000)], '2026-11-13');
		const nov = invoiceOf(summary, '2026-11');
		expect(nov.paidCents).toBe(30_000);
		expect(summary.toPayCents).toBe(0);
		expect(invoiceStatusOf(nov, summary, '2026-11-13')).toEqual({ kind: 'paid' });
		expect(invoiceOf(summary, '2026-12').paidCents).toBe(0);
	});

	it('fatura anterior não zerada: o pagamento paga primeiro ela, como antes', () => {
		// Outubro informado com R$ 400 (âncora na véspera do fechamento de 10/10).
		const settings = card({ openingBalanceCents: -40_000, openingBalanceDate: '2026-10-09' });
		const movements = [payment('2026-11-05', 30_000)];

		const open = buildCardSummary(settings, PURCHASES, movements, '2026-11-07');
		const octOpen = invoiceOf(open, '2026-10');
		expect(octOpen.paidCents).toBe(30_000);
		expect(open.toPayCents).toBe(10_000);
		expect(invoiceOf(open, '2026-11').paidCents).toBe(0);

		const later = buildCardSummary(settings, PURCHASES, movements, '2026-11-12');
		const oct = invoiceOf(later, '2026-10');
		const nov = invoiceOf(later, '2026-11');
		expect(oct.paidCents).toBe(30_000);
		expect(oct.leftOpenCents).toBe(10_000);
		expect(nov.previousUnpaidCents).toBe(10_000);
		expect(nov.paidCents).toBe(0);
		expect(later.toPayCents).toBe(40_000);
		expect(reminderOf(later, '2026-11')).toBe(40_000);
	});
});
