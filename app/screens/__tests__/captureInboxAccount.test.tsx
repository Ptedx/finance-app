/**
 * Escolher a conta na revisão da captura (SPD-111, AUTO-11).
 *
 * A captura que caiu em "Sem conta" só mostrava o texto no cartão da revisão, e a única
 * saída era confirmar e depois mover tudo de uma vez em "Lançamentos sem conta". Agora o
 * seletor de conta já aparece aberto nela, e confirmar leva a conta escolhida. O resto da
 * tela é dublê; as chaves de tradução aparecem cruas.
 */

const mockConfirm = jest.fn(async (..._args: unknown[]) => undefined);
const mockData: { pending: unknown[]; accounts: unknown[] } = { pending: [], accounts: [] };

jest.mock('@react-native-async-storage/async-storage', () =>
	require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

jest.mock('expo-sqlite', () => ({
	openDatabaseSync: () => ({
		execAsync: jest.fn(async () => undefined),
		runAsync: jest.fn(async () => ({ changes: 0, lastInsertRowId: 0 })),
		getFirstAsync: jest.fn(async () => null),
		getAllAsync: jest.fn(async () => []),
		withTransactionAsync: jest.fn(async (body: () => Promise<void>) => body()),
	}),
}));

jest.mock('expo-router', () => ({
	useRouter: () => ({ replace: jest.fn(), back: jest.fn(), push: jest.fn() }),
	Stack: { Screen: () => null },
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('react-native-safe-area-context', () => {
	const { View } = require('react-native');
	return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) };
});

jest.mock('react-i18next', () => ({
	useTranslation: () => ({
		t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
	}),
}));

jest.mock('../../components/HorizontalCategoryPicker', () => () => null);

jest.mock('../../contexts/AccountsContext', () => ({
	useAccounts: () => ({ accounts: mockData.accounts, activeAccounts: mockData.accounts }),
}));

jest.mock('../../contexts/TransactionsContext', () => ({
	useTransactions: () => ({
		transactions: [],
		categories: [{ id: 'food', name: 'Alimentação', type: 'expense', color: '#fff', icon: 'pizza' }],
	}),
}));

jest.mock('../../contexts/CapturesContext', () => ({
	useCaptures: () => ({
		supported: true,
		enabled: true,
		pending: mockData.pending,
		resolved: [],
		ignoredApps: [],
		isLoading: false,
		lastAction: null,
		refresh: jest.fn(),
		openSettings: jest.fn(),
		confirm: mockConfirm,
		dismiss: jest.fn(),
		markTransfer: jest.fn(),
		answerDuplicate: jest.fn(),
		answerTransfer: jest.fn(),
		revert: jest.fn(),
		unignoreApp: jest.fn(),
		undo: jest.fn(),
		clearUndo: jest.fn(),
	}),
}));

import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { Account, Capture } from '../../database/schema';
import CaptureInboxScreen from '../CaptureInboxScreen';

jest.setTimeout(20_000);

const account = (id: string, name: string, kind: Account['kind']): Account => ({
	id,
	name,
	kind,
	role: kind === 'credit_card' ? 'card' : 'main',
	envelopeMonthlyCents: null,
	bankName: null,
	color: '#15E8FE',
	last4: null,
	network: null,
	closingDay: kind === 'credit_card' ? 10 : null,
	dueDay: null,
	closingDaysBefore: null,
	creditLimitCents: null,
	cardNames: null,
	packageName: null,
	accountKey: null,
	openingBalanceCents: 0,
	openingBalanceDate: '2026-11-01',
	sortOrder: 0,
	archived: false,
	updatedAt: '',
});

const CHECKING = account('conta-a', 'Conta A', 'checking');
const CARD = account('cartao-b', 'Cartão B', 'credit_card');

const capture = (overrides: Partial<Capture> = {}): Capture => ({
	id: 'cap-1',
	fingerprint: 'fp',
	packageName: 'com.example.bank',
	appLabel: 'Banco',
	title: 'Compra',
	text: 'Compra aprovada',
	postedAt: '2026-11-07T15:00:00.000Z',
	amountCents: 4_500,
	direction: 'out',
	kind: 'purchase',
	counterparty: 'PADARIA',
	merchantKey: 'padaria',
	cardLast4: null,
	status: 'pending',
	question: null,
	relatedId: null,
	suggestedCategory: 'food',
	transactionId: null,
	autoConfirmed: false,
	reason: null,
	accountId: null,
	transferId: null,
	installments: null,
	createdAt: '',
	updatedAt: '',
	...overrides,
});

let renderer: ReactTestRenderer;

const mount = async (pending: Capture) => {
	mockData.pending = [pending];
	mockData.accounts = [CHECKING, CARD];
	await act(async () => {
		renderer = create(<CaptureInboxScreen />);
	});
};

/** O controle tocável com aquele rótulo (o `Pressable`, não a `View` que ele desenha). */
const pressable = (label: string): ReactTestInstance | undefined =>
	renderer.root.findAll(
		(node) => node.props.accessibilityLabel === label && typeof node.props.onPress === 'function'
	)[0];

const press = async (label: string) => {
	const target = pressable(label);
	if (!target) throw new Error(`nada tocável com o rótulo ${label}`);
	await act(async () => {
		target.props.onPress();
	});
};

const accountPickerShown = (): boolean =>
	renderer.root.findAll((node) => node.props.accessibilityRole === 'radiogroup' && node.props.accessibilityLabel === 'accounts.picker.label')
		.length > 0;

beforeEach(() => {
	mockConfirm.mockClear();
});

afterEach(() => {
	act(() => renderer.unmount());
});

describe('a captura "Sem conta" escolhe a conta na revisão', () => {
	it('mostra o seletor de conta já aberto', async () => {
		await mount(capture());

		expect(accountPickerShown()).toBe(true);
		expect(pressable(CHECKING.name)).toBeDefined();
		expect(pressable(CARD.name)).toBeDefined();
	});

	it('escolhendo uma conta, confirmar leva essa conta', async () => {
		await mount(capture());

		await press(CARD.name);
		await press('captures.confirm');

		expect(mockConfirm).toHaveBeenCalledTimes(1);
		expect(mockConfirm.mock.calls[0]).toEqual(['cap-1', 'food', CARD.id]);
	});
});

describe('a captura com conta pode trocá-la', () => {
	it('o seletor começa fechado e abre pela linha da conta', async () => {
		await mount(capture({ accountId: CHECKING.id }));

		expect(accountPickerShown()).toBe(false);
		await press(`captures.inAccount ${JSON.stringify({ account: CHECKING.name })}`);
		expect(accountPickerShown()).toBe(true);

		await press(CARD.name);
		await press('captures.confirm');

		expect(mockConfirm.mock.calls[0]).toEqual(['cap-1', 'food', CARD.id]);
	});

	it('sem mexer na conta, confirmar não manda conta nenhuma: fica a do aviso', async () => {
		await mount(capture({ accountId: CHECKING.id }));

		await press('captures.confirm');

		expect(mockConfirm.mock.calls[0].slice(0, 2)).toEqual(['cap-1', 'food']);
		expect(mockConfirm.mock.calls[0][2]).toBeUndefined();
	});
});
