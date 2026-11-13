/**
 * A trava por biometria nas preferências da primeira abertura (SPD-088, E2E-04 e E2E-19).
 *
 * No Android a opção aparecia "Face ID Authentication": o app chamava de Face ID qualquer
 * reconhecimento facial, e a frase vinha com o tipo cru em inglês. E desligar não pedia a
 * biometria. O `biometricUtils` é um dublê; as chaves de tradução aparecem cruas.
 */

const mockAuthenticateWithBiometrics = jest.fn();
const mockSetBiometricEnabled = jest.fn();

jest.mock('expo-router', () => ({
	useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('expo-haptics', () => ({
	impactAsync: jest.fn(async () => undefined),
	notificationAsync: jest.fn(async () => undefined),
	ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
	NotificationFeedbackType: { Success: 'success', Error: 'error' },
}));
jest.mock('react-i18next', () => ({
	useTranslation: () => ({
		t: (key: string, params?: Record<string, unknown>) =>
			params ? `${key}${JSON.stringify(params)}` : key,
	}),
}));
jest.mock('../../contexts/CurrencyContext', () => ({
	AVAILABLE_CURRENCIES: [],
	useCurrency: () => ({ currentCurrency: { code: 'BRL' }, setCurrency: jest.fn() }),
}));
jest.mock('../../utils/notificationUtils', () => ({
	setNotificationsEnabled: jest.fn(async () => undefined),
	registerForPushNotificationsAsync: jest.fn(async () => undefined),
}));
jest.mock('../../utils/onboardingUtils', () => ({ setOnboardingCompleted: jest.fn() }));
jest.mock('../../utils/biometricUtils', () => ({
	isBiometricAvailable: jest.fn(async () => true),
	getBiometricType: jest.fn(async () => 'Face ID'),
	getSupportedAuthTypes: jest.fn(async () => [2]),
	isBiometricEnabled: jest.fn(async () => true),
	setBiometricEnabled: (value: boolean) => mockSetBiometricEnabled(value),
	authenticateWithBiometrics: (reason?: string) => mockAuthenticateWithBiometrics(reason),
}));

import { Platform, Switch } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import SecurityScreen from '../security';

jest.setTimeout(30000);

let renderer: ReactTestRenderer;
const originalOS = Platform.OS;

const isHostText = (node: ReactTestInstance): boolean => (node.type as unknown) === 'Text';
const texts = (): string[] =>
	renderer.root.findAll(isHostText).map((node) => [node.props.children].flat().join(''));

/** O interruptor da trava: o segundo da tela (o primeiro é o das notificações). */
const lockSwitch = (): ReactTestInstance =>
	renderer.root.findAll((node) => (node.type as unknown) === Switch)[1];

beforeEach(async () => {
	jest.clearAllMocks();
	Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true, writable: true });
	mockSetBiometricEnabled.mockResolvedValue(undefined);
	await act(async () => {
		renderer = create(<SecurityScreen />);
	});
});

afterEach(() => {
	act(() => renderer.unmount());
	Object.defineProperty(Platform, 'OS', { value: originalOS, configurable: true, writable: true });
});

it('no Android, com desbloqueio pelo rosto, a opção é biometria', () => {
	expect(texts()).toContain('settings.biometricLock.biometric');
	expect(texts()).toContain(
		'onboardingSecurity.biometricLockDesc{"method":"settings.biometricMethod.biometric"}'
	);
	expect(texts().some((text) => text.includes('Face ID'))).toBe(false);
});

it('desligar pede a biometria; cancelou, continua ligada', async () => {
	mockAuthenticateWithBiometrics.mockResolvedValue(false);
	expect(lockSwitch().props.value).toBe(true);

	await act(async () => {
		await lockSwitch().props.onValueChange(false);
	});

	expect(mockAuthenticateWithBiometrics).toHaveBeenCalledWith('settings.biometricDisablePrompt');
	expect(mockSetBiometricEnabled).not.toHaveBeenCalled();
	expect(lockSwitch().props.value).toBe(true);
});
