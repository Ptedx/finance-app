/**
 * As Trilhas 8 (Contas a pagar) e 21 (Tela inicial) numa conta vazia (SPD-160): o que falta
 * aparece de exemplo, só em memória e marcado "Exemplo", para cada passo apontar — a faixa
 * "Revisar", o card "Contas do mês", o cartão, a conta e a linha "Sem conta" da tela inicial, as
 * contas a pagar de exemplo na lista e a edição de uma delas.
 *
 * O critério é confiança: "Já paguei", "Desfazer", tocar na conta, Salvar, Desativar e Apagar do
 * exemplo não chamam os contextos que gravam, o SQLite nem os lembretes, e os totais de verdade
 * ("Este mês", "Em caixa", "Depois das faturas", "Falta pagar", as faturas) ficam iguais, com os
 * mesmos números, antes e depois de ligar o exemplo. Com o dado de verdade, nada de exemplo
 * naquele bloco; fechando a trilha, o exemplo some; outra trilha que passa pela tela inicial
 * não a enche de exemplo.
 *
 * Os contextos são dublês; as chaves de tradução aparecem cruas. Só a medida é de mentira (no
 * jest a `View` não se mede): todo alvo marcado e montado está no meio da tela.
 */

import type { Bill } from '../../../database/schema';

type Row = { bill: Bill; status: string; dueDate: string };

const mockStorage = new Map<string, string>();
const mockActions: unknown[] = [];
const mockRouter = {
	push: jest.fn(),
	back: jest.fn(),
	replace: jest.fn(),
	navigate: jest.fn(),
	dismiss: jest.fn(),
	dismissAll: jest.fn(),
	canGoBack: () => true,
};
/** Tudo o que grava, lança, agenda ou abre a revisão: nenhum pode ser chamado pelo exemplo. */
const mockWrites = {
	bills: {
		createBill: jest.fn(),
		saveBill: jest.fn(),
		setBillActive: jest.fn(),
		removeBill: jest.fn(),
		planPayment: jest.fn(),
		markPaid: jest.fn(),
		skipMonth: jest.fn(),
		undoPaid: jest.fn(),
		rescheduleReminders: jest.fn(),
	},
	transactions: {
		addTransaction: jest.fn(),
		updateTransaction: jest.fn(),
		deleteTransaction: jest.fn(),
	},
	captures: {
		confirm: jest.fn(),
		dismiss: jest.fn(),
		markTransfer: jest.fn(),
		answerDuplicate: jest.fn(),
		undo: jest.fn(),
		openSettings: jest.fn(),
	},
	notifications: {
		scheduleBillReminders: jest.fn(),
		scheduleCardReminders: jest.fn(),
	},
};
const mockDb = {
	execAsync: jest.fn(async () => undefined),
	runAsync: jest.fn(async () => ({ changes: 0, lastInsertRowId: 0 })),
	getFirstAsync: jest.fn(async () => null),
	getAllAsync: jest.fn(async () => []),
	withTransactionAsync: jest.fn(async (body: () => Promise<void>) => body()),
};

const mockData: {
	bills: Bill[];
	rows: Row[];
	dueCents: number;
	bankAccounts: unknown[];
	creditCards: unknown[];
	debitCards: unknown[];
	cardsTotals: {
		toPayCents: number;
		openInvoicesCents: number;
		limitAvailableCents: number | null;
		limitUsedCents: number;
	};
	unassignedNetCents: number;
	pending: unknown[];
} = {
	bills: [],
	rows: [],
	dueCents: 0,
	bankAccounts: [],
	creditCards: [],
	debitCards: [],
	cardsTotals: {
		toPayCents: 0,
		openInvoicesCents: 0,
		limitAvailableCents: null,
		limitUsedCents: 0,
	},
	unassignedNetCents: 0,
	pending: [],
};

jest.mock('@react-native-async-storage/async-storage', () => ({
	getItem: jest.fn(async (key: string) => mockStorage.get(key) ?? null),
	setItem: jest.fn(async (key: string, value: string) => {
		mockStorage.set(key, value);
	}),
	removeItem: jest.fn(async () => undefined),
}));

jest.mock('expo-sqlite', () => ({ openDatabaseSync: () => mockDb }));

jest.mock('expo-router', () => ({
	router: mockRouter,
	useRouter: () => mockRouter,
	useLocalSearchParams: () => ({}),
	useFocusEffect: (effect: () => void) => require('react').useEffect(effect, [effect]),
	Stack: { Screen: () => null },
}));

