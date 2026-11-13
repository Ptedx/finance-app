/**
 * Mudar o dia de fechamento não leva a fatura informada para outra fatura (SPD-179). O cartão
 * fechava dia 27 no app, e o "Acertar valor" pôs a fatura de outubro do banco (R$ 8.422,77) na
 * véspera do fechamento, 26/10. Em 03/11 o dono pagou R$ 8.422,78. O banco fecha dia 26: trocado
 * o dia, 26/10 passava a ser o primeiro dia da fatura de novembro, que pulava para R$ 9.779,67, e
 * outubro aparecia sem nada a pagar. Com a âncora movida junto, outubro continua R$ 8.422,77 e
 * paga, e novembro continua R$ 1.356,90.
 */

import {
	buildCardSummary,
	type CardEntry,
	type CardMovement,
	type CardSettings,
	type CardSummary,
	cycleRuleOf,
	invoiceChangesForRule,
	owedOn,
	reanchorForRule,
} from '../cardMath';

const TODAY = '2026-11-13';

const card = (overrides: Partial<CardSettings> = {}): CardSettings => ({
	closingDay: 27,
	closingDaysBefore: 7,
	dueDay: 3,
	creditLimitCents: 2_000_000,
	openingBalanceCents: -842_277,
	openingBalanceDate: '2026-10-26',
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
const payment = (date: string, amountCents: number): CardMovement => ({
	date,
	amountCents,
	inbound: true,
});

/** R$ 1.356,90 de compras de novembro, depois do fechamento de outubro. */
const NOVEMBER = [purchase('2026-10-28', 100_000), purchase('2026-11-10', 35_690)];
const PAID = [payment('2026-11-03', 842_278)];

/** O cartão com o novo dia de fechamento e a âncora no lugar. */
const withClosing = (
	settings: CardSettings,
	closingDay: number,
	entries: CardEntry[],
	movements: CardMovement[]
): CardSettings => {
	const moved = { ...settings, closingDay };
	return { ...moved, ...reanchorForRule(settings, cycleRuleOf(moved), entries, movements) };
};

const amountOf = (summary: CardSummary, key: string): number =>
	summary.invoices.find((invoice) => invoice.cycle.key === key)?.amountCents ?? 0;

describe('mudar o dia de fechamento (SPD-179)', () => {
	it('de 27 para 26: outubro continua R$ 8.422,77 e paga, novembro continua R$ 1.356,90', () => {
		const before = buildCardSummary(card(), NOVEMBER, PAID, TODAY);
		expect(amountOf(before, '2026-10')).toBe(842_277);
		expect(amountOf(before, '2026-11')).toBe(135_690);

		const settings = withClosing(card(), 26, NOVEMBER, PAID);
		expect(settings.openingBalanceDate).toBe('2026-10-25');
		expect(settings.openingBalanceCents).toBe(-842_277);
		const after = buildCardSummary(settings, NOVEMBER, PAID, TODAY);
		expect(after.closedCycle?.key).toBe('2026-10');
		expect(amountOf(after, '2026-10')).toBe(842_277);
		expect(amountOf(after, '2026-11')).toBe(135_690);
		expect(after.closedStatus).toBe('paid');
		expect(after.toPayCents).toBe(0);
		expect(after.owedCents).toBe(before.owedCents);
	});

	it('sem mover a âncora, novembro pulava para R$ 9.779,67 (o defeito)', () => {
		const broken = buildCardSummary(card({ closingDay: 26 }), NOVEMBER, PAID, TODAY);
		expect(amountOf(broken, '2026-11')).toBe(842_277 + 135_690);
	});

	it('o aviso antes de salvar mostra o que muda: nada com a âncora no lugar, o pulo sem ela', () => {
		const settings = withClosing(card(), 26, NOVEMBER, PAID);
		expect(invoiceChangesForRule(card(), settings, NOVEMBER, PAID, TODAY)).toEqual([]);
		expect(invoiceChangesForRule(card(), card({ closingDay: 26 }), NOVEMBER, PAID, TODAY)).toEqual([
			{ key: '2026-10', closingDate: '2026-10-26', beforeCents: 842_277, afterCents: 0 },
			{ key: '2026-11', closingDate: '2026-11-26', beforeCents: 135_690, afterCents: 977_967 },
		]);
	});

	it('compra do dia que muda de lado vai para a fatura que o banco diz', () => {
		// O banco fecha 26: a compra de 26/10 é de novembro. Com o app fechando 27 ela ficava
		// dentro da âncora de outubro, que o banco não cobrou; agora volta para novembro.
		const entries = [...NOVEMBER, purchase('2026-10-26', 5_000)];
		const settings = withClosing(card(), 26, entries, PAID);
		const after = buildCardSummary(settings, entries, PAID, TODAY);
		expect(amountOf(after, '2026-10')).toBe(842_277);
		expect(amountOf(after, '2026-11')).toBe(140_690);
		expect(invoiceChangesForRule(card(), settings, entries, PAID, TODAY)).toEqual([
			{ key: '2026-11', closingDate: '2026-11-26', beforeCents: 135_690, afterCents: 140_690 },
		]);
	});

	it('de 26 para 27: a compra do dia 26 fica dentro da fatura de outubro que o banco mostrou', () => {
		const start = card({ closingDay: 26, openingBalanceDate: '2026-10-25' });
		const entries = [...NOVEMBER, purchase('2026-10-26', 5_000)];
		const settings = withClosing(start, 27, entries, PAID);
		expect(settings.openingBalanceDate).toBe('2026-10-26');
		expect(settings.openingBalanceCents).toBe(-842_277);
		expect(amountOf(buildCardSummary(settings, entries, PAID, TODAY), '2026-10')).toBe(842_277);
	});

	it('pagamento do dia que muda de lado não mexe no devido', () => {
		const movements = [payment('2026-10-26', 20_000), ...PAID];
		const settings = withClosing(card(), 26, NOVEMBER, movements);
		expect(owedOn(settings, NOVEMBER, movements, TODAY)).toBe(
			owedOn(card(), NOVEMBER, movements, TODAY)
		);
	});

	it('sem compras nos dias que mudam, o devido é o mesmo para qualquer novo dia', () => {
		const movements = [payment('2026-10-10', 30_000), ...PAID];
		const entries = [purchase('2026-11-10', 35_690)];
		for (const anchorDate of ['2026-10-26', '2026-10-12']) {
			const start = card({ openingBalanceDate: anchorDate });
			for (let day = 1; day <= 31; day += 1) {
				const settings = withClosing(start, day, entries, movements);
				expect(owedOn(settings, entries, movements, TODAY)).toBe(
					owedOn(start, entries, movements, TODAY)
				);
			}
		}
	});

	it('âncora no meio do ciclo (a do cadastro) não muda o devido nem com compras nos dias que mudam', () => {
		const start = card({ openingBalanceDate: '2026-11-12', openingBalanceCents: -50_000 });
		const entries = [purchase('2026-11-05', 1_000), purchase('2026-11-13', 2_000)];
		for (let day = 1; day <= 31; day += 1) {
			const settings = withClosing(start, day, entries, PAID);
			expect(owedOn(settings, entries, PAID, TODAY)).toBe(owedOn(start, entries, PAID, TODAY));
		}
	});

	it('fica como está: mesmo dia, só o vencimento mudando, sem regra ou âncora zero', () => {
		const same = { openingBalanceCents: -842_277, openingBalanceDate: '2026-10-26' };
		const closing26 = cycleRuleOf(card({ closingDay: 26 }));
		expect(reanchorForRule(card(), cycleRuleOf(card()), NOVEMBER, PAID)).toEqual(same);
		expect(reanchorForRule(card(), cycleRuleOf(card({ dueDay: 5 })), NOVEMBER, PAID)).toEqual(same);
		expect(reanchorForRule(card({ closingDay: null }), closing26, NOVEMBER, PAID)).toEqual(same);
		expect(reanchorForRule(card(), null, NOVEMBER, PAID)).toEqual(same);
		expect(reanchorForRule(card({ openingBalanceCents: 0 }), closing26, NOVEMBER, PAID)).toEqual({
			openingBalanceCents: 0,
			openingBalanceDate: '2026-10-26',
		});
	});

	it('âncora no meio do ciclo que continua dentro da fatura não sai do lugar', () => {
		const start = card({ openingBalanceDate: '2026-11-05', openingBalanceCents: -50_000 });
		expect(reanchorForRule(start, cycleRuleOf(card({ closingDay: 26 })), NOVEMBER, PAID)).toEqual({
			openingBalanceCents: -50_000,
			openingBalanceDate: '2026-11-05',
		});
	});
});
