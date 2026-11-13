/**
 * Conta a pagar de mês passado em aberto (SPD-145, fase 1).
 *
 * Cada conta guarda só "pago até" (`paidThrough`). Com outubro em aberto e hoje em novembro,
 * "Já paguei" marcava novembro e outubro virava "Paga" sem ninguém pagar; a baixa automática
 * de um pagamento de 05/11 quitava novembro e apagava o atraso; e a tela inicial não via
 * outubro. Agora "Já paguei", a baixa e o desfazer andam um mês por vez, sempre pelo mais
 * antigo em aberto (`paidThrough + 1`), até 3 meses para trás, e o atraso aparece à parte.
 *
 * O cenário é o do relatório: "Plano", dia 10, R$ 500, pago até setembro, hoje 11/11/2026.
 * As datas entram como texto `YYYY-MM-DD`, então a suíte vale em qualquer fuso.
 */

import type { Bill } from '../../database/schema';
import { type BillMovement, billPaymentPatch, billPaymentUndo, matchBillPayment, paysBillMonth } from '../billMatcher';
import { BILL_OVERDUE_MONTHS, billReminders, billStatus, firstOpenMonth } from '../billReminders';
import {
	billsOfMonth,
	canUndoMonth,
	homeBills,
	markedPaid,
	monthBills,
	newBillDraft,
	overdueBills,
	payableMonth,
	undonePaid,
} from '../billRules';

const TODAY = '2026-11-11';
const NOVEMBER = '2026-11';

const bill = (overrides: Partial<Bill> = {}): Bill => ({
	id: 'plano',
	name: 'Plano',
	dueDay: 10,
	amountCents: 50_000,
	accountId: null,
	category: null,
	matchHint: null,
	debtId: null,
	paidThrough: '2026-09',
	paidByRef: null,
	active: true,
	sortOrder: 0,
	updatedAt: '2026-09-10T00:00:00.000Z',
	...overrides,
});

const movement = (overrides: Partial<BillMovement> = {}): BillMovement => ({
	id: 'tx-1',
	amountCents: 50_000,
	date: '2026-11-05',
	accountId: null,
	text: 'PLANO SAUDE TESTE',
	isExpense: true,
	...overrides,
});

/** "plano 2026-10", ou null. */
const matchOf = (bills: Bill[], mv: BillMovement): string | null => {
	const match = matchBillPayment(bills, mv);
	return match ? `${match.bill.id} ${match.month}` : null;
};

/** Aplica a baixa como `settleBillPayment` grava. */
const settle = (current: Bill, mv: BillMovement): Bill => {
	const match = matchBillPayment([current], mv);
	if (!match) return current;
	return { ...current, ...billPaymentPatch(current, match.month, mv.id) };
};

describe('o mês mais antigo em aberto', () => {
	it('é o seguinte ao pago', () => {
		expect(firstOpenMonth(bill(), NOVEMBER)).toBe('2026-10');
		expect(firstOpenMonth(bill({ paidThrough: '2026-10' }), NOVEMBER)).toBe('2026-11');
		expect(firstOpenMonth(bill({ paidThrough: '2026-11' }), NOVEMBER)).toBe('2026-12');
	});

	it('nunca mais de 3 meses para trás', () => {
		expect(BILL_OVERDUE_MONTHS).toBe(3);
		expect(firstOpenMonth(bill({ paidThrough: '2026-05' }), NOVEMBER)).toBe('2026-08');
		expect(firstOpenMonth(bill({ paidThrough: '2025-01' }), NOVEMBER)).toBe('2026-08');
		// Virada de ano: em fevereiro, o limite é novembro do ano anterior.
		expect(firstOpenMonth(bill({ paidThrough: '2026-06' }), '2027-02')).toBe('2026-11');
	});

	it('sem mês pago (a conta de dívida antes do mês de partida): o passado não vira atraso', () => {
		expect(firstOpenMonth(bill({ paidThrough: null, debtId: 'fin' }), NOVEMBER)).toBe('2026-11');
	});

	it('o "Já paguei" quita o mais antigo em aberto, até o mês atual; adiante, nada', () => {
		expect(payableMonth(bill(), NOVEMBER)).toBe('2026-10');
		expect(payableMonth(bill({ paidThrough: '2026-10' }), NOVEMBER)).toBe('2026-11');
		expect(payableMonth(bill({ paidThrough: '2026-11' }), NOVEMBER)).toBeNull();
	});
});

