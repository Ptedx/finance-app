/**
 * O custo fixo (e o fôlego) não contam mais as recorrências antigas (SPD-122, DEC-37).
 *
 * A tela de recorrências saiu no SPD-079 e as regras não lançam mais nada desde o SPD-113,
 * mas o custo fixo dos Relatórios e dos insights ainda somava cada regra ativa — e, pior,
 * descontava a conta a pagar e a parcela da dívida de mesmo valor ("já no custo fixo"). Aqui
 * os contextos são dublês com números concretos; o cálculo é o de verdade.
 *
 *  - Internet: conta a pagar de R$ 80 por mês.
 *  - Financiamento: parcela de R$ 1.500 (Price, sem juros, 12 parcelas).
 *  - Regras antigas ativas: R$ 120 por mês e R$ 1.500 por mês (a do mesmo valor da parcela).
 *
 * Antes: 120 + 1.500 (regras) + 80 (conta) + 0 (a parcela "já estava" na regra) = R$ 1.700.
 * Agora: 80 + 1.500 = R$ 1.580 — as regras não mudam nada.
 */

const mockRules: Array<Record<string, unknown>> = [];

jest.mock('../../contexts/PeriodContext', () => ({
	usePeriod: () => ({ selectedMonth: 11, selectedYear: 2026 }),
}));
jest.mock('../../contexts/RecurringTransactionsContext', () => ({
	useRecurringTransactions: () => ({ transactions: mockRules, refreshTransactions: jest.fn() }),
}));
jest.mock('../../contexts/AccountsContext', () => ({
	useAccounts: () => ({ activeAccounts: [], overview: { cashCents: 0, savedCents: 0 }, creditCards: [], cardSummaries: new Map() }),
}));
jest.mock('../../contexts/BillsContext', () => ({
	useBills: () => ({
		bills: [
			{ id: 'internet', name: 'Internet', dueDay: 10, amountCents: 80_00, active: true, debtId: null },
			// A conta ligada ao financiamento: entra pela parcela da dívida, não por aqui.
			{ id: 'financiamento', name: 'Financiamento', dueDay: 10, amountCents: 1_500_00, active: true, debtId: 'carro' },
		],
	}),
}));
jest.mock('../../contexts/DebtsContext', () => {
	const { todayISO } = jest.requireActual('../../utils/dateUtils');
	return {
		useDebts: () => ({
			activeDebts: [
				{
					id: 'carro',
					name: 'Financiamento',
					kind: 'financing',
					system: 'price',
					openingBalanceCents: 18_000_00,
					openingBalanceDate: todayISO(),
					installmentCents: 1_500_00,
					remainingAtOpening: 12,
					installmentsTotal: 12,
					dueDay: 10,
					rateBp: 0,
					feeCents: 0,
					adminFeeBp: null,
					accountId: null,
					category: null,
					archived: false,
					sortOrder: 0,
				},
			],
		}),
	};
});
const mockPeriodTotals = { incomeCents: 8_000_00, expenseCents: 0 };
const mockMonthlyData = { incomes: [], expenses: [] };
const mockCategoryTotals = { expenses: [] };
const mockCategories: unknown[] = [];
jest.mock('../../contexts/TransactionsContext', () => ({
	useTransactions: () => ({
		periodTotals: mockPeriodTotals,
		balanceCents: 15_800_00,
		monthlyData: mockMonthlyData,
		categoryTotals: mockCategoryTotals,
		categories: mockCategories,
	}),
}));
jest.mock('../../database/database', () => ({
	initDatabase: jest.fn(async () => undefined),
	getPeriodSummary: jest.fn(async () => ({ incomeCents: 0, expenseCents: 0 })),
	getTotalByCategory: jest.fn(async () => []),
}));

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useWealthMetrics, type WealthMetricsResult } from '../useWealthMetrics';

let result: WealthMetricsResult | null = null;
let renderer: ReactTestRenderer | null = null;

const Probe = () => {
	result = useWealthMetrics();
	return null;
};

const render = async () => {
	await act(async () => {
		renderer = create(<Probe />);
	});
};

const rule = (id: string, amountCents: number) => ({
	id,
	amountCents,
	isIncome: false,
	note: id,
	category: 'housing',
	recurrenceType: 'monthly',
	day: 10,
	active: true,
	updatedAt: '2026-10-01T00:00:00.000Z',
});

beforeEach(() => {
	mockRules.length = 0;
	result = null;
});

afterEach(() => {
	act(() => renderer?.unmount());
	renderer = null;
});

it('sem regra nenhuma: R$ 80 da internet + R$ 1.500 da parcela = R$ 1.580', async () => {
	await render();

	expect(result?.metrics.monthlyFixedCents).toBe(1_580_00);
});

it('com as regras de R$ 120 e de R$ 1.500 ativas, o custo fixo continua R$ 1.580', async () => {
	mockRules.push(rule('academia', 120_00), rule('carro-antigo', 1_500_00));
	await render();

	expect(result?.metrics.monthlyFixedCents).toBe(1_580_00);
	// 1.580 contra R$ 8.000 de receita: 19,75%.
	expect(result?.metrics.fixedCostBasisPoints).toBe(1_975);
	// R$ 15.800 de caixa pagam dez meses de custo fixo.
	expect(result?.metrics.runwayMonths).toBe(10);
});

it('uma regra de receita (salário de R$ 8.000) também não vira renda recorrente', async () => {
	mockRules.push({ ...rule('salario', 8_000_00), isIncome: true });
	await render();

	expect(result?.metrics.monthlyFixedCents).toBe(1_580_00);
	expect((result?.metrics as unknown as Record<string, unknown>).monthlyRecurringIncomeCents ?? 0).toBe(0);
});
