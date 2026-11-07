/**
 * "Seu nome como aparece no banco" em Ajustes (SPD-115): a linha abre a folha, o nome
 * digitado é salvo e volta preenchido quando a folha reabre — também numa montagem nova da
 * tela, que é o app aberto de novo.
 *
 * O armazenamento é o de verdade (`ownNamePreference`) sobre o dublê do AsyncStorage. As
 * chaves de tradução aparecem cruas.
 */

jest.mock('expo-router', () => ({
	router: { back: jest.fn(), push: jest.fn() },
	Stack: { Screen: () => null },
}));

jest.mock('expo-constants', () => ({ expoConfig: { version: '1.2.9' } }));

jest.mock('@expo/vector-icons', () => {
	const { createElement } = require('react');
	return { Ionicons: (props: Record<string, unknown>) => createElement('Icon', props) };
});

jest.mock('react-native-safe-area-context', () => {
	const { View } = require('react-native');
	return {
		SafeAreaView: View,
		useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
	};
});

jest.mock('react-i18next', () => ({
	useTranslation: () => ({
		t: (key: string, params?: Record<string, unknown>) =>
			params ? `${key}${JSON.stringify(params)}` : key,
	}),
}));

jest.mock('@react-native-async-storage/async-storage', () =>
	require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('../../database/database', () => ({ setPreference: jest.fn() }));

jest.mock('../../components/CurrencySelector', () => () => null);
jest.mock('../../components/LanguageSelector', () => () => null);

jest.mock('../../contexts/AuthContext', () => ({
	useAuth: () => ({ account: null, isAvailable: false }),
}));
jest.mock('../../contexts/BillsContext', () => ({
	useBills: () => ({ rescheduleReminders: jest.fn() }),
}));
jest.mock('../../contexts/CapturesContext', () => ({
	useCaptures: () => ({
		supported: true,
		enabled: true,
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
jest.mock('../../contexts/RecurringTransactionsContext', () => ({
	useRecurringTransactions: () => ({ transactions: [], refreshTransactions: jest.fn() }),
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
jest.mock('../../utils/statementImport', () => ({
	StatementImportError: class StatementImportError extends Error {},
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Modal, TextInput } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { setPreference } from '../../database/database';
import { OWN_BANK_NAME_KEY } from '../../utils/ownNamePreference';
import SettingsScreen from '../SettingsScreen';

jest.setTimeout(20_000);

let renderer: ReactTestRenderer;

const isHostText = (node: ReactTestInstance): boolean => (node.type as unknown) === 'Text';
const textOf = (node: ReactTestInstance): string => [node.props.children].flat().join('');

/** A linha do nome: a que tem o título `ownName.settingsItem`. */
const nameRow = (): ReactTestInstance => {
	const title = renderer.root
		.findAll(isHostText)
		.find((node) => textOf(node) === 'ownName.settingsItem');
	if (!title) throw new Error('a linha do nome não está na tela');
	let row: ReactTestInstance | null = title;
	while (row && !row.props.onPress) row = row.parent;
	if (!row) throw new Error('a linha do nome não é tocável');
	return row;
};

/** O que a linha mostra à direita: o nome salvo, ou "não informado". */
const rowValue = (): string[] =>
	nameRow()
		.findAll(isHostText)
		.map(textOf)
		.filter((text) => text !== 'ownName.settingsItem');

/** A folha do nome; fechada, o Modal não desenha o campo e ela não é achada. */
const sheet = (): ReactTestInstance | undefined =>
	renderer.root
		.findAll((node) => (node.type as unknown) === Modal)
		.find((node) => node.findAll((n) => n.props.accessibilityLabel === 'ownName.field').length > 0);

const isOpen = (): boolean => Boolean(sheet()?.props.visible);
const openSheetNode = (): ReactTestInstance => {
	const node = sheet();
	if (!node) throw new Error('a folha do nome não está aberta');
	return node;
};
const input = (): ReactTestInstance =>
	openSheetNode().find(
		(node) =>
			(node.type as unknown) === TextInput && node.props.accessibilityLabel === 'ownName.field'
	);
const press = async (label: string) => {
	const button = openSheetNode().find(
		(node) => node.props.accessibilityLabel === label && typeof node.props.onPress === 'function'
	);
	await act(async () => {
		await button.props.onPress();
	});
};

const mount = async () => {
	await act(async () => {
		renderer = create(<SettingsScreen />);
	});
};

const openSheet = async () => {
	await act(async () => {
		await nameRow().props.onPress();
	});
};

beforeEach(async () => {
	await AsyncStorage.clear();
	jest.clearAllMocks();
	(setPreference as jest.Mock).mockImplementation((key: string, value: string | null) =>
		value === null ? AsyncStorage.removeItem(key) : AsyncStorage.setItem(key, value)
	);
});

afterEach(() => {
	act(() => renderer?.unmount());
});

describe('seu nome como aparece no banco', () => {
	it('sem nome salvo, a linha diz que não foi informado', async () => {
		await mount();
		expect(rowValue()).toEqual(['ownName.notSet']);
	});

	it('salva o que foi digitado e reabre com o valor', async () => {
		await mount();
		await openSheet();
		expect(isOpen()).toBe(true);
		expect(input().props.value).toBe('');

		await act(async () => {
			input().props.onChangeText('  MARIA S OLIVEIRA ');
		});
		await press('ownName.save');

		expect(await AsyncStorage.getItem(OWN_BANK_NAME_KEY)).toBe('MARIA S OLIVEIRA');
		expect(isOpen()).toBe(false);
		expect(rowValue()).toEqual(['MARIA S OLIVEIRA']);

		await openSheet();
		expect(input().props.value).toBe('MARIA S OLIVEIRA');
	});

	it('o app aberto de novo mostra o nome salvo, na linha e na folha', async () => {
		await AsyncStorage.setItem(OWN_BANK_NAME_KEY, 'MARIA S OLIVEIRA');
		await mount();
		expect(rowValue()).toEqual(['MARIA S OLIVEIRA']);

		await openSheet();
		expect(input().props.value).toBe('MARIA S OLIVEIRA');
	});

	it('apagar o campo e salvar tira o nome', async () => {
		await AsyncStorage.setItem(OWN_BANK_NAME_KEY, 'MARIA S OLIVEIRA');
		await mount();
		await openSheet();

		await act(async () => {
			input().props.onChangeText('');
		});
		await press('ownName.save');

		expect(await AsyncStorage.getItem(OWN_BANK_NAME_KEY)).toBeNull();
		expect(rowValue()).toEqual(['ownName.notSet']);
	});
});
