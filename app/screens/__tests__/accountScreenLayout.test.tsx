/**
 * A tela da Conta (SPD-110): a pilha da raiz não desenha cabeçalho, então a tela desenha o
 * seu (título e seta de voltar) em todos os estados. E o modal "Confirme com a senha" do
 * "Apagar a conta" (E2E-47): no Android o teclado cobria o botão "Apagar a conta para
 * sempre" e o campo abria com cursor mas sem teclado. As chaves de tradução aparecem cruas.
 */

const mockBack = jest.fn();
const mockAuthenticate = jest.fn();

const mockSignedIn = {
	id: 'conta-1',
	email: 'eu@exemplo.com',
	name: 'Fulano',
	baseCurrency: 'BRL',
	language: 'pt',
};
let mockAuthState: { account: typeof mockSignedIn | null; isAvailable: boolean; pendingClaim: boolean } = {
	account: mockSignedIn,
	isAvailable: true,
	pendingClaim: false,
};

jest.mock('expo-router', () => ({
	router: { back: () => mockBack(), dismissTo: jest.fn() },
	Stack: { Screen: () => null },
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('react-native-safe-area-context', () => {
	const { View } = require('react-native');
	return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 24, right: 0, bottom: 34, left: 0 }) };
});

jest.mock('react-i18next', () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock('../../contexts/AuthContext', () => ({
	useAuth: () => ({
		...mockAuthState,
		signIn: jest.fn(),
		signUp: jest.fn(),
		signOut: jest.fn(),
		deleteAccount: jest.fn(),
		claimCounts: null,
		resolveClaim: jest.fn(),
	}),
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

jest.mock('../../contexts/CurrencyContext', () => ({
	useCurrency: () => ({ currentCurrency: { code: 'BRL' } }),
}));

jest.mock('../../contexts/PeriodContext', () => ({
	usePeriod: () => ({ resetToCurrentMonth: jest.fn() }),
}));

jest.mock('../../hooks/useBiometricAuth', () => ({
	useBiometricAuth: () => ({ authenticate: mockAuthenticate, isAuthenticating: false }),
}));

jest.mock('../../sync/claim', () => ({
	claimSummaryParams: jest.fn(() => ({})),
}));

jest.mock('../../api/client', () => ({
	ApiError: class ApiError extends Error {},
}));

import { Alert, type AlertButton, KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import AccountScreen from '../AccountScreen';

jest.setTimeout(20_000);

let renderer: ReactTestRenderer;
const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
const originalOS = Platform.OS;

const setOS = (os: typeof Platform.OS) => {
	Object.defineProperty(Platform, 'OS', { value: os, configurable: true, writable: true });
};

const isHostText = (node: ReactTestInstance): boolean => (node.type as unknown) === 'Text';

const render = async () => {
	await act(async () => {
		renderer = create(<AccountScreen />);
	});
};

/** O texto marcado como cabeçalho, fora do modal. */
const headerTitles = (): string[] =>
	renderer.root
		.findAll((node) => isHostText(node) && node.props.accessibilityRole === 'header')
		.map((node) => [node.props.children].flat().join(''));

const pressable = (label: string): ReactTestInstance | undefined =>
	renderer.root.findAll((node) => node.props.accessibilityLabel === label && typeof node.props.onPress === 'function')[0];

/** O ancestral mais próximo de `node` que passa no teste. */
const ancestor = (node: ReactTestInstance, test: (candidate: ReactTestInstance) => boolean): ReactTestInstance | null => {
	let current = node.parent;
	while (current) {
		if (test(current)) return current;
		current = current.parent;
	}
	return null;
};

const passwordField = (): ReactTestInstance =>
	renderer.root.find(
		(node) => typeof node.type === 'string' && node.props.accessibilityLabel === 'account.deletePasswordLabel'
	);

/** Do botão até o modal da senha, com a biometria aprovada. */
const openPasswordModal = async () => {
	const text = renderer.root.find((node) => isHostText(node) && node.props.children === 'account.deleteAccount');
	await act(async () => {
		await ancestor(text, (candidate) => typeof candidate.props.onPress === 'function')?.props.onPress();
	});
	const buttons = alertSpy.mock.calls.at(-1)?.[2] as AlertButton[];
	await act(async () => {
		await buttons.find((button) => button.text === 'account.deleteContinue')?.onPress?.();
	});
};

beforeEach(() => {
	jest.clearAllMocks();
	mockAuthenticate.mockImplementation(async (_reason: string, onSuccess?: () => void) => {
		onSuccess?.();
		return true;
	});
	mockAuthState = { account: mockSignedIn, isAvailable: true, pendingClaim: false };
});

afterEach(() => {
	act(() => renderer.unmount());
	setOS(originalOS);
});

describe.each([
	['sem servidor configurado', { account: null, isAvailable: false, pendingClaim: false }],
	['sem conta (entrar ou criar)', { account: null, isAvailable: true, pendingClaim: false }],
	['com conta', { account: mockSignedIn, isAvailable: true, pendingClaim: false }],
	['com conta e dados esperando decisão', { account: mockSignedIn, isAvailable: true, pendingClaim: true }],
])('%s', (_name, state) => {
	it('tem cabeçalho "Conta" com a seta de voltar, que volta para Configurações', async () => {
		mockAuthState = state;
		await render();

		expect(headerTitles()).toEqual(['account.screenTitle']);
		const back = pressable('account.back');
		expect(back?.props.accessibilityRole).toBe('button');
		await act(async () => {
			back?.props.onPress();
		});
		expect(mockBack).toHaveBeenCalledTimes(1);
	});
});

describe('modal da senha no Android (E2E-47)', () => {
	beforeEach(() => setOS('android'));

	it('fica dentro de algo que sobe com o teclado, e o botão de apagar vai junto', async () => {
		await render();
		await openPasswordModal();

		const avoider = ancestor(passwordField(), (candidate) => (candidate.type as unknown) === KeyboardAvoidingView);
		expect(avoider).not.toBeNull();
		expect(avoider?.props.behavior).toBeDefined();

		const button = renderer.root.find(
			(node) => isHostText(node) && node.props.children === 'account.deleteAction'
		);
		expect(ancestor(button, (candidate) => candidate === avoider)).toBe(avoider);
	});

	it('o botão responde ao primeiro toque com o teclado aberto', async () => {
		await render();
		await openPasswordModal();

		const scroll = ancestor(passwordField(), (candidate) => (candidate.type as unknown) === ScrollView);
		expect(scroll?.props.keyboardShouldPersistTaps).toBe('handled');
	});

	it('o campo não abre com cursor sem teclado: não se foca sozinho', async () => {
		await render();
		await openPasswordModal();

		expect(passwordField().props.autoFocus).toBeFalsy();
	});
});
