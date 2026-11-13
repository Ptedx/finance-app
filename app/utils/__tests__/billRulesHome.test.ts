/**
 * Contas do mês enxuto na tela inicial e a troca de mês e os filtros de Contas a pagar (SPD-142).
 *
 * A tela inicial mostra só o que pede atenção: as atrasadas e as que vencem nos próximos 7 dias
 * (hoje incluído), no máximo 3, atrasadas primeiro. Perto da virada do mês, a conta do dia 3 já
 * pago este mês aparece com o vencimento do mês seguinte. A página de contas a pagar mostra
 * qualquer mês, com o status e o total daquele mês, e filtra por situação. As datas entram como
 * texto `YYYY-MM-DD`, então a suíte vale em qualquer fuso.
 */

import type { Bill } from '../../database/schema';
import {
	billsOfMonth,
	filterMonthRows,
	HOME_BILLS_DAYS_AHEAD,
	HOME_BILLS_MAX_ROWS,
	homeBills,
	monthBills,
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
	paidThrough: '2026-10',
	paidByRef: null,
	active: true,
	sortOrder: 0,
	updatedAt: '2026-10-01T00:00:00.000Z',
	...overrides,
});

/** `[id, status, vencimento]` de cada linha, para comparar de uma vez. */
const shape = (rows: { bill: Bill; status: string; dueDate: string }[]) =>
	rows.map((row) => [row.bill.id, row.status, row.dueDate]);

describe('tela inicial: o que aparece', () => {
	const today = '2026-11-11';

	it('a janela é de 7 dias, e cabem 3 linhas', () => {
		expect(HOME_BILLS_DAYS_AHEAD).toBe(7);
		expect(HOME_BILLS_MAX_ROWS).toBe(3);
	});

	it('atrasada, vence hoje e vence em 7 dias aparecem; em 8 dias e paga, não', () => {
		const view = homeBills(
			[
				bill({ id: 'oito', name: 'Em 8 dias', dueDay: 19 }),
				bill({ id: 'sete', name: 'Em 7 dias', dueDay: 18 }),
				bill({ id: 'paga', name: 'Paga', dueDay: 12, paidThrough: '2026-11' }),
				bill({ id: 'hoje', name: 'Hoje', dueDay: 11 }),
				bill({ id: 'atrasada', name: 'Atrasada', dueDay: 5 }),
			],
			today
		);
		expect(shape(view.rows)).toEqual([
			['atrasada', 'late', '2026-11-05'],
			['hoje', 'due_today', '2026-11-11'],
			['sete', 'upcoming', '2026-11-18'],
		]);
		expect(view.moreCount).toBe(0);
	});

	it('atrasadas primeiro (a mais antiga antes), depois por data', () => {
		const view = homeBills(
			[
				bill({ id: 'amanha', name: 'Amanhã', dueDay: 12 }),
				bill({ id: 'dia9', name: 'Dia 9', dueDay: 9 }),
				bill({ id: 'dia2', name: 'Dia 2', dueDay: 2 }),
			],
			today
		);
		expect(shape(view.rows)).toEqual([
			['dia2', 'late', '2026-11-02'],
			['dia9', 'late', '2026-11-09'],
			['amanha', 'upcoming', '2026-11-12'],
		]);
	});

	it('mais de 3: mostra 3 e conta o resto', () => {
		const view = homeBills(
			[
				bill({ id: 'a', name: 'A', dueDay: 12 }),
				bill({ id: 'b', name: 'B', dueDay: 13 }),
				bill({ id: 'c', name: 'C', dueDay: 14 }),
				bill({ id: 'd', name: 'D', dueDay: 15 }),
				bill({ id: 'e', name: 'E', dueDay: 3 }),
			],
			today
		);
		expect(view.rows.map((row) => row.bill.id)).toEqual(['e', 'a', 'b']);
		expect(view.moreCount).toBe(2);
	});

	it('nada atrasado nem vencendo em 7 dias: lista vazia', () => {
		const view = homeBills(
			[bill({ id: 'longe', dueDay: 25 }), bill({ id: 'paga', dueDay: 1, paidThrough: '2026-11' })],
			today
		);
		expect(view).toEqual({ rows: [], moreCount: 0 });
	});

	it('nenhuma conta: lista vazia', () => {
		expect(homeBills([], today)).toEqual({ rows: [], moreCount: 0 });
	});

	it('desativada e apagada ficam fora', () => {
		const view = homeBills(
			[
				bill({ id: 'off', dueDay: 12, active: false }),
				bill({ id: 'apagada', dueDay: 12, deletedAt: '2026-11-01T00:00:00.000Z' }),
			],
			today
		);
		expect(view.rows).toEqual([]);
	});

	it('valor variável e conta de dívida seguem as mesmas regras', () => {
		const view = homeBills(
			[
				bill({ id: 'celular', dueDay: 14, amountCents: null }),
				bill({ id: 'fin', dueDay: 8, debtId: 'divida' }),
				bill({ id: 'fin-longe', dueDay: 30, debtId: 'outra' }),
			],
			today
		);
		expect(shape(view.rows)).toEqual([
			['fin', 'late', '2026-11-08'],
			['celular', 'upcoming', '2026-11-14'],
		]);
	});

	describe('virada do mês', () => {
		it('hoje 28/11: a conta do dia 3, já paga em novembro, aparece com 3 de dezembro', () => {
			const view = homeBills([bill({ id: 'dia3', dueDay: 3, paidThrough: '2026-11' })], '2026-11-28');
			expect(shape(view.rows)).toEqual([['dia3', 'upcoming', '2026-12-03']]);
		});

		it('hoje 28/11: 5 de dezembro (7 dias) aparece; 6 de dezembro (8 dias), não', () => {
			const view = homeBills(
				[
					bill({ id: 'dia5', dueDay: 5, paidThrough: '2026-11' }),
					bill({ id: 'dia6', dueDay: 6, paidThrough: '2026-11' }),
				],
				'2026-11-28'
			);
			expect(shape(view.rows)).toEqual([['dia5', 'upcoming', '2026-12-05']]);
		});

		it('hoje 28/11: a do dia 3 ainda em aberto em novembro aparece uma vez só, atrasada', () => {
			const view = homeBills([bill({ id: 'dia3', dueDay: 3, paidThrough: '2026-10' })], '2026-11-28');
			expect(shape(view.rows)).toEqual([['dia3', 'late', '2026-11-03']]);
		});

		it('dezembro já pago adiante: a de 3 de dezembro não aparece', () => {
			const view = homeBills([bill({ id: 'dia3', dueDay: 3, paidThrough: '2026-12' })], '2026-11-28');
			expect(view.rows).toEqual([]);
		});

		it('virada do ano: hoje 29/12, a do dia 2 vence em 2 de janeiro', () => {
			const view = homeBills([bill({ id: 'dia2', dueDay: 2, paidThrough: '2026-12' })], '2026-12-29');
			expect(shape(view.rows)).toEqual([['dia2', 'upcoming', '2027-01-02']]);
		});

		it('dia 31 em fevereiro vale o último dia: hoje 25/02, vence em 28/02', () => {
			const view = homeBills([bill({ id: 'dia31', dueDay: 31, paidThrough: '2027-01' })], '2027-02-25');
			expect(shape(view.rows)).toEqual([['dia31', 'upcoming', '2027-02-28']]);
		});
	});
});

