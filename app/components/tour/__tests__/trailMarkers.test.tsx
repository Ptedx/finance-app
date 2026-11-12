/**
 * As marcas das Trilhas 10 a 15 (SPD-131b) nas telas de verdade: cada alvo que essas trilhas
 * apontam existe na tela do passo (Patrimônio, o "Este mês" da tela inicial, Lançamentos e
 * Relatórios), e o "?" de cada trilha está onde o texto aprovado diz. A Trilha 9, que cruza
 * telas, tem o teste dela (`trailDebts`).
 *
 * As telas são desenhadas com dados de teste que mostram tudo (com e sem o dado que muda o
 * alvo: reserva sem custo, mês sem lançamento, meta sem definir). As seções dos Relatórios que
 * as trilhas só envolvem (o ranking, a projeção…) são dublês: a marca é o invólucro na tela.
 */

const mockData: { reports: Record<string, unknown>; transactions: unknown[]; goal: unknown } = {
	reports: {},
	transactions: [],
	goal: null,
};

jest.mock('@react-native-async-storage/async-storage', () => ({
	getItem: jest.fn(async () => null),
	setItem: jest.fn(async () => undefined),
	removeItem: jest.fn(async () => undefined),
}));

jest.mock('expo-router', () => ({
	router: { push: jest.fn(), back: jest.fn() },
	useRouter: () => ({ replace: jest.fn(), back: jest.fn(), push: jest.fn(), canGoBack: () => true }),
	useLocalSearchParams: () => ({}),
	Stack: { Screen: () => null },
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('react-native-safe-area-context', () => {
	const { View } = require('react-native');
	return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) };
});

jest.mock('react-i18next', () => ({
	useTranslation: () => ({
		t: (key: string, params?: Record<string, unknown>) => (params ? `${key}${JSON.stringify(params)}` : key),
	}),
}));

jest.mock('../../../database/database', () => ({}));
jest.mock('../../../utils/exportUtils', () => ({ exportFinancialReport: jest.fn() }));
jest.mock('../../../utils/dateUtils', () => ({ ...jest.requireActual('../../../utils/dateUtils'), todayISO: () => '2026-11-07' }));

// O que as trilhas só envolvem (e as folhas, que nunca abrem): dublês.
jest.mock('../../PeriodSelector', () => () => null);
jest.mock('../../BudgetEditor', () => () => null);
jest.mock('../../TransactionItem', () => () => null);
jest.mock('../../TransferItem', () => () => null);
jest.mock('../../wealth/ReserveSheet', () => () => null);
jest.mock('../../reports/GoalSheet', () => () => null);
jest.mock('../../reports/DebtsSection', () => () => null);
jest.mock('../../reports/ProjectionChart', () => () => null);
jest.mock('../../reports/CategoryRanking', () => () => null);
jest.mock('../../reports/SourceRanking', () => () => null);
jest.mock('../../reports/CommittedSection', () => () => null);
jest.mock('../../reports/InsightsList', () => () => null);

const mockAccounts = [
	{ id: 'corrente', name: 'Corrente Teste', kind: 'checking', role: 'main', archived: false },
	{ id: 'envelope', name: 'Envelope Teste', kind: 'checking', role: 'envelope', archived: false },
];

jest.mock('../../../contexts/AccountsContext', () => ({
	useAccounts: () => ({
		accounts: mockAccounts,
		activeAccounts: mockAccounts,
		bankAccounts: mockAccounts,
		periodTransfers: [],
		cardSummaries: new Map(),
		cdi: null,
		overview: { cashCents: 100_000, savedCents: 300_000, netCents: 400_000 },
		refresh: jest.fn(async () => undefined),
		month: {
			incomeCents: 800_000,
			totalSpendCents: 500_000,
			mainSpendCents: 200_000,
			cards: [{ accountId: 'cartao', name: 'Cartão Teste', spendCents: 200_000, purchasesCents: 150_000, invoiceBased: true }],
			envelopes: [{ accountId: 'envelope', name: 'Envelope Teste', targetCents: 100_000, spentCents: 40_000, remainingCents: 60_000 }],
			savedCents: 100_000,
			yieldCents: 1_000,
			leftoverCents: 300_000,
			savingsRateBp: 3_750,
		},
		provisionalMonth: { incomeCents: 10_000, spendCents: 5_000 },
	}),
}));

jest.mock('../../../contexts/DebtsContext', () => ({
	useDebts: () => ({
		debts: [],
		summary: { balanceCents: 0, monthlyCents: 0, weightedRateBp: null, lastPayoffDate: null, releases: [] },
		refresh: jest.fn(async () => undefined),
	}),
}));

jest.mock('../../../contexts/TransactionsContext', () => ({
	useTransactions: () => ({
		transactions: mockData.transactions,
		categories: [],
		isLoading: false,
		refreshData: jest.fn(async () => undefined),
		currentPeriodTransactions: [],
		categoryTotals: [],
	}),
}));

jest.mock('../../../contexts/PeriodContext', () => ({
	usePeriod: () => ({
		selectedMonth: 11,
		selectedYear: 2026,
		startDate: '2026-11-01',
		endDate: '2026-11-30',
		setSelectedPeriod: jest.fn(),
	}),
}));

jest.mock('../../../contexts/BudgetContext', () => ({ useBudget: () => ({ currentBudgetCents: 600_000 }) }));

jest.mock('../../../hooks/useRetirementGoal', () => ({
	useRetirementGoal: () => ({ goal: mockData.goal, isLoading: false, save: jest.fn(), clear: jest.fn() }),
}));

jest.mock('../../../hooks/useReserveGoal', () => ({
	useReserveGoal: () => ({ goal: { targetMonths: 6, monthlyCostCents: null }, save: jest.fn() }),
}));

jest.mock('../../../hooks/useReportsData', () => ({
	TREND_RANGES: [3, 6, 12],
	useReportsData: () => mockData.reports,
}));

import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { act, create } from 'react-test-renderer';
import MonthOverviewCard from '../../../components/MonthOverviewCard';
import ReportsScreen from '../../../screens/ReportsScreen';
import TransactionListScreen from '../../../screens/TransactionListScreen';
import WealthScreen from '../../../screens/WealthScreen';
import { configureMoney } from '../../../utils/money';
import { TRAILS, type TrailId } from '../../../utils/trails';
import { clearTourRegistry, hasTarget } from '../registry';

// A primeira tela desenhada carrega os módulos: com a suíte em paralelo, passa dos 5 s padrão.
jest.setTimeout(60_000);

/** A reserva com custo conhecido, ainda enchendo: mostra meta, origem, ritmo e cascata. */
const filling = {
	status: 'thin',
	monthlyCostCents: 300_000,
	costSource: 'history',
	targetMonths: 6,
	targetCents: 1_800_000,
	split: { poolCents: 300_000, reserveCents: 300_000, investmentCents: 0 },
	progressBp: 1_666,
	monthsCovered: 1,
	gapCents: 1_500_000,
	monthsToFill: 15,
	minimumGapCents: 600_000,
};
/** Sem mês fechado nem orçamento: a reserva pede o custo. */
const unknownReserve = { ...filling, status: 'unknown', monthlyCostCents: null, costSource: null, targetCents: null };

const goal = { targetMonthlyCents: 1_000_000, reinvestBp: 2_500, expectedYieldBp: 1_000, outsideCapitalCents: 50_000 };
const retirement = {
	progressBp: 500,
	reach: { kind: 'eta', month: '2046-11', years: 20 },
	capitalCents: 100_000,
	requiredCapitalCents: 150_000_000,
	expectedYieldBp: 1_000,
	requiredMonthlyCents: 1_250_000,
	targetMonthlyCents: 1_000_000,
	passiveIncomeNowCents: 800,
	realizedYieldBp: null,
	realizedYieldBasis: 'posted',
	isWithdrawing: false,
	monthlyContributionCents: 100_000,
	contributionDelayMonths: 15,
	contributionByHorizon: [5, 10, 15, 20].map((years) => ({ years, monthlyCents: 100_000 * years })),
	projection: [],
};
const indicators = ['savings-rate', 'emergency-reserve', 'fixed-cost', 'card-load', 'spending-trend'].map((id) => ({
	id,
	status: 'good',
	unit: id === 'emergency-reserve' ? 'months' : 'bp',
	value: 1_000,
	target: 2_000,
	direction: 'atLeast',
	params: {},
}));

const reports = (overrides: Record<string, unknown> = {}) => ({
	reserve: filling,
	reserveComputedCostCents: 300_000,
	priorities: [
		{ id: 'reserveMinimum', status: 'doing', missingCents: 600_000 },
		{ id: 'retirement', status: 'next', missingCents: null },
	],
	isLoading: false,
	refresh: jest.fn(async () => undefined),
	retirement,
	income: { netCents: 800_000, incomeCount: 1, passThroughCount: 0, grossCents: 800_000 },
	debtScenario: null,
	health: indicators,
	debts: { summary: {}, items: [] },
	series: [],
	provisional: { incomeCents: 0, spendCents: 0 },
	categories: [],
	sources: [],
	committed: [],
	insights: [],
	...overrides,
});

const entry = {
	id: 't1',
	amountCents: 5_000,
	category: 'food',
	date: '2026-11-05',
	note: 'Mercado Teste',
	isIncome: false,
	accountId: 'corrente',
	installmentGroup: null,
	installmentIndex: null,
	installmentCount: null,
	cardLast4: null,
	updatedAt: '',
};

/** Outro lançamento, em outra conta: com duas contas movimentadas, aparece o filtro "Por conta". */
const other = { ...entry, id: 't2', accountId: 'envelope', note: 'Farmácia Teste' };

let renderer: ReactTestRenderer | null = null;

/** Desenha e devolve os alvos que estavam marcados, entre os candidatos. */
const render = async (element: Parameters<typeof create>[0], candidates: readonly string[]) => {
	clearTourRegistry();
	await act(async () => {
		renderer = create(element);
	});
	return candidates.filter((id) => hasTarget(id));
};

/** Os "?" na tela: a trilha de cada um, pela dica (o rótulo é o mesmo em todos). */
const helpButtons = (): string[] =>
	(renderer?.root.findAll((node: ReactTestInstance) => typeof node.type !== 'string' && typeof node.props.onPress === 'function' && typeof node.props.accessibilityHint === 'string') ?? [])
		.map((node) => String(node.props.accessibilityHint).match(/"trails\.(\w+)\.title"/)?.[1])
		.filter((trail): trail is string => Boolean(trail));

/** Todos os alvos que as trilhas pedem nas telas do passo dado. */
const targetsOf = (trails: readonly TrailId[], screens: readonly string[]): string[] => {
	const ids = new Set<string>();
	for (const id of trails) {
		for (const step of TRAILS[id].steps) {
			if (!screens.includes(step.screen)) continue;
			for (const group of step.targets ?? []) for (const target of group) ids.add(target);
		}
	}
	return [...ids].sort();
};

beforeEach(() => {
	mockData.reports = reports();
	mockData.transactions = [entry, other];
	mockData.goal = goal;
	configureMoney({ locale: 'pt-BR', currencyCode: 'BRL', currencySymbol: 'R$' });
});

afterEach(async () => {
	await act(async () => {
		renderer?.unmount();
	});
	renderer = null;
	configureMoney({ locale: 'en-US', currencyCode: 'USD', currencySymbol: '$' });
});

describe('as marcas das Trilhas 10 a 15 nas telas', () => {
	it('Patrimônio: cada alvo da reserva, do "Por onde começar" e do patrimônio está na tela, e os três "?"', async () => {
		const wanted = targetsOf(['reserve', 'netWorth'], ['wealth']);
		const marked = new Set(await render(<WealthScreen />, wanted));
		expect(helpButtons().sort()).toEqual(['debts', 'netWorth', 'reserve', 'reserve']);
		await act(async () => {
			renderer?.unmount();
		});

		// Sem custo conhecido, o card da reserva pede o dado: o passo 7 aponta o botão.
		mockData.reports = reports({ reserve: unknownReserve });
		for (const id of await render(<WealthScreen />, wanted)) marked.add(id);
		expect(wanted.filter((id) => !marked.has(id))).toEqual([]);
	});

	it('"Este mês": cada alvo da trilha 12 está no card, e o "?" também', async () => {
		const wanted = targetsOf(['month'], ['home']);
		expect(wanted.length).toBeGreaterThan(8);
		const marked = await render(<MonthOverviewCard />, wanted);
		expect(wanted.filter((id) => !marked.includes(id))).toEqual([]);
		expect(helpButtons()).toEqual(['month']);
	});

	it('Lançamentos: cada alvo da trilha 13 está na tela (com e sem lançamento no mês), e o "?"', async () => {
		const wanted = targetsOf(['transactions'], ['transactions']);
		const marked = new Set(await render(<TransactionListScreen />, wanted));
		expect(helpButtons()).toEqual(['transactions']);
		expect(marked.has('transactions.first')).toBe(true);
		expect(marked.has('transactions.empty')).toBe(false);
		await act(async () => {
			renderer?.unmount();
		});

		mockData.transactions = [];
		for (const id of await render(<TransactionListScreen />, wanted)) marked.add(id);
		expect(wanted.filter((id) => !marked.has(id))).toEqual([]);
	});

	it('Relatórios: cada alvo das trilhas 14 e 15 está na tela (com e sem meta), e os "?"', async () => {
		const wanted = targetsOf(['health', 'freedom'], ['reports']);
		const marked = new Set(await render(<ReportsScreen />, wanted));
		expect(helpButtons().sort()).toEqual(['freedom', 'freedom', 'health']);
		await act(async () => {
			renderer?.unmount();
		});

		// Sem meta: o convite, com o título e o "Definir meta" marcados.
		mockData.goal = null;
		mockData.reports = reports({ retirement: null });
		const unset = await render(<ReportsScreen />, wanted);
		expect(unset).toEqual(expect.arrayContaining(['freedom.title', 'freedom.goal']));
		expect(unset).not.toContain('freedom.capital');
		for (const id of unset) marked.add(id);
		expect(wanted.filter((id) => !marked.has(id))).toEqual([]);
	});
});
