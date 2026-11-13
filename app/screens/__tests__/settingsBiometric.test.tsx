/**
 * A trava por biometria em Ajustes (SPD-088, E2E-04 e E2E-19).
 *
 * O que o teste no aparelho mostrou: no Android a opção se chamava "Autenticação por Face ID"
 * com um "?" no lugar do ícone (`scan-face` não existe no Ionicons), e desligar a trava era um
 * toque, sem autenticar — quem pegasse o celular com o app aberto tirava a trava.
 *
 * O `biometricUtils` é um dublê: a pergunta é o que a tela pede e grava em cada desfecho. As
 * chaves de tradução aparecem cruas, com os parâmetros em JSON.
 */

const mockAuthenticateWithBiometrics = jest.fn();
const mockSetBiometricEnabled = jest.fn();
const mockSupportedTypes = jest.fn();
const mockIsBiometricEnabled = jest.fn();

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
	getSupportedAuthTypes: () => mockSupportedTypes(),
	isBiometricEnabled: () => mockIsBiometricEnabled(),
	setBiometricEnabled: (value: boolean) => mockSetBiometricEnabled(value),
	authenticateWithBiometrics: (reason?: string) => mockAuthenticateWithBiometrics(reason),
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

import { Platform, Switch } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import SettingsScreen from '../SettingsScreen';

const ionicons: Record<string, number> = jest.requireActual(
	'@expo/vector-icons/build/vendor/react-native-vector-icons/glyphmaps/Ionicons.json'
);

// A primeira montagem carrega a tela inteira; com a suíte toda rodando junto, passou dos
// 5 s padrão.
jest.setTimeout(20_000);

const FACIAL_RECOGNITION = 2;
const FINGERPRINT = 1;

let renderer: ReactTestRenderer;
const originalOS = Platform.OS;

const setOS = (os: 'ios' | 'android') => {
	Object.defineProperty(Platform, 'OS', { value: os, configurable: true, writable: true });
};

const isHostText = (node: ReactTestInstance): boolean => (node.type as unknown) === 'Text';
const textOf = (node: ReactTestInstance): string => [node.props.children].flat().join('');

/** A linha da trava: a que fica na seção de segurança, logo depois do título dela. */
const lockRow = (): ReactTestInstance => {
	const title = renderer.root
		.findAll(isHostText)
		.find((node) => /^settings\.(biometricLock|biometricAuth)/.test(textOf(node)));
	if (!title) throw new Error('a linha da trava não está na tela');
	let row: ReactTestInstance | null = title;
	while (row && !row.props.onPress) row = row.parent;
	if (!row) throw new Error('a linha da trava não é tocável');
	return row;
};

const lockTitle = (): string =>
	textOf(
		lockRow()
			.findAll(isHostText)
			.find((node) => /^settings\./.test(textOf(node))) as ReactTestInstance
	);
const lockIcon = (): string =>
	lockRow().findAll((node) => (node.type as unknown) === 'Icon')[0].props.name;
const lockSwitch = (): ReactTestInstance =>
	lockRow().find((node) => (node.type as unknown) === Switch);

const mount = async () => {
	await act(async () => {
		renderer = create(<SettingsScreen />);
	});
};

const flip = async (value: boolean) => {
	const onValueChange = lockSwitch().props.onValueChange as (next: boolean) => Promise<void>;
	await act(async () => {
		await onValueChange(value);
	});
};

beforeEach(() => {
	jest.clearAllMocks();
	mockSupportedTypes.mockResolvedValue([FACIAL_RECOGNITION]);
	mockIsBiometricEnabled.mockResolvedValue(true);
	mockSetBiometricEnabled.mockResolvedValue(undefined);
});

afterEach(() => {
	act(() => renderer?.unmount());
	setOS(originalOS as 'ios' | 'android');
});

describe('nome e ícone da trava (E2E-04)', () => {
	it('no Android é biometria, mesmo com desbloqueio pelo rosto, e o ícone existe', async () => {
		setOS('android');
		await mount();

		expect(lockTitle()).toBe('settings.biometricLock.biometric');
		expect(lockIcon()).toBe('finger-print');
		expect(lockIcon() in ionicons).toBe(true);
	});

	it('no iPhone com Face ID diz Face ID, com um ícone que o Ionicons tem', async () => {
		setOS('ios');
		await mount();

		expect(lockTitle()).toBe('settings.biometricLock.faceId');
		expect(lockIcon() in ionicons).toBe(true);
	});

	it('no iPhone com digital diz Touch ID', async () => {
		setOS('ios');
		mockSupportedTypes.mockResolvedValue([FINGERPRINT]);
		await mount();

		expect(lockTitle()).toBe('settings.biometricLock.touchId');
		expect(lockIcon()).toBe('finger-print');
	});
});

describe('desligar a trava pede a biometria (E2E-19)', () => {
	beforeEach(() => setOS('android'));

	it('falhou ou cancelou: continua ligada e nada é gravado', async () => {
		mockAuthenticateWithBiometrics.mockResolvedValue(false);
		await mount();
		expect(lockSwitch().props.value).toBe(true);

		await flip(false);

		expect(mockAuthenticateWithBiometrics).toHaveBeenCalledTimes(1);
		expect(mockAuthenticateWithBiometrics).toHaveBeenCalledWith('settings.biometricDisablePrompt');
		expect(mockSetBiometricEnabled).not.toHaveBeenCalled();
		expect(lockSwitch().props.value).toBe(true);
	});

	it('o toque na linha também passa pela biometria', async () => {
		mockAuthenticateWithBiometrics.mockResolvedValue(false);
		await mount();

		const onPress = lockRow().props.onPress as () => Promise<void>;
		await act(async () => {
			await onPress();
		});

		expect(mockAuthenticateWithBiometrics).toHaveBeenCalledTimes(1);
		expect(mockSetBiometricEnabled).not.toHaveBeenCalled();
		expect(lockSwitch().props.value).toBe(true);
	});

	it('autenticou: desliga e grava', async () => {
		mockAuthenticateWithBiometrics.mockResolvedValue(true);
		await mount();

		await flip(false);

		expect(mockSetBiometricEnabled).toHaveBeenCalledWith(false);
		expect(lockSwitch().props.value).toBe(false);
	});

	it('ligar continua como era: pede a biometria e só liga se ela passar', async () => {
		mockIsBiometricEnabled.mockResolvedValue(false);
		mockAuthenticateWithBiometrics.mockResolvedValue(false);
		await mount();

		await flip(true);
		expect(mockSetBiometricEnabled).not.toHaveBeenCalled();
		expect(lockSwitch().props.value).toBe(false);

		mockAuthenticateWithBiometrics.mockResolvedValue(true);
		await flip(true);
		expect(mockAuthenticateWithBiometrics).toHaveBeenLastCalledWith(
			'settings.biometricEnablePrompt'
		);
		expect(mockSetBiometricEnabled).toHaveBeenCalledWith(true);
		expect(lockSwitch().props.value).toBe(true);
	});
});