describe('Contas a pagar: outro mês', () => {
	const today = '2026-11-11';
	const bills = [
		bill({ id: 'plano', name: 'Plano', dueDay: 10, amountCents: 50_000, paidThrough: '2026-09' }),
		bill({ id: 'mei', name: 'MEI', dueDay: 20, amountCents: 7_000, paidThrough: '2026-11' }),
		bill({ id: 'tim', name: 'Celular', dueDay: 15, amountCents: null, paidThrough: '2026-10' }),
		bill({ id: 'off', name: 'Desativada', dueDay: 1, active: false }),
	];

	it('o mês de hoje é o mesmo que `monthBills`', () => {
		expect(billsOfMonth(bills, '2026-11', today)).toEqual(monthBills(bills, today));
	});

	it('mês anterior: o que não foi pago lá está atrasado, o resto pago; o total é o dele', () => {
		const view = billsOfMonth(bills, '2026-10', today);
		expect(view.month).toBe('2026-10');
		expect(shape(view.rows)).toEqual([
			['plano', 'late', '2026-10-10'],
			['tim', 'paid', '2026-10-15'],
			['mei', 'paid', '2026-10-20'],
		]);
		expect(view.dueCents).toBe(50_000);
		expect(view.variableCount).toBe(0);
		expect(view.lateCount).toBe(1);
	});

	it('mês seguinte: tudo a vencer, salvo o pago adiante', () => {
		const view = billsOfMonth(bills, '2026-12', today);
		expect(shape(view.rows)).toEqual([
			['plano', 'upcoming', '2026-12-10'],
			['tim', 'upcoming', '2026-12-15'],
			['mei', 'upcoming', '2026-12-20'],
		]);
		expect(view.dueCents).toBe(50_000 + 7_000);
		expect(view.variableCount).toBe(1);
		expect(view.lateCount).toBe(0);
	});
});

describe('Contas a pagar: filtros', () => {
	const rows = monthBills(
		[
			bill({ id: 'atrasada', dueDay: 5 }),
			bill({ id: 'hoje', dueDay: 11 }),
			bill({ id: 'depois', dueDay: 20 }),
			bill({ id: 'paga', dueDay: 1, paidThrough: '2026-11' }),
		],
		'2026-11-11'
	).rows;
	const ids = (filter: Parameters<typeof filterMonthRows>[1]) =>
		filterMonthRows(rows, filter).map((row) => row.bill.id);

	it('Todas: todas, na ordem de vencimento', () => {
		expect(ids('all')).toEqual(['paga', 'atrasada', 'hoje', 'depois']);
	});

	it('A vencer: as de hoje e as de depois', () => {
		expect(ids('upcoming')).toEqual(['hoje', 'depois']);
	});

	it('Atrasadas', () => {
		expect(ids('late')).toEqual(['atrasada']);
	});

	it('Pagas', () => {
		expect(ids('paid')).toEqual(['paga']);
	});
});
