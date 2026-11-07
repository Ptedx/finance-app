/**
 * Encargos do cartão (SPD-092, E2E-20): juros, IOF, anuidade, multa e tarifas que o banco
 * cobra e nenhuma notificação de compra traz. Entram na fatura, no valor a pagar e no
 * limite, mas não são compra. Os números são os do teste no aparelho (`e2e/achados.md`).
 */

import {
	buildCardSummary,
	CARD_ADJUSTMENT_NOTE,
	CARD_CHARGE_NOTE,
	type CardChargeKind,
	type CardEntry,
	type CardMovement,
	type CardSettings,
	cardChargeDate,
	cardChargeKindOf,
	cardChargeNote,
	cardChargeShown,
	chargeMonthOptions,
	invoiceMonthOf,
	isCardAdjustment,
	isCardCharge,
	isCardNonPurchase,
	openInvoiceInformed,
	planCardAdjustment,
	splitCardCharges,
} from '../cardMath';

/** O Nubank do teste: fecha dia 10, vence 7 dias depois, cadastrado em 07/11 com a fatura aberta informada. */
const nubank = (overrides: Partial<CardSettings> = {}): CardSettings => ({
	closingDay: 10,
	closingDaysBefore: 7,
	creditLimitCents: 500_000,
	openingBalanceCents: 0,
	openingBalanceDate: '2026-11-06',
	...overrides,
});

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

const charge = (date: string, cents: number, kind: CardChargeKind = 'bank'): CardEntry =>
	purchase(date, cents, { note: cardChargeNote(kind), category: 'other_expense' });

const TODAY = '2026-11-07';

/**
 * O "Acertar valor" como o AccountsContext faz quando o dono responde "sim, é encargo": a
 * diferença a mais vira encargo, o resto segue pelo `planCardAdjustment` de sempre.
 */
const acertar = (
	settings: CardSettings,
	entries: CardEntry[],
	movements: CardMovement[],
	today: string,
	openTyped: number | null,
	closedTyped: number | null
) => {
	const shown = cardChargeShown(settings, buildCardSummary(settings, entries, movements, today));
	const split = splitCardCharges(shown, today, openTyped, closedTyped);
	const plan = planCardAdjustment(settings, entries, movements, today, split.openCents, split.closedCents);
	const nextSettings = plan.anchor ? { ...settings, openingBalanceCents: plan.anchor.cents, openingBalanceDate: plan.anchor.date } : settings;
	const added = [
		...(plan.adjustmentCents === 0
			? []
			: [purchase(today, Math.abs(plan.adjustmentCents), { isIncome: plan.adjustmentCents < 0, note: CARD_ADJUSTMENT_NOTE })]),
		...split.charges.map((item) => charge(item.date, item.cents)),
	];
	return { split, plan, settings: nextSettings, entries: [...entries, ...added] };
};

/** O que o "comprados no mês" soma: à vista, sem ajuste nem encargo. */
const boughtCents = (entries: CardEntry[]) =>
	entries.filter((entry) => !entry.isIncome && !entry.installmentGroup && !isCardNonPurchase(entry)).reduce((sum, entry) => sum + entry.amountCents, 0);

describe('isCardCharge — o lançamento de encargo do cartão', () => {
	it('reconhece a nota-marcador, com ou sem o tipo', () => {
		for (const kind of ['interest', 'iof', 'annualFee', 'fee', 'other', 'bank'] as CardChargeKind[]) {
			expect(isCardCharge(charge(TODAY, 1_000, kind))).toBe(true);
		}
		expect(isCardCharge(purchase(TODAY, 1_000, { note: `  ${CARD_CHARGE_NOTE}  ` }))).toBe(true);
		expect(isCardCharge(purchase(TODAY, 1_000, { note: `${CARD_CHARGE_NOTE} (seguro)` }))).toBe(true);
	});

	it('compra comum, nota parecida, ajuste e parcela não são encargo', () => {
		expect(isCardCharge(purchase(TODAY, 1_000))).toBe(false);
		expect(isCardCharge(purchase(TODAY, 1_000, { note: `${CARD_CHARGE_NOTE} extra` }))).toBe(false);
		expect(isCardCharge(purchase(TODAY, 1_000, { note: 'encargo do cartão' }))).toBe(false);
		expect(isCardCharge(purchase(TODAY, 1_000, { note: null as unknown as string }))).toBe(false);
		expect(isCardCharge(purchase(TODAY, 1_000, { note: CARD_ADJUSTMENT_NOTE }))).toBe(false);
		expect(isCardCharge(purchase(TODAY, 1_000, { note: cardChargeNote('interest'), installmentGroup: 'g' }))).toBe(false);
	});

	it('o tipo volta da nota; tipo desconhecido é "outro"', () => {
		expect(cardChargeKindOf(cardChargeNote('interest'))).toBe('interest');
		expect(cardChargeKindOf(cardChargeNote('iof'))).toBe('iof');
		expect(cardChargeKindOf(cardChargeNote('annualFee'))).toBe('annualFee');
		expect(cardChargeKindOf(cardChargeNote('fee'))).toBe('fee');
		expect(cardChargeKindOf(cardChargeNote('bank'))).toBe('bank');
		expect(cardChargeKindOf(CARD_CHARGE_NOTE)).toBe('other');
		expect(cardChargeKindOf(`${CARD_CHARGE_NOTE} (seguro)`)).toBe('other');
		expect(cardChargeKindOf('Padaria')).toBeNull();
	});

	it('nem ajuste nem encargo são compra', () => {
		expect(isCardNonPurchase(charge(TODAY, 3_890))).toBe(true);
		expect(isCardNonPurchase(purchase(TODAY, 3_890, { note: CARD_ADJUSTMENT_NOTE }))).toBe(true);
		expect(isCardNonPurchase(purchase(TODAY, 3_890))).toBe(false);
		// O encargo não é o ajuste: quem só tira o ajuste (o "informado" do SPD-085) o deixa.
		expect(isCardAdjustment(charge(TODAY, 3_890))).toBe(false);
	});
});

