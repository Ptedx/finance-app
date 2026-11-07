/**
 * Cartão cadastrado com a fatura que o banco mostra (SPD-085): a fatura fechada em aberto,
 * o ajuste que não é compra, a parcela antiga que já está na fatura informada e o saldo
 * anterior não pago. Os números são os do teste no aparelho (`e2e/achados.md`, E2E-06 a 21).
 */

import {
	buildCardSummary,
	CARD_ADJUSTMENT_NOTE,
	type CardEntry,
	type CardMovement,
	type CardSettings,
	existingInstallmentDates,
	invoiceAmount,
	invoiceStatusOf,
	invoicesToInform,
	isCardAdjustment,
	openInvoiceInformed,
	planCardOpening,
} from '../cardMath';

/** O Nubank do teste: fecha dia 10, vence 7 dias depois. */
const nubank = (overrides: Partial<CardSettings> = {}): CardSettings => ({
	closingDay: 10,
	closingDaysBefore: 7,
	creditLimitCents: 500_000,
	openingBalanceCents: 0,
	openingBalanceDate: '2026-11-06',
	...overrides,
});

/** O Inter do teste: fecha dia 5, vence 7 dias depois. */
const inter = (overrides: Partial<CardSettings> = {}): CardSettings => nubank({ closingDay: 5, ...overrides });

let seq = 0;
const purchase = (date: string, amountCents: number, overrides: Partial<CardEntry> = {}): CardEntry => ({
	id: `e${++seq}`,
	amountCents,
	isIncome: false,
	date,
	note: 'Compra',
	category: 'shopping',
	installmentGroup: null,
	installmentIndex: null,
	installmentCount: null,
	...overrides,
});

const adjustment = (date: string, cents: number): CardEntry =>
	purchase(date, Math.abs(cents), {
		isIncome: cents < 0,
		note: CARD_ADJUSTMENT_NOTE,
		category: cents < 0 ? 'other_income' : 'other_expense',
	});

const payment = (date: string, amountCents: number): CardMovement => ({ date, amountCents, inbound: true });

/** Aplica um plano de abertura como o AccountsContext: âncora nova e, se houver, o ajuste de hoje. */
const apply = (settings: CardSettings, plan: ReturnType<typeof planCardOpening>, today: string) => ({
	settings: plan.anchor ? { ...settings, openingBalanceCents: plan.anchor.cents, openingBalanceDate: plan.anchor.date } : settings,
	entries: plan.adjustmentCents === 0 ? [] : [adjustment(today, plan.adjustmentCents)],
});

const TODAY = '2026-11-07';

describe('isCardAdjustment — o lançamento de ajuste com a fatura do banco', () => {
	it('reconhece pela nota-marcador, nos dois sentidos', () => {
		expect(isCardAdjustment(adjustment(TODAY, 200_000))).toBe(true);
		expect(isCardAdjustment(adjustment(TODAY, -192_000))).toBe(true);
	});

	it('compra comum, nota parecida ou parcela não são ajuste', () => {
		expect(isCardAdjustment(purchase(TODAY, 5_000))).toBe(false);
		expect(isCardAdjustment(purchase(TODAY, 5_000, { note: 'Ajuste' }))).toBe(false);
		expect(isCardAdjustment(purchase(TODAY, 5_000, { note: null as unknown as string }))).toBe(false);
		expect(
			isCardAdjustment(purchase(TODAY, 5_000, { note: CARD_ADJUSTMENT_NOTE, installmentGroup: 'g', installmentIndex: 1, installmentCount: 2 }))
		).toBe(false);
	});
});

describe('invoicesToInform — o que o cadastro pergunta (E2E-08)', () => {
	it('Inter em 07/11: a de novembro fechou em 05/11 e vence 12/11 — pergunta as duas', () => {
		const asked = invoicesToInform({ closingDay: 5, dueDaysAfter: 7 }, TODAY);
		expect(asked.closed).toMatchObject({ key: '2026-11', closingDate: '2026-11-05', dueDate: '2026-11-12' });
		expect(asked.open).toMatchObject({ key: '2026-12', closingDate: '2026-12-05', dueDate: '2026-12-14' });
	});

	it('Nubank em 07/11: a de outubro já venceu em 19/10 — só a aberta, de novembro', () => {
		const asked = invoicesToInform({ closingDay: 10, dueDaysAfter: 7 }, TODAY);
		expect(asked.closed).toBeNull();
		expect(asked.open).toMatchObject({ key: '2026-11', closingDate: '2026-11-10' });
	});

	it('no dia do vencimento ainda pergunta a fechada; no dia seguinte, não', () => {
		const rule = { closingDay: 5, dueDaysAfter: 7 };
		expect(invoicesToInform(rule, '2026-11-12').closed?.key).toBe('2026-11');
		expect(invoicesToInform(rule, '2026-11-13').closed).toBeNull();
	});
});

