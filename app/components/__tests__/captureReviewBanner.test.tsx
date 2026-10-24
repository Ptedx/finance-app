/**
 * A faixa da captura desligada (SPD-068): a dispensa é relida quando a tela ganha foco e
 * quando o app volta ao primeiro plano.
 *
 * O caso real: no primeiro login num aparelho, o `AuthContext` apaga a dispensa para o
 * aviso voltar a valer. Mas a faixa lia a dispensa só ao montar, e a Home fica montada por
 * baixo da tela de login — o aviso só reaparecia quando o app era reaberto. Aqui o
 * armazenamento é um Map, o foco é disparado à mão e o resto da faixa roda de verdade.
 */

const mockStorage = new Map<string, string>();
const mockFocus: { effect: (() => void) | null } = { effect: null };

jest.mock('@react-native-async-storage/async-storage', () => ({
	getItem: jest.fn(async (key: string) => mockStorage.get(key) ?? null),
	setItem: jest.fn(async (key: string, value: string) => {
		mockStorage.set(key, value);
	}),
	removeItem: jest.fn(async (key: string) => {
		mockStorage.delete(key);
	}),
}));

// Como o de verdade: roda ao ganhar foco (a montagem é o primeiro foco). O teste guarda o
// efeito para disparar os focos seguintes.
jest.mock('expo-router', () => ({
	useRouter: () => ({ push: jest.fn() }),
	useFocusEffect: (effect: () => void) => {
		mockFocus.effect = effect;
		require('react').useEffect(() => effect(), [effect]);
	},
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('react-i18next', () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock('../../contexts/CapturesContext', () => ({
	useCaptures: () => ({ pendingCount: 0, supported: true, enabled: false, openSettings: jest.fn() }),
}));

import { AppState, type AppStateStatus } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { STORAGE_KEYS } from '../../utils/storageUtils';
import CaptureReviewBanner from '../CaptureReviewBanner';

let appStateHandler: ((state: AppStateStatus) => void) | null = null;
let renderer: ReactTestRenderer | null = null;

/** O aviso está na tela? É o único texto com a chave `captures.accessOff`. */
const warningShown = (): boolean =>
	(renderer?.root.findAll((node) => node.props.children === 'captures.accessOff') ?? []).length > 0;

const mount = async (): Promise<void> => {
	await act(async () => {
		renderer = create(<CaptureReviewBanner />);
	});
};

beforeEach(() => {
	mockStorage.clear();
	mockFocus.effect = null;
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

describe('a dispensa do aviso de captura desligada', () => {
	it('dispensado ao montar, o aviso fica escondido', async () => {
		mockStorage.set(STORAGE_KEYS.captureAccessDismissed, '1');
		await mount();

		expect(warningShown()).toBe(false);
	});

	it('a dispensa apagada (o login) volta a mostrar o aviso quando a tela ganha foco', async () => {
		mockStorage.set(STORAGE_KEYS.captureAccessDismissed, '1');
		await mount();
		expect(warningShown()).toBe(false);

		// O AuthContext apaga a dispensa com a Home montada por baixo do login.
		mockStorage.delete(STORAGE_KEYS.captureAccessDismissed);
		await act(async () => {
			mockFocus.effect?.();
		});

		expect(warningShown()).toBe(true);
	});

	it('e quando o app volta ao primeiro plano', async () => {
		mockStorage.set(STORAGE_KEYS.captureAccessDismissed, '1');
		await mount();

		mockStorage.delete(STORAGE_KEYS.captureAccessDismissed);
		await act(async () => {
			appStateHandler?.('active');
		});

		expect(warningShown()).toBe(true);
	});

	it('dispensar no foco seguinte continua escondido', async () => {
		await mount();
		expect(warningShown()).toBe(true);

		mockStorage.set(STORAGE_KEYS.captureAccessDismissed, '1');
		await act(async () => {
			mockFocus.effect?.();
		});

		expect(warningShown()).toBe(false);
	});
});