describe('"Acertar valor" com a diferença como encargo (E2E-20)', () => {
	// Nubank: fatura informada R$ 1.234,56 (âncora de 06/11), compra de R$ 100 e a parcela
	// 2/5 de R$ 300 em 07/11 — o app mostra R$ 1.634,56; o banco, R$ 1.673,46.
	const settings = nubank({ openingBalanceCents: -123_456 });
	const entries = [
		purchase(TODAY, 10_000),
		purchase(TODAY, 30_000, { note: 'Notebook (2/5)', category: 'education', installmentGroup: 'nb', installmentIndex: 2, installmentCount: 5 }),
	];

	it('app R$ 1.634,56, banco R$ 1.673,46: encargo de R$ 38,90 na mesma fatura', () => {
		expect(buildCardSummary(settings, entries, [], TODAY).openInvoiceCents).toBe(163_456);

		const result = acertar(settings, entries, [], TODAY, 167_346, null);
		expect(result.split).toEqual({ openCents: 163_456, closedCents: null, charges: [{ date: TODAY, cents: 3_890 }], totalCents: 3_890 });
		expect(result.plan).toEqual({ anchor: null, adjustmentCents: 0 });

		const summary = buildCardSummary(result.settings, result.entries, [], TODAY);
		expect(summary.openInvoiceCents).toBe(167_346);
		expect(summary.owedCents).toBe(167_346);
		expect(summary.limitAvailableCents).toBe(500_000 - 167_346);
		// O encargo é desta fatura: novembro, que fecha em 10/11.
		expect(invoiceMonthOf(TODAY, { closingDay: 10, dueDaysAfter: 7 })).toBe('2026-11');

		// Depois do fechamento é o valor a pagar.
		const closed = buildCardSummary(result.settings, result.entries, [], '2026-11-12');
		expect(closed.toPayCents).toBe(167_346);
		expect(closed.closedInvoiceCents).toBe(167_346);

		// "Comprados no mês" não muda: R$ 100 à vista antes e depois.
		expect(boughtCents(entries)).toBe(10_000);
		expect(boughtCents(result.entries)).toBe(10_000);
	});

	it('banco menor que o app: nada vira encargo, segue o ajuste de sempre', () => {
		const shown = cardChargeShown(settings, buildCardSummary(settings, entries, [], TODAY));
		expect(splitCardCharges(shown, TODAY, 160_000, null)).toEqual({ openCents: 160_000, closedCents: null, charges: [], totalCents: 0 });
	});

	it('fatura igual ou não informada: nada a perguntar', () => {
		const shown = cardChargeShown(settings, buildCardSummary(settings, entries, [], TODAY));
		expect(splitCardCharges(shown, TODAY, 163_456, null).totalCents).toBe(0);
		expect(splitCardCharges(shown, TODAY, null, null).totalCents).toBe(0);
	});

	// Dezembro de R$ 500 não pago; em 11/01 o app mostra janeiro fechada R$ 800 (500 + a
	// parcela de 300) e o banco cobra R$ 870 — os R$ 70 são os juros do rotativo.
	it('fatura fechada com juros: o encargo entra nela, na véspera do fechamento', () => {
		const late = nubank();
		const ledger = [
			purchase('2026-11-20', 50_000),
			purchase('2026-12-10', 30_000, { note: 'Notebook (3/5)', installmentGroup: 'nb', installmentIndex: 3, installmentCount: 5 }),
		];
		const today = '2027-01-11';
		const before = buildCardSummary(late, ledger, [], today);
		expect(before.toPayCents).toBe(80_000);

		const result = acertar(late, ledger, [], today, null, 87_000);
		expect(result.split).toEqual({ openCents: null, closedCents: null, charges: [{ date: '2027-01-09', cents: 7_000 }], totalCents: 7_000 });
		// A fechada não foi ancorada de novo: o histórico das faturas fica como estava.
		expect(result.plan.anchor).toBeNull();

		const after = buildCardSummary(result.settings, result.entries, [], today);
		expect(after.toPayCents).toBe(87_000);
		const january = after.invoices.find((invoice) => invoice.offset === -1);
		expect(january).toMatchObject({ amountCents: 37_000, previousUnpaidCents: 50_000 });
	});

	it('fechada e aberta a mais: um encargo em cada fatura, e a soma na pergunta', () => {
		const late = nubank();
		const ledger = [purchase('2026-11-20', 50_000), purchase('2026-12-10', 30_000)];
		const today = '2027-01-11';
		const result = acertar(late, ledger, [], today, 1_500, 87_000);
		expect(result.split.charges).toEqual([
			{ date: '2027-01-09', cents: 7_000 },
			{ date: today, cents: 1_500 },
		]);
		expect(result.split.totalCents).toBe(8_500);
		const after = buildCardSummary(result.settings, result.entries, [], today);
		expect(after).toMatchObject({ toPayCents: 87_000, openInvoiceCents: 1_500 });
	});

	it('fechada a mais, mas a âncora já está nela: a diferença vai para a âncora, como antes', () => {
		// Inter cadastrado em 07/11 com a fechada de R$ 2.000: âncora em 04/11, o último dia dela.
		const inter = nubank({ closingDay: 5, openingBalanceCents: -200_000, openingBalanceDate: '2026-11-04' });
		const shown = cardChargeShown(inter, buildCardSummary(inter, [], [], TODAY));
		expect(shown).toEqual({ openCents: 0, closedCents: 200_000, closedChargeDate: null });
		expect(splitCardCharges(shown, TODAY, null, 210_000)).toEqual({ openCents: null, closedCents: 210_000, charges: [], totalCents: 0 });
	});

	it('fechada a mais com a fechada já paga: sem encargo (o app não sabe o que sobrou dela)', () => {
		const late = nubank();
		const ledger = [purchase('2026-12-10', 30_000)];
		const paid: CardMovement[] = [{ date: '2027-01-11', amountCents: 30_000, inbound: true }];
		const shown = cardChargeShown(late, buildCardSummary(late, ledger, paid, '2027-01-11'));
		expect(shown.closedChargeDate).toBeNull();
	});

	it('sem dia de fechamento: o encargo entra hoje e o devido dá o informado', () => {
		const loose = nubank({ closingDay: null, closingDaysBefore: null });
		const ledger = [purchase(TODAY, 10_000)];
		const result = acertar(loose, ledger, [], TODAY, 12_500, null);
		expect(result.split.charges).toEqual([{ date: TODAY, cents: 2_500 }]);
		expect(buildCardSummary(result.settings, result.entries, [], TODAY).owedCents).toBe(12_500);
	});
});

