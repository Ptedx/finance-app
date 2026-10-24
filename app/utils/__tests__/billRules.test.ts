/**
 * As regras da tela de contas a pagar (SPD-062/065), fora da tela.
 *
 * O mês pago de uma conta nova, a pergunta "este mês já está pago?", o total do mês na
 * Home (as de valor variável ficam fora, com aviso) e o bloqueio da conta que vem de uma
 * dívida. As datas entram como texto `YYYY-MM-DD`, então a suíte vale em qualquer fuso.
 */

import type { Bill } from '../../database/schema';
import {
	type BillInput,
	billDraftOf,
	canDeleteBill,
	canToggleActive,
	dueDatePassed,
	editedBillDraft,
	initialPaidThrough,
	isLockedByDebt,
	markedPaid,
	monthBills,
	needsInitialPaidThrough,
	newBillDraft,
	undonePaid,
} from '../billRules';

const bill = (overrides: Partial<Bill> = {}): Bill => ({
	id: 'plano',
	name: 'Plano de saúde',
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

const input = (overrides: Partial<BillInput> = {}): BillInput => ({
	name: 'Conta de celular',
	dueDay: 15,
	amountCents: null,
	accountId: null,
	category: null,
	matchHint: 'tim',
	...overrides,
});

describe('conta nova: o mês pago de partida', () => {
	it('nasce com o mês anterior pago', () => {
		expect(initialPaidThrough('2026-10-24', false)).toBe('2026-09');
	});

	it('com "este mês já está pago", nasce com o mês atual pago', () => {
		expect(initialPaidThrough('2026-10-24', true)).toBe('2026-10');
	});

	it('o mês anterior atravessa o ano', () => {
		expect(initialPaidThrough('2027-01-05', false)).toBe('2026-12');
	});

	it('o rascunho leva o mês de partida, ativo, sem dívida e sem baixa', () => {
		const draft = newBillDraft(input(), '2026-10-24', false, 3);
		expect(draft).toEqual({
			name: 'Conta de celular',
			dueDay: 15,
			amountCents: null,
			accountId: null,
			category: null,
			matchHint: 'tim',
			debtId: null,
			paidThrough: '2026-09',
			paidByRef: null,
			active: true,
			sortOrder: 3,
		});
	});

	it('nome e palavras do pagamento chegam aparados; palavras em branco viram nulo', () => {
		const draft = newBillDraft(
			input({ name: '  MaisMEI  ', matchHint: '   ' }),
			'2026-10-24',
			false,
			0
		);
		expect(draft.name).toBe('MaisMEI');
		expect(draft.matchHint).toBeNull();
	});
});

describe('a pergunta "este mês já está pago?"', () => {
	it('só aparece quando o vencimento deste mês já passou', () => {
		expect(dueDatePassed(10, '2026-10-24')).toBe(true);
		expect(dueDatePassed(30, '2026-10-24')).toBe(false);
	});

	it('no próprio dia do vencimento ainda não passou', () => {
		expect(dueDatePassed(24, '2026-10-24')).toBe(false);
	});

	it('o dia 31 em fevereiro vale o último dia do mês: em 28/02 vence hoje, não passou', () => {
		expect(dueDatePassed(31, '2026-02-28')).toBe(false);
		expect(dueDatePassed(27, '2026-02-28')).toBe(true);
	});
});

describe('a conta de dívida que acabou de nascer', () => {
	it('é a ligada a dívida que nunca recebeu baixa', () => {
		expect(needsInitialPaidThrough(bill({ debtId: 'fin', paidThrough: null }))).toBe(true);
		expect(needsInitialPaidThrough(bill({ debtId: 'fin', paidThrough: '2026-09' }))).toBe(false);
		expect(
			needsInitialPaidThrough(bill({ debtId: 'fin', paidThrough: null, paidByRef: 'tx-1' }))
		).toBe(false);
		expect(needsInitialPaidThrough(bill({ debtId: null, paidThrough: null }))).toBe(false);
	});
});

describe('o bloqueio da conta que vem de uma dívida', () => {
	const fromDebt = bill({
		id: 'fin',
		debtId: 'fin',
		name: 'Financiamento',
		dueDay: 5,
		amountCents: 180_000,
		accountId: 'inter',
	});

	it('ligada a dívida viva: travada, não apaga nem desliga', () => {
		expect(isLockedByDebt(fromDebt)).toBe(true);
		expect(canDeleteBill(fromDebt)).toBe(false);
		expect(canToggleActive(fromDebt)).toBe(false);
	});

	it('de dívida quitada ou apagada (desativada pelo app): pode apagar, mas não religar', () => {
		const ended = { ...fromDebt, active: false };
		expect(isLockedByDebt(ended)).toBe(false);
		expect(canDeleteBill(ended)).toBe(true);
		expect(canToggleActive(ended)).toBe(false);
	});

	it('cadastrada à mão: apaga e desliga', () => {
		expect(isLockedByDebt(bill())).toBe(false);
		expect(canDeleteBill(bill())).toBe(true);
		expect(canToggleActive(bill())).toBe(true);
	});

	it('editar não muda nome, dia, valor nem conta da dívida; categoria e palavras mudam', () => {
		const draft = editedBillDraft(
			fromDebt,
			input({
				name: 'Outro',
				dueDay: 20,
				amountCents: 1,
				accountId: 'nubank',
				category: 'housing',
				matchHint: 'caixa',
			})
		);
		expect(draft).toMatchObject({
			name: 'Financiamento',
			dueDay: 5,
			amountCents: 180_000,
			accountId: 'inter',
			category: 'housing',
			matchHint: 'caixa',
			debtId: 'fin',
		});
	});

	it('editar a cadastrada à mão muda tudo e preserva o mês pago e a baixa', () => {
		const manual = bill({ paidThrough: '2026-10', paidByRef: 'tx-9' });
		const draft = editedBillDraft(
			manual,
			input({ name: 'Unimed', dueDay: 12, amountCents: 61_000 })
		);
		expect(draft).toEqual({
			...billDraftOf(manual),
			name: 'Unimed',
			dueDay: 12,
			amountCents: 61_000,
			matchHint: 'tim',
		});
	});
});

describe('"Já paguei" e desfazer', () => {
	it('"Já paguei" leva o mês pago até o mês atual e não mexe na baixa', () => {
		expect(markedPaid(bill({ paidThrough: '2026-08', paidByRef: 'tx-1' }), '2026-10')).toEqual({
			paidThrough: '2026-10',
			paidByRef: 'tx-1',
		});
	});

	it('"Já paguei" nunca volta um mês pago que já estava adiante', () => {
		expect(markedPaid(bill({ paidThrough: '2026-11' }), '2026-10').paidThrough).toBe('2026-11');
	});

	it('desfazer volta exatamente ao que era antes, quando se sabe', () => {
		const previous = { paidThrough: '2026-08', paidByRef: null };
		expect(
			undonePaid(bill({ paidThrough: '2026-10', paidByRef: 'tx-1' }), '2026-10', previous)
		).toEqual(previous);
	});

	it('sem o estado anterior (o app reabriu), desfazer deixa o mês atual em aberto', () => {
		expect(undonePaid(bill({ paidThrough: '2026-10', paidByRef: 'tx-1' }), '2026-10')).toEqual({
			paidThrough: '2026-09',
			paidByRef: 'tx-1',
		});
	});
});

describe('as contas do mês', () => {
	const today = '2026-10-24';
	const bills = [
		bill({ id: 'tim', name: 'TIM', dueDay: 28, amountCents: null, paidThrough: '2026-09' }),
		bill({ id: 'plano', name: 'Plano', dueDay: 10, amountCents: 50_000, paidThrough: '2026-09' }),
		bill({ id: 'mei', name: 'MaisMEI', dueDay: 20, amountCents: 7_600, paidThrough: '2026-10' }),
		bill({
			id: 'fin',
			name: 'Financiamento',
			dueDay: 24,
			amountCents: 180_000,
			paidThrough: '2026-09',
			debtId: 'fin',
		}),
		bill({ id: 'velha', name: 'Academia', dueDay: 1, amountCents: 9_900, active: false }),
		bill({
			id: 'apagada',
			name: 'Apagada',
			dueDay: 2,
			amountCents: 1_000,
			deletedAt: '2026-10-02T00:00:00.000Z',
		}),
	];

	it('lista só as ativas, em ordem de vencimento, com o status do mês', () => {
		const view = monthBills(bills, today);
		expect(view.month).toBe('2026-10');
		expect(view.rows.map((row) => [row.bill.id, row.status, row.dueDate])).toEqual([
			['plano', 'late', '2026-10-10'],
			['mei', 'paid', '2026-10-20'],
			['fin', 'due_today', '2026-10-24'],
			['tim', 'upcoming', '2026-10-28'],
		]);
	});

	it('o total soma as não pagas com valor; as de valor variável ficam fora e contadas', () => {
		const view = monthBills(bills, today);
		expect(view.dueCents).toBe(50_000 + 180_000);
		expect(view.variableCount).toBe(1);
		expect(view.lateCount).toBe(1);
	});

	it('paga não entra no total nem conta como variável', () => {
		const view = monthBills(
			[
				bill({ amountCents: null, paidThrough: '2026-10' }),
				bill({ id: 'x', paidThrough: '2026-10' }),
			],
			today
		);
		expect(view.dueCents).toBe(0);
		expect(view.variableCount).toBe(0);
	});

	it('sem contas: lista vazia e total zero', () => {
		expect(monthBills([], today)).toEqual({
			month: '2026-10',
			rows: [],
			dueCents: 0,
			variableCount: 0,
			lateCount: 0,
		});
	});
});
