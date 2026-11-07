/**
 * "Saldo não informado" na lista de contas e no card de contas da tela inicial (SPD-114).
 *
 * A conta que a captura criou sozinha nasce com saldo 0. O selo aparece na linha dela até o
 * usuário definir o saldo ou dispensar, e tocar nele abre a conta já no "Acertar com o banco".
 * A conta cadastrada à mão com saldo zero não ganha selo. O resto da tela é dublê; as chaves
 * de tradução aparecem cruas.
 */

const mockPush = jest.fn();
const mockData: { accounts: unknown[] } = { accounts: [] };

jest.mock('@react-native-async-storage/async-storage', () =>
	require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

jest.mock('expo-router', () => ({
	useRouter: () => ({ replace: jest.fn(), back: jest.fn(), push: mockPush }),
	useFocusEffect: (effect: () => void) => require('react').useEffect(effect, [effect]),
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

jest.mock('../../database/database', () => ({ setPreference: jest.fn() }));
jest.mock('../../utils/distinctAccounts', () => ({
	getDistinctAccountPairs: jest.fn(async () => []),
	markAccountsDistinct: jest.fn(),
}));
jest.mock('../../utils/businessFeedPreference', () => ({ getBusinessFeeds: jest.fn(async () => ({})) }));

jest.mock('../../contexts/AccountsContext', () => ({
	useAccounts: () => ({
		accounts: mockData.accounts,
		bankAccounts: mockData.accounts,
		balances: new Map([['captura', -2_647]]),
		provisionalBalances: new Map(),
		overview: { cashCents: -2_647, netCents: -2_647 },
		provisionalOverview: { cashCents: 0, netCents: 0 },
		month: null,
		unassignedNetCents: 0,
		isLoading: false,
		mergeAccounts: jest.fn(),
	}),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import AccountsOverview from '../../components/AccountsOverview';
import type { Account } from '../../database/schema';
import { BALANCE_UNSET_DISMISSED_KEY } from '../../utils/balanceUnsetDismissals';
import AccountsScreen from '../AccountsScreen';

jest.setTimeout(20_000);

/** A conta como a captura cria: nome do banco, app ligado, saldo 0 na véspera da compra. */
const FROM_CAPTURE: Account = {
	id: 'captura',
	name: 'Banco Teste',
	kind: 'checking',
	role: 'main',
	envelopeMonthlyCents: null,
	network: null,
	bankName: 'Banco Teste',
	color: '#4CAF50',
	last4: null,
	closingDay: null,
	dueDay: null,
	closingDaysBefore: null,
	creditLimitCents: null,
	cardNames: null,
	packageName: 'br.com.bancoteste',
	accountKey: null,
	openingBalanceCents: 0,
	openingBalanceDate: '2026-11-05',
	sortOrder: 0,
	archived: false,
	updatedAt: '',
};

/** Cadastrada à mão com o saldo em branco: zero de propósito. */
const BY_HAND: Account = { ...FROM_CAPTURE, id: 'mao', name: 'Corrente', packageName: null, sortOrder: 1 };

let renderer: ReactTestRenderer;

const badges = (): ReactTestInstance[] =>
	renderer.root.findAll(
		(node) => typeof node.props.onPress === 'function' && node.props.accessibilityLabel === 'accounts.balanceUnset.badge'
	);

const mount = async (element: Parameters<typeof create>[0]) => {
	await act(async () => {
		renderer = create(element);
	});
};

beforeEach(async () => {
	jest.clearAllMocks();
	await AsyncStorage.clear();
	mockData.accounts = [FROM_CAPTURE, BY_HAND];
});

afterEach(() => {
	act(() => renderer.unmount());
});

describe('lista de contas', () => {
	it('mostra o selo só na conta criada pela captura', async () => {
		await mount(<AccountsScreen />);
		expect(badges()).toHaveLength(1);
		const texts = renderer.root.findAll((node) => (node.type as unknown) === 'Text' && node.props.children === 'accounts.balanceUnset.badge');
		expect(texts).toHaveLength(1);
	});

	it('tocar no selo abre a conta já no "Acertar com o banco"', async () => {
		await mount(<AccountsScreen />);
		await act(async () => {
			badges()[0].props.onPress();
		});
		expect(mockPush).toHaveBeenCalledTimes(1);
		expect(mockPush).toHaveBeenCalledWith({ pathname: '/accounts/[id]', params: { id: 'captura', setBalance: '1' } });
	});

	it('dispensado neste aparelho, o selo não aparece', async () => {
		await AsyncStorage.setItem(BALANCE_UNSET_DISMISSED_KEY, JSON.stringify(['captura']));
		await mount(<AccountsScreen />);
		expect(badges()).toHaveLength(0);
	});

	it('com o saldo definido, o selo some sozinho', async () => {
		mockData.accounts = [{ ...FROM_CAPTURE, openingBalanceCents: 150_000, openingBalanceDate: '2026-11-06' }, BY_HAND];
		await mount(<AccountsScreen />);
		expect(badges()).toHaveLength(0);
	});
});

describe('card de contas da tela inicial', () => {
	it('mostra o selo na mesma conta, e tocar nele leva ao "Acertar com o banco"', async () => {
		await mount(<AccountsOverview />);
		expect(badges()).toHaveLength(1);
		await act(async () => {
			badges()[0].props.onPress();
		});
		expect(mockPush).toHaveBeenCalledWith({ pathname: '/accounts/[id]', params: { id: 'captura', setBalance: '1' } });
	});
});
