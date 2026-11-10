/**
 * SPD-126: o custo fixo de `useWealthMetrics` — o do indicador "Custo fixo", do fôlego e dos
 * insights — soma as parcelas em andamento dos cartões ativos, as mesmas de "Parcelas em
 * andamento" (`CardSummary.installmentPlans`).
 *
 * Os números são os do aparelho de teste: renda de R$ 8.000, contas a pagar de R$ 1.620,
 * Notebook R$ 300 por mês (faltam 3 de 5) e Loja R$ 50 por mês (faltam 7 de 10) no cartão.
 *
 *  - Antes: R$ 1.620 → 2.025 pb (20%).
 *  - Agora: R$ 1.620 + R$ 350 = R$ 1.970 → 2.463 pb (25%).
 *
 * Os contextos são dublês; o cálculo é o de verdade.
 */

const plan = (group: string, note: string, parcelCents: number, remainingCount: number, totalCount: number) => ({
	group,
	note,
	category: 'shopping',
	totalCount,
	remainingCount,
	parcelCents,
	remainingCents: parcelCents * remainingCount,
	nextDate: '2026-11-25',
	lastDate: '2027-05-25',
});

const mockCreditCards: Array<{ id: string; kind: string }> = [];
const mockCardSummaries = new Map<string, { installmentPlans: ReturnType<typeof plan>[] }>();
const mockDebts: unknown[] = [];

jest.mock('../../contexts/PeriodContext', () => ({
	usePeriod: () => ({ selectedMonth: 11, selectedYear: 2026 }),
}));
jest.mock('../../contexts/AccountsContext', () => ({
	useAccounts: () => ({
		activeAccounts: [],
		overview: { cashCents: 0, savedCents: 0 },
		creditCards: mockCreditCards,
		cardSummaries: mockCardSummaries,
	}),
}));
jest.mock('../../contexts/BillsContext', () => ({
	useBills: () => ({
		bills: [
			{ id: 'aluguel', name: 'Aluguel', dueDay: 5, amountCents: 1_620_00, active: true, debtId: null },
			// A conta ligada ao financiamento: entra pela parcela da dívida, não por aqui.
			{ id: 'financiamento', name: 'Financiamento', dueDay: 10, amountCents: 1_500_00, active: true, debtId: 'carro' },
		],
	}),
}));
jest.mock('../../contexts/DebtsContext', () => ({
	useDebts: () => ({ activeDebts: mockDebts }),
}));
const mockPeriodTotals = { incomeCents: 8_000_00, expenseCents: 0 };
const mockMonthlyData = { incomes: [], expenses: [] };
const mockCategoryTotals = { expenses: [] };
const mockCategories: unknown[] = [];
jest.mock('../../contexts/TransactionsContext', () => ({
	useTransactions: () => ({
		periodTotals: mockPeriodTotals,
		balanceCents: 19_700_00,
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
import { todayISO } from '../../utils/dateUtils';
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

/** Financiamento de R$ 1.500 por mês, 12 parcelas, sem juros, aberto hoje. */
const carro = () => ({
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
});

beforeEach(() => {
	result = null;
	mockCreditCards.length = 0;
	mockCardSummaries.clear();
	mockDebts.length = 0;
	mockCreditCards.push({ id: 'cartao', kind: 'credit_card' });
	mockCardSummaries.set('cartao', {
		installmentPlans: [plan('loja', 'Loja', 50_00, 7, 10), plan('notebook', 'Notebook', 300_00, 3, 5)],
	});
});

afterEach(() => {
	act(() => renderer?.unmount());
	renderer = null;
});

it('sem cartão: só as contas a pagar, R$ 1.620 contra R$ 8.000 = 2.025 pb', async () => {
	mockCreditCards.length = 0;
	mockCardSummaries.clear();
	await render();

	expect(result?.metrics.monthlyFixedCents).toBe(1_620_00);
	expect(result?.metrics.fixedCostBasisPoints).toBe(2_025);
});

it('com as parcelas do cartão: R$ 1.620 + R$ 300 + R$ 50 = R$ 1.970, 2.463 pb, dez meses de fôlego', async () => {
	await render();

	expect(result?.metrics.monthlyFixedCents).toBe(1_970_00);
	expect(result?.metrics.fixedCostBasisPoints).toBe(2_463);
	// R$ 19.700 de caixa pagam dez meses de R$ 1.970.
	expect(result?.metrics.runwayMonths).toBe(10);
});

it('cartão arquivado não entra: o resumo existe, mas o cartão não está entre os ativos', async () => {
	mockCardSummaries.set('arquivado', { installmentPlans: [plan('tv', 'TV', 200_00, 4, 10)] });
	await render();

	expect(result?.metrics.monthlyFixedCents).toBe(1_970_00);
});

it('não conta em dobro: a parcela da dívida entra uma vez, a conta ligada a ela não, e a mesma compra em dois resumos entra uma vez', async () => {
	mockDebts.push(carro());
	mockCreditCards.push({ id: 'virtual', kind: 'credit_card' });
	mockCardSummaries.set('virtual', { installmentPlans: [plan('notebook', 'Notebook', 300_00, 3, 5)] });
	await render();

	expect(result?.metrics.monthlyFixedCents).toBe(1_620_00 + 1_500_00 + 350_00);
});
