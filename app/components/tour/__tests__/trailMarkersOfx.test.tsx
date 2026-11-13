/**
 * A marca e o "?" da Trilha 16 (Extrato do banco, OFX) em Configurações (SPD-131c): o item
 * "Importar extrato do banco (OFX)" é o alvo dos passos 1 e 2, e o "?" dentro dele abre a
 * trilha 16. Os outros passos são texto: o resumo e as perguntas só aparecem ao importar. O
 * resto da tela é dublê, como em `settingsLayout`; as chaves de tradução aparecem cruas.
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
		t: (key: string, params?: Record<string, unknown>) => (params ? `${key}${JSON.stringify(params)}` : key),
	}),
}));

jest.mock('../../CurrencySelector', () => () => null);
jest.mock('../../LanguageSelector', () => () => null);

jest.mock('../../../contexts/AuthContext', () => ({
	useAuth: () => ({ account: null, isAvailable: false }),
}));
jest.mock('../../../contexts/BillsContext', () => ({
	useBills: () => ({ rescheduleReminders: jest.fn() }),
}));
jest.mock('../../../contexts/CapturesContext', () => ({
	useCaptures: () => ({
		supported: false,
		enabled: false,
		pendingCount: 0,
		openSettings: jest.fn(),
		importStatement: jest.fn(),
	}),
}));
jest.mock('../../../contexts/CurrencyContext', () => ({
	useCurrency: () => ({ currentCurrency: { code: 'BRL', symbol: 'R$' } }),
}));
jest.mock('../../../contexts/LanguageContext', () => ({
	useLanguage: () => ({ currentLanguage: { code: 'pt', nativeName: 'Português' } }),
}));
jest.mock('../../../contexts/PeriodContext', () => ({
	usePeriod: () => ({ resetToCurrentMonth: jest.fn() }),
}));
jest.mock('../../../contexts/SyncContext', () => ({
	describeSync: () => ({
		tone: 'ok',
		label: { key: 'account.statusSynced', count: 0 },
		short: { key: 'account.statusSynced', count: 0 },
	}),
	useSync: () => ({ status: 'idle', pending: 0, unsynced: 0, lastSyncedAt: null, syncNow: jest.fn() }),
}));
jest.mock('../../../contexts/TransactionsContext', () => ({
	useTransactions: () => ({ refreshData: jest.fn() }),
}));
jest.mock('../../../diagnostics/export', () => ({ exportDiagnostics: jest.fn() }));
jest.mock('../../../hooks/useBiometricAuth', () => ({
	useBiometricAuth: () => ({ authenticate: jest.fn(), isAuthenticating: false }),
}));
jest.mock('../../../utils/biometricUtils', () => ({
	isBiometricAvailable: jest.fn(async () => true),
	getBiometricType: jest.fn(async () => 'Face ID'),
	getSupportedAuthTypes: () => [1],
	isBiometricEnabled: jest.fn(async () => false),
	setBiometricEnabled: jest.fn(),
	authenticateWithBiometrics: jest.fn(async () => true),
}));
jest.mock('../../../utils/dataWipe', () => ({ eraseAllData: jest.fn() }));
jest.mock('../../../utils/exportUtils', () => ({
	exportDatabaseData: jest.fn(),
	importDatabaseData: jest.fn(),
}));
jest.mock('../../../utils/notificationUtils', () => ({
	areNotificationsEnabled: jest.fn(async () => false),
}));
jest.mock('../../../utils/ownNamePreference', () => ({
	getOwnBankName: jest.fn(async () => null),
	setOwnBankName: jest.fn(),
}));
jest.mock('../../../utils/statementImport', () => ({
	StatementImportError: class StatementImportError extends Error {},
}));

import { Text } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import SettingsScreen from '../../../screens/SettingsScreen';
import { TRAILS } from '../../../utils/trails';
import { clearTourRegistry, hasTarget } from '../registry';

// A primeira montagem carrega a tela inteira; com a suíte toda rodando junto, passa dos 5 s.
jest.setTimeout(60_000);

let renderer: ReactTestRenderer;

afterEach(() => {
	act(() => renderer.unmount());
});

/** A trilha que um "?" abre, pela dica (o rótulo é o mesmo em todos). */
const trailOf = (node: ReactTestInstance): string | undefined =>
	String(node.props.accessibilityHint).match(/"trails\.(\w+)\.title"/)?.[1];

const isHelp = (node: ReactTestInstance): boolean =>
	typeof node.type !== 'string' && typeof node.props.onPress === 'function' && typeof node.props.accessibilityHint === 'string';

it('o item do extrato tem a marca dos passos 1 e 2, e o "?" dentro dele abre a trilha 16', async () => {
	clearTourRegistry();
	await act(async () => {
		renderer = create(<SettingsScreen />);
	});
	const wanted = [...new Set(TRAILS.ofx.steps.flatMap((step) => (step.targets ?? []).flat()))];
	expect(wanted).toEqual(['settings.ofx']);
	expect(wanted.filter((id) => !hasTarget(id))).toEqual([]);
	// Os passos 3 a 7 não apontam nada: só texto.
	expect(TRAILS.ofx.steps.filter((step) => (step.targets ?? []).length > 0).map((step) => step.id)).toEqual(['1', '2']);

	expect(renderer.root.findAll(isHelp).map(trailOf)).toContain('ofx');

	// O "?" fica dentro do item do extrato, não solto na tela.
	const label = renderer.root.find((node: ReactTestInstance) => (node.type as unknown) === Text && node.props.children === 'captures.import.item');
	let item: ReactTestInstance | null = label;
	while (item && typeof item.props.onPress !== 'function') item = item.parent;
	if (!item) throw new Error('o item do extrato não é tocável');
	expect([...new Set(item.findAll(isHelp).map(trailOf))]).toEqual(['ofx']);
});
