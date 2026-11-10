/**
 * Estorno com saldo anterior (rotativo): o crédito do estorno é usado uma vez só (SPD-136,
 * dúvida do SPD-125). O cartão fecha dia 10 e vence dia 17; foi informado em 30/09 sem nada
 * devido. A fatura de outubro é o ciclo de 10/09 a 09/10, a de novembro o de 10/10 a 09/11, a
 * de dezembro o de 10/11 a 09/12 e a de janeiro o de 10/12 a 09/01.
 *
 * Outubro de R$ 500 com R$ 300 pagos deixa R$ 200 de saldo anterior em novembro. Se novembro
 * tem R$ 100 de compra e R$ 300 de estorno, o banco fecha novembro em zero: o estorno quitou o
 * saldo anterior. Antes, `carriedCredit` não sabia do saldo anterior e mandava os R$ 200 do
 * estorno também como crédito para dezembro — a fatura de R$ 50 de dezembro mostrava "falta
 * pagar" R$ 0, e o lembrete e os Relatórios não diziam nada, com o cartão devendo R$ 50.
 *
 * Em todos os cenários depois do fechamento, a soma do "falta pagar" das faturas (a fechada e a
 * aberta) é o devido do cartão: o número da tela bate com o do banco.
 */

import { cardInvoicesDue } from '../billReminders';
import {
	buildCardSummary,
	type CardEntry,
	type CardMovement,
	type CardSettings,
	type CardSummary,
	carriedCredit,
	cycleRuleOf,
	type InvoiceView,
	invoiceDueCents,
	invoiceStatusOf,
	invoicesClosingBetween,
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

/** A soma do "falta pagar" da fechada, da aberta e das futuras: tem de ser o devido do cartão. */
const dueSum = (summary: CardSummary): number =>
	summary.invoices.filter((invoice) => invoice.offset >= -1).reduce((sum, invoice) => sum + invoiceDueCents(invoice, summary), 0);

/** Outubro R$ 500, R$ 300 pagos em 12/10: R$ 200 de saldo anterior em novembro. */
const october = [purchase('2026-10-01', 50_000)];
const partialPayment = [payment('2026-10-12', 30_000)];

describe('estorno que quita o saldo anterior não vira crédito de novo (SPD-136)', () => {
	// Novembro: R$ 100 de compra e R$ 300 de estorno. Dezembro: R$ 50 de compra.
	const entries = [...october, purchase('2026-10-20', 10_000), refund('2026-11-05', 30_000), purchase('2026-11-11', 5_000)];

	it('dezembro aberto (12/11): falta pagar R$ 50, e o devido de R$ 50 bate com a soma das faturas', () => {
		const summary = buildCardSummary(card(), entries, partialPayment, '2026-11-12');
		expect(summary.owedCents).toBe(5_000);
		expect(summary.creditCents).toBe(0);

		// Novembro fechou em zero: o estorno cobriu os R$ 100 de compra e os R$ 200 de saldo anterior.
		const nov = invoiceOf(summary, '2026-11');
		expect(nov).toMatchObject({ offset: -1, amountCents: -20_000, previousUnpaidCents: 20_000 });
		expect(summary.toPayCents).toBe(0);
		expect(invoiceStatusOf(nov, summary, '2026-11-12')).toEqual({ kind: 'paid' });

		const dec = invoiceOf(summary, '2026-12');
		expect(dec).toMatchObject({ offset: 0, amountCents: 5_000, creditAppliedCents: 0, paidCents: 0 });
		expect(invoiceDueCents(dec, summary)).toBe(5_000);
		expect(reminderOf(summary, '2026-12')).toBe(5_000);
		expect(reportOf(summary, '2026-12')).toBe(5_000);
		expect(dueSum(summary)).toBe(summary.owedCents);
	});

	it('dezembro fechado (13/12) sem pagamento: a pagar R$ 50 e nenhum crédito ao lado', () => {
		const summary = buildCardSummary(card(), entries, partialPayment, '2026-12-13');
		const dec = invoiceOf(summary, '2026-12');
		expect(dec).toMatchObject({ offset: -1, amountCents: 5_000, creditAppliedCents: 0 });
		expect(summary.toPayCents).toBe(5_000);
		expect(invoiceStatusOf(dec, summary, '2026-12-13')).toEqual({ kind: 'toPay', amountCents: 5_000 });
		expect(dueSum(summary)).toBe(summary.owedCents);
	});

	it('dezembro pago (R$ 50 em 12/12): paga, e os R$ 50 não viram pagamento antecipado de janeiro', () => {
		const summary = buildCardSummary(card(), entries, [...partialPayment, payment('2026-12-12', 5_000)], '2026-12-13');
		const dec = invoiceOf(summary, '2026-12');
		expect(dec).toMatchObject({ creditAppliedCents: 0, paidCents: 5_000 });
		expect(summary.toPayCents).toBe(0);
		expect(invoiceStatusOf(dec, summary, '2026-12-13')).toEqual({ kind: 'paid' });
		expect(invoiceOf(summary, '2027-01').paidCents).toBe(0);
		expect(summary.owedCents).toBe(0);
		expect(dueSum(summary)).toBe(0);
	});

	it('carriedCredit: com os pagamentos, nada chega a dezembro; sem eles (o gasto do mês), segue como antes', () => {
		const rule = cycleRuleOf(card());
		if (rule === null) throw new Error('sem regra');
		expect(carriedCredit(card(), entries, rule, { movements: partialPayment, today: '2026-11-12' })('2026-12')).toBe(0);
		expect(carriedCredit(card(), entries, rule)('2026-12')).toBe(20_000);
		// "Gastou" do mês (`invoicesClosingBetween`) é gasto, não dívida: o estorno abate as compras.
		expect(invoicesClosingBetween(card(), entries, '2026-12-01', '2026-12-31')).toBe(0);
	});
});

describe('estorno maior que o saldo anterior: só a sobra passa (SPD-136)', () => {
	// Novembro: R$ 100 de compra e R$ 500 de estorno → o banco fecha em −R$ 200 (os R$ 200 de
	// saldo anterior saem dos R$ 400 do estorno).
	const november = [purchase('2026-10-20', 10_000), refund('2026-11-05', 50_000)];

	it('dezembro de R$ 300: abate R$ 200, falta pagar R$ 100', () => {
		const entries = [...october, ...november, purchase('2026-11-11', 30_000)];
		const summary = buildCardSummary(card(), entries, partialPayment, '2026-11-12');
		const dec = invoiceOf(summary, '2026-12');
		expect(dec).toMatchObject({ amountCents: 30_000, creditAppliedCents: 20_000, paidCents: 0 });
		expect(invoiceDueCents(dec, summary)).toBe(10_000);
		expect(reminderOf(summary, '2026-12')).toBe(10_000);
		expect(summary.owedCents).toBe(10_000);
		expect(dueSum(summary)).toBe(summary.owedCents);
	});

	it('dezembro de R$ 50: coberto pelo crédito, e sobram R$ 150 de crédito', () => {
		const entries = [...october, ...november, purchase('2026-11-11', 5_000)];
		const summary = buildCardSummary(card(), entries, partialPayment, '2026-11-12');
		const dec = invoiceOf(summary, '2026-12');
		expect(dec).toMatchObject({ amountCents: 5_000, creditAppliedCents: 5_000 });
		expect(invoiceDueCents(dec, summary)).toBe(0);
		expect(summary).toMatchObject({ owedCents: 0, creditCents: 15_000 });
		expect(dueSum(summary)).toBe(0);
	});
});

describe('duas faturas seguidas de crédito, com saldo anterior (SPD-136)', () => {
	// Novembro: R$ 100 − R$ 400 = −R$ 300; com os R$ 200 de saldo anterior, o banco fecha em −R$ 100.
	// Dezembro: R$ 50 − R$ 200 = −R$ 150; fecha em −R$ 250. Janeiro: R$ 400 → falta pagar R$ 150.
	const entries = [
		...october,
		purchase('2026-10-20', 10_000),
		refund('2026-11-05', 40_000),
		purchase('2026-11-20', 5_000),
		refund('2026-12-01', 20_000),
		purchase('2026-12-11', 40_000),
	];

	it('janeiro aberto (12/12): abate R$ 250, falta pagar R$ 150', () => {
		const summary = buildCardSummary(card(), entries, partialPayment, '2026-12-12');
		expect(invoiceOf(summary, '2026-12')).toMatchObject({ offset: -1, amountCents: -15_000 });
		expect(summary.toPayCents).toBe(0);
		const jan = invoiceOf(summary, '2027-01');
		expect(jan).toMatchObject({ offset: 0, amountCents: 40_000, creditAppliedCents: 25_000 });
		expect(invoiceDueCents(jan, summary)).toBe(15_000);
		expect(summary.owedCents).toBe(15_000);
		expect(dueSum(summary)).toBe(summary.owedCents);
	});
});

describe('o que não muda (SPD-136)', () => {
	it('estorno sem saldo anterior nem pagamento: o crédito inteiro passa para dezembro', () => {
		const entries = [purchase('2026-10-20', 10_000), refund('2026-11-05', 30_000), purchase('2026-11-11', 25_000)];
		const summary = buildCardSummary(card(), entries, [], '2026-11-12');
		const dec = invoiceOf(summary, '2026-12');
		expect(dec).toMatchObject({ amountCents: 25_000, creditAppliedCents: 20_000 });
		expect(invoiceDueCents(dec, summary)).toBe(5_000);
		expect(summary.owedCents).toBe(5_000);
		expect(dueSum(summary)).toBe(summary.owedCents);
	});

	it('outubro pago inteiro e estorno em novembro: dezembro recebe os R$ 200 de crédito', () => {
		const entries = [...october, purchase('2026-10-20', 10_000), refund('2026-11-05', 30_000), purchase('2026-11-11', 25_000)];
		const summary = buildCardSummary(card(), entries, [payment('2026-10-12', 50_000)], '2026-11-12');
		const dec = invoiceOf(summary, '2026-12');
		expect(dec).toMatchObject({ amountCents: 25_000, creditAppliedCents: 20_000, paidCents: 0 });
		expect(invoiceDueCents(dec, summary)).toBe(5_000);
		expect(summary.owedCents).toBe(5_000);
		expect(dueSum(summary)).toBe(summary.owedCents);
	});

	it('duas faturas seguidas de crédito, sem saldo anterior: o crédito soma e cobre janeiro', () => {
		const entries = [
			purchase('2026-10-20', 10_000),
			refund('2026-11-05', 40_000),
			purchase('2026-11-20', 5_000),
			refund('2026-12-01', 20_000),
			purchase('2026-12-11', 40_000),
		];
		const summary = buildCardSummary(card(), entries, [], '2026-12-12');
		const jan = invoiceOf(summary, '2027-01');
		expect(jan).toMatchObject({ amountCents: 40_000, creditAppliedCents: 40_000 });
		expect(invoiceDueCents(jan, summary)).toBe(0);
		expect(summary).toMatchObject({ owedCents: 0, creditCents: 5_000 });
		expect(dueSum(summary)).toBe(0);
	});

	it('fechada ainda no prazo: é cobrada inteira e o estorno da aberta vai para a fatura seguinte', () => {
		// Hoje 12/10: outubro (R$ 500) fechou, R$ 300 pagos, vence 19/10. Novembro, aberta, tem R$ 100 de
		// compra e R$ 300 de estorno. O app conta com o resto de outubro pago: os R$ 200 do estorno
		// abatem a parcela de dezembro, como antes — o saldo de outubro só é conhecido quando novembro fecha.
		const entries = [...october, purchase('2026-10-11', 10_000), refund('2026-10-12', 30_000), purchase('2026-11-11', 5_000)];
		const summary = buildCardSummary(card(), entries, partialPayment, '2026-10-12');
		expect(summary.toPayCents).toBe(20_000);
		expect(invoiceDueCents(invoiceOf(summary, '2026-11'), summary)).toBe(0);
		expect(invoiceOf(summary, '2026-12')).toMatchObject({ offset: 1, amountCents: 5_000, creditAppliedCents: 5_000 });
	});
});
