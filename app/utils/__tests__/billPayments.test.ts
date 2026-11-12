/**
 * Os meses das contas a pagar (SPD-146, fase 2 do relatório "Excluir conta e contas
 * atrasadas"): o mês pulado ("Não vou pagar este mês") e o pago fora de ordem viram registro
 * em `bill_payments`, e `paidThrough` continua sendo o trecho contínuo já pago — é o que um
 * aparelho com a versão antiga lê.
 *
 * O cenário é o do relatório: conta "Plano", dia 10, R$ 500, paga até setembro, hoje 11/11.
 * Tudo aqui é conta pura, com números, e as datas entram como texto: vale em qualquer fuso.
 */

import type { Bill, BillPayment } from '../../database/schema';
import {
	billPaymentPatch,
	billSettledBy,
	billSettlementUndo,
	matchBillPayment,
} from '../billMatcher';
import { billPaymentId, paymentFor } from '../billPayments';
import { billReminders, billStatus } from '../billReminders';
import {
	billsOfMonth,
	canUndoMonth,
	homeBills,
	monthBills,
	overdueBills,
	payableMonth,
	settleMonth,
	undoMonth,
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
	updatedAt: '2026-10-01T00:00:00.000Z',
	...overrides,
});

const record = (month: string, overrides: Partial<BillPayment> = {}): BillPayment => ({
	id: billPaymentId('plano', month),
	billId: 'plano',
	month,
	status: 'paid',
	transactionId: null,
	amountCents: null,
	updatedAt: '2026-11-11T12:00:00.000Z',
	...overrides,
});

const skipped = (month: string) => record(month, { status: 'skipped' });

describe('o registro de um mês', () => {
	it('o id sai da conta e do mês: dois aparelhos marcando o mesmo mês caem na mesma linha', () => {
		expect(billPaymentId('plano', '2026-10')).toBe(billPaymentId('plano', '2026-10'));
		expect(billPaymentId('plano', '2026-10')).not.toBe(billPaymentId('plano', '2026-11'));
		expect(billPaymentId('plano', '2026-10')).not.toBe(billPaymentId('luz', '2026-10'));
		expect(billPaymentId('plano', '2026-10')).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
		);
	});

	it('o registro apagado (desfeito) não conta', () => {
		const gone = record('2026-10', { deletedAt: '2026-11-11T13:00:00.000Z' });
		expect(paymentFor([gone], 'plano', '2026-10')).toBeUndefined();
		expect(paymentFor([record('2026-10')], 'plano', '2026-10')?.month).toBe('2026-10');
		expect(paymentFor([record('2026-10')], 'luz', '2026-10')).toBeUndefined();
	});
});