describe('planCardOpening — a fatura informada no cadastro', () => {
	it('fora da janela, a fatura aberta vira âncora na véspera e nenhum lançamento (E2E-06)', () => {
		const plan = planCardOpening(nubank(), [], [], TODAY, 123_456, null);
		expect(plan).toEqual({ anchor: { date: '2026-11-06', cents: -123_456 }, adjustmentCents: 0 });

		const { settings } = apply(nubank(), plan, TODAY);
		// A padaria de 01/11, lançada depois, já está no valor informado; a de hoje soma.
		const entries = [purchase('2026-11-01', 5_000), purchase(TODAY, 10_000)];
		const summary = buildCardSummary(settings, entries, [], TODAY);
		expect(summary).toMatchObject({ openInvoiceCents: 133_456, owedCents: 133_456, toPayCents: 0, closedInvoiceCents: 0 });
	});

	it('a compra que o conserto trouxe da conta corrente para o ciclo aberto não soma em cima do valor', () => {
		// Compra de 03/11 (antes da âncora, já no valor do banco) e uma de hoje (depois).
		const entries = [purchase('2026-11-03', 4_000), purchase(TODAY, 1_000)];
		const plan = planCardOpening(nubank(), entries, [], TODAY, 123_456, null);
		const { settings } = apply(nubank(), plan, TODAY);
		expect(plan.adjustmentCents).toBe(0);
		expect(buildCardSummary(settings, entries, [], TODAY).openInvoiceCents).toBe(123_456);
	});

	it('na janela, fechada R$ 2.000 e aberta R$ 80: cada valor na sua fatura (E2E-08)', () => {
		const plan = planCardOpening(inter(), [], [], TODAY, 8_000, 200_000);
		expect(plan).toEqual({ anchor: { date: '2026-11-04', cents: -200_000 }, adjustmentCents: 8_000 });

		const { settings, entries } = apply(inter(), plan, TODAY);
		const summary = buildCardSummary(settings, entries, [], TODAY);
		expect(summary).toMatchObject({
			closedInvoiceCents: 200_000,
			toPayCents: 200_000,
			openInvoiceCents: 8_000,
			closedStatus: 'due',
			daysToDue: 5,
		});
		expect(summary.closedCycle?.dueDate).toBe('2026-11-12');
	});

	it('na janela, só a fechada: a aberta fica no que o app já tem', () => {
		const plan = planCardOpening(inter(), [], [], TODAY, null, 200_000);
		expect(plan).toEqual({ anchor: { date: '2026-11-04', cents: -200_000 }, adjustmentCents: 0 });
	});

	it('no dia do fechamento a véspera é da fatura fechada: a aberta vai como ajuste', () => {
		const plan = planCardOpening(inter(), [], [], '2026-11-05', 8_000, null);
		expect(plan).toEqual({ anchor: null, adjustmentCents: 8_000 });
	});

	it('sem fechamento, a soma vira âncora na véspera', () => {
		const plan = planCardOpening(nubank({ closingDay: null, closingDaysBefore: null }), [], [], TODAY, 123_456, null);
		expect(plan).toEqual({ anchor: { date: '2026-11-06', cents: -123_456 }, adjustmentCents: 0 });
	});

	it('nada informado não muda nada', () => {
		expect(planCardOpening(nubank(), [], [], TODAY, null, null)).toEqual({ anchor: null, adjustmentCents: 0 });
	});
});