jest.mock('../registry', () => {
	const actual = jest.requireActual('../registry');
	return {
		...actual,
		measureTarget: async (id: string) =>
			actual.hasTarget(id) ? { x: 16, y: 200, width: 300, height: 50 } : null,
	};
});

jest.mock('../../../utils/onboardingUtils', () => ({
	isOnboardingCompleted: jest.fn(async () => true),
}));
jest.mock('../../../utils/accountReminder', () => ({
	shouldShowReminder: jest.fn(async () => false),
	dismissReminder: jest.fn(async () => undefined),
}));
jest.mock('../../../utils/balanceUnsetDismissals', () => ({
	getDismissedBalanceUnset: jest.fn(async () => new Set()),
}));
jest.mock('../../../utils/notificationUtils', () => mockWrites.notifications);
jest.mock('../../../../modules/spendr-captures', () => ({ requestCaptureRebind: jest.fn() }));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => {
	const { View } = require('react-native');
	return {
		SafeAreaView: View,
		useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
	};
});
jest.mock('react-i18next', () => ({
	useTranslation: () => ({
		t: (key: string, params?: Record<string, unknown>) =>
			params ? `${key}${JSON.stringify(params)}` : key,
	}),
}));

// A face do cartão: só o nome, para ver qual cartão está na tela.
jest.mock('../../cards/CardFace', () => {
	const { Text } = require('react-native');
	return ({ card }: { card: { name: string } }) => <Text>{`face:${card.name}`}</Text>;
});
jest.mock('../../cards/DebitCardFace', () => () => null);
jest.mock('../../bills/BillStatusPill', () => () => null);
jest.mock('../../PeriodSelector', () => () => null);
jest.mock('../../BudgetEditor', () => () => null);

jest.mock('../../../contexts/BillsContext', () => {
	const React = require('react');
	const { todayISO } = jest.requireActual('../../../utils/dateUtils');
	const value = () => ({
		bills: mockData.bills,
		activeBills: mockData.bills.filter((bill) => bill.active),
		payments: [],
		month: {
			month: todayISO().slice(0, 7),
			rows: mockData.rows,
			dueCents: mockData.dueCents,
			variableCount: 0,
			lateCount: 0,
		},
		today: todayISO(),
		isLoading: false,
		refresh: jest.fn(),
		...mockWrites.bills,
	});
	// O `TrailRecordsSource` lê as contas a pagar do contexto, sem exigir o provider.
	const context = React.createContext({
		get bills() {
			return mockData.bills;
		},
	});
	return {
		__esModule: true,
		default: context,
		markPaidTransactionId: (id: string, month: string) => `lancamento-${id}-${month}`,
		useBills: value,
	};
});

jest.mock('../../../contexts/DebtsContext', () => ({
	__esModule: true,
	default: require('react').createContext(null),
}));

jest.mock('../../../contexts/AccountsContext', () => ({
	useAccounts: () => ({
		accounts: [...mockData.bankAccounts, ...mockData.creditCards],
		activeAccounts: [...mockData.bankAccounts, ...mockData.creditCards],
		bankAccounts: mockData.bankAccounts,
		creditCards: mockData.creditCards,
		debitCards: mockData.debitCards,
		cardSummaries: new Map(),
		cardsTotals: mockData.cardsTotals,
		balances: new Map([['corrente', 100_000]]),
		provisionalBalances: new Map(),
		overview: { cashCents: 100_000, savedCents: 0, cardsOwedCents: 30_000, netCents: 70_000 },
		provisionalOverview: { cashCents: 0, netCents: 0 },
		provisionalMonth: undefined,
		month: {
			incomeCents: 500_000,
			totalSpendCents: 320_000,
			mainSpendCents: 320_000,
			cards: [],
			envelopes: [],
			reserves: [],
			savedCents: 0,
			yieldCents: 0,
			leftoverCents: 180_000,
			savingsRateBp: 3_600,
		},
		unassignedNetCents: mockData.unassignedNetCents,
		isLoading: false,
		refresh: jest.fn(),
	}),
}));

jest.mock('../../../contexts/TransactionsContext', () => ({
	useTransactions: () => ({
		transactions: [],
		categories: [
			{ id: 'housing', name: 'Moradia', type: 'expense', color: '#888888', icon: 'home' },
		],
		isLoading: false,
		refreshData: jest.fn(),
		...mockWrites.transactions,
	}),
}));