describe('"Registrar encargo" — a data põe o encargo na fatura do ciclo', () => {
	it('anuidade de R$ 25 em 15/11, fechamento dia 10: fatura de dezembro', () => {
		const date = cardChargeDate('2026-11', 15);
		expect(date).toBe('2026-11-15');
		const settings = nubank({ openingBalanceCents: -123_456 });
		const summary = buildCardSummary(settings, [charge(date as string, 2_500, 'annualFee')], [], TODAY);
		expect(invoiceMonthOf(date as string, { closingDay: 10, dueDaysAfter: 7 })).toBe('2026-12');
		expect(summary.openInvoiceCents).toBe(123_456);
		expect(summary.invoices.find((invoice) => invoice.cycle.key === '2026-12')?.amountCents).toBe(2_500);
		// Já ocupa o limite, como uma compra lançada para a fatura seguinte.
		expect(summary.limitUsedCents).toBe(123_456 + 2_500);
	});

	it('os meses que a folha oferece: dois para trás, o atual e o seguinte', () => {
		expect(chargeMonthOptions(TODAY)).toEqual(['2026-09', '2026-10', '2026-11', '2026-12']);
		expect(chargeMonthOptions('2027-01-15')).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
	});

	it('dia que não existe no mês não vira data', () => {
		expect(cardChargeDate('2026-02', 30)).toBeNull();
		expect(cardChargeDate('2026-11', 0)).toBeNull();
		expect(cardChargeDate('2026-11', 1.5)).toBeNull();
		expect(cardChargeDate('2026-11', 30)).toBe('2026-11-30');
	});
});

describe('openInvoiceInformed — o encargo do "Acertar valor" também informa a fatura', () => {
	it('encargo pela fatura do banco no ciclo aberto conta como informada; o registrado à mão, não', () => {
		expect(openInvoiceInformed(nubank(), [charge(TODAY, 3_890, 'bank')], TODAY)).toBe(true);
		expect(openInvoiceInformed(nubank(), [charge(TODAY, 2_500, 'annualFee')], TODAY)).toBe(false);
	});
});
