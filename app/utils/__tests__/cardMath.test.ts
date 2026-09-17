import { isBusinessDay } from '../businessDays';
import {
	buildCardSummary,
	buildInstallmentPlans,
	type CardEntry,
	type CardMovement,
	type CardSettings,
	type CycleRule,
	cycleFor,
	cycleRuleOf,
	daysBetween,
	existingInstallmentDates,
	invoiceAmount,
	invoiceDueIn,
	invoicesDueBetween,
	owedOn,
	shiftCycle,
} from '../cardMath';
import { addDays, buildClampedDate } from '../dateUtils';

/** O Nubank do usuário: vence dia 25, fecha 7 dias antes. */
const NUBANK: CycleRule = { dueDay: 25, closingDaysBefore: 7 };

const settings = (overrides: Partial<CardSettings> = {}): CardSettings => ({
	dueDay: 25,
	closingDaysBefore: 7,
	creditLimitCents: 500_000,
	openingBalanceCents: 0,
	openingBalanceDate: '2026-01-01',
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

const payment = (date: string, amountCents: number): CardMovement => ({ date, amountCents, inbound: true });

// Calendário de 2026 usado abaixo: 25/09 é sexta, 25/10 é domingo, 25/11 é quarta e
// 25/12 é Natal numa sexta.

describe('invoiceDueIn — a fatura leva o nome do mês em que vence', () => {
	it('setembro: vence sexta 25/09, fecha 18/09, compras de 18/08 a 17/09', () => {
		expect(invoiceDueIn(2026, 9, NUBANK)).toEqual({
			key: '2026-09',
			start: '2026-08-18',
			end: '2026-09-17',
			closingDate: '2026-09-18',
			dueDate: '2026-09-25',
		});
	});

	it('outubro: 25/10 é domingo, vence segunda 26/10 e o fechamento acompanha (19/10)', () => {
		expect(invoiceDueIn(2026, 10, NUBANK)).toEqual({
			key: '2026-10',
			start: '2026-09-18',
			end: '2026-10-18',
			closingDate: '2026-10-19',
			dueDate: '2026-10-26',
		});
	});

	it('dezembro: Natal numa sexta empurra o vencimento para segunda 28/12', () => {
		expect(invoiceDueIn(2026, 12, NUBANK)).toMatchObject({ closingDate: '2026-12-21', dueDate: '2026-12-28' });
	});

	it('vencimento no dia 31 prende no fim dos meses curtos', () => {
		// 28/02/2026 é sábado: vence segunda 02/03.
		expect(invoiceDueIn(2026, 2, { dueDay: 31, closingDaysBefore: 7 })).toMatchObject({ key: '2026-02', dueDate: '2026-03-02' });
	});
});

describe('cycleFor — em qual fatura a compra entra', () => {
	it('até a véspera do fechamento é a fatura de setembro; a de outubro só começa depois', () => {
		expect(cycleFor('2026-09-17', NUBANK).key).toBe('2026-09');
		expect(cycleFor('2026-09-18', NUBANK).key).toBe('2026-10');
	});

	it('vencimento no começo do mês fecha no mês anterior', () => {
		// Vence 05/10 (segunda), fecha 25/09 com 10 dias de antecedência.
		const rule = { dueDay: 5, closingDaysBefore: 10 };
		expect(cycleFor('2026-09-24', rule)).toMatchObject({ key: '2026-10', closingDate: '2026-09-25', dueDate: '2026-10-05' });
		expect(cycleFor('2026-09-25', rule).key).toBe('2026-11');
	});

	it('virada de ano', () => {
		expect(cycleFor('2026-12-21', NUBANK).key).toBe('2027-01');
		expect(shiftCycle(invoiceDueIn(2026, 12, NUBANK), 1, NUBANK).key).toBe('2027-01');
		expect(shiftCycle(invoiceDueIn(2027, 1, NUBANK), -1, NUBANK).key).toBe('2026-12');
	});

	it('ciclos são contíguos, todo dia pertence a exatamente um e o vencimento é dia útil (propriedade)', () => {
		for (const dueDay of [1, 5, 10, 15, 25, 28, 30, 31]) {
			for (const closingDaysBefore of [1, 7, 10, 20]) {
				const rule = { dueDay, closingDaysBefore };
				let date = '2025-01-01';
				let previousKey = '';
				for (let i = 0; i < 800; i += 1) {
					const cycle = cycleFor(date, rule);
					expect(date >= cycle.start && date <= cycle.end).toBe(true);
					expect(addDays(cycle.end, 1)).toBe(cycle.closingDate);
					expect(addDays(cycle.dueDate, -closingDaysBefore)).toBe(cycle.closingDate);
					expect(isBusinessDay(cycle.dueDate)).toBe(true);
					expect(shiftCycle(cycle, 1, rule).start).toBe(cycle.closingDate);
					expect(cycle.key >= previousKey).toBe(true);
					previousKey = cycle.key;
					date = addDays(date, 1);
				}
			}
		}
	});

	it('sem vencimento não há regra', () => {
		expect(cycleRuleOf({ dueDay: null, closingDaysBefore: 7 })).toBeNull();
		expect(cycleRuleOf({ dueDay: 25, closingDaysBefore: null })).toEqual({ dueDay: 25, closingDaysBefore: 7 });
	});
});

describe('owedOn e invoiceAmount', () => {
	it('compras somam, estorno e pagamento subtraem', () => {
		const entries = [purchase('2026-09-01', 10_000), purchase('2026-09-02', 3_000, { isIncome: true })];
		expect(owedOn(settings(), entries, [payment('2026-09-03', 2_000)], '2026-09-05')).toBe(5_000);
	});

	it('o que é datado depois de hoje não conta no devido', () => {
		expect(owedOn(settings(), [purchase('2026-10-01', 9_999)], [], '2026-09-05')).toBe(0);
	});

	it('a âncora é a "fatura atual" informada: engole o que veio antes e entra no ciclo em que cai', () => {
		const s = settings({ openingBalanceCents: -80_000, openingBalanceDate: '2026-09-04' });
		const entries = [purchase('2026-09-02', 5_000), purchase('2026-09-06', 2_000)];
		expect(owedOn(s, entries, [], '2026-09-06')).toBe(82_000);
		const cycle = cycleFor('2026-09-06', NUBANK);
		expect(invoiceAmount(cycle, s, entries)).toBe(82_000);
		expect(invoiceAmount(cycle, s, entries, '2026-09-05')).toBe(80_000);
	});
});

describe('buildCardSummary', () => {
	it('a fatura do Nubank do usuário: 3.800 informados em 15/09 e compras depois, em 17/09 ainda é a de setembro', () => {
		const s = settings({ creditLimitCents: 1_600_000, openingBalanceCents: -380_000, openingBalanceDate: '2026-09-15' });
		const summary = buildCardSummary(s, [purchase('2026-09-16', 3_280)], [], '2026-09-17');
		expect(summary).toMatchObject({
			owedCents: 383_280,
			openInvoiceCents: 383_280,
			toPayCents: 0,
			closedStatus: 'none',
			daysToClosing: 1,
			bestPurchaseDate: '2026-09-18',
			limitAvailableCents: 1_216_720,
		});
		expect(summary.openCycle).toMatchObject({ key: '2026-09', dueDate: '2026-09-25' });
	});

	it('cartão novo com compras no ciclo aberto: fatura aberta, nada a pagar, limite descontado', () => {
		const summary = buildCardSummary(
			settings(),
			[purchase('2026-09-20', 30_000), purchase('2026-10-01', 20_000)],
			[],
			'2026-10-05'
		);
		expect(summary).toMatchObject({
			configured: true,
			owedCents: 50_000,
			openInvoiceCents: 50_000,
			toPayCents: 0,
			closedStatus: 'none',
			limitUsedCents: 50_000,
			limitAvailableCents: 450_000,
			limitUsagePercent: 10,
			daysToClosing: 14,
			bestPurchaseDate: '2026-10-19',
		});
		expect(summary.openCycle?.key).toBe('2026-10');
	});

	it('fatura fechada e não paga: a pagar, com status pelo vencimento', () => {
		const entries = [purchase('2026-09-10', 70_000), purchase('2026-09-20', 10_000)];
		const due = buildCardSummary(settings(), entries, [], '2026-09-20');
		expect(due).toMatchObject({ closedInvoiceCents: 70_000, openInvoiceCents: 10_000, toPayCents: 70_000, closedStatus: 'due', daysToDue: 5 });
		expect(buildCardSummary(settings(), entries, [], '2026-09-22').closedStatus).toBe('due_soon');
		expect(buildCardSummary(settings(), entries, [], '2026-09-26')).toMatchObject({ closedStatus: 'overdue', daysToDue: -1 });
	});

	it('pagamento da fatura fechada zera o a pagar e marca como paga', () => {
		const entries = [purchase('2026-09-10', 70_000), purchase('2026-09-20', 10_000)];
		const summary = buildCardSummary(settings(), entries, [payment('2026-09-24', 70_000)], '2026-09-24');
		expect(summary).toMatchObject({ toPayCents: 0, closedStatus: 'paid', owedCents: 10_000, paidSinceClosingCents: 70_000 });
	});

	it('pagamento parcial deixa o restante a pagar', () => {
		const summary = buildCardSummary(settings(), [purchase('2026-09-10', 70_000)], [payment('2026-09-23', 50_000)], '2026-09-23');
		expect(summary).toMatchObject({ toPayCents: 20_000, closedStatus: 'due_soon' });
	});

	it('pagar a mais vira crédito', () => {
		const summary = buildCardSummary(settings(), [purchase('2026-09-10', 10_000)], [payment('2026-09-23', 15_000)], '2026-09-23');
		expect(summary).toMatchObject({ owedCents: 0, creditCents: 5_000, toPayCents: 0 });
	});

	it('parcelas futuras ocupam o limite mas não a fatura aberta', () => {
		const group = 'g1';
		const parcels = [
			purchase('2026-09-20', 10_000, { installmentGroup: group, installmentIndex: 1, installmentCount: 3, note: 'TV (1/3)' }),
			purchase('2026-10-20', 10_000, { installmentGroup: group, installmentIndex: 2, installmentCount: 3, note: 'TV (2/3)' }),
			purchase('2026-11-20', 10_000, { installmentGroup: group, installmentIndex: 3, installmentCount: 3, note: 'TV (3/3)' }),
		];
		const summary = buildCardSummary(settings(), parcels, [], '2026-09-25');
		expect(summary).toMatchObject({
			owedCents: 10_000,
			openInvoiceCents: 10_000,
			futureCommittedCents: 20_000,
			limitUsedCents: 30_000,
			limitAvailableCents: 470_000,
		});
		expect(summary.invoices.filter((i) => i.offset > 0).map((i) => [i.cycle.key, i.amountCents])).toEqual([
			['2026-11', 10_000],
			['2026-12', 10_000],
		]);
		expect(summary.installmentPlans).toEqual([
			{
				group,
				note: 'TV',
				category: 'shopping',
				totalCount: 3,
				remainingCount: 2,
				parcelCents: 10_000,
				remainingCents: 20_000,
				nextDate: '2026-10-20',
				lastDate: '2026-11-20',
			},
		]);
	});

	it('parcela programada para mais tarde no ciclo aberto entra na fatura aberta mas não no devido de hoje', () => {
		const summary = buildCardSummary(settings(), [purchase('2026-10-05', 10_000)], [], '2026-09-25');
		expect(summary).toMatchObject({ owedCents: 0, openInvoiceCents: 10_000, futureCommittedCents: 10_000, toPayCents: 0 });
	});

	it('"fatura atual" informada pelo usuário não aparece como fatura fechada em aberto', () => {
		const s = settings({ openingBalanceCents: -376_720, openingBalanceDate: '2026-09-19' });
		const summary = buildCardSummary(s, [], [], '2026-09-20');
		expect(summary).toMatchObject({ owedCents: 376_720, openInvoiceCents: 376_720, toPayCents: 0, closedStatus: 'none' });
	});

	it('sem vencimento: limite e devido funcionam, faturas não', () => {
		const summary = buildCardSummary(settings({ dueDay: null }), [purchase('2026-09-12', 10_000)], [], '2026-09-20');
		expect(summary).toMatchObject({ configured: false, owedCents: 10_000, toPayCents: 10_000, invoices: [], limitUsedCents: 10_000, bestPurchaseDate: null });
	});

	it('sem limite: uso e disponível são nulos', () => {
		const summary = buildCardSummary(settings({ creditLimitCents: null }), [], [], '2026-09-20');
		expect(summary).toMatchObject({ limitCents: null, limitAvailableCents: null, limitUsagePercent: null });
	});

	it('acima do limite o disponível fica negativo, sem esconder', () => {
		const summary = buildCardSummary(settings({ creditLimitCents: 10_000 }), [purchase('2026-09-12', 15_000)], [], '2026-09-20');
		expect(summary).toMatchObject({ limitAvailableCents: -5_000, limitUsagePercent: 150 });
	});

	it('a soma das faturas do histórico bate com o devido quando nada foi pago (propriedade)', () => {
		let state = 7;
		const random = () => {
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
			return state / 0x100000000;
		};
		for (let round = 0; round < 200; round += 1) {
			const rule = { dueDay: 1 + Math.floor(random() * 31), closingDaysBefore: 1 + Math.floor(random() * 20) };
			const today = '2026-09-20';
			const entries: CardEntry[] = [];
			for (let i = 0; i < 20; i += 1) {
				entries.push(purchase(addDays('2026-06-01', Math.floor(random() * 110)), 100 + Math.floor(random() * 50_000), { isIncome: random() < 0.1 }));
			}
			const s = settings(rule);
			const summary = buildCardSummary(s, entries, [], today);
			const posted = entries.filter((e) => e.date <= today);
			const total = posted.reduce((sum, e) => sum + (e.isIncome ? -e.amountCents : e.amountCents), 0);
			let byCycles = 0;
			let cycle = cycleFor('2026-06-01', rule);
			while (cycle.start <= today) {
				byCycles += invoiceAmount(cycle, s, entries, today);
				cycle = shiftCycle(cycle, 1, rule);
			}
			expect(byCycles).toBe(total);
			expect(summary.owedCents - summary.creditCents).toBe(total);
		}
	});
});

describe('invoicesDueBetween — o cartão no quadro do mês', () => {
	const s = settings({ openingBalanceCents: -380_000, openingBalanceDate: '2026-09-15' });
	const entries = [purchase('2026-09-16', 3_280), purchase('2026-09-20', 5_000), purchase('2026-10-25', 1_000)];

	it('setembro mostra a fatura que vence em setembro, com o valor informado dentro', () => {
		expect(invoicesDueBetween(s, entries, '2026-09-01', '2026-09-30')).toBe(383_280);
	});

	it('outubro mostra só o que foi comprado depois do fechamento de setembro', () => {
		expect(invoicesDueBetween(s, entries, '2026-10-01', '2026-10-31')).toBe(5_000);
		expect(invoicesDueBetween(s, entries, '2026-11-01', '2026-11-30')).toBe(1_000);
	});

	it('meses seguidos somam todas as faturas, sem contar nada duas vezes', () => {
		const months = ['09', '10', '11'].map((m) => invoicesDueBetween(s, entries, `2026-${m}-01`, buildClampedDate(2026, Number(m), 31)) ?? 0);
		expect(months.reduce((a, b) => a + b, 0)).toBe(invoicesDueBetween(s, entries, '2026-09-01', '2026-11-30'));
	});

	it('sem vencimento devolve nulo, para quem chama usar as compras do mês', () => {
		expect(invoicesDueBetween(settings({ dueDay: null }), entries, '2026-09-01', '2026-09-30')).toBeNull();
	});
});

describe('buildInstallmentPlans', () => {
	it('ignora planos já quitados e ordena pela próxima parcela', () => {
		const done = purchase('2026-08-01', 5_000, { installmentGroup: 'old', installmentIndex: 2, installmentCount: 2, note: 'Velho (2/2)' });
		const a = purchase('2026-11-01', 7_000, { installmentGroup: 'a', installmentIndex: 5, installmentCount: 6, note: 'Notebook (5/6)' });
		const b = purchase('2026-10-01', 3_000, { installmentGroup: 'b', installmentIndex: 2, installmentCount: 4, note: 'Tênis (2/4)' });
		expect(buildInstallmentPlans([done, a, b], '2026-09-20').map((p) => p.note)).toEqual(['Tênis', 'Notebook']);
	});
});

describe('existingInstallmentDates — compra parcelada feita antes do app', () => {
	it('a parcela atual no começo do ciclo aberto, as seguintes uma por fatura', () => {
		expect(existingInstallmentDates(4, 6, NUBANK, '2026-09-20')).toEqual([
			{ index: 4, date: '2026-09-18' },
			{ index: 5, date: '2026-10-19' },
			{ index: 6, date: '2026-11-18' },
		]);
	});

	it('cada parcela cai numa fatura diferente e na ordem (propriedade)', () => {
		for (const dueDay of [1, 15, 25, 31]) {
			const rule = { dueDay, closingDaysBefore: 7 };
			const dates = existingInstallmentDates(1, 12, rule, '2026-01-30');
			const keys = dates.map((d) => cycleFor(d.date, rule).key);
			expect(new Set(keys).size).toBe(12);
			expect([...keys].sort()).toEqual(keys);
			expect(keys[0]).toBe(cycleFor('2026-01-30', rule).key);
		}
	});

	it('sem vencimento, de mês em mês a partir de hoje; índices inválidos não geram nada', () => {
		expect(existingInstallmentDates(2, 3, null, '2026-01-31')).toEqual([
			{ index: 2, date: '2026-01-31' },
			{ index: 3, date: '2026-02-28' },
		]);
		expect(existingInstallmentDates(0, 3, NUBANK, '2026-09-20')).toEqual([]);
		expect(existingInstallmentDates(4, 3, NUBANK, '2026-09-20')).toEqual([]);
	});
});

describe('daysBetween', () => {
	it('conta dias de calendário, negativo quando já passou', () => {
		expect(daysBetween('2026-09-20', '2026-09-25')).toBe(5);
		expect(daysBetween('2026-09-25', '2026-09-20')).toBe(-5);
		expect(daysBetween('2026-02-28', buildClampedDate(2026, 3, 1))).toBe(1);
	});
});
