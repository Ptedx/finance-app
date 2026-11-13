/**
 * Vencimento pelo dia que a fatura do banco mostra (SPD-119).
 *
 * O formulário grava o dia de vencimento digitado (`dueDay`) e o prazo contado na fatura
 * aberta do dia (`closingDaysBefore`). O ciclo usava só o prazo: "fecha 28 / vence 5" gravado
 * em outubro (8 dias, 28/10 → 05/11) dava 08/03 para a fatura de fevereiro, onde o banco diz
 * 05/03. Com `dueDay`, cada fatura vence no dia `dueDay` — no mês do fechamento quando cai
 * depois dele, senão no seguinte; dia que o mês não tem é o último —, no próximo dia útil.
 * Sem `dueDay` (cartão sem o dia gravado), fica o fechamento mais o prazo.
 */

import { cardInvoicesDue } from '../billReminders';
import {
	buildCardSummary,
	type CardSettings,
	cycleFor,
	cycleRuleOf,
	invoiceClosingIn,
	invoicesToInform,
	shiftCycle,
} from '../cardMath';

/** Fecha 28 e vence 5, gravado em outubro: o prazo da fatura aberta de então é 8 dias. */
const DAY_28_5 = { closingDay: 28, closingDaysBefore: 8, dueDay: 5 };
/** O C6: fecha 3 e vence 13, no mesmo mês. */
const C6 = { closingDay: 3, closingDaysBefore: 10, dueDay: 13 };

const dueOf = (card: Parameters<typeof cycleRuleOf>[0], year: number, month: number): string => {
	const rule = cycleRuleOf(card);
	if (!rule) throw new Error('sem regra');
	return invoiceClosingIn(year, month, rule).dueDate;
};

const settings = (card: Partial<CardSettings>, overrides: Partial<CardSettings> = {}): CardSettings => ({
	closingDay: null,
	closingDaysBefore: null,
	creditLimitCents: 500_000,
	openingBalanceCents: 0,
	openingBalanceDate: '2026-10-01',
	...card,
	...overrides,
});

describe('cartão com o dia de vencimento: cada fatura vence nesse dia', () => {
	it('a regra leva o dia digitado', () => {
		expect(cycleRuleOf(DAY_28_5)).toEqual({ closingDay: 28, dueDaysAfter: 8, dueDay: 5 });
	});

	it('fecha 28 / vence 5: outubro 05/11 (quinta), novembro 05/12 (sábado → 07/12), dezembro 05/01/2027 (terça), fevereiro 05/03/2027 (sexta)', () => {
		expect(dueOf(DAY_28_5, 2026, 10)).toBe('2026-11-05');
		expect(dueOf(DAY_28_5, 2026, 11)).toBe('2026-12-07');
		expect(dueOf(DAY_28_5, 2026, 12)).toBe('2027-01-05');
		expect(dueOf(DAY_28_5, 2027, 2)).toBe('2027-03-05');
	});

	it('o prazo gravado não muda o vencimento: com 7 ou 8 dias, a de fevereiro vence 05/03', () => {
		expect(dueOf({ ...DAY_28_5, closingDaysBefore: 7 }, 2027, 2)).toBe('2027-03-05');
		expect(dueOf({ ...DAY_28_5, closingDaysBefore: 8 }, 2027, 2)).toBe('2027-03-05');
	});

	it('C6 fecha 3 / vence 13: no mesmo mês — 13/11 (sexta), 13/12 (domingo → 14/12), 13/02/2027 (sábado → 15/02)', () => {
		expect(dueOf(C6, 2026, 11)).toBe('2026-11-13');
		expect(dueOf(C6, 2026, 12)).toBe('2026-12-14');
		expect(dueOf(C6, 2027, 1)).toBe('2027-01-13');
		expect(dueOf(C6, 2027, 2)).toBe('2027-02-15');
	});

	it('dia que o mês não tem é o último: vence 31 em novembro é 30/11; em fevereiro, 28/02 (domingo → 01/03)', () => {
		const card = { closingDay: 25, closingDaysBefore: 6, dueDay: 31 };
		expect(dueOf(card, 2026, 11)).toBe('2026-11-30');
		expect(dueOf(card, 2027, 2)).toBe('2027-03-01');
	});

	it('fechamento que o mês não tem: fecha 31 / vence 7 — a de fevereiro fecha 28/02 e vence 07/03 (domingo → 08/03)', () => {
		const card = { closingDay: 31, closingDaysBefore: 7, dueDay: 7 };
		expect(dueOf(card, 2027, 2)).toBe('2027-03-08');
		expect(dueOf(card, 2026, 11)).toBe('2026-12-07');
	});

	it('o vencimento no dia útil vale para feriado: vence 15 em novembro de 2026 é domingo e feriado → 16/11', () => {
		expect(dueOf({ closingDay: 5, closingDaysBefore: 10, dueDay: 15 }, 2026, 11)).toBe('2026-11-16');
	});

	it('o vencimento nunca muda as datas do ciclo: compras, fechamento e nome da fatura são os de antes', () => {
		const withDay = cycleRuleOf(DAY_28_5);
		const withoutDay = cycleRuleOf({ ...DAY_28_5, dueDay: null });
		if (!withDay || !withoutDay) throw new Error('sem regra');
		for (const date of ['2026-11-07', '2026-11-28', '2027-02-27', '2027-02-28']) {
			const { dueDate: _a, ...a } = cycleFor(date, withDay);
			const { dueDate: _b, ...b } = cycleFor(date, withoutDay);
			expect(a).toEqual(b);
		}
		expect(shiftCycle(cycleFor('2026-11-07', withDay), 3, withDay).dueDate).toBe('2027-03-05');
	});
});