describe('mês pulado ("Não vou pagar este mês")', () => {
	const payments = [skipped('2026-10')];

	it('outubro aparece como pulado, não como pago nem atrasado', () => {
		expect(billStatus(bill(), '2026-10', TODAY, payments)).toBe('skipped');
		expect(billStatus(bill(), '2026-10', TODAY)).toBe('late');
	});

	it('"Em atraso" some: R$ 500 de outubro deixam de contar', () => {
		expect(overdueBills([bill()], NOVEMBER)).toEqual({
			cents: 50_000,
			billCount: 1,
			variableCount: 0,
			oldestMonth: '2026-10',
		});
		expect(overdueBills([bill()], NOVEMBER, payments)).toEqual({
			cents: 0,
			billCount: 0,
			variableCount: 0,
			oldestMonth: null,
		});
	});

	it('"Falta pagar" de outubro vai a zero, e novembro continua R$ 500', () => {
		const october = billsOfMonth([bill()], '2026-10', TODAY, payments);
		expect(october.dueCents).toBe(0);
		expect(october.lateCount).toBe(0);
		const november = monthBills([bill()], TODAY, payments);
		expect(november.dueCents).toBe(50_000);
		expect(november.lateCount).toBe(1);
	});

	it('o próximo "Já paguei" quita novembro, não outubro', () => {
		expect(payableMonth(bill(), NOVEMBER)).toBe('2026-10');
		expect(payableMonth(bill(), NOVEMBER, payments)).toBe(NOVEMBER);
	});

	it('pular o mês mais antigo em aberto leva paidThrough por cima dele, sem lançamento nem valor', () => {
		const result = settleMonth(bill(), [], '2026-10', NOVEMBER, { status: 'skipped' });
		expect(result.paidThrough).toBe('2026-10');
		expect(result.record).toEqual({
			id: billPaymentId('plano', '2026-10'),
			billId: 'plano',
			month: '2026-10',
			status: 'skipped',
			transactionId: null,
			amountCents: null,
		});
	});

	it('pular um mês com outro mais antigo em aberto não mexe em paidThrough', () => {
		const result = settleMonth(bill({ paidThrough: '2026-08' }), [], '2026-10', NOVEMBER, {
			status: 'skipped',
		});
		expect(result.paidThrough).toBe('2026-08');
		expect(
			payableMonth(bill({ paidThrough: '2026-08' }), NOVEMBER, [result.record as BillPayment])
		).toBe('2026-09');
	});

	it('a tela inicial não mostra outubro pulado: mostra novembro, atrasado', () => {
		const view = homeBills([bill()], TODAY, payments);
		expect(view.rows.map((row) => [row.status, row.dueDate])).toEqual([['late', '2026-11-10']]);
	});

	it('o lembrete não muda: outubro já passou do D+3, novembro segue avisando', () => {
		const now = new Date(2026, 10, 11, 8, 0, 0);
		const withSkip = billReminders([bill()], now, payments).map((reminder) => reminder.month);
		expect(withSkip).toEqual(billReminders([bill()], now).map((reminder) => reminder.month));
	});
});

describe('mês pago fora de ordem (novembro com outubro em aberto)', () => {
	const payments = [record(NOVEMBER, { transactionId: 'tx-nov', amountCents: 50_000 })];

	it('novembro fica pago e outubro continua em atraso', () => {
		expect(billStatus(bill(), NOVEMBER, TODAY, payments)).toBe('paid');
		expect(billStatus(bill(), '2026-10', TODAY, payments)).toBe('late');
		expect(monthBills([bill()], TODAY, payments).dueCents).toBe(0);
		expect(overdueBills([bill()], NOVEMBER, payments)).toEqual({
			cents: 50_000,
			billCount: 1,
			variableCount: 0,
			oldestMonth: '2026-10',
		});
		expect(payableMonth(bill(), NOVEMBER, payments)).toBe('2026-10');
	});

	it('pagar novembro com outubro em aberto não mexe em paidThrough', () => {
		const result = settleMonth(bill(), [], NOVEMBER, NOVEMBER, {
			status: 'paid',
			transactionId: 'tx-nov',
			amountCents: 50_000,
		});
		expect(result.paidThrough).toBe('2026-09');
		expect(result.record).toMatchObject({
			month: NOVEMBER,
			status: 'paid',
			transactionId: 'tx-nov',
			amountCents: 50_000,
		});
	});

	it('quando outubro é pago, paidThrough anda por cima de novembro', () => {
		const result = settleMonth(bill(), payments, '2026-10', NOVEMBER, {
			status: 'paid',
			transactionId: 'tx-out',
			amountCents: 50_000,
		});
		expect(result.paidThrough).toBe(NOVEMBER);
	});

	it('a tela inicial mostra outubro atrasado, com a data dele', () => {
		const view = homeBills([bill()], TODAY, payments);
		expect(view.rows.map((row) => [row.status, row.dueDate])).toEqual([['late', '2026-10-10']]);
	});

	it('sem lembrete de novembro: o mês está pago', () => {
		const now = new Date(2026, 10, 1, 8, 0, 0);
		const months = billReminders([bill()], now, payments).map((reminder) => reminder.month);
		expect(months).not.toContain(NOVEMBER);
		expect(billReminders([bill()], now).map((reminder) => reminder.month)).toContain(NOVEMBER);
	});
});

