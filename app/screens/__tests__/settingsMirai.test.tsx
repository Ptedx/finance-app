/**
 * O Mirai em Configurações (SPD-163, D6): a linha aparece só para a conta em que o servidor o
 * ligou; a chave mostra se ele está ativado; desligar tira o botão e ligar passa pela tela de
 * ativação (as duas coisas são do `MiraiContext`, testado em `miraiLayer.test.tsx`; aqui, só
 * que a tela pede a certa).
 */

const mockMirai: { value: Record<string, unknown> | null } = { value: null };
const mockSetTurnedOn = jest.fn();

jest.mock('expo-router', () => ({
	router: { back: jest.fn(), push: jest.fn() },
	Stack: { Screen: () => null },
}));

jest.mock('expo-constants', () => ({ expoConfig: { version: '1.2.9' } }));

// O ícone vira um elemento de verdade, para o teste ler o nome que a tela pediu.
jest.mock('@expo/vector-icons', () => {
	const { createElement } = require('react');
	return { Ionicons: (props: Record<string, unknown>) => createElement('Icon', props) };
});

jest.mock('react-native-safe-area-context', () => {
	const { View } = require('react-native');
	return { SafeAreaView: View };
});

jest.mock('react-i18next', () => ({
	useTranslation: () => ({
		t: (key: string, params?: Record<string, unknown>) =>
			params ? `${key}${JSON.stringify(params)}` : key,
	}),
}));

jest.mock('../../components/CurrencySelector', () => () => null);
jest.mock('../../components/LanguageSelector', () => () => null);

jest.mock('../../contexts/MiraiContext', () => ({
	useMirai: () => mockMirai.value,
}));
jest.mock('../../contexts/AuthContext', () => ({
	useAuth: () => ({ account: null, isAvailable: false }),
}));
jest.mock('../../contexts/BillsContext', () => ({
	useBills: () => ({ rescheduleReminders: jest.fn() }),
}));
jest.mock('../../contexts/CapturesContext', () => ({
	useCaptures: () => ({
		supported: false,
		enabled: false,
		pendingCount: 0,
		openSettings: jest.fn(),
		importStatement: jest.fn(),
	}),
}));
jest.mock('../../contexts/CurrencyContext', () => ({
	useCurrency: () => ({ currentCurrency: { code: 'BRL', symbol: 'R$' } }),
}));
jest.mock('../../contexts/LanguageContext', () => ({
	useLanguage: () => ({ currentLanguage: { code: 'pt', nativeName: 'Português' } }),
}));
jest.mock('../../contexts/PeriodContext', () => ({
	usePeriod: () => ({ resetToCurrentMonth: jest.fn() }),
}));
jest.mock('../../contexts/SyncContext', () => ({
	describeSync: () => ({
		tone: 'ok',
		label: { key: 'account.statusSynced', count: 0 },
		short: { key: 'account.statusSynced', count: 0 },
	}),
	useSync: () => ({
		status: 'idle',
		pending: 0,
		unsynced: 0,
		lastSyncedAt: null,
		syncNow: jest.fn(),
	}),
}));
jest.mock('../../contexts/TransactionsContext', () => ({
	useTransactions: () => ({ refreshData: jest.fn() }),
}));
jest.mock('../../diagnostics/export', () => ({ exportDiagnostics: jest.fn() }));
jest.mock('../../hooks/useBiometricAuth', () => ({
	useBiometricAuth: () => ({ authenticate: jest.fn(), isAuthenticating: false }),
}));
jest.mock('../../utils/biometricUtils', () => ({
	isBiometricAvailable: jest.fn(async () => false),
	getBiometricType: jest.fn(async () => null),
	getSupportedAuthTypes: jest.fn(async () => []),
	isBiometricEnabled: jest.fn(async () => false),
	setBiometricEnabled: jest.fn(),
	authenticateWithBiometrics: jest.fn(),
}));
jest.mock('../../utils/dataWipe', () => ({ eraseAllData: jest.fn() }));
jest.mock('../../utils/exportUtils', () => ({
	exportDatabaseData: jest.fn(),
	importDatabaseData: jest.fn(),
}));
jest.mock('../../utils/notificationUtils', () => ({
	areNotificationsEnabled: jest.fn(async () => false),
}));
jest.mock('../../utils/ownNamePreference', () => ({
	getOwnBankName: jest.fn(async () => null),
	setOwnBankName: jest.fn(),
}));
jest.mock('../../utils/statementImport', () => ({
	StatementImportError: class StatementImportError extends Error {},
}));

import { Switch } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import SettingsScreen from '../SettingsScreen';

const ionicons: Record<string, number> = jest.requireActual(
	'@expo/vector-icons/build/vendor/react-native-vector-icons/glyphmaps/Ionicons.json'
);

// A primeira montagem carrega a tela inteira; com a suíte toda rodando junto, passa dos 5 s.
jest.setTimeout(20_000);

let renderer: ReactTestRenderer;

const isHostText = (node: ReactTestInstance): boolean => (node.type as unknown) === 'Text';
const textOf = (node: ReactTestInstance): string => [node.props.children].flat().join('');

const miraiRow = (): ReactTestInstance | null => {
	const title = renderer.root
		.findAll(isHostText)
		.find((node) => textOf(node) === 'mirai.settingsLabel');
	let row: ReactTestInstance | null = title ?? null;
	while (row && !row.props.onPress) row = row.parent;
	return row;
};

const miraiSwitch = (): ReactTestInstance => {
	const row = miraiRow();
	if (!row) throw new Error('a linha do Mirai não está na tela');
	return row.find((node) => (node.type as unknown) === Switch);
};

const mount = async () => {
	await act(async () => {
		renderer = create(<SettingsScreen />);
	});
};

beforeEach(() => {
	mockSetTurnedOn.mockClear();
	mockMirai.value = null;
});

afterEach(() => {
	act(() => renderer?.unmount());
});

describe('o Mirai em Configurações', () => {
	it('fora do provider, ou com a conta fora da lista, a linha não aparece', async () => {
		await mount();
		expect(miraiRow()).toBeNull();
		act(() => renderer.unmount());

		mockMirai.value = { enabled: false, choice: null, setTurnedOn: mockSetTurnedOn };
		await mount();
		expect(miraiRow()).toBeNull();
	});

	it('ativado: a chave ligada, com um ícone que o Ionicons tem; desligar pede off', async () => {
		mockMirai.value = { enabled: true, choice: 'on', setTurnedOn: mockSetTurnedOn };
		await mount();

		expect(miraiSwitch().props.value).toBe(true);
		const icon = miraiRow()?.findAll((node) => (node.type as unknown) === 'Icon')[0].props.name;
		expect(icon in ionicons).toBe(true);

		await act(async () => miraiSwitch().props.onValueChange(false));
		expect(mockSetTurnedOn).toHaveBeenCalledWith(false);
	});

	it('sem ativar (vem desligado) ou desligado: a chave desligada; ligar pede on', async () => {
		for (const choice of [null, 'off']) {
			mockMirai.value = { enabled: true, choice, setTurnedOn: mockSetTurnedOn };
			await mount();
			expect(miraiSwitch().props.value).toBe(false);
			await act(async () => miraiSwitch().props.onValueChange(true));
			expect(mockSetTurnedOn).toHaveBeenLastCalledWith(true);
			act(() => renderer.unmount());
		}
	});
});