jest.mock('../../../contexts/CapturesContext', () => ({
	useCaptures: () => ({
		supported: true,
		enabled: true,
		pending: mockData.pending,
		pendingCount: mockData.pending.length,
		resolved: [],
		ignoredApps: [],
		lastNotificationAt: null,
		isLoading: false,
		...mockWrites.captures,
	}),
}));

jest.mock('../../../contexts/SyncContext', () => ({ useSync: () => ({ syncNow: jest.fn() }) }));
jest.mock('../../../contexts/AuthContext', () => ({
	useAuth: () => ({ account: { id: 'eu' }, isAvailable: true }),
}));
jest.mock('../../../contexts/BudgetContext', () => ({
	useBudget: () => ({ currentBudgetCents: null }),
}));
jest.mock('../../../contexts/PeriodContext', () => {
	const today = new Date();
	return {
		usePeriod: () => ({ selectedMonth: today.getMonth() + 1, selectedYear: today.getFullYear() }),
	};
});

import type React from 'react';
import { useState } from 'react';
import { AccessibilityInfo, Alert, Text } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import MonthOverviewCard from '../../../components/MonthOverviewCard';
import BillEditScreen from '../../../screens/BillEditScreen';
import BillsScreen from '../../../screens/BillsScreen';
import HomeScreen from '../../../screens/HomeScreen';
import { todayISO } from '../../../utils/dateUtils';
import { configureMoney } from '../../../utils/money';
import { STORAGE_KEYS } from '../../../utils/storageUtils';
import { isSampleId, SAMPLE_IDS } from '../../../utils/trailSample';
import type { TrailId, TrailLocation, TrailNavAction } from '../../../utils/trails';
import { clearTourRegistry, hasTarget } from '../registry';
import { type TourContextValue, useTour } from '../TourContext';
import TourProvider from '../TourProvider';
import TrailRecordsSource from '../TrailRecordsSource';

jest.setTimeout(60_000);
jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);

const MONTH = todayISO().slice(0, 7);

const INTERNET: Bill = {
	id: 'internet',
	name: 'Internet teste',
	dueDay: 20,
	amountCents: 12_000,
	accountId: 'corrente',
	category: null,
	matchHint: null,
	debtId: null,
	paidThrough: null,
	paidByRef: null,
	active: true,
	sortOrder: 0,
	updatedAt: '2026-11-01T00:00:00.000Z',
};
const CORRENTE = {
	id: 'corrente',
	name: 'Corrente Teste',
	kind: 'checking',
	role: 'main',
	color: '#123456',
	archived: false,
	openingBalanceCents: 0,
	packageName: null,
};
const CARTAO = {
	id: 'cartao',
	name: 'Cartão Teste',
	kind: 'credit_card',
	archived: false,
	closingDay: 5,
	packageName: null,
};

let renderer: ReactTestRenderer | null = null;
let setStack: React.Dispatch<React.SetStateAction<TrailLocation[]>> | null = null;
let tour: TourContextValue | null = null;

/** A pilha do app, de mentira: só a tela do topo é desenhada. */
const FakeStack: React.FC<{ initial: TrailLocation[] }> = ({ initial }) => {
	const [stack, update] = useState(initial);
	setStack = update;
	tour = useTour();
	const top = stack[stack.length - 1];
	if (!top) return null;
	const key = `${stack.length}:${top.screen}`;
	if (top.screen === 'home') return <HomeScreen key={key} />;
	if (top.screen === 'bills') return <BillsScreen key={key} />;
	if (top.screen === 'billNew') return <BillEditScreen key={key} />;
	if (top.screen === 'billEdit') return <BillEditScreen key={key} billId={top.params?.id} />;
	return <Text key={key}>{`tela ${top.screen}`}</Text>;
};

const navigator = {
	run: (action: TrailNavAction) => {
		mockActions.push(action);
		setStack?.((stack) => {
			if (action.type === 'push') return [...stack, action.location];
			if (action.type === 'pop') return stack.slice(0, Math.max(0, stack.length - action.count));
			if (action.type === 'root') return [];
			return [{ screen: action.screen }];
		});
	},
};

const wait = (ms: number) =>
	act(async () => new Promise<void>((resolve) => setTimeout(resolve, ms)));

const textOf = (node: ReactTestInstance): string => [node.props.children].flat().join('');

const isText = (node: ReactTestInstance) =>
	(node.type as unknown) === Text || (node.type as unknown) === 'Text';