describe('desfazer o mês certo', () => {
	it('desfazer novembro pago fora de ordem tira só o registro dele; paidThrough fica', () => {
		const nov = record(NOVEMBER, { transactionId: 'tx-nov' });
		const undo = undoMonth(bill(), [nov], NOVEMBER);
		expect(undo).toEqual({ paidThrough: '2026-09', remove: nov, fill: [] });
	});

	it('desfazer outubro com novembro registrado: paidThrough volta a setembro e novembro continua pago', () => {
		const oct = record('2026-10', { transactionId: 'tx-out' });
		const nov = record(NOVEMBER, { transactionId: 'tx-nov' });
		const undo = undoMonth(bill({ paidThrough: NOVEMBER }), [oct, nov], '2026-10');
		expect(undo).toEqual({ paidThrough: '2026-09', remove: oct, fill: [] });
	});

	it('desfazer outubro com novembro pago sem registro (app antigo): novembro ganha o registro, para continuar pago', () => {
		const oct = skipped('2026-10');
		const undo = undoMonth(bill({ paidThrough: NOVEMBER }), [oct], '2026-10');
		expect(undo?.paidThrough).toBe('2026-09');
		expect(undo?.remove).toBe(oct);
		expect(undo?.fill).toEqual([
			{
				id: billPaymentId('plano', NOVEMBER),
				billId: 'plano',
				month: NOVEMBER,
				status: 'paid',
				transactionId: null,
				amountCents: null,
			},
		]);
		// O que a tela mostra depois: outubro em atraso, novembro pago — nada mais mudou.
		const after = bill({ paidThrough: undo?.paidThrough ?? null });
		const payments = (undo?.fill ?? []) as BillPayment[];
		expect(billStatus(after, '2026-10', TODAY, payments)).toBe('late');
		expect(billStatus(after, NOVEMBER, TODAY, payments)).toBe('paid');
	});

	it('sem registro, só o último mês pago desfaz (a regra da fase 1)', () => {
		expect(undoMonth(bill({ paidThrough: '2026-10' }), [], '2026-10')).toEqual({
			paidThrough: '2026-09',
			remove: null,
			fill: [],
		});
		expect(undoMonth(bill({ paidThrough: NOVEMBER }), [], '2026-10')).toBeNull();
		expect(canUndoMonth(bill({ paidThrough: NOVEMBER }), '2026-10')).toBe(false);
		expect(canUndoMonth(bill({ paidThrough: NOVEMBER }), '2026-10', [skipped('2026-10')])).toBe(
			true
		);
	});
});

describe('versão mista: paidThrough vindo de um app antigo', () => {
	it('é piso: tudo até ele está pago, mesmo sem registro', () => {
		expect(billStatus(bill({ paidThrough: '2026-10' }), '2026-10', TODAY, [])).toBe('paid');
	});

	it('o app antigo deu "Já paguei" por cima do outubro pulado: outubro continua pulado, novembro pago', () => {
		const old = bill({ paidThrough: NOVEMBER });
		expect(billStatus(old, '2026-10', TODAY, [skipped('2026-10')])).toBe('skipped');
		expect(billStatus(old, NOVEMBER, TODAY, [skipped('2026-10')])).toBe('paid');
		expect(payableMonth(old, NOVEMBER, [skipped('2026-10')])).toBeNull();
	});

	it('o app antigo desfez e baixou paidThrough: o registro de novembro continua valendo', () => {
		const old = bill({ paidThrough: '2026-09' });
		const payments = [record(NOVEMBER, { transactionId: 'tx-nov' })];
		expect(billStatus(old, NOVEMBER, TODAY, payments)).toBe('paid');
		expect(billStatus(old, '2026-10', TODAY, payments)).toBe('late');
	});
});

