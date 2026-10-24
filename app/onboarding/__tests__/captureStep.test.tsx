/**
 * A etapa da captura no onboarding (SPD-021): no Android, entre "Como funciona" e as
 * preferências, explica a leitura das notificações do banco e leva à tela do sistema. Dá
 * para pular. Sem o serviço nativo (iOS, Expo Go) a etapa não aparece: "Continuar" vai
 * direto às preferências, e a rota, se aberta mesmo assim, redireciona.
 */

const mockModule = { supported: true, enabled: false, openSettings: jest.fn() };
const mockPush = jest.fn();

jest.mock('../../../modules/spendr-captures', () => ({
	isCaptureSupported: () => mockModule.supported,
	isCaptureEnabled: () => mockModule.enabled,
	openCaptureSettings: () => mockModule.openSettings(),
}));

jest.mock('expo-router', () => {
	const { Text } = require('react-native');
	return {
		useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn() }),
		Redirect: ({ href }: { href: string }) => <Text>{`redirect:${href}`}</Text>,
	};
});

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('react-native-safe-area-context', () => ({
	SafeAreaView: ({ children }: { children: unknown }) => children,
}));

jest.mock('react-i18next', () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

import { AppState, type AppStateStatus } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import CaptureStepScreen from '../captures';
import InfoScreen from '../info';

// A primeira montagem carrega o ScrollView e o resto do react-native sob demanda; com a
// suíte inteira em paralelo isso passou dos 5 s padrão.
jest.setTimeout(30000);

let renderer: ReactTestRenderer | null = null;
let appStateHandler: ((state: AppStateStatus) => void) | null = null;

const mount = async (screen: 'info' | 'step'): Promise<void> => {
	await act(async () => {
		renderer = create(screen === 'info' ? <InfoScreen /> : <CaptureStepScreen />);
	});
};

const hasText = (text: string): boolean =>
	(renderer?.root.findAll((node) => node.props.children === text) ?? []).length > 0;

/** Toca no botão que contém o texto. */
const pressText = async (text: string): Promise<void> => {
	const target = renderer?.root.findAll(
		(node) =>
			typeof node.props.onPress === 'function' &&
			node.findAll((child) => child.props.children === text).length > 0
	)[0];
	if (!target) throw new Error(`botão "${text}" não encontrado`);
	await act(async () => {
		target.props.onPress();
	});
};

beforeEach(() => {
	mockModule.supported = true;
	mockModule.enabled = false;
	mockModule.openSettings = jest.fn();
	mockPush.mockClear();
	appStateHandler = null;
	jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
		appStateHandler = handler as (state: AppStateStatus) => void;
		return { remove: jest.fn() } as unknown as ReturnType<typeof AppState.addEventListener>;
	});
});

afterEach(async () => {
	await act(async () => {
		renderer?.unmount();
	});
	renderer = null;
	jest.restoreAllMocks();
});

describe('a etapa da captura no onboarding', () => {
	it('no Android, "Continuar" de "Como funciona" leva à etapa', async () => {
		await mount('info');
		await pressText('info.continue');

		expect(mockPush).toHaveBeenCalledWith('/onboarding/captures');
	});

	it('sem o serviço nativo (iOS, Expo Go), pula direto para as preferências', async () => {
		mockModule.supported = false;
		await mount('info');
		await pressText('info.continue');

		expect(mockPush).toHaveBeenCalledWith('/onboarding/security');
		expect(mockPush).not.toHaveBeenCalledWith('/onboarding/captures');
	});

	it('sem o serviço nativo, a rota redireciona e não mostra a etapa', async () => {
		mockModule.supported = false;
		await mount('step');

		expect(hasText('redirect:/onboarding/security')).toBe(true);
		expect(hasText('onboardingCaptures.title')).toBe(false);
	});

	it('explica e leva à tela do sistema', async () => {
		await mount('step');
		expect(hasText('onboardingCaptures.title')).toBe(true);

		await pressText('captures.setupButton');

		expect(mockModule.openSettings).toHaveBeenCalledTimes(1);
		expect(mockPush).not.toHaveBeenCalled();
	});

	it('pular segue para as preferências sem abrir o sistema', async () => {
		await mount('step');
		await pressText('onboardingCaptures.skip');

		expect(mockPush).toHaveBeenCalledWith('/onboarding/security');
		expect(mockModule.openSettings).not.toHaveBeenCalled();
	});

	it('de volta do sistema com o acesso ligado, mostra que deu certo e continua', async () => {
		await mount('step');
		expect(hasText('onboardingCaptures.enabled')).toBe(false);

		mockModule.enabled = true;
		await act(async () => {
			appStateHandler?.('active');
		});

		expect(hasText('onboardingCaptures.enabled')).toBe(true);
		expect(hasText('onboardingCaptures.skip')).toBe(false);
		await pressText('onboardingCaptures.continue');
		expect(mockPush).toHaveBeenCalledWith('/onboarding/security');
	});
});
