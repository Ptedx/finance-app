/**
 * O aviso "Juntamos X em Y" na lista de contas (SPD-116): quando o app juntou sozinho a ficha
 * duplicada vazia, a tela de Contas — onde estaria o aviso "Duas contas do mesmo banco" — conta
 * o que fez, uma vez. Sai ao tocar em "Entendi" ou ao deixar a tela. O resto da tela é dublê;
 * as chaves de tradução aparecem cruas.
 */

const mockDismiss = jest.fn();
const mockData: { notices: { from: string; into: string }[] } = { notices: [] };

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

jest.mock('../../contexts/AccountsContext', () => ({
	useAccounts: () => ({
		accounts: [],
		bankAccounts: [],
		balances: new Map(),
		provisionalBalances: new Map(),
		overview: { cashCents: 0, netCents: 0 },
		provisionalOverview: { cashCents: 0, netCents: 0 },
		month: null,
		unassignedNetCents: 0,
		isLoading: false,
		mergeAccounts: jest.fn(),
		autoMergeNotices: mockData.notices,
		dismissAutoMergeNotices: mockDismiss,
	}),
}));

import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import AccountsScreen from '../AccountsScreen';

jest.setTimeout(20_000);

let renderer: ReactTestRenderer | null = null;

const texts = (): string[] =>
	renderer?.root
		.findAll((node) => (node.type as unknown) === 'Text')
		.map((node) => [node.props.children].flat().join(''))
		.filter((text) => /^accounts\.duplicate\.autoMerged(Body)? /.test(text)) ?? [];

const okButtons = (): ReactTestInstance[] =>
	renderer?.root.findAll(
		(node) => typeof node.props.onPress === 'function' && node.props.accessibilityLabel === 'accounts.duplicate.autoMergedOk'
	) ?? [];

const mount = async () => {
	await act(async () => {
		renderer = create(<AccountsScreen />);
	});
};

beforeEach(() => {
	jest.clearAllMocks();
	mockData.notices = [];
});

afterEach(() => {
	act(() => renderer?.unmount());
	renderer = null;
});

describe('aviso "Juntamos X em Y"', () => {
	it('mostra os nomes das duas contas', async () => {
		mockData.notices = [{ from: 'Banco Teste', into: 'Corrente' }];
		await mount();
		expect(texts()).toEqual([
			'accounts.duplicate.autoMerged {"from":"Banco Teste","into":"Corrente"}',
			'accounts.duplicate.autoMergedBody {"from":"Banco Teste","into":"Corrente"}',
		]);
	});

	it('"Entendi" tira o aviso', async () => {
		mockData.notices = [{ from: 'Banco Teste', into: 'Corrente' }];
		await mount();
		expect(okButtons()).toHaveLength(1);
		await act(async () => {
			okButtons()[0].props.onPress();
		});
		expect(mockDismiss).toHaveBeenCalledTimes(1);
	});

	it('deixar a tela depois de ver o aviso também o tira: aparece uma vez', async () => {
		mockData.notices = [{ from: 'Banco Teste', into: 'Corrente' }];
		await mount();
		expect(mockDismiss).not.toHaveBeenCalled();
		act(() => renderer?.unmount());
		renderer = null;
		expect(mockDismiss).toHaveBeenCalledTimes(1);
	});

	it('sem junção, nada aparece e nada é dispensado', async () => {
		await mount();
		expect(texts()).toEqual([]);
		act(() => renderer?.unmount());
		renderer = null;
		expect(mockDismiss).not.toHaveBeenCalled();
	});
});