describe('baixa automática com os registros', () => {
	const movement = (
		overrides: Partial<{ id: string; date: string; amountCents: number; text: string }> = {}
	) => ({
		id: 'pix-1',
		amountCents: -50_000,
		date: '2026-11-05',
		accountId: null,
		text: 'Pix Plano',
		isExpense: true,
		...overrides,
	});

	it('continua quitando o mais antigo em aberto: com outubro pulado, o de 05/11 quita novembro', () => {
		expect(matchBillPayment([bill()], movement())?.month).toBe('2026-10');
		expect(matchBillPayment([bill()], movement(), [skipped('2026-10')])?.month).toBe(NOVEMBER);
	});

	it('com novembro pago fora de ordem, o de 05/11 quita outubro e paidThrough anda até novembro', () => {
		const payments = [record(NOVEMBER, { transactionId: 'tx-nov' })];
		const match = matchBillPayment([bill()], movement(), payments);
		expect(match?.month).toBe('2026-10');
		expect(billPaymentPatch(bill(), '2026-10', 'pix-1', payments).paidThrough).toBe(NOVEMBER);
		// Sem registros, a regra da fase 1: só até o mês casado.
		expect(billPaymentPatch(bill(), '2026-10', 'pix-1').paidThrough).toBe('2026-10');
	});

	it('o lançamento que já quitou um mês (registro) não casa de novo', () => {
		const payments = [record('2026-10', { transactionId: 'pix-1' })];
		expect(matchBillPayment([bill()], movement(), payments)).toBeNull();
	});

	it('apagar o lançamento reabre exatamente o mês dele, pelo registro', () => {
		const oct = record('2026-10', { transactionId: 'pix-1' });
		const nov = record(NOVEMBER, { transactionId: 'tx-nov' });
		const undo = billSettlementUndo(
			bill({ paidThrough: NOVEMBER, paidByRef: 'pix-1' }),
			'pix-1',
			'2026-11-05',
			[oct, nov]
		);
		expect(undo?.draft.paidThrough).toBe('2026-09');
		expect(undo?.draft.paidByRef).toBeNull();
		expect(undo?.remove).toBe(oct);
		expect(undo?.fill).toEqual([]);
	});

	it('sem registro, apagar segue a regra da fase 1 (pela última baixa)', () => {
		const undo = billSettlementUndo(
			bill({ paidThrough: '2026-10', paidByRef: 'pix-1' }),
			'pix-1',
			'2026-11-05',
			[]
		);
		expect(undo?.draft.paidThrough).toBe('2026-09');
		expect(undo?.remove).toBeNull();
		expect(billSettlementUndo(bill({ paidByRef: 'outro' }), 'pix-1', '2026-11-05', [])).toBeNull();
	});
});

describe('a linha dos aprovados automaticamente', () => {
	const bills = [
		bill({ paidByRef: 'pix-1' }),
		bill({ id: 'luz', name: 'Luz', paidByRef: 'pix-2' }),
	];

	it('com o registro, diz a conta e o mês', () => {
		const payments = [record('2026-10', { transactionId: 'pix-1' })];
		expect(billSettledBy(bills, payments, 'pix-1')).toEqual({ name: 'Plano', month: '2026-10' });
	});

	it('sem registro, só o nome (como no SPD-153)', () => {
		expect(billSettledBy(bills, [], 'pix-2')).toEqual({ name: 'Luz', month: null });
	});

	it('registro desfeito ou mês pulado não dão mês; lançamento de ninguém, nada', () => {
		const gone = record('2026-10', {
			transactionId: 'pix-1',
			deletedAt: '2026-11-11T13:00:00.000Z',
		});
		expect(billSettledBy(bills, [gone], 'pix-1')).toEqual({ name: 'Plano', month: null });
		expect(billSettledBy(bills, [], 'pix-9')).toBeNull();
		expect(billSettledBy(bills, [], null)).toBeNull();
	});
});
