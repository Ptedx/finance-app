/**
 * O "Apagar a conta" na tela de Conta (SPD-084): confirmação que explica o que some →
 * biometria, como no "Apagar todos os dados" → senha num modal (o `Alert.prompt` é só do
 * iOS) → o resultado.
 *
 * O que acontece no servidor e no disco é de `utils/accountDeletion.ts`, aqui um dublê; a
 * pergunta é o que a tela mostra em cada desfecho. As chaves de tradução aparecem cruas.
 */

const mockDeleteAccount = jest.fn();
const mockAuthenticate = jest.fn();
const mockDismissTo = jest.fn();
const mockResetToCurrentMonth = jest.fn();

jest.mock('expo-router', () => ({
	router: { dismissTo: (...args: unknown[]) => mockDismissTo(...args) },
	Stack: { Screen: () => null },
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('react-native-safe-area-context', () => {
	const { View } = require('react-native');
	return { SafeAreaView: View };
});

jest.mock('react-i18next', () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock('../../contexts/AuthContext', () => ({
	useAuth: () => ({
		account: {
			id: 'conta-1',
			email: 'eu@exemplo.com',
			name: 'Fulano',
			baseCurrency: 'BRL',
			language: 'pt',
		},
		isAvailable: true,
		signIn: jest.fn(),
		signUp: jest.fn(),
		signOut: jest.fn(),
		deleteAccount: (password: string) => mockDeleteAccount(password),
		pendingClaim: false,
		claimCounts: null,
		resolveClaim: jest.fn(),
	}),
}));

jest.mock('../../contexts/SyncContext', () => ({
	useSync: () => ({ status: 'idle', pending: 0, lastSyncedAt: null, syncNow: jest.fn() }),
}));

jest.mock('../../contexts/TransactionsContext', () => ({
	useTransactions: () => ({ refreshData: jest.fn() }),
}));

jest.mock('../../contexts/CurrencyContext', () => ({
	useCurrency: () => ({ currentCurrency: { code: 'BRL' } }),
}));

jest.mock('../../contexts/PeriodContext', () => ({
	usePeriod: () => ({ resetToCurrentMonth: mockResetToCurrentMonth }),
}));

jest.mock('../../hooks/useBiometricAuth', () => ({
	useBiometricAuth: () => ({ authenticate: mockAuthenticate, isAuthenticating: false }),
}));

jest.mock('../../database/database', () => ({
	countUnsyncedRows: jest.fn(async () => 0),
}));

jest.mock('../../sync/claim', () => ({
	claimSummaryParams: jest.fn(() => ({})),
}));

jest.mock('../../api/client', () => ({
	ApiError: class ApiError extends Error {},
}));

import { Alert, type AlertButton } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import AccountScreen from '../AccountScreen';

// A primeira montagem carrega a tela inteira; com a suíte toda rodando junto, passou dos
// 5 s padrão.
jest.setTimeout(20_000);

let renderer: ReactTestRenderer;
const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

/** O `Text` nativo, não o componente: é ele que tem o texto como filho. */
const isHostText = (node: ReactTestInstance): boolean => (node.type as unknown) === 'Text';

/** O texto está na tela? */
const texts = (): string[] =>
	renderer.root.findAll(isHostText).map((node) => [node.props.children].flat().join(''));

/** Toca no que tem este texto: sobe da etiqueta até quem recebe o toque. */
const press = async (label: string) => {
	const text = renderer.root.find((node) => isHostText(node) && node.props.children === label);
	let target: ReactTestInstance | null = text;
	while (target && !target.props.onPress) target = target.parent;
	if (!target) throw new Error(`nada tocável em ${label}`);
	const onPress = target.props.onPress as () => unknown;
	await act(async () => {
		await onPress();
	});
};

const passwordField = (): ReactTestInstance | undefined =>
	renderer.root.findAll(
		(node) =>
			typeof node.type === 'string' &&
			node.props.accessibilityLabel === 'account.deletePasswordLabel'
	)[0];

/** O último `Alert.alert`, com o botão pedido apertado. */
const pressAlertButton = async (text: string) => {
	const buttons = alertSpy.mock.calls.at(-1)?.[2] as AlertButton[];
	const button = buttons.find((candidate) => candidate.text === text);
	if (!button?.onPress) throw new Error(`sem botão ${text}`);
	const onPress = button.onPress as () => unknown;
	await act(async () => {
		await onPress();
	});
};

/** Do botão até o modal da senha, com a biometria aprovada. */
const openPasswordModal = async () => {
	await press('account.deleteAccount');
	await pressAlertButton('account.deleteContinue');
};

const typePassword = async (value: string) => {
	const field = passwordField();
	if (!field) throw new Error('sem o campo da senha');
	await act(async () => {
		field.props.onChangeText(value);
	});
};

beforeEach(async () => {
	jest.clearAllMocks();
	mockAuthenticate.mockImplementation(async (_reason: string, onSuccess?: () => void) => {
		onSuccess?.();
		return true;
	});
	await act(async () => {
		renderer = create(<AccountScreen />);
	});
});

afterEach(() => {
	act(() => renderer.unmount());
});

it('a confirmação explica o que some antes de tudo, e cancelar não faz nada', async () => {
	await press('account.deleteAccount');

	expect(alertSpy).toHaveBeenCalledWith(
		'account.deleteTitle',
		'account.deleteConfirm',
		expect.any(Array)
	);
	const buttons = alertSpy.mock.calls[0][2] as AlertButton[];
	expect(buttons.map((button) => button.style)).toEqual(['cancel', 'destructive']);
	expect(mockAuthenticate).not.toHaveBeenCalled();
	expect(passwordField()).toBeUndefined();
});

it('a biometria recusada para no aviso, como no "Apagar todos os dados"', async () => {
	mockAuthenticate.mockImplementationOnce(
		async (_reason: string, _ok?: () => void, onFailure?: () => void) => {
			onFailure?.();
			return false;
		}
	);

	await openPasswordModal();

	expect(mockAuthenticate).toHaveBeenCalledWith(
		'account.deleteAuthMsg',
		expect.any(Function),
		expect.any(Function)
	);
	expect(alertSpy).toHaveBeenLastCalledWith('settings.authFailed', 'account.deleteAuthFailed');
	expect(passwordField()).toBeUndefined();
});

it('o campo da senha é secreto e tem nome para o leitor de tela', async () => {
	await openPasswordModal();

	const field = passwordField();
	expect(field?.props.secureTextEntry).toBe(true);
	expect(field?.props.autoCapitalize).toBe('none');
});

it('senha errada: diz isso, e o modal fica para tentar de novo', async () => {
	mockDeleteAccount.mockResolvedValueOnce({ ok: false, reason: 'wrong_password' });
	await openPasswordModal();
	await typePassword('senha-errada');

	await press('account.deleteAction');

	expect(mockDeleteAccount).toHaveBeenCalledWith('senha-errada');
	expect(texts()).toContain('account.deleteWrongPassword');
	expect(passwordField()).toBeDefined();
	expect(mockDismissTo).not.toHaveBeenCalled();

	// A segunda tentativa, com a senha certa.
	mockDeleteAccount.mockResolvedValueOnce({ ok: true, alreadyGone: false, deviceWiped: true });
	await typePassword('senha-certa');
	await press('account.deleteAction');

	expect(mockDeleteAccount).toHaveBeenLastCalledWith('senha-certa');
	expect(mockDismissTo).toHaveBeenCalledWith('/(tabs)');
});

it('sem rede, servidor antigo, erro: diz que não deu agora, e nada foi apagado', async () => {
	mockDeleteAccount.mockResolvedValueOnce({ ok: false, reason: 'unavailable' });
	await openPasswordModal();
	await typePassword('minha-senha');

	await press('account.deleteAction');

	expect(texts()).toContain('account.deleteUnavailable');
	expect(passwordField()).toBeDefined();
	expect(mockDismissTo).not.toHaveBeenCalled();
	expect(mockResetToCurrentMonth).not.toHaveBeenCalled();
});

it('apagada: vai para a tela inicial e diz o que aconteceu', async () => {
	mockDeleteAccount.mockResolvedValueOnce({ ok: true, alreadyGone: false, deviceWiped: true });
	await openPasswordModal();
	await typePassword('minha-senha');

	await press('account.deleteAction');

	expect(passwordField()).toBeUndefined();
	expect(mockResetToCurrentMonth).toHaveBeenCalled();
	expect(mockDismissTo).toHaveBeenCalledWith('/(tabs)');
	expect(alertSpy).toHaveBeenLastCalledWith(
		'account.deleteSuccessTitle',
		'account.deleteSuccessMsg'
	);
	expect(mockDismissTo.mock.invocationCallOrder[0]).toBeLessThan(
		alertSpy.mock.invocationCallOrder[alertSpy.mock.invocationCallOrder.length - 1]
	);
});

it('apagada, mas o aparelho não terminou: o aviso manda terminar pelo "Apagar todos os dados"', async () => {
	mockDeleteAccount.mockResolvedValueOnce({ ok: true, alreadyGone: false, deviceWiped: false });
	await openPasswordModal();
	await typePassword('minha-senha');

	await press('account.deleteAction');

	expect(mockDismissTo).toHaveBeenCalledWith('/(tabs)');
	expect(alertSpy).toHaveBeenLastCalledWith(
		'account.deleteSuccessTitle',
		'account.deleteSuccessPartial'
	);
});

it('a sessão caiu no meio: fecha o modal e pede para entrar de novo', async () => {
	mockDeleteAccount.mockResolvedValueOnce({ ok: false, reason: 'session_lost' });
	await openPasswordModal();
	await typePassword('minha-senha');

	await press('account.deleteAction');

	expect(passwordField()).toBeUndefined();
	expect(alertSpy).toHaveBeenLastCalledWith('account.errorTitle', 'account.deleteSessionLost');
	expect(mockDismissTo).not.toHaveBeenCalled();
});

it('sem senha digitada não há o que mandar', async () => {
	await openPasswordModal();

	await press('account.deleteAction');

	expect(mockDeleteAccount).not.toHaveBeenCalled();
});