const textsIn = (root: ReactTestInstance | undefined): string[] =>
	(root?.findAll(isText) ?? []).map(textOf);

const texts = (): string[] => textsIn(renderer?.root);

const waitForText = async (text: string, timeout = 10_000) => {
	const start = Date.now();
	while (!texts().includes(text) && Date.now() - start < timeout) await wait(25);
	if (!texts().includes(text))
		throw new Error(`"${text}" não apareceu. Na tela: ${texts().join(' | ')}`);
};

const waitUntil = async (check: () => boolean, timeout = 10_000) => {
	const start = Date.now();
	while (!check() && Date.now() - start < timeout) await wait(25);
	expect(check()).toBe(true);
};

const byTestId = (id: string): ReactTestInstance[] =>
	renderer?.root.findAll((node) => node.props.testID === id && typeof node.type === 'string') ?? [];

/** O bloco de exemplo marcado: existe uma vez e tem o selo "Exemplo" dentro. */
const taggedBlock = (id: string): boolean => {
	const [block] = byTestId(id);
	return (
		Boolean(block) &&
		block.findAll((node) => node.props.testID === 'trail-sample-block-tag').length > 0
	);
};

const blockTags = () => byTestId('trail-sample-block-tag').length;

const hasBanner = () => byTestId('trail-sample-banner').length > 0;

/** Tudo o que se toca com este rótulo. */
const pressables = (label: string): ReactTestInstance[] =>
	renderer?.root.findAll(
		(candidate: ReactTestInstance) =>
			candidate.props.accessibilityLabel === label && typeof candidate.props.onPress === 'function'
	) ?? [];

const pressAll = async (label: string) => {
	const nodes = pressables(label);
	if (nodes.length === 0) throw new Error(`nada tocável com o rótulo ${label}`);
	for (const node of nodes)
		await act(async () => {
			node.props.onPress();
		});
	return nodes.length;
};

const pressLabel = async (label: string) => {
	const node = pressables(label)[0];
	if (!node) throw new Error(`nada tocável com o rótulo ${label}`);
	await act(async () => {
		node.props.onPress();
	});
};

/** O "?" de uma trilha: o rótulo é o mesmo em todos, a dica diz qual. */
const pressHelp = async (trail: TrailId) => {
	const hint = `trails.helpHint{"trail":"trails.${trail}.title"}`;
	const node = renderer?.root.findAll(
		(candidate) =>
			candidate.props.accessibilityHint === hint && typeof candidate.props.onPress === 'function'
	)[0];
	if (!node) throw new Error(`nenhum "?" da trilha ${trail}`);
	await act(async () => {
		node.props.onPress();
	});
};

const pointing = () => byTestId('trail-outline').length > 0;

/** O balão diz que o passo é de exemplo. */
const bubbleTagged = () => {
	const [bubble] = byTestId('trail-bubble');
	return (
		Boolean(bubble) && bubble.findAll((node) => node.props.testID === 'trail-sample-tag').length > 0
	);
};

const title = (trail: TrailId, id: string | number) => `trails.${trail}.steps.${id}.title`;
const counter = (current: number, total: number) =>
	`tutorial.counter{"current":${current},"total":${total}}`;

/** O componente montado deste tipo (o `findByType` não aceita os tipos do React Native). */
const ofType = (type: unknown) => renderer?.root.find((node) => (node.type as unknown) === type);

const monthCard = () => ofType(MonthOverviewCard);

/** Os números de verdade da tela inicial: "Este mês", os totais das contas e o resto da tela que não é exemplo. */
const realTotals = () => {
	const month = monthCard();
	const accounts = renderer?.root.findAll(
		(node) =>
			typeof node.type === 'string' &&
			typeof node.props.accessibilityLabel === 'string' &&
			node.props.accessibilityLabel.startsWith('accounts.cash ')
	);
	return {
		month: textsIn(month),
		accounts: (accounts ?? []).map((node) => node.props.accessibilityLabel as string),
	};
};

const mount = async (initial: TrailLocation[] = [{ screen: 'home' }]) => {
	await act(async () => {
		renderer = create(
			<TourProvider trailOptions={{ navigator, settleMs: 0, readyTimeoutMs: 3_000 }}>
				<TrailRecordsSource />
				<FakeStack initial={initial} />
			</TourProvider>
		);
	});
	await wait(50);
};