describe('openInvoiceInformed — a fatura aberta já tem o valor do banco', () => {
	it('âncora com valor dentro do ciclo aberto', () => {
		expect(openInvoiceInformed(nubank({ openingBalanceCents: -123_456 }), [], TODAY)).toBe(true);
	});

	it('cartão cadastrado do jeito antigo: âncora zero e ajuste no ciclo aberto', () => {
		expect(openInvoiceInformed(nubank(), [adjustment(TODAY, 123_456)], TODAY)).toBe(true);
	});

	it('nada informado: âncora zero e sem ajuste, ou ajuste só numa fatura antiga', () => {
		expect(openInvoiceInformed(nubank(), [purchase(TODAY, 10_000)], TODAY)).toBe(false);
		expect(openInvoiceInformed(nubank({ openingBalanceDate: '2026-09-01' }), [adjustment('2026-09-15', 10_000)], TODAY)).toBe(false);
	});

	it('âncora com valor na fatura fechada não diz nada da aberta', () => {
		expect(openInvoiceInformed(inter({ openingBalanceCents: -200_000, openingBalanceDate: '2026-11-04' }), [], TODAY)).toBe(false);
	});
});

describe('existingInstallmentDates — parcela que já está na fatura informada (E2E-18)', () => {
	it('a 2/5 fica de fora; entram 3/5, 4/5 e 5/5 em dez, jan e fev', () => {
		const rule = { closingDay: 10, dueDaysAfter: 7 };
		const dates = existingInstallmentDates(2, 5, rule, TODAY, '2026-11-06', true);
		expect(dates).toEqual([
			{ index: 3, date: '2026-11-10' },
			{ index: 4, date: '2026-12-10' },
			{ index: 5, date: '2027-01-10' },
		]);

		// Fatura informada R$ 1.234,56 + compra de R$ 100: novembro continua R$ 1.334,56.
		const settings = nubank({ openingBalanceCents: -123_456 });
		const parcels = dates.map((d) => purchase(d.date, 30_000, { installmentGroup: 'g', installmentIndex: d.index, installmentCount: 5 }));
		const summary = buildCardSummary(settings, [purchase(TODAY, 10_000), ...parcels], [], TODAY);
		expect(summary.openInvoiceCents).toBe(133_456);
		expect(summary.invoices.filter((i) => i.offset >= 0).map((i) => [i.cycle.key, i.amountCents])).toEqual([
			['2026-11', 133_456],
			['2026-12', 30_000],
			['2027-01', 30_000],
			['2027-02', 30_000],
		]);
		expect(summary.installmentPlans[0]).toMatchObject({ totalCount: 5, remainingCount: 3 });
	});

	it('a última parcela já na fatura informada: nada a criar', () => {
		expect(existingInstallmentDates(5, 5, { closingDay: 10, dueDaysAfter: 7 }, TODAY, '2026-11-06', true)).toEqual([]);
	});

	it('sem fechamento, as seguintes de mês em mês a partir do mês que vem', () => {
		expect(existingInstallmentDates(2, 4, null, TODAY, '2026-11-06', true)).toEqual([
			{ index: 3, date: '2026-12-07' },
			{ index: 4, date: '2027-01-07' },
		]);
	});

	it('sem valor informado continua como antes: a parcela atual entra na fatura aberta', () => {
		expect(existingInstallmentDates(2, 3, { closingDay: 10, dueDaysAfter: 7 }, TODAY, '2026-11-06')[0]).toEqual({
			index: 2,
			date: TODAY,
		});
	});
});