describe('"Já paguei" com outubro em aberto, hoje em novembro', () => {
	it('quita outubro, não novembro', () => {
		expect(markedPaid(bill({ paidByRef: 'tx-0' }), NOVEMBER)).toEqual({ paidThrough: '2026-10', paidByRef: 'tx-0' });
		const after = { ...bill(), ...markedPaid(bill(), NOVEMBER) };
		expect(billStatus(after, '2026-10', TODAY)).toBe('paid');
		expect(billStatus(after, '2026-11', TODAY)).toBe('late');
	});

	it('duas vezes: outubro, depois novembro; a terceira não paga dezembro', () => {
		const first = { ...bill(), ...markedPaid(bill(), NOVEMBER) };
		const second = { ...first, ...markedPaid(first, NOVEMBER) };
		expect(first.paidThrough).toBe('2026-10');
		expect(second.paidThrough).toBe('2026-11');
		expect(markedPaid(second, NOVEMBER).paidThrough).toBe('2026-11');
	});

	it('com mais de 3 meses em aberto, quita o mais antigo dentro do limite', () => {
		expect(markedPaid(bill({ paidThrough: '2026-05' }), NOVEMBER).paidThrough).toBe('2026-08');
	});
});

describe('desfazer depois de reabrir o app (sem o estado de antes)', () => {
	it('reabre o último mês pago, um por vez', () => {
		const paidNov = bill({ paidThrough: '2026-11', paidByRef: 'tx-nov' });
		expect(undonePaid(paidNov, '2026-11')).toEqual({ paidThrough: '2026-10', paidByRef: 'tx-nov' });
		const paidOct = bill({ paidThrough: '2026-10' });
		expect(undonePaid(paidOct, '2026-10').paidThrough).toBe('2026-09');
	});

	it('nunca marca como pago um mês que não foi pago: outubro em aberto continua em aberto', () => {
		// Pago só até setembro: desfazer novembro (que nem está pago) não mexe em nada.
		expect(undonePaid(bill(), '2026-11')).toEqual({ paidThrough: '2026-09', paidByRef: null });
		// Pago até dezembro: só dezembro reabre; um mês do meio não.
		expect(undonePaid(bill({ paidThrough: '2026-12' }), '2026-11').paidThrough).toBe('2026-12');
	});

	it('"Desfazer" vale só para o último mês pago', () => {
		expect(canUndoMonth(bill({ paidThrough: '2026-10' }), '2026-10')).toBe(true);
		expect(canUndoMonth(bill({ paidThrough: '2026-10' }), '2026-09')).toBe(false);
		expect(canUndoMonth(bill(), '2026-10')).toBe(false);
		expect(canUndoMonth(bill({ paidThrough: null }), '2026-10')).toBe(false);
	});
});