describe('cartão sem o dia de vencimento: fechamento mais o prazo, como antes', () => {
	it('fecha 28 + 7 dias: novembro 05/12 (sábado → 07/12), dezembro 04/01/2027, fevereiro 07/03 (domingo → 08/03)', () => {
		const card = { closingDay: 28, closingDaysBefore: 7, dueDay: null };
		expect(cycleRuleOf(card)).toEqual({ closingDay: 28, dueDaysAfter: 7 });
		expect(dueOf(card, 2026, 11)).toBe('2026-12-07');
		expect(dueOf(card, 2026, 12)).toBe('2027-01-04');
		expect(dueOf(card, 2027, 2)).toBe('2027-03-08');
	});

	it('sem o campo (quem monta só fechamento e prazo): a mesma regra', () => {
		expect(dueOf({ closingDay: 28, closingDaysBefore: 7 }, 2027, 2)).toBe('2027-03-08');
	});

	it('sem fechamento não há regra, com ou sem vencimento', () => {
		expect(cycleRuleOf({ closingDay: null, closingDaysBefore: null, dueDay: 10 })).toBeNull();
	});
});

describe('o que sai do vencimento: resumo, lembrete e faturas a informar', () => {
	it('em 10/02/2027 a fatura aberta (fevereiro) vence 05/03, e a fechada (janeiro) 05/02', () => {
		const summary = buildCardSummary(settings(DAY_28_5), [], [], '2027-02-10');
		expect(summary.openCycle?.dueDate).toBe('2027-03-05');
		expect(summary.closedCycle?.dueDate).toBe('2027-02-05');
	});

	it('o lembrete da fatura fechada usa o mesmo vencimento: fatura de fevereiro de R$ 300 vence 05/03', () => {
		const summary = buildCardSummary(
			settings(DAY_28_5, { openingBalanceCents: -30_000, openingBalanceDate: '2027-02-27' }),
			[],
			[],
			'2027-03-02'
		);
		expect(summary.closedCycle?.key).toBe('2027-02');
		expect(summary.daysToDue).toBe(3);
		expect(cardInvoicesDue(summary)).toEqual([{ invoice: '2027-02', dueDate: '2027-03-05', amountCents: 30_000 }]);
	});

	it('em 06/03/2027 a fatura de fevereiro já venceu: o cadastro não pede mais o valor dela', () => {
		const rule = cycleRuleOf(DAY_28_5);
		if (!rule) throw new Error('sem regra');
		expect(invoicesToInform(rule, '2027-03-05').closed?.key).toBe('2027-02');
		expect(invoicesToInform(rule, '2027-03-06').closed).toBeNull();
	});
});