const writes = () => [
	...Object.entries({
		...mockWrites.bills,
		...mockWrites.transactions,
		...mockWrites.captures,
		...mockWrites.notifications,
	})
		.filter(([, fn]) => fn.mock.calls.length > 0)
		.map(([name]) => name),
	...Object.entries(mockDb)
		.filter(
			([name, fn]) => name !== 'getAllAsync' && name !== 'getFirstAsync' && fn.mock.calls.length > 0
		)
		.map(([name]) => `sql.${name}`),
	...(alertSpy.mock.calls.length > 0 ? ['Alert.alert'] : []),
];

beforeEach(() => {
	mockStorage.clear();
	// O guia de primeira visita e o aviso "Como usar" não abrem por cima da trilha.
	mockStorage.set(
		STORAGE_KEYS.tutorial,
		JSON.stringify({ install: 'upgrade', auto: false, notice: 'done', seen: [] })
	);
	mockActions.length = 0;
	for (const group of Object.values(mockWrites))
		for (const fn of Object.values(group)) fn.mockClear();
	for (const fn of Object.values(mockDb)) fn.mockClear();
	for (const fn of [mockRouter.push, mockRouter.back, mockRouter.navigate]) fn.mockClear();
	alertSpy.mockClear();
	mockData.bills = [];
	mockData.rows = [];
	mockData.dueCents = 0;
	mockData.bankAccounts = [];
	mockData.creditCards = [];
	mockData.debitCards = [];
	mockData.cardsTotals = {
		toPayCents: 0,
		openInvoicesCents: 0,
		limitAvailableCents: null,
		limitUsedCents: 0,
	};
	mockData.unassignedNetCents = 0;
	mockData.pending = [];
	tour = null;
	clearTourRegistry();
	configureMoney({ locale: 'pt-BR', currencyCode: 'BRL', currencySymbol: 'R$' });
});

afterEach(async () => {
	await act(async () => {
		renderer?.unmount();
	});
	renderer = null;
	configureMoney({ locale: 'en-US', currencyCode: 'USD', currencySymbol: '$' });
});