describe('baixa automática com outubro em aberto', () => {
	it('pagamento de 05/11 com o nome no texto quita outubro (não novembro)', () => {
		expect(matchOf([bill()], movement())).toBe('plano 2026-10');
	});

	it('só pelo valor exato, sem o nome, não dá baixa de mês atrasado — nem pula para novembro', () => {
		expect(matchOf([bill()], movement({ text: 'PIX ENVIADO' }))).toBeNull();
		expect(matchOf([bill()], movement({ text: null }))).toBeNull();
	});

	it('pela dica "como aparece no banco" também vale', () => {
		expect(matchOf([bill({ matchHint: 'unimed' })], movement({ text: 'UNIMED BH' }))).toBe('plano 2026-10');
	});

	it('05/11 quita outubro e 10/11 quita novembro: nenhum mês pulado', () => {
		let current = bill();
		current = settle(current, movement({ id: 'tx-out', date: '2026-11-05' }));
		expect(current.paidThrough).toBe('2026-10');
		current = settle(current, movement({ id: 'tx-nov', date: '2026-11-10', text: 'Débito automático' }));
		expect(current.paidThrough).toBe('2026-11');
		expect(current.paidByRef).toBe('tx-nov');
	});

	it('o buraco de 16/10 a 30/10: com o nome, quita outubro; sem o nome e com outro valor, não', () => {
		expect(matchOf([bill()], movement({ date: '2026-10-20' }))).toBe('plano 2026-10');
		expect(matchOf([bill()], movement({ date: '2026-10-20', text: 'Mercado', amountCents: 49_000 }))).toBeNull();
	});

	it('na janela de um mês já pago, não casa um mês adiante por engano', () => {
		// Outubro pago; 14/10 é da janela de outubro e 31/10 é cedo para dezembro.
		expect(matchOf([bill({ paidThrough: '2026-10' })], movement({ date: '2026-10-14' }))).toBeNull();
		expect(matchOf([bill({ paidThrough: '2026-11' })], movement({ date: '2026-11-15' }))).toBeNull();
	});

	it('limite de 3 meses: pago até maio, um pagamento de novembro com o nome quita agosto', () => {
		expect(matchOf([bill({ paidThrough: '2026-05' })], movement())).toBe('plano 2026-08');
	});

	it('valor que varia: com o nome, qualquer valor quita outubro', () => {
		const celular = bill({ id: 'celular', name: 'Celular', amountCents: null });
		expect(matchOf([celular], movement({ text: 'Celular teste', amountCents: 13_517 }))).toBe('celular 2026-10');
	});

	it('apagar o pagamento de 05/11 que quitou outubro reabre outubro', () => {
		const paid = bill({ paidThrough: '2026-10', paidByRef: 'tx-1' });
		expect(billPaymentUndo(paid, 'tx-1', '2026-11-05')?.paidThrough).toBe('2026-09');
	});
});

describe('o pagamento do "Já paguei" (paysBillMonth, o casamento sem a dúvida da baixa)', () => {
	it('outubro: aceita do vencimento − 10 dias até hoje, pelo nome ou pelo valor exato', () => {
		const plano = bill();
		expect(paysBillMonth(plano, movement({ date: '2026-10-20', text: null }), '2026-10', { lateByAmount: true })).toBe(
			true
		);
		expect(paysBillMonth(plano, movement({ date: '2026-09-29' }), '2026-10', { lateByAmount: true })).toBe(false);
		// Sem o "Já paguei", só o valor não basta num mês atrasado.
		expect(paysBillMonth(plano, movement({ date: '2026-10-20', text: null }), '2026-10')).toBe(false);
	});
});

describe('tela inicial e total', () => {
	const bills = [
		bill(),
		bill({ id: 'mei', name: 'MEI', dueDay: 20, amountCents: 7_600, paidThrough: '2026-10' }),
		bill({ id: 'tim', name: 'Celular', dueDay: 15, amountCents: null, paidThrough: '2026-08' }),
		bill({ id: 'off', name: 'Desligada', active: false, paidThrough: '2026-05' }),
	];

	it('"Em atraso" soma os meses passados em aberto, à parte do mês', () => {
		expect(overdueBills(bills, NOVEMBER)).toEqual({
			cents: 50_000,
			billCount: 2,
			variableCount: 1,
			oldestMonth: '2026-09',
		});
	});

	it('"Falta pagar este mês" continua só novembro', () => {
		const month = monthBills(bills, TODAY);
		expect(month.dueCents).toBe(50_000 + 7_600);
		expect(month.variableCount).toBe(1);
	});

	it('dois meses em atraso contam duas vezes no valor e uma vez na conta', () => {
		expect(overdueBills([bill({ paidThrough: '2026-08' })], NOVEMBER)).toEqual({
			cents: 100_000,
			billCount: 1,
			variableCount: 0,
			oldestMonth: '2026-09',
		});
	});

	it('limite de 3 meses: pago até maio, só agosto, setembro e outubro', () => {
		expect(overdueBills([bill({ paidThrough: '2026-05' })], NOVEMBER).cents).toBe(150_000);
		expect(billsOfMonth([bill({ paidThrough: '2026-05' })], '2026-07', TODAY).rows[0].status).toBe('paid');
		expect(billsOfMonth([bill({ paidThrough: '2026-05' })], '2026-08', TODAY).rows[0].status).toBe('late');
	});

	it('sem atraso: zero', () => {
		expect(overdueBills([bill({ paidThrough: '2026-10' })], NOVEMBER)).toEqual({
			cents: 0,
			billCount: 0,
			variableCount: 0,
			oldestMonth: null,
		});
	});

	it('a atrasada de outubro entra na lista curta, atrasadas primeiro, no máximo 3', () => {
		const view = homeBills(
			[
				bill({ id: 'a', name: 'A', dueDay: 12, paidThrough: '2026-10' }),
				bill({ id: 'b', name: 'B', dueDay: 13, paidThrough: '2026-10' }),
				bill({ id: 'c', name: 'C', dueDay: 14, paidThrough: '2026-10' }),
				bill(),
			],
			TODAY
		);
		expect(view.rows.map((row) => [row.bill.id, row.status, row.dueDate])).toEqual([
			['plano', 'late', '2026-10-10'],
			['a', 'upcoming', '2026-11-12'],
			['b', 'upcoming', '2026-11-13'],
		]);
		expect(view.moreCount).toBe(1);
	});
});

