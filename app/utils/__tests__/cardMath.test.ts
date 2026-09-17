import { isBusinessDay } from '../businessDays';
import {
	buildCardSummary,
	buildInstallmentPlans,
	cardInstallmentDates,
	type CardEntry,
	type CardMovement,
	type CardSettings,
	type CycleRule,
	cycleFor,
	cycleRuleOf,
	daysBetween,
	existingInstallmentDates,
	invoiceAmount,
	invoiceClosingIn,
	invoicesClosingBetween,
	owedOn,
	planCardAdjustment,
	shiftCycle,
} from '../cardMath';
import { addDays, buildClampedDate } from '../dateUtils';

/** O Nubank do usuário: fecha dia 25, vence 7 dias depois. */
const NUBANK: CycleRule = { closingDay: 25, dueDaysAfter: 7 };

const settings = (overrides: Partial<CardSettings> = {}): CardSettings => ({
	closingDay: 25,
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

// Calendário de 2026 usado abaixo: 25/09 e 02/10 são sextas; 01/11 é domingo e 02/11 é
// Finados; 01/01/2027 é sexta e feriado.

describe('invoiceClosingIn — a fatura leva o nome do mês em que fecha', () => {
	it('setembro: fecha 25/09, vence sexta 02/10, compras de 25/08 a 24/09', () => {
		expect(invoiceClosingIn(2026, 9, NUBANK)).toEqual({
			key: '2026-09',
			start: '2026-08-25',
			end: '2026-09-24',
			closingDate: '2026-09-25',
			dueDate: '2026-10-02',
		});
	});

	it('outubro: 01/11 é domingo e 02/11 é Finados, vence terça 03/11; o fechamento não anda', () => {
		expect(invoiceClosingIn(2026, 10, NUBANK)).toMatchObject({ closingDate: '2026-10-25', dueDate: '2026-11-03' });
	});

	it('dezembro: vencimento no Ano Novo, que cai numa sexta, passa para segunda 04/01', () => {
		expect(invoiceClosingIn(2026, 12, NUBANK)).toMatchObject({ key: '2026-12', dueDate: '2027-01-04' });
	});

	it('fechamento no dia 31 prende no fim dos meses curtos', () => {
		const rule = { closingDay: 31, dueDaysAfter: 7 };
		expect(invoiceClosingIn(2026, 2, rule)).toMatchObject({ closingDate: '2026-02-28', dueDate: '2026-03-09' });
		expect(invoiceClosingIn(2026, 3, rule)).toMatchObject({ start: '2026-02-28', end: '2026-03-30', closingDate: '2026-03-31' });
	});
});

describe('cycleFor — em qual fatura a compra entra', () => {
	it('dia 17 de setembro ainda é a fatura de setembro; a de outubro começa no dia 25', () => {
		expect(cycleFor('2026-09-17', NUBANK).key).toBe('2026-09');
		expect(cycleFor('2026-09-24', NUBANK).key).toBe('2026-09');
		expect(cycleFor('2026-09-25', NUBANK).key).toBe('2026-10');
	});

	it('virada de ano', () => {
		expect(cycleFor('2026-12-25', NUBANK).key).toBe('2027-01');
		expect(shiftCycle(invoiceClosingIn(2026, 12, NUBANK), 1, NUBANK).key).toBe('2027-01');
		expect(shiftCycle(invoiceClosingIn(2027, 1, NUBANK), -1, NUBANK).key).toBe('2026-12');
	});

	it('ciclos são contíguos, todo dia pertence a exatamente um e o vencimento é dia útil (propriedade)', () => {
		for (const closingDay of [1, 5, 10, 25, 28, 29, 30, 31]) {
			for (const dueDaysAfter of [1, 7, 10, 20]) {
				const rule = { closingDay, dueDaysAfter };
				let date = '2025-01-01';
				for (let i = 0; i < 800; i += 1) {
					const cycle = cycleFor(date, rule);
					expect(date >= cycle.start && date <= cycle.end).toBe(true);
					expect(addDays(cycle.end, 1)).toBe(cycle.closingDate);
					expect(cycle.closingDate.slice(0, 7)).toBe(cycle.key);
					expect(isBusinessDay(cycle.dueDate)).toBe(true);
					const slack = daysBetween(addDays(cycle.closingDate, dueDaysAfter), cycle.dueDate);
					expect(slack >= 0 && slack <= 5).toBe(true);
					expect(shiftCycle(cycle, 1, rule).start).toBe(cycle.closingDate);
					date = addDays(date, 1);
				}
			}
		}
	});

	it('sem fechamento não há regra', () => {
		expect(cycleRuleOf({ closingDay: null, closingDaysBefore: 7 })).toBeNull();
		expect(cycleRuleOf({ closingDay: 25, closingDaysBefore: null })).toEqual({ closingDay: 25, dueDaysAfter: 7 });
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
	it('o Nubank do usuário em 17/09: fatura de setembro com os 3.800 informados, fecha em 8 dias', () => {
		const s = settings({ creditLimitCents: 1_600_000, openingBalanceCents: -380_000, openingBalanceDate: '2026-09-15' });
		const summary = buildCardSummary(s, [purchase('2026-09-16', 3_280)], [], '2026-09-17');
		expect(summary).toMatchObject({
			owedCents: 383_280,
			openInvoiceCents: 383_280,
			toPayCents: 0,
			closedStatus: 'none',
			daysToClosing: 8,
			bestPurchaseDate: '2026-09-25',
			limitAvailableCents: 1_216_720,
		});
		expect(summary.openCycle).toMatchObject({ key: '2026-09', closingDate: '2026-09-25', dueDate: '2026-10-02' });
	});

	it('cartão novo com compras no ciclo aberto: fatura aberta, nada a pagar, limite descontado', () => {
		const summary = buildCardSummary(settings(), [purchase('2026-09-26', 30_000), purchase('2026-10-01', 20_000)], [], '2026-10-05');
		expect(summary).toMatchObject({
			configured: true,
			owedCents: 50_000,
			openInvoiceCents: 50_000,
			toPayCents: 0,
			closedStatus: 'none',
			limitUsedCents: 50_000,
			limitAvailableCents: 450_000,
			limitUsagePercent: 10,
			daysToClosing: 20,
			bestPurchaseDate: '2026-10-25',
		});
		expect(summary.openCycle?.key).toBe('2026-10');
	});

	it('fatura fechada e não paga: a pagar, com status pelo vencimento', () => {
		const entries = [purchase('2026-09-10', 70_000), purchase('2026-09-26', 10_000)];
		const due = buildCardSummary(settings(), entries, [], '2026-09-27');
		expect(due).toMatchObject({ closedInvoiceCents: 70_000, openInvoiceCents: 10_000, toPayCents: 70_000, closedStatus: 'due', daysToDue: 5 });
		expect(buildCardSummary(settings(), entries, [], '2026-09-29').closedStatus).toBe('due_soon');
		expect(buildCardSummary(settings(), entries, [], '2026-10-03')).toMatchObject({ closedStatus: 'overdue', daysToDue: -1 });
	});

	it('o fluxo do usuário: põe dinheiro na conta e paga a fatura fechada inteira', () => {
		const entries = [purchase('2026-09-10', 70_000), purchase('2026-09-26', 10_000)];
		const summary = buildCardSummary(settings(), entries, [payment('2026-10-01', 70_000)], '2026-10-01');
		expect(summary).toMatchObject({ toPayCents: 0, closedStatus: 'paid', owedCents: 10_000, paidSinceClosingCents: 70_000 });
		const byKey = Object.fromEntries(summary.invoices.map((i) => [i.cycle.key, i.paidCents]));
		expect(byKey).toMatchObject({ '2026-09': 70_000, '2026-10': 0 });
	});

	it('pagamento parcial deixa o restante a pagar', () => {
		const summary = buildCardSummary(settings(), [purchase('2026-09-10', 70_000)], [payment('2026-09-30', 50_000)], '2026-09-30');
		expect(summary).toMatchObject({ toPayCents: 20_000, closedStatus: 'due_soon' });
		expect(summary.invoices.find((i) => i.offset === -1)?.paidCents).toBe(50_000);
	});

	it('pagar a mais quita a fechada e o que sobra aparece como antecipação da aberta', () => {
		const entries = [purchase('2026-09-10', 10_000), purchase('2026-09-28', 8_000)];
		const summary = buildCardSummary(settings(), entries, [payment('2026-09-30', 15_000)], '2026-09-30');
		expect(summary).toMatchObject({ owedCents: 3_000, toPayCents: 0, closedStatus: 'paid' });
		expect(summary.invoices.find((i) => i.offset === -1)?.paidCents).toBe(10_000);
		expect(summary.invoices.find((i) => i.offset === 0)?.paidCents).toBe(5_000);
	});

	it('pagar mais que tudo vira crédito', () => {
		const summary = buildCardSummary(settings(), [purchase('2026-09-10', 10_000)], [payment('2026-09-30', 15_000)], '2026-09-30');
		expect(summary).toMatchObject({ owedCents: 0, creditCents: 5_000, toPayCents: 0 });
	});

	it('pagamento antecipado da fatura aberta, sem fechada pendente, abate o devido', () => {
		const summary = buildCardSummary(settings(), [purchase('2026-09-26', 20_000)], [payment('2026-10-10', 20_000)], '2026-10-10');
		expect(summary).toMatchObject({ owedCents: 0, openInvoiceCents: 20_000, toPayCents: 0, closedStatus: 'none' });
		expect(summary.invoices.find((i) => i.offset === 0)?.paidCents).toBe(20_000);
	});

	it('parcelas futuras ocupam o limite mas não a fatura aberta', () => {
		const group = 'g1';
		const parcels = [
			purchase('2026-09-26', 10_000, { installmentGroup: group, installmentIndex: 1, installmentCount: 3, note: 'TV (1/3)' }),
			purchase('2026-10-26', 10_000, { installmentGroup: group, installmentIndex: 2, installmentCount: 3, note: 'TV (2/3)' }),
			purchase('2026-11-26', 10_000, { installmentGroup: group, installmentIndex: 3, installmentCount: 3, note: 'TV (3/3)' }),
		];
		const summary = buildCardSummary(settings(), parcels, [], '2026-10-01');
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
				nextDate: '2026-10-26',
				lastDate: '2026-11-26',
			},
		]);
	});

	it('parcela programada para mais tarde no ciclo aberto entra na fatura aberta mas não no devido de hoje', () => {
		const summary = buildCardSummary(settings(), [purchase('2026-10-05', 10_000)], [], '2026-09-26');
		expect(summary).toMatchObject({ owedCents: 0, openInvoiceCents: 10_000, futureCommittedCents: 10_000, toPayCents: 0 });
	});

	it('"fatura atual" informada pelo usuário não aparece como fatura fechada em aberto', () => {
		const s = settings({ openingBalanceCents: -376_720, openingBalanceDate: '2026-09-26' });
		const summary = buildCardSummary(s, [], [], '2026-09-27');
		expect(summary).toMatchObject({ owedCents: 376_720, openInvoiceCents: 376_720, toPayCents: 0, closedStatus: 'none' });
	});

	it('sem fechamento: limite e devido funcionam, faturas não', () => {
		const summary = buildCardSummary(settings({ closingDay: null }), [purchase('2026-09-12', 10_000)], [], '2026-09-20');
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
			const rule = { closingDay: 1 + Math.floor(random() * 31), dueDaysAfter: 1 + Math.floor(random() * 20) };
			const today = '2026-09-20';
			const entries: CardEntry[] = [];
			for (let i = 0; i < 20; i += 1) {
				entries.push(purchase(addDays('2026-06-01', Math.floor(random() * 110)), 100 + Math.floor(random() * 50_000), { isIncome: random() < 0.1 }));
			}
			const s = settings({ closingDay: rule.closingDay, closingDaysBefore: rule.dueDaysAfter });
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

describe('invoicesClosingBetween — o cartão no quadro do mês', () => {
	const s = settings({ openingBalanceCents: -380_000, openingBalanceDate: '2026-09-15' });
	const entries = [purchase('2026-09-16', 3_280), purchase('2026-09-26', 5_000), purchase('2026-10-26', 1_000)];

	it('setembro mostra a fatura de setembro, com o valor informado dentro', () => {
		expect(invoicesClosingBetween(s, entries, '2026-09-01', '2026-09-30')).toBe(383_280);
	});

	it('outubro mostra só o que foi comprado depois do fechamento de setembro', () => {
		expect(invoicesClosingBetween(s, entries, '2026-10-01', '2026-10-31')).toBe(5_000);
		expect(invoicesClosingBetween(s, entries, '2026-11-01', '2026-11-30')).toBe(1_000);
	});

	it('meses seguidos somam todas as faturas, sem contar nada duas vezes', () => {
		const months = ['09', '10', '11'].map(
			(m) => invoicesClosingBetween(s, entries, `2026-${m}-01`, buildClampedDate(2026, Number(m), 31)) ?? 0
		);
		expect(months.reduce((a, b) => a + b, 0)).toBe(invoicesClosingBetween(s, entries, '2026-09-01', '2026-11-30'));
	});

	it('sem fechamento devolve nulo, para quem chama usar as compras do mês', () => {
		expect(invoicesClosingBetween(settings({ closingDay: null }), entries, '2026-09-01', '2026-09-30')).toBeNull();
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
			{ index: 4, date: '2026-08-25' },
			{ index: 5, date: '2026-09-25' },
			{ index: 6, date: '2026-10-25' },
		]);
	});

	it('cada parcela cai numa fatura diferente e na ordem (propriedade)', () => {
		for (const closingDay of [1, 15, 25, 31]) {
			const rule = { closingDay, dueDaysAfter: 7 };
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

describe('planCardAdjustment — acertar com o banco sem misturar faturas', () => {
	it('fechada não paga fica na fechada, aberta na aberta, e a diferença vira ajuste', () => {
		// 27/09: setembro fechou em 25/09 e vence 02/10; outubro está aberta.
		const entries = [purchase('2026-09-20', 10_000), purchase('2026-09-26', 3_000)];
		const plan = planCardAdjustment(settings(), entries, [], '2026-09-27', 50_000, 200_000);
		expect(plan).toEqual({ anchorDate: '2026-09-24', anchorCents: -200_000, adjustmentCents: 47_000 });

		// Aplicando o plano, o resumo mostra exatamente o que o banco mostra.
		const s = settings({ openingBalanceCents: plan.anchorCents, openingBalanceDate: plan.anchorDate });
		const withAdjustment = [...entries, purchase('2026-09-27', plan.adjustmentCents)];
		const summary = buildCardSummary(s, withAdjustment, [], '2026-09-27');
		expect(summary).toMatchObject({ closedInvoiceCents: 200_000, openInvoiceCents: 50_000, toPayCents: 200_000, closedStatus: 'due', owedCents: 250_000 });

		// E pagar a fechada a quita — não vira "pagamento antecipado".
		const paid = buildCardSummary(s, withAdjustment, [payment('2026-10-01', 200_000)], '2026-10-01');
		expect(paid).toMatchObject({ toPayCents: 0, closedStatus: 'paid' });
		expect(paid.invoices.find((i) => i.offset === -1)?.paidCents).toBe(200_000);
	});

	it('pagamento já registrado depois do fechamento continua abatendo a fechada', () => {
		const plan = planCardAdjustment(settings(), [], [payment('2026-09-26', 50_000)], '2026-09-27', 0, 150_000);
		expect(plan.anchorCents).toBe(-200_000);
		const s = settings({ openingBalanceCents: plan.anchorCents, openingBalanceDate: plan.anchorDate });
		expect(buildCardSummary(s, [], [payment('2026-09-26', 50_000)], '2026-09-27')).toMatchObject({ toPayCents: 150_000, owedCents: 150_000 });
	});

	it('quando a aberta já bate, não cria ajuste; quando o app tem a mais, o ajuste é negativo', () => {
		const entries = [purchase('2026-09-26', 3_000)];
		expect(planCardAdjustment(settings(), entries, [], '2026-09-27', 3_000, 0).adjustmentCents).toBe(0);
		expect(planCardAdjustment(settings(), entries, [], '2026-09-27', 1_000, 0).adjustmentCents).toBe(-2_000);
	});

	it('sem dia de fechamento, âncora na véspera com a soma, descontado o lançado hoje', () => {
		const plan = planCardAdjustment(settings({ closingDay: null }), [purchase('2026-09-27', 1_000)], [], '2026-09-27', 10_000, 5_000);
		expect(plan).toEqual({ anchorDate: '2026-09-26', anchorCents: -14_000, adjustmentCents: 0 });
	});
});

describe('compras a revisar entram na fatura', () => {
	it('a compra da caixa de entrada soma na fatura aberta, no devido e no limite, e é listada à parte', () => {
		const pending = purchase('2026-09-27', 4_500, { pendingReview: true, note: 'IFOOD' });
		const summary = buildCardSummary(settings(), [purchase('2026-09-26', 1_000), pending], [], '2026-09-27');
		expect(summary).toMatchObject({ openInvoiceCents: 5_500, owedCents: 5_500, limitUsedCents: 5_500, pendingReviewCents: 4_500 });
		expect(summary.pendingEntries.map((e) => e.note)).toEqual(['IFOOD']);
	});
});

describe('cardInstallmentDates — uma parcela por fatura', () => {
	it('mês a mês quando cada mês já muda de fatura', () => {
		expect(cardInstallmentDates('2026-09-10', 3, NUBANK)).toEqual(['2026-09-10', '2026-10-10', '2026-11-10']);
	});

	it('quando somar um mês cai no fechamento, a parcela vai para o começo da fatura certa', () => {
		// Fecha dia 30; compra em 29/01. 28/02 já é o fechamento de fevereiro.
		const rule = { closingDay: 30, dueDaysAfter: 7 };
		const dates = cardInstallmentDates('2026-01-29', 3, rule);
		expect(dates.map((d) => cycleFor(d, rule).key)).toEqual(['2026-01', '2026-02', '2026-03']);
	});

	it('cada parcela numa fatura, em ordem (propriedade)', () => {
		for (const closingDay of [1, 15, 28, 29, 30, 31]) {
			const rule = { closingDay, dueDaysAfter: 7 };
			let date = '2026-01-01';
			for (let i = 0; i < 400; i += 3) {
				const keys = cardInstallmentDates(date, 6, rule).map((d) => cycleFor(d, rule).key);
				expect(new Set(keys).size).toBe(6);
				expect(keys[5]).toBe(shiftCycle(cycleFor(date, rule), 5, rule).key);
				date = addDays(date, 3);
			}
		}
	});
});

describe('invoicesClosingBetween — fechamento no primeiro dia do mês', () => {
	it('a fatura que fecha em 01/09 é a de setembro', () => {
		const s = settings({ closingDay: 1 });
		expect(invoicesClosingBetween(s, [purchase('2026-08-15', 7_000)], '2026-09-01', '2026-09-30')).toBe(7_000);
	});
});
