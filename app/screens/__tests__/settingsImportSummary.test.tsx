/**
 * O resumo do import do extrato (E2E-51): com uma linha só, o alerta dizia "1 linhas no
 * arquivo." — o texto era uma chave só, sem singular. Cada linha do resumo agora tem a sua
 * forma de singular e de plural, como o resto do i18n (`_one`/`_other`), e a de zero
 * (`_zero`): no português o i18next põe o 0 no singular ("0 linha"), e "0 já estava no app"
 * ficaria pior do que antes.
 *
 * O `t` é o do i18next de verdade, com os três idiomas do app; o resto da tela é dublê.
 */

const mockLanguage = { current: 'pt' };
const mockImportStatement = jest.fn();

jest.mock('react-i18next', () => {
	const i18next = require('i18next');
	const instance = i18next.createInstance();
	instance.init({
		lng: 'pt',
		fallbackLng: false,
		initAsync: false,
		interpolation: { escapeValue: false },
		resources: {
			pt: { translation: require('../../i18n/locales/pt').default },
			en: { translation: require('../../i18n/locales/en').default },
			it: { translation: require('../../i18n/locales/it').default },
		},
	});
	return {
		useTranslation: () => ({
			t: (key: string, options?: Record<string, unknown>) => instance.t(key, { ...options, lng: mockLanguage.current }),
		}),
	};
});

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
		importStatement: () => mockImportStatement(),
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
	withStatementAccountChooser: (_chooser: unknown, run: () => Promise<unknown>) => run(),
	walkStatementChoice: jest.fn(),
	createStatementInstallments: jest.fn(async () => 0),
}));

import { Alert, type AlertButton } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import SettingsScreen from '../SettingsScreen';

jest.setTimeout(20_000);

const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((_title, _body, buttons?: AlertButton[]) => {
	// O resumo espera o "OK" para seguir.
	buttons?.[0]?.onPress?.();
});

/** O nome do item "Importar extrato" em cada idioma, para achar o toque. */
const ITEM = { pt: 'Importar extrato do banco (OFX)', en: 'Import bank statement (OFX)', it: 'Importa estratto conto (OFX)' };

/** As linhas do resumo que o alerta mostra, com estes números. */
const summaryLines = async (language: keyof typeof ITEM, summary: Record<string, number>): Promise<string[]> => {
	mockLanguage.current = language;
	mockImportStatement.mockResolvedValueOnce({
		summary: {
			total: 0,
			skippedExisting: 0,
			matchedCaptures: 0,
			matchedTransactions: 0,
			pending: 0,
			questions: 0,
			autoConfirmed: 0,
			ignored: 0,
			transfers: 0,
			...summary,
		},
		settledCaptures: [],
		installmentOffers: [],
	});
	let renderer: ReactTestRenderer | null = null;
	await act(async () => {
		renderer = create(<SettingsScreen />);
	});
	const screen = renderer as unknown as ReactTestRenderer;
	const item = screen.root.find((node) => (node.type as unknown) === 'Text' && node.props.children === ITEM[language]);
	let target: ReactTestInstance | null = item;
	while (target && typeof target.props.onPress !== 'function') target = target.parent;
	await act(async () => {
		await target?.props.onPress();
	});
	act(() => screen.unmount());
	return String(alertSpy.mock.calls.at(-1)?.[1]).split('\n');
};

beforeEach(() => {
	alertSpy.mockClear();
	mockImportStatement.mockReset();
});

// Um de cada: 1 linha, 1 já no app, 1 para revisar, 1 automática, 1 de fora.
const ONE = { total: 1, skippedExisting: 1, pending: 1, autoConfirmed: 1, ignored: 1 };
// Dois de cada, somados de partes diferentes, como o resumo faz.
const TWO = { total: 2, skippedExisting: 1, matchedCaptures: 1, pending: 1, questions: 1, autoConfirmed: 2, ignored: 1, transfers: 1 };
const ZERO = { total: 3, matchedTransactions: 3 };

it.each([
	['pt', ONE, ['1 linha no arquivo.', '1 já estava no app.', '1 para revisar.', '1 adicionada automaticamente.', '1 ficou de fora (fatura, investimentos, transferências).']],
	['pt', TWO, ['2 linhas no arquivo.', '2 já estavam no app.', '2 para revisar.', '2 adicionadas automaticamente.', '2 ficaram de fora (fatura, investimentos, transferências).']],
	['pt', ZERO, ['3 linhas no arquivo.', '3 já estavam no app.', '0 para revisar.', '0 adicionadas automaticamente.', '0 ficaram de fora (fatura, investimentos, transferências).']],
	['en', ONE, ['1 line in the file.', '1 was already in the app.', '1 to review.', '1 added automatically.', '1 left out (card bill, investments, transfers).']],
	['en', TWO, ['2 lines in the file.', '2 were already in the app.', '2 to review.', '2 added automatically.', '2 left out (card bill, investments, transfers).']],
	['en', ZERO, ['3 lines in the file.', '3 were already in the app.', '0 to review.', '0 added automatically.', '0 left out (card bill, investments, transfers).']],
	['it', ONE, ['1 riga nel file.', "1 era già nell'app.", '1 da rivedere.', '1 aggiunta automaticamente.', '1 esclusa (carta, investimenti, trasferimenti).']],
	['it', TWO, ['2 righe nel file.', "2 erano già nell'app.", '2 da rivedere.', '2 aggiunte automaticamente.', '2 escluse (carta, investimenti, trasferimenti).']],
	['it', ZERO, ['3 righe nel file.', "3 erano già nell'app.", '0 da rivedere.', '0 aggiunte automaticamente.', '0 escluse (carta, investimenti, trasferimenti).']],
] as const)('%s: %j', async (language, summary, expected) => {
	expect(await summaryLines(language, summary)).toEqual(expected);
});