describe('Trilha 21 numa conta vazia (SPD-160)', () => {
	it('fora da trilha, a tela inicial vazia não tem exemplo: os convites "Cadastrar" e "Adicionar"', async () => {
		await mount();
		expect(blockTags()).toBe(0);
		expect(hasTarget('home.review')).toBe(false);
		expect(hasTarget('home.unassigned')).toBe(false);
		expect(hasTarget('home.billsInvite')).toBe(true);
		expect(hasTarget('home.cardsAdd')).toBe(true);
		expect(hasTarget('home.accountsAdd')).toBe(true);
	});

	it('com a trilha aberta, cada bloco que falta aparece de exemplo, marcado, e cada passo aponta', async () => {
		await mount();
		await pressHelp('home');
		await waitForText(title('home', 1));

		for (const id of [
			'home-sample-review',
			'home-sample-bills',
			'home-sample-cards',
			'home-sample-accounts',
			'home-sample-unassigned',
		])
			expect({ id, tagged: taggedBlock(id) }).toEqual({ id, tagged: true });
		for (const id of [
			'home.review',
			'home.billsCard',
			'home.cards',
			'home.cardsTotals',
			'home.accounts',
			'home.accountsTotals',
			'home.unassigned',
		])
			expect({ id, registered: hasTarget(id) }).toEqual({ id, registered: true });
		// Os convites saem: no lugar deles, o exemplo.
		expect(hasTarget('home.billsInvite')).toBe(false);
		expect(hasTarget('home.cardsAdd')).toBe(false);
		expect(hasTarget('home.accountsAdd')).toBe(false);
		// Os nomes e valores do exemplo: 1 aviso, o aluguel de R$ 1.500, o cartão e a conta de exemplo.
		expect(texts()).toContain('captures.homeBanner{"count":1}');
		expect(textsIn(byTestId('home-sample-bills')[0]).join(' ')).toContain('trails.sample.bill');
		expect(textsIn(byTestId('home-sample-bills')[0])).toContain('R$ 1.500,00');
		expect(texts()).toContain('face:trails.sample.card');
		expect(texts()).toContain('trails.sample.account');
		expect(textsIn(byTestId('home-sample-unassigned')[0])).toContain('− R$ 100,00');

		// "Proteja seus dados" não aparece (logado): o passo 2 sai, e o contador conta 8.
		expect(texts()).toContain(counter(1, 8));
		expect(pointing()).toBe(true);
		expect(bubbleTagged()).toBe(true);
		const shown: { id: number; pointing: boolean; sample: boolean }[] = [];
		for (const [index, id] of [3, 4, 5, 6, 7, 8, 9].entries()) {
			await pressLabel('tutorial.next');
			await waitForText(title('home', id));
			expect(texts()).toContain(counter(index + 2, 8));
			shown.push({ id, pointing: pointing(), sample: bubbleTagged() });
		}
		// O "+" e as abas ficam fora desta tela no teste: o 9 é o texto sem apontar.
		expect(shown).toEqual([
			{ id: 3, pointing: true, sample: true },
			{ id: 4, pointing: true, sample: false },
			{ id: 5, pointing: true, sample: true },
			{ id: 6, pointing: true, sample: true },
			{ id: 7, pointing: true, sample: true },
			{ id: 8, pointing: true, sample: true },
			{ id: 9, pointing: false, sample: false },
		]);
		expect(mockActions).toEqual([]);
		expect(writes()).toEqual([]);
	});

	it('tocar nos blocos de exemplo não abre nada nem grava nada', async () => {
		await mount();
		await pressHelp('home');
		await waitForText(title('home', 1));
		for (const fn of Object.values(mockDb)) fn.mockClear();

		// A faixa "Revisar" de exemplo nem é tocável; o card das contas, a linha "Sem conta" e a
		// conta de exemplo não abrem nada.
		expect(byTestId('home-sample-review')[0].props.onPress).toBeUndefined();
		const tappable = renderer?.root.findAll(
			(node) =>
				typeof node.props.onPress === 'function' &&
				typeof node.props.accessibilityLabel === 'string' &&
				(node.props.accessibilityLabel.startsWith('trails.sample.tag') ||
					node.props.accessibilityLabel.includes('"name":"trails.sample.account"'))
		);
		expect((tappable ?? []).length).toBeGreaterThanOrEqual(3);
		for (const node of tappable ?? [])
			await act(async () => {
				node.props.onPress();
			});
		await wait(50);
		expect(mockRouter.push).not.toHaveBeenCalled();
		expect(writes()).toEqual([]);
	});

	it('os totais de verdade não mudam com o exemplo: "Este mês", "Em caixa" e "Depois das faturas", com os mesmos números', async () => {
		// Uma conta de verdade; sem cartão, conta a pagar, aviso nem lançamento sem conta.
		mockData.bankAccounts = [CORRENTE];
		await mount();
		const before = realTotals();
		expect(before.accounts).toEqual(['accounts.cash R$ 1.000,00. accounts.afterCards R$ 700,00']);
		expect(before.month).toEqual(
			expect.arrayContaining(['R$ 5.000,00', 'R$ 3.200,00', 'R$ 1.800,00'])
		);
		expect(blockTags()).toBe(0);

		await pressHelp('home');
		await waitForText(title('home', 1));
		// O exemplo está na tela: a faixa, as contas a pagar, o cartão e a linha "Sem conta".
		expect(blockTags()).toBe(4);
		expect(taggedBlock('home-sample-unassigned')).toBe(true);
		expect(byTestId('home-sample-accounts')).toEqual([]);
		// ... e os números de verdade são os mesmos: nem o "− R$ 100,00" da linha "Sem conta" nem a
		// fatura do cartão de exemplo entram em "Em caixa" ou em "Depois das faturas".
		expect(realTotals()).toEqual(before);
		// O "Falta pagar" do card é só o do exemplo, e só nele.
		expect(textsIn(byTestId('home-sample-bills')[0])).toContain('R$ 1.500,00');
		expect(textsIn(monthCard())).not.toContain('R$ 1.500,00');
	});

	it('com o dado de verdade, cada bloco é o de verdade: nenhum exemplo, e os números iguais', async () => {
		mockData.bankAccounts = [CORRENTE];
		mockData.creditCards = [CARTAO];
		mockData.cardsTotals = {
			toPayCents: 0,
			openInvoicesCents: 30_000,
			limitAvailableCents: null,
			limitUsedCents: 0,
		};
		mockData.bills = [{ ...INTERNET }];
		mockData.rows = [{ bill: mockData.bills[0], status: 'upcoming', dueDate: `${MONTH}-20` }];
		mockData.dueCents = 12_000;
		mockData.unassignedNetCents = -5_000;
		mockData.pending = [{ id: 'aviso' }];
		await mount();
		const home = () => textsIn(ofType(HomeScreen));
		const before = home();
		expect(before).toEqual(
			expect.arrayContaining(['R$ 300,00', 'captures.homeBanner{"count":1}', '− R$ 50,00'])
		);
		expect(before.join(' ')).toContain('R$ 120,00');

		await pressHelp('home');
		await waitForText(title('home', 1));
		expect(blockTags()).toBe(0);
		expect(home()).toEqual(before);
		expect(realTotals().accounts).toEqual([
			'accounts.cash R$ 1.000,00. accounts.afterCards R$ 700,00',
		]);
		expect(bubbleTagged()).toBe(false);
	});

	it('fechando a trilha, o exemplo some e a tela volta aos convites', async () => {
		await mount();
		await pressHelp('home');
		await waitForText(title('home', 1));
		expect(blockTags()).toBeGreaterThan(0);

		await pressLabel('tutorial.skip');
		await waitUntil(() => blockTags() === 0);
		expect(hasTarget('home.review')).toBe(false);
		expect(hasTarget('home.unassigned')).toBe(false);
		expect(hasTarget('home.billsInvite')).toBe(true);
		expect(hasTarget('home.cardsAdd')).toBe(true);
		expect(texts()).not.toContain('face:trails.sample.card');
		expect(writes()).toEqual([]);
	});

	it('outra trilha com exemplo que passa pela tela inicial (o "+", Trilha 5) não a enche de exemplo', async () => {
		await mount();
		await act(async () => {
			tour?.startTrail('add', { here: { screen: 'home' } });
		});
		await waitForText(title('add', 1));
		expect(blockTags()).toBe(0);
		expect(hasTarget('home.billsInvite')).toBe(true);
		expect(hasTarget('home.cardsAdd')).toBe(true);
	});
});