describe('saldo anterior não pago (E2E-21)', () => {
	// Dezembro (10/11–09/12) com R$ 500 e ninguém pagou; janeiro com a parcela de R$ 300.
	const entries = [purchase('2026-11-20', 50_000), purchase('2026-12-10', 30_000)];
	const JAN_11 = '2027-01-11';

	it('janeiro mostra os R$ 500 que vieram de dezembro; a pagar R$ 800', () => {
		const summary = buildCardSummary(nubank(), entries, [], JAN_11);
		const jan = summary.invoices.find((i) => i.offset === -1);
		expect(jan).toMatchObject({ amountCents: 30_000, previousUnpaidCents: 50_000 });
		expect(summary.toPayCents).toBe(80_000);
		expect(summary.closedCycle?.dueDate).toBe('2027-01-18');
	});

	it('dezembro diz que ficou em aberto, em vez de só "venceu"', () => {
		const summary = buildCardSummary(nubank(), entries, [], JAN_11);
		const dec = summary.invoices.find((i) => i.offset === -2);
		expect(dec).toMatchObject({ amountCents: 50_000, leftOpenCents: 50_000 });
		expect(invoiceStatusOf(dec as NonNullable<typeof dec>, summary, JAN_11)).toEqual({ kind: 'leftOpen', amountCents: 50_000 });
	});

	it('pagar os R$ 800 quita janeiro inteiro, sem virar pagamento antecipado', () => {
		const summary = buildCardSummary(nubank(), entries, [payment('2027-01-15', 80_000)], '2027-01-16');
		const jan = summary.invoices.find((i) => i.offset === -1);
		const feb = summary.invoices.find((i) => i.offset === 0);
		expect(jan?.paidCents).toBe(80_000);
		expect(feb?.paidCents).toBe(0);
		expect(summary.toPayCents).toBe(0);
		expect(invoiceStatusOf(jan as NonNullable<typeof jan>, summary, '2027-01-16')).toEqual({ kind: 'paid' });
	});

	it('dezembro pago em dia não deixa saldo anterior', () => {
		const summary = buildCardSummary(nubank(), entries, [payment('2026-12-15', 50_000)], JAN_11);
		expect(summary.invoices.find((i) => i.offset === -1)?.previousUnpaidCents).toBe(0);
		expect(summary.invoices.find((i) => i.offset === -2)?.leftOpenCents).toBe(0);
		expect(summary.toPayCents).toBe(30_000);
	});

	it('antes da âncora o app não sabe de saldo anterior: o valor informado não vira dívida velha', () => {
		const summary = buildCardSummary(nubank({ openingBalanceCents: -123_456 }), [], [], TODAY);
		expect(summary.invoices.every((i) => i.previousUnpaidCents === 0 && i.leftOpenCents === 0)).toBe(true);
	});
});

describe('invoiceStatusOf — o chip de cada fatura', () => {
	it('fechada sem valor com vencimento por vir: "vence", nunca "venceu" (E2E-09)', () => {
		const summary = buildCardSummary(inter(), [], [], TODAY);
		const closed = summary.invoices.find((i) => i.offset === -1);
		expect(closed?.cycle.dueDate).toBe('2026-11-12');
		expect(invoiceStatusOf(closed as NonNullable<typeof closed>, summary, TODAY)).toEqual({ kind: 'closedUpcoming' });
	});

	it('fechada sem valor que já venceu: "venceu"', () => {
		const summary = buildCardSummary(nubank(), [], [], TODAY);
		const closed = summary.invoices.find((i) => i.offset === -1);
		expect(invoiceStatusOf(closed as NonNullable<typeof closed>, summary, TODAY)).toEqual({ kind: 'closedPast' });
	});

	it('fechada informada no cadastro: a pagar até o vencimento', () => {
		const settings = inter({ openingBalanceCents: -200_000, openingBalanceDate: '2026-11-04' });
		const summary = buildCardSummary(settings, [], [], TODAY);
		const closed = summary.invoices.find((i) => i.offset === -1);
		expect(invoiceStatusOf(closed as NonNullable<typeof closed>, summary, TODAY)).toEqual({ kind: 'toPay', amountCents: 200_000 });
	});

	it('aberta e futura', () => {
		const summary = buildCardSummary(nubank(), [purchase('2026-12-01', 1_000)], [], TODAY);
		const [open, future] = [summary.invoices.find((i) => i.offset === 0), summary.invoices.find((i) => i.offset === 1)];
		expect(invoiceStatusOf(open as NonNullable<typeof open>, summary, TODAY)).toEqual({ kind: 'open' });
		expect(invoiceStatusOf(future as NonNullable<typeof future>, summary, TODAY)).toEqual({ kind: 'future' });
	});
});

describe('ajuste conta na fatura, como antes', () => {
	it('o ajuste antigo de R$ 1.234,56 continua dentro do valor da fatura', () => {
		const settings = nubank();
		const summary = buildCardSummary(settings, [adjustment(TODAY, 123_456), purchase('2026-11-01', 5_000)], [], TODAY);
		expect(summary.openInvoiceCents).toBe(123_456);
		expect(invoiceAmount(summary.openCycle as NonNullable<typeof summary.openCycle>, settings, [adjustment(TODAY, 123_456)])).toBe(123_456);
	});
});
