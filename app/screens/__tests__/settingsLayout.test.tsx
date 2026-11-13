/**
 * O topo de Configurações (SPD-121): a área segura já empurra a tela para baixo da barra de
 * status, e o cabeçalho somava mais 60 por cima — no aparelho, um vão dobrado acima de
 * "Configurações". Fica um só: o da área segura e o respiro normal do cabeçalho. O resto da
 * tela é dublê; as chaves de tradução aparecem cruas.
 */

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
	useTranslation: () => ({
		t: (key: string, params?: Record<string, unknown>) =>
			params ? `${key}${JSON.stringify(params)}` : key,
	}),
}));

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
	// O estado "tudo salvo" (`describeSync` está testado em `syncContext.test.tsx`).
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
	isBiometricAvailable: jest.fn(async () => true),
	getBiometricType: jest.fn(async () => 'Face ID'),
	getSupportedAuthTypes: () => [1],
	isBiometricEnabled: jest.fn(async () => false),
	setBiometricEnabled: jest.fn(),
	authenticateWithBiometrics: jest.fn(async () => true),
}));
jest.mock('../../utils/dataWipe', () => ({ eraseAllData: jest.fn() }));
jest.mock('../../utils/exportUtils', () => ({
	exportDatabaseData: jest.fn(),
	importDatabaseData: jest.fn(),
}));
jest.mock('../../utils/notificationUtils', () => ({
	areNotificationsEnabled: jest.fn(async () => false),
}));
// O nome no banco (SPD-115) tem o teste dele (`settingsOwnName.test.tsx`).
jest.mock('../../utils/ownNamePreference', () => ({
	getOwnBankName: jest.fn(async () => null),
	setOwnBankName: jest.fn(),
}));
jest.mock('../../utils/statementImport', () => ({
	StatementImportError: class StatementImportError extends Error {},
}));

import { StyleSheet } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import SettingsScreen from '../SettingsScreen';

// A primeira montagem carrega a tela inteira; com a suíte toda rodando junto, passa dos 5 s.
jest.setTimeout(20_000);

let renderer: ReactTestRenderer;

afterEach(() => {
	act(() => renderer.unmount());
});

it('o título fica logo abaixo da área segura, sem um segundo vão de 60 por cima', async () => {
	await act(async () => {
		renderer = create(<SettingsScreen />);
	});

	const title = renderer.root.find(
		(node: ReactTestInstance) =>
			(node.type as unknown) === 'Text' && node.props.accessibilityRole === 'header' && node.props.children === 'settings.headerTitle'
	);
	let above = 0;
	for (let up = title.parent; up; up = up.parent) {
		if (typeof up.type !== 'string') continue;
		const style = StyleSheet.flatten(up.props.style) ?? {};
		above += Number(style.paddingTop ?? style.paddingVertical ?? style.padding ?? 0) + Number(style.marginTop ?? 0);
	}
	// Só o respiro do próprio cabeçalho (12), como nas outras telas com seta de voltar.
	expect(above).toBeLessThanOrEqual(12);
});
