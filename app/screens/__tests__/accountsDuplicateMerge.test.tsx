/**
 * O aviso "Duas contas do mesmo banco" na lista de contas, quando o juntar é recusado
 * (SPD-152): o `mergeAccounts` recusa juntar papéis diferentes (`MergeRoleError`). O aviso já
 * só pareia fichas do mesmo papel (`duplicateAccountPairs`), mas o papel pode mudar em outro
 * aparelho entre abrir o aviso e tocar: aí a tela diz por que não juntou, em vez de engolir o
 * erro. O resto da tela é dublê; as chaves de tradução aparecem cruas.
 */

const mockMerge = jest.fn();

jest.mock('@react-native-async-storage/async-storage', () =>
	require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

jest.mock('expo-router', () => ({
	useRouter: () => ({ replace: jest.fn(), back: jest.fn(), push: jest.fn() }),
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

const mockAccount = (overrides: Record<string, unknown>) => ({
	id: 'x',
	name: 'Conta',
	kind: 'checking',
	role: 'main',
	envelopeMonthlyCents: null,
	network: null,
	bankName: null,
	color: '#000',
	last4: null,
	closingDay: null,
	dueDay: null,
	closingDaysBefore: null,
	creditLimitCents: null,
	cardNames: null,
	packageName: null,
	accountKey: null,
	openingBalanceCents: 0,
	openingBalanceDate: '2026-09-01',
	sortOrder: 0,
	archived: false,
	updatedAt: '',
	...overrides,
});

const mockAccounts = [
	mockAccount({ id: 'banco-app', name: 'Banco Teste', bankName: 'Banco Teste', packageName: 'br.com.bancoteste' }),
	mockAccount({ id: 'banco-mao', name: 'Banco Teste PF', bankName: 'Banco Teste', sortOrder: 1 }),
];

jest.mock('../../contexts/AccountsContext', () => ({
	useAccounts: () => ({
		accounts: mockAccounts,
		bankAccounts: mockAccounts,
		balances: new Map(),
		provisionalBalances: new Map(),
		overview: { cashCents: 0, netCents: 0 },
		provisionalOverview: { cashCents: 0, netCents: 0 },
		month: null,
		unassignedNetCents: 0,
		isLoading: false,
		mergeAccounts: mockMerge,
		autoMergeNotices: [],
		dismissAutoMergeNotices: jest.fn(),
	}),
}));

import { Alert, type AlertButton } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { MergeRoleError } from '../../utils/accountMerging';
import AccountsScreen from '../AccountsScreen';

jest.setTimeout(20_000);

let renderer: ReactTestRenderer | null = null;

const mount = async () => {
	await act(async () => {
		renderer = create(<AccountsScreen />);
	});
};

/** Toca em "Juntar" no aviso e em "Ficar com Banco Teste" na confirmação. */
const mergeKeepingFed = async (alert: jest.SpyInstance) => {
	const action = renderer?.root.find(
		(node) => typeof node.props.onPress === 'function' && node.props.accessibilityLabel === 'accounts.duplicate.action'
	);
	act(() => action?.props.onPress());
	const buttons = alert.mock.calls[0][2] as AlertButton[];
	const keep = buttons.find((button) => button.text === 'accounts.duplicate.keep {"name":"Banco Teste"}');
	await act(async () => {
		keep?.onPress?.();
	});
};

beforeEach(() => {
	jest.clearAllMocks();
});

afterEach(() => {
	act(() => renderer?.unmount());
	renderer = null;
});

describe('juntar pelo aviso de duplicadas', () => {
	it('recusado por papel diferente: a tela diz por quê, com os dois nomes', async () => {
		mockMerge.mockRejectedValue(new MergeRoleError());
		const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
		await mount();
		await mergeKeepingFed(alert);

		expect(mockMerge).toHaveBeenCalledWith('banco-mao', 'banco-app');
		expect(alert).toHaveBeenCalledTimes(2);
		expect(alert.mock.calls[1][0]).toBe('accounts.duplicate.title');
		expect(alert.mock.calls[1][1]).toBe('accounts.edit.mergeRoleBlocked {"from":"Banco Teste PF","into":"Banco Teste"}');
	});

	it('aceito: junta e não mostra mais nada', async () => {
		mockMerge.mockResolvedValue(undefined);
		const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
		await mount();
		await mergeKeepingFed(alert);

		expect(mockMerge).toHaveBeenCalledWith('banco-mao', 'banco-app');
		expect(alert).toHaveBeenCalledTimes(1);
	});
});
