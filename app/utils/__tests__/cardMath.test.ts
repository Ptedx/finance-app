import {
	buildCardSummary,
	buildInstallmentPlans,
	type CardEntry,
	type CardMovement,
	type CardSettings,
	cycleClosingIn,
	cycleFor,
	daysBetween,
	existingInstallmentDates,
	invoiceAmount,
	owedOn,
	shiftCycle,
} from '../cardMath';
import { addDays, buildClampedDate } from '../dateUtils';

const settings = (overrides: Partial<CardSettings> = {}): CardSettings => ({
	closingDay: 10,
	dueDay: 17,
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

describe('cycleFor — em qual fatura a compra entra', () => {
	it('antes do dia de fechamento entra na fatura que fecha neste mês', () => {
		expect(cycleFor('2026-09-09', 10, 17)).toEqual({
			key: '2026-09',
			start: '2026-08-10',
			end: '2026-09-09',
			closingDate: '2026-09-10',
			dueDate: '2026-09-17',
		});
	});

	it('no dia do fechamento já entra na próxima: é o melhor dia de compra', () => {
		expect(cycleFor('2026-09-10', 10, 17)).toMatchObject({ key: '2026-10', start: '2026-09-10', end: '2026-10-09' });
	});

	it('vencimento antes do dia de fechamento cai no mês seguinte ao fechamento', () => {
		expect(cycleFor('2026-09-20', 25, 3)).toMatchObject({ closingDate: '2026-09-25', dueDate: '2026-10-03' });
	});

	it('fechamento no dia 31 prende nos meses curtos e volta ao 31', () => {
		expect(cycleFor('2026-02-10', 31, 7)).toMatchObject({ start: '2026-01-31', end: '2026-02-27', closingDate: '2026-02-28' });
		expect(cycleFor('2026-02-28', 31, 7)).toMatchObject({ start: '2026-02-28', closingDate: '2026-03-31' });
	});

	it('virada de ano', () => {
		expect(cycleFor('2026-12-20', 15, 22)).toMatchObject({ key: '2027-01', closingDate: '2027-01-15', dueDate: '2027-01-22' });
		expect(shiftCycle(cycleClosingIn(2026, 12, 15, 22), 1, 15, 22).key).toBe('2027-01');
		expect(shiftCycle(cycleClosingIn(2027, 1, 15, 22), -1, 15, 22).key).toBe('2026-12');
	});

	it('ciclos são contíguos e todo dia pertence a exatamente um (propriedade)', () => {
		for (const closingDay of [1, 5, 10, 28, 29, 30, 31]) {
			for (const dueDay of [1, 7, 20, 31]) {
				let date = '2025-01-01';
				for (let i = 0; i < 800; i += 1) {
					const cycle = cycleFor(date, closingDay, dueDay);
					expect(date >= cycle.start && date <= cycle.end).toBe(true);
					expect(cycle.dueDate > cycle.closingDate).toBe(true);
					expect(addDays(cycle.end, 1)).toBe(cycle.closingDate);
					expect(shiftCycle(cycle, 1, closingDay, dueDay).start).toBe(cycle.closingDate);
					date = addDays(date, 1);
				}
			}
		}
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
		const cycle = cycleFor('2026-09-06', 10, 17);
		expect(invoiceAmount(cycle, s, entries)).toBe(82_000);
		expect(invoiceAmount(cycle, s, entries, '2026-09-05')).toBe(80_000);
	});
});

describe('buildCardSummary', () => {
	it('cartão novo com compras no ciclo aberto: fatura aberta, nada a pagar, limite descontado', () => {
		const summary = buildCardSummary(
			settings(),
			[purchase('2026-09-12', 30_000), purchase('2026-09-20', 20_000)],
			[],
			'2026-09-25'
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
			daysToClosing: 15,
			bestPurchaseDay: 10,
		});
		expect(summary.openCycle?.key).toBe('2026-10');
	});

	it('fatura fechada e não paga: a pagar, com status pelo vencimento', () => {
		const entries = [purchase('2026-08-20', 70_000), purchase('2026-09-12', 10_000)];
		const due = buildCardSummary(settings(), entries, [], '2026-09-12');
		expect(due).toMatchObject({ closedInvoiceCents: 70_000, openInvoiceCents: 10_000, toPayCents: 70_000, closedStatus: 'due', daysToDue: 5 });
		expect(buildCardSummary(settings(), entries, [], '2026-09-15').closedStatus).toBe('due_soon');
		expect(buildCardSummary(settings(), entries, [], '2026-09-18')).toMatchObject({ closedStatus: 'overdue', daysToDue: -1 });
	});

	it('pagamento da fatura fechada zera o a pagar e marca como paga', () => {
		const entries = [purchase('2026-08-20', 70_000), purchase('2026-09-12', 10_000)];
		const summary = buildCardSummary(settings(), entries, [payment('2026-09-15', 70_000)], '2026-09-16');
		expect(summary).toMatchObject({ toPayCents: 0, closedStatus: 'paid', owedCents: 10_000, paidSinceClosingCents: 70_000 });
	});

	it('pagamento parcial deixa o restante a pagar', () => {
		const summary = buildCardSummary(settings(), [purchase('2026-08-20', 70_000)], [payment('2026-09-15', 50_000)], '2026-09-16');
		expect(summary).toMatchObject({ toPayCents: 20_000, closedStatus: 'due_soon' });
	});

	it('pagar a mais vira crédito', () => {
		const summary = buildCardSummary(settings(), [purchase('2026-08-20', 10_000)], [payment('2026-09-15', 15_000)], '2026-09-16');
		expect(summary).toMatchObject({ owedCents: 0, creditCents: 5_000, toPayCents: 0 });
	});

	it('parcelas futuras ocupam o limite mas não a fatura aberta', () => {
		const group = 'g1';
		const parcels = [
			purchase('2026-09-12', 10_000, { installmentGroup: group, installmentIndex: 1, installmentCount: 3, note: 'TV (1/3)' }),
			purchase('2026-10-12', 10_000, { installmentGroup: group, installmentIndex: 2, installmentCount: 3, note: 'TV (2/3)' }),
			purchase('2026-11-12', 10_000, { installmentGroup: group, installmentIndex: 3, installmentCount: 3, note: 'TV (3/3)' }),
		];
		const summary = buildCardSummary(settings(), parcels, [], '2026-09-20');
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
				nextDate: '2026-10-12',
				lastDate: '2026-11-12',
			},
		]);
	});

	it('parcela programada para mais tarde no ciclo aberto entra na fatura aberta mas não no devido de hoje', () => {
		const summary = buildCardSummary(settings(), [purchase('2026-10-05', 10_000)], [], '2026-09-20');
		expect(summary).toMatchObject({ owedCents: 0, openInvoiceCents: 10_000, futureCommittedCents: 10_000, toPayCents: 0 });
	});

	it('"fatura atual" informada pelo usuário não aparece como fatura fechada em aberto', () => {
		const s = settings({ openingBalanceCents: -376_720, openingBalanceDate: '2026-09-19' });
		const summary = buildCardSummary(s, [], [], '2026-09-20');
		expect(summary).toMatchObject({ owedCents: 376_720, openInvoiceCents: 376_720, toPayCents: 0, closedStatus: 'none' });
	});

	it('sem dia de fechamento: limite e devido funcionam, faturas não', () => {
		const summary = buildCardSummary(settings({ closingDay: null }), [purchase('2026-09-12', 10_000)], [], '2026-09-20');
		expect(summary).toMatchObject({ configured: false, owedCents: 10_000, toPayCents: 10_000, invoices: [], limitUsedCents: 10_000 });
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
			const closingDay = 1 + Math.floor(random() * 31);
			const today = '2026-09-20';
			const entries: CardEntry[] = [];
			for (let i = 0; i < 20; i += 1) {
				entries.push(purchase(addDays('2026-06-01', Math.floor(random() * 110)), 100 + Math.floor(random() * 50_000), { isIncome: random() < 0.1 }));
			}
			const s = settings({ closingDay, dueDay: 7 });
			const summary = buildCardSummary(s, entries, [], today);
			const posted = entries.filter((e) => e.date <= today);
			const total = posted.reduce((sum, e) => sum + (e.isIncome ? -e.amountCents : e.amountCents), 0);
			let byCycles = 0;
			let cycle = cycleFor('2026-06-01', closingDay, 7);
			while (cycle.start <= today) {
				byCycles += invoiceAmount(cycle, s, entries, today);
				cycle = shiftCycle(cycle, 1, closingDay, 7);
			}
			expect(byCycles).toBe(total);
			expect(summary.owedCents - summary.creditCents).toBe(total);
		}
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
		expect(existingInstallmentDates(4, 6, 10, 17, '2026-09-20')).toEqual([
			{ index: 4, date: '2026-09-10' },
			{ index: 5, date: '2026-10-10' },
			{ index: 6, date: '2026-11-10' },
		]);
	});

	it('cada parcela cai numa fatura diferente e na ordem (propriedade)', () => {
		for (const closingDay of [1, 15, 28, 31]) {
			const dates = existingInstallmentDates(1, 12, closingDay, 5, '2026-01-30');
			const keys = dates.map((d) => cycleFor(d.date, closingDay, 5).key);
			expect(new Set(keys).size).toBe(12);
			expect([...keys].sort()).toEqual(keys);
			expect(keys[0]).toBe(cycleFor('2026-01-30', closingDay, 5).key);
		}
	});

	it('sem fechamento, de mês em mês a partir de hoje; índices inválidos não geram nada', () => {
		expect(existingInstallmentDates(2, 3, null, null, '2026-01-31')).toEqual([
			{ index: 2, date: '2026-01-31' },
			{ index: 3, date: '2026-02-28' },
		]);
		expect(existingInstallmentDates(0, 3, 10, 17, '2026-09-20')).toEqual([]);
		expect(existingInstallmentDates(4, 3, 10, 17, '2026-09-20')).toEqual([]);
	});
});

describe('daysBetween', () => {
	it('conta dias de calendário, negativo quando já passou', () => {
		expect(daysBetween('2026-09-20', '2026-09-25')).toBe(5);
		expect(daysBetween('2026-09-25', '2026-09-20')).toBe(-5);
		expect(daysBetween('2026-02-28', buildClampedDate(2026, 3, 1))).toBe(1);
	});
});
