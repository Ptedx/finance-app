/**
 * A faixa da captura desligada (SPD-068): a dispensa é relida quando a tela ganha foco e
 * quando o app volta ao primeiro plano.
 *
 * O caso real: no primeiro login num aparelho, o `AuthContext` apaga a dispensa para o
 * aviso voltar a valer. Mas a faixa lia a dispensa só ao montar, e a Home fica montada por
 * baixo da tela de login — o aviso só reaparecia quando o app era reaberto. Aqui o
 * armazenamento é um Map, o foco é disparado à mão e o resto da faixa roda de verdade.
 *
 * E a captura parada (SPD-021): acesso ligado, conta ligada a app de banco e 3 dias sem
 * aviso. A faixa mostra os dias, "Reconectar" pede o religamento e abre a tela do sistema,
 * e a dispensa vence em 7 dias.
 */

const mockStorage = new Map<string, string>();
const mockFocus: { effect: (() => void) | null } = { effect: null };
const mockCaptures = {
	pendingCount: 0,
	supported: true,
	enabled: false,
	openSettings: jest.fn(),
	pending: [] as Array<{ packageName: string; postedAt: string }>,
	resolved: [] as Array<{ packageName: string; postedAt: string }>,
};
const mockAccounts = {
	activeAccounts: [] as Array<{ packageName: string | null; archived: boolean }>,
};
const mockRebind = jest.fn(() => true);

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

// A contagem entra no texto ("captures.stalled|4") para o teste ver os dias.
jest.mock('react-i18next', () => ({
	useTranslation: () => ({
		t: (key: string, options?: { count?: number }) =>
			options?.count === undefined ? key : `${key}|${options.count}`,
	}),
}));

jest.mock('../../contexts/CapturesContext', () => ({
	useCaptures: () => mockCaptures,
}));

jest.mock('../../contexts/AccountsContext', () => ({
	useAccounts: () => mockAccounts,
}));

jest.mock('../../../modules/spendr-captures', () => ({
	requestCaptureRebind: () => mockRebind(),
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
	mockCaptures.enabled = false;
	mockCaptures.pending = [];
	mockCaptures.resolved = [];
	mockCaptures.openSettings = jest.fn();
	mockAccounts.activeAccounts = [];
	mockRebind.mockClear();
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

describe('o aviso de captura parada', () => {
	const DAY = 24 * 60 * 60 * 1000;
	const NOW = Date.parse('2026-10-24T15:00:00.000Z');
	let now = NOW;

	/** O texto do aviso de parada, com os dias, ou nulo se ele não está na tela. */
	const stalledText = (): string | null => {
		const node = renderer?.root.findAll(
			(candidate) =>
				typeof candidate.props.children === 'string' &&
				candidate.props.children.startsWith('captures.stalled|')
		)[0];
		return node ? (node.props.children as string) : null;
	};

	const press = async (match: (props: Record<string, unknown>) => boolean): Promise<void> => {
		const target = renderer?.root.findAll(
			(node) => typeof node.props.onPress === 'function' && match(node.props)
		)[0];
		if (!target) throw new Error('botão não encontrado');
		await act(async () => {
			target.props.onPress();
		});
	};

	beforeEach(() => {
		now = NOW;
		jest.spyOn(Date, 'now').mockImplementation(() => now);
		mockCaptures.enabled = true;
		mockAccounts.activeAccounts = [{ packageName: 'com.nu.production', archived: false }];
		mockCaptures.resolved = [
			{ packageName: 'com.nu.production', postedAt: new Date(NOW - 4 * DAY).toISOString() },
		];
	});

	it('acesso ligado, conta de banco e 4 dias sem aviso: mostra os dias', async () => {
		await mount();

		expect(stalledText()).toBe('captures.stalled|4');
		expect(warningShown()).toBe(false);
	});

	it('com aviso recente, nada', async () => {
		mockCaptures.pending = [
			{ packageName: 'com.nu.production', postedAt: new Date(NOW - DAY).toISOString() },
		];
		await mount();

		expect(stalledText()).toBeNull();
	});

	it('"Reconectar" pede o religamento e abre a tela do sistema', async () => {
		await mount();
		await press((props) => props.accessibilityHint === 'captures.stalledHint');

		expect(mockRebind).toHaveBeenCalledTimes(1);
		expect(mockCaptures.openSettings).toHaveBeenCalledTimes(1);
	});

	it('dispensado, some e fica escondido nos focos seguintes', async () => {
		await mount();
		await press((props) => props.accessibilityLabel === 'captures.stalledDismiss');

		expect(stalledText()).toBeNull();
		expect(mockStorage.get('@spendr_capture_stalled_dismissed_at')).toBe(String(NOW));
		// A dispensa da parada não é a da desligada.
		expect(mockStorage.has(STORAGE_KEYS.captureAccessDismissed)).toBe(false);

		now = NOW + 6 * DAY;
		await act(async () => {
			mockFocus.effect?.();
		});
		expect(stalledText()).toBeNull();
	});

	it('7 dias depois da dispensa, volta', async () => {
		await mount();
		await press((props) => props.accessibilityLabel === 'captures.stalledDismiss');
		expect(stalledText()).toBeNull();

		now = NOW + 7 * DAY;
		await act(async () => {
			appStateHandler?.('active');
		});

		expect(stalledText()).toBe('captures.stalled|11');
	});
});