describe('Trilha 8 numa conta vazia (SPD-160)', () => {
	it('o card, a lista e a edição de exemplo; os passos 1 e 8 a 12 apontam, marcados como exemplo', async () => {
		await mount();
		await pressHelp('bills');
		await waitForText(title('bills', 1));
		expect(texts()).toContain(counter(1, 12));
		expect(taggedBlock('home-sample-bills')).toBe(true);
		expect(hasTarget('home.billsCard')).toBe(true);
		expect(pointing()).toBe(true);
		expect(bubbleTagged()).toBe(true);
		// A Trilha 8 não enche o resto da tela inicial de exemplo.
		expect(blockTags()).toBe(1);

		const shown: { id: number; pointing: boolean; sample: boolean }[] = [];
		for (const id of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
			await pressLabel('tutorial.next');
			await waitForText(title('bills', id));
			shown.push({ id, pointing: pointing(), sample: bubbleTagged() });
			if (id === 8) {
				// A lista de exemplo: a faixa, o selo em cada conta, "Já paguei", "Desfazer" e a lista.
				expect(hasBanner()).toBe(true);
				expect(byTestId('trail-sample-block-tag')).toHaveLength(2);
				for (const target of ['bills.pay', 'bills.undo', 'bills.list', 'bills.add'])
					expect({ target, registered: hasTarget(target) }).toEqual({ target, registered: true });
				expect(hasTarget('bills.emptyAdd')).toBe(false);
				expect(texts()).toEqual(
					expect.arrayContaining(['trails.sample.bill', 'trails.sample.billPaid'])
				);
				expect(texts()).toContain('R$ 1.500,00');
			}
		}
		await pressLabel('tutorial.next');
		await waitForText(title('bills', 12));
		shown.push({ id: 12, pointing: pointing(), sample: bubbleTagged() });
		// A edição da conta a pagar de exemplo: a faixa, os campos dela e "Desativar" e "Apagar".
		expect(hasBanner()).toBe(true);
		expect(hasTarget('billEdit.actions')).toBe(true);
		expect(hasTarget('billEdit.account')).toBe(true);
		expect(pressables('bills.edit.deactivate')).toHaveLength(1);
		expect(pressables('bills.edit.delete')).toHaveLength(1);

		expect(shown).toEqual([
			{ id: 2, pointing: true, sample: false },
			{ id: 3, pointing: true, sample: false },
			{ id: 4, pointing: true, sample: false },
			{ id: 5, pointing: true, sample: false },
			{ id: 6, pointing: true, sample: false },
			{ id: 7, pointing: true, sample: false },
			{ id: 8, pointing: true, sample: true },
			{ id: 9, pointing: true, sample: true },
			{ id: 10, pointing: true, sample: true },
			{ id: 11, pointing: true, sample: true },
			{ id: 12, pointing: true, sample: true },
		]);
		const pushed = mockActions.filter(
			(action): action is { type: 'push'; location: TrailLocation } =>
				(action as TrailNavAction).type === 'push'
		);
		expect(pushed.map((action) => action.location)).toEqual([
			{ screen: 'bills' },
			{ screen: 'billNew' },
			{ screen: 'billEdit', params: { id: SAMPLE_IDS.bill } },
		]);
		expect(isSampleId(SAMPLE_IDS.bill) && isSampleId(SAMPLE_IDS.billPaid)).toBe(true);
		expect(writes()).toEqual([]);
	});

	it('"Já paguei", "Desfazer", tocar na conta, Salvar, Desativar e Apagar do exemplo não gravam, não lançam e não agendam nada', async () => {
		await mount();
		await pressHelp('bills');
		await waitForText(title('bills', 1));
		for (let id = 2; id <= 8; id += 1) {
			await pressLabel('tutorial.next');
			await waitForText(title('bills', id));
		}
		for (const fn of Object.values(mockDb)) fn.mockClear();
		mockRouter.push.mockClear();

		expect(await pressAll('bills.markPaid')).toBe(1);
		expect(await pressAll('bills.undoPaid')).toBe(1);
		// Tocar na conta de exemplo não abre a edição (quem abre é a trilha).
		const rows = renderer?.root.findAll(
			(node) =>
				typeof node.props.onPress === 'function' &&
				typeof node.props.accessibilityLabel === 'string' &&
				node.props.accessibilityLabel.startsWith('trails.sample.tag, trails.sample.bill')
		);
		expect((rows ?? []).length).toBe(2);
		for (const row of rows ?? [])
			await act(async () => {
				row.props.onPress();
			});
		await wait(50);
		expect(mockRouter.push).not.toHaveBeenCalled();
		expect(writes()).toEqual([]);

		for (let id = 9; id <= 12; id += 1) {
			await pressLabel('tutorial.next');
			await waitForText(title('bills', id));
		}
		expect(hasBanner()).toBe(true);
		await pressAll('bills.edit.save');
		await pressAll('bills.edit.deactivate');
		await pressAll('bills.edit.delete');
		await wait(50);
		expect(writes()).toEqual([]);
		expect(mockRouter.back).not.toHaveBeenCalled();
		expect([...mockStorage.keys()].filter((key) => key !== STORAGE_KEYS.tutorial)).toEqual([]);
	});

	it('com uma conta a pagar de verdade, a lista e o card são os dela, sem exemplo', async () => {
		mockData.bills = [{ ...INTERNET }];
		mockData.rows = [{ bill: mockData.bills[0], status: 'upcoming', dueDate: `${MONTH}-20` }];
		mockData.dueCents = 12_000;
		await mount();
		await pressHelp('bills');
		await waitForText(title('bills', 1));
		expect(blockTags()).toBe(0);
		expect(bubbleTagged()).toBe(false);
		for (let id = 2; id <= 8; id += 1) {
			await pressLabel('tutorial.next');
			await waitForText(title('bills', id));
		}
		expect(hasBanner()).toBe(false);
		expect(texts()).not.toContain('trails.sample.bill');
		expect(texts()).toContain('Internet teste');
		expect(bubbleTagged()).toBe(false);
	});

	it('fechando a trilha na lista de exemplo, o exemplo some', async () => {
		await mount();
		await pressHelp('bills');
		await waitForText(title('bills', 1));
		for (let id = 2; id <= 8; id += 1) {
			await pressLabel('tutorial.next');
			await waitForText(title('bills', id));
		}
		// Na lista: a faixa e as duas contas a pagar de exemplo, com o selo.
		expect(hasBanner()).toBe(true);
		expect(blockTags()).toBe(2);
		expect(texts()).toContain('trails.sample.bill');

		await pressLabel('tutorial.skip');
		await waitUntil(() => blockTags() === 0);
		// Fechar volta ao Início, de onde a trilha abriu: o card das contas a pagar é de novo a linha
		// com "Cadastrar", e o exemplo não está em lugar nenhum.
		expect(mockActions.slice(-1)).toEqual([{ type: 'pop', count: 1 }]);
		expect(hasBanner()).toBe(false);
		expect(texts()).not.toContain('trails.sample.bill');
		expect(texts()).not.toContain('trails.sample.billPaid');
		expect(hasTarget('home.billsInvite')).toBe(true);
		expect(hasTarget('home.billsCard')).toBe(false);
		expect(writes()).toEqual([]);
	});
});