describe('lembretes com outubro em aberto', () => {
	it('outubro parou no D+3 (13/10); novembro, ainda sem pagar, segue avisando', () => {
		// 11/11 às 08:00 locais: faltam os atrasos de novembro das 09:00 de 11, 12 e 13/11.
		const reminders = billReminders([bill()], new Date(2026, 10, 11, 8, 0));
		expect(reminders.map((item) => `${item.month} ${item.kind} ${item.n}`)).toEqual([
			'2026-11 late 1',
			'2026-11 late 2',
			'2026-11 late 3',
			'2026-12 soon 3',
			'2026-12 today 0',
			'2026-12 late 1',
			'2026-12 late 2',
			'2026-12 late 3',
		]);
	});

	it('quitar outubro pelo "Já paguei" não cala os avisos de novembro', () => {
		const afterOctober = { ...bill(), ...markedPaid(bill(), NOVEMBER) };
		const reminders = billReminders([afterOctober], new Date(2026, 10, 11, 8, 0));
		expect(reminders.filter((item) => item.month === '2026-11')).toHaveLength(3);
	});
});

describe('o começo da conta', () => {
	it('conta criada em novembro não mostra outubro atrasado', () => {
		const draft = newBillDraft(
			{ name: 'Nova', dueDay: 5, amountCents: 10_000, accountId: null, category: null, matchHint: null },
			'2026-11-03',
			false,
			0
		);
		const nova = bill({ ...draft, id: 'nova' });
		expect(overdueBills([nova], NOVEMBER).billCount).toBe(0);
		expect(billsOfMonth([nova], '2026-10', TODAY).rows[0].status).toBe('paid');
		expect(homeBills([nova], TODAY).rows.map((row) => row.dueDate)).toEqual(['2026-11-05']);
		expect(payableMonth(nova, NOVEMBER)).toBe('2026-11');
	});

	it('conta de dívida sem mês de partida não mostra passado', () => {
		const fin = bill({ id: 'fin', debtId: 'fin', paidThrough: null, dueDay: 5 });
		expect(overdueBills([fin], NOVEMBER).billCount).toBe(0);
		expect(billsOfMonth([fin], '2026-10', TODAY).rows[0].status).toBe('paid');
		expect(homeBills([fin], TODAY).rows.map((row) => [row.dueDate, row.status])).toEqual([['2026-11-05', 'late']]);
		expect(payableMonth(fin, NOVEMBER)).toBe('2026-11');
	});

	it('conta de dívida com outubro em aberto se comporta como as outras', () => {
		const fin = bill({ id: 'fin', debtId: 'fin', dueDay: 5, amountCents: 180_000 });
		expect(overdueBills([fin], NOVEMBER).cents).toBe(180_000);
		expect(markedPaid(fin, NOVEMBER).paidThrough).toBe('2026-10');
	});

	it('conta de valor variável com outubro em aberto: conta no atraso, fora da soma', () => {
		const celular = bill({ id: 'celular', amountCents: null });
		expect(overdueBills([celular], NOVEMBER)).toMatchObject({ cents: 0, billCount: 1, variableCount: 1 });
		expect(markedPaid(celular, NOVEMBER).paidThrough).toBe('2026-10');
	});
});
