/**
 * Orçamento que continua valendo (E2E-31): o mês sem orçamento próprio usa o último
 * definido antes dele, sem gravar nada; definir num mês muda daquele mês em diante.
 *
 * A conta é `budgetForMonth`, pura; o provider só é montado para conferir que olhar um
 * mês herdado não grava nada e que salvar grava no mês escolhido. O banco é mock.
 */

import type { Budget } from '../../database/schema';

const mockStored: Budget[] = [];
const mockPeriod = { selectedMonth: 12, selectedYear: 2026 };

jest.mock('../../database/database', () => ({
	initDatabase: jest.fn(async () => undefined),
	getBudgets: jest.fn(async () => [...mockStored]),
	setBudget: jest.fn(async () => undefined),
	clearBudget: jest.fn(async () => undefined),
}));

jest.mock('../../sync/queue', () => ({ schedule: jest.fn() }));

jest.mock('../../hooks/useAfterPull', () => ({ useAfterPull: jest.fn() }));

jest.mock('../PeriodContext', () => ({
	usePeriod: () => mockPeriod,
}));

import { act, create } from 'react-test-renderer';
import { setBudget } from '../../database/database';
import { BudgetProvider, budgetForMonth, useBudget } from '../BudgetContext';

const budget = (year: number, month: number, amountCents: number): Budget => ({
	id: `b-${year}-${month}`,
	year,
	month,
	amountCents,
	updatedAt: '2026-11-07T12:00:00.000Z',
});

describe('budgetForMonth', () => {
	const novembro = [budget(2026, 11, 500_000)];

	it('o mês em que foi definido usa o próprio', () => {
		expect(budgetForMonth(novembro, 2026, 11)).toEqual({ amountCents: 500_000, year: 2026, month: 11, inherited: false });
	});

	it('R$ 5.000 em nov/2026 continua em dez/2026 e jan/2027', () => {
		expect(budgetForMonth(novembro, 2026, 12)).toEqual({ amountCents: 500_000, year: 2026, month: 11, inherited: true });
		expect(budgetForMonth(novembro, 2027, 1)).toEqual({ amountCents: 500_000, year: 2026, month: 11, inherited: true });
	});

	it('não vale para trás: outubro continua sem orçamento', () => {
		expect(budgetForMonth(novembro, 2026, 10)).toBeNull();
		expect(budgetForMonth([], 2026, 11)).toBeNull();
	});

	it('R$ 6.000 em jan/2027 muda dali em diante; nov e dez continuam R$ 5.000', () => {
		// Fora de ordem de propósito: o banco devolve ordenado, mas a conta não depende disso.
		const budgets = [budget(2027, 1, 600_000), budget(2026, 11, 500_000)];
		expect(budgetForMonth(budgets, 2026, 11)?.amountCents).toBe(500_000);
		expect(budgetForMonth(budgets, 2026, 12)?.amountCents).toBe(500_000);
		expect(budgetForMonth(budgets, 2027, 1)).toEqual({ amountCents: 600_000, year: 2027, month: 1, inherited: false });
		expect(budgetForMonth(budgets, 2027, 2)?.amountCents).toBe(600_000);
		expect(budgetForMonth([...budgets].reverse(), 2026, 12)?.amountCents).toBe(500_000);
	});

	it('atravessa anos: dezembro de um ano vale para março do seguinte', () => {
		expect(budgetForMonth([budget(2025, 12, 300_000)], 2026, 3)).toMatchObject({ amountCents: 300_000, year: 2025, month: 12 });
	});
});

describe('BudgetProvider', () => {
	type Api = ReturnType<typeof useBudget>;

	const mount = async (): Promise<() => Api> => {
		let latest: Api | null = null;
		const Probe = () => {
			latest = useBudget();
			return null;
		};
		await act(async () => {
			create(
				<BudgetProvider>
					<Probe />
				</BudgetProvider>
			);
		});
		return () => latest as unknown as Api;
	};

	beforeEach(() => {
		mockStored.length = 0;
		jest.clearAllMocks();
	});

	it('dezembro sem orçamento próprio mostra o de novembro, sem gravar nada', async () => {
		mockStored.push(budget(2026, 11, 500_000));
		const api = await mount();
		expect(api().currentBudgetCents).toBe(500_000);
		expect(api().budgetInheritedFrom).toEqual({ year: 2026, month: 11 });
		expect(setBudget).not.toHaveBeenCalled();
	});

	it('salvar em dezembro grava em dezembro', async () => {
		mockStored.push(budget(2026, 11, 500_000));
		const api = await mount();
		await act(async () => {
			await api().setBudgetForCurrentPeriod(450_000);
		});
		expect(setBudget).toHaveBeenCalledWith(2026, 12, 450_000);
	});
});
