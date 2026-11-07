/**
 * Religar os lembretes em Ajustes não agenda mais as recorrências antigas (SPD-122, DEC-37).
 *
 * A chave de notificações chamava `checkAndScheduleNotifications` com as regras antigas, e o
 * "Aluguel vence amanhã" voltava mesmo sem a tela das recorrências existir. Agora ligar a
 * chave só remarca as Contas do mês e as faturas (`rescheduleReminders` do `BillsContext`).
 *
 * O `notificationUtils` é o de verdade, sobre um `expo-notifications` de mentira; o resto da
 * tela é dublê, como em `settingsBiometric.test.tsx`.
 */

const mockStorage = new Map<string, string>();
const mockScheduled = new Map<string, Record<string, unknown>>();
const mockRescheduleBills = jest.fn(async () => undefined);
const mockRules: Array<Record<string, unknown>> = [];

jest.mock('@react-native-async-storage/async-storage', () => ({
	getItem: jest.fn(async (key: string) => mockStorage.get(key) ?? null),
	setItem: jest.fn(async (key: string, value: string) => {
		mockStorage.set(key, value);
	}),
	removeItem: jest.fn(async (key: string) => {
		mockStorage.delete(key);
	}),
}));

jest.mock('expo-device', () => ({ isDevice: false }));

jest.mock('expo-notifications', () => ({
	AndroidImportance: { MAX: 5, HIGH: 4, DEFAULT: 3 },
	SchedulableTriggerInputTypes: { DATE: 'date' },
	setNotificationHandler: jest.fn(),
	setNotificationChannelAsync: jest.fn(async () => null),
	getPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
	requestPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
	getExpoPushTokenAsync: jest.fn(async () => ({ data: null })),
	scheduleNotificationAsync: jest.fn(async (request: { identifier: string }) => {
		mockScheduled.set(request.identifier, request);
		return request.identifier;
	}),
	cancelScheduledNotificationAsync: jest.fn(async (identifier: string) => {
		mockScheduled.delete(identifier);
	}),
	cancelAllScheduledNotificationsAsync: jest.fn(async () => {
		mockScheduled.clear();
	}),
	getAllScheduledNotificationsAsync: jest.fn(async () =>
		Array.from(mockScheduled.entries()).map(([identifier, request]) => ({ ...request, identifier }))
	),
}));

jest.mock('expo-router', () => ({
	router: { back: jest.fn(), push: jest.fn() },
	Stack: { Screen: () => null },
}));

jest.mock('expo-constants', () => ({ expoConfig: { version: '1.2.9' } }));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('react-native-safe-area-context', () => {
	const { View } = require('react-native');
	return { SafeAreaView: View };
});

jest.mock('react-i18next', () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock('../../components/CurrencySelector', () => () => null);
jest.mock('../../components/LanguageSelector', () => () => null);

jest.mock('../../contexts/AuthContext', () => ({
	useAuth: () => ({ account: null, isAvailable: false }),
}));
jest.mock('../../contexts/BillsContext', () => ({
	useBills: () => ({ rescheduleReminders: mockRescheduleBills }),
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
jest.mock('../../contexts/RecurringTransactionsContext', () => ({
	useRecurringTransactions: () => ({ transactions: mockRules, refreshTransactions: jest.fn() }),
}));
jest.mock('../../contexts/SyncContext', () => ({
	describeSync: () => ({
		tone: 'ok',
		label: { key: 'account.statusSynced', count: 0 },
		short: { key: 'account.statusSynced', count: 0 },
	}),
	useSync: () => ({ status: 'idle', pending: 0, unsynced: 0, lastSyncedAt: null, syncNow: jest.fn() }),
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
// O nome no banco (SPD-115) tem o teste dele (`settingsOwnName.test.tsx`).
jest.mock('../../utils/ownNamePreference', () => ({
	getOwnBankName: jest.fn(async () => null),
	setOwnBankName: jest.fn(),
}));
jest.mock('../../utils/statementImport', () => ({
	StatementImportError: class StatementImportError extends Error {},
}));

import * as Notifications from 'expo-notifications';
import { Switch } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { getISODate } from '../../utils/dateUtils';
import SettingsScreen from '../SettingsScreen';

// A primeira montagem carrega a tela inteira; com a suíte toda rodando junto, passa dos 5 s.
jest.setTimeout(20_000);

const scheduleMock = Notifications.scheduleNotificationAsync as jest.Mock;

const inDays = (days: number): Date => {
	const date = new Date();
	date.setHours(0, 0, 0, 0);
	date.setDate(date.getDate() + days);
	return date;
};

let renderer: ReactTestRenderer;

const isHostText = (node: ReactTestInstance): boolean => (node.type as unknown) === 'Text';
const textOf = (node: ReactTestInstance): string => [node.props.children].flat().join('');

/** A chave das notificações: o `Switch` da linha "settings.notifications". */
const notificationsSwitch = (): ReactTestInstance => {
	const title = renderer.root.findAll(isHostText).find((node) => textOf(node) === 'settings.notifications');
	if (!title) throw new Error('a linha das notificações não está na tela');
	let row: ReactTestInstance | null = title;
	while (row && !row.props.onPress) row = row.parent;
	if (!row) throw new Error('a linha das notificações não é tocável');
	return row.find((node) => (node.type as unknown) === Switch);
};

beforeEach(() => {
	mockStorage.clear();
	mockScheduled.clear();
	mockRules.length = 0;
	// Aluguel de R$ 1.500, ativo, vencendo daqui a 10 dias.
	mockRules.push({
		id: 'aluguel',
		amountCents: 150_000,
		isIncome: false,
		note: 'Aluguel',
		category: 'housing',
		recurrenceType: 'monthly',
		day: 10,
		active: true,
		nextDue: getISODate(inDays(10)),
		updatedAt: '2026-10-01T00:00:00.000Z',
	});
	mockStorage.set('@spendr_notifications_enabled', 'false');
	jest.clearAllMocks();
});

afterEach(() => {
	act(() => renderer?.unmount());
});

it('ligar os lembretes com uma regra ativa: nenhum lembrete de recorrência, e as contas são remarcadas', async () => {
	await act(async () => {
		renderer = create(<SettingsScreen />);
	});
	expect(notificationsSwitch().props.value).toBe(false);

	const onValueChange = notificationsSwitch().props.onValueChange as () => Promise<void>;
	await act(async () => {
		await onValueChange();
	});

	expect(mockStorage.get('@spendr_notifications_enabled')).toBe('true');
	expect(scheduleMock.mock.calls.filter(([request]) => String(request.identifier).startsWith('transaction_'))).toHaveLength(0);
	expect(Array.from(mockScheduled.keys()).filter((id) => id.startsWith('transaction_'))).toEqual([]);
	expect(mockRescheduleBills).toHaveBeenCalledTimes(1);
});
