/**
 * "Juntar com outro cartão" na edição do cartão (E2E-34, SPD-097).
 *
 * O botão só existe quando há outro cartão para receber as compras. O toque pergunta para
 * qual cartão levar, confirma dizendo o que fica e o que sai, e só então chama
 * `mergeCards(este, escolhido)`. O resto da tela é dublê; as chaves de tradução aparecem
 * cruas.
 */

const mockMergeCards = jest.fn(async (_fromId: string, _intoId: string) => undefined);
const mockReplace = jest.fn();
const mockAccounts: { accounts: unknown[] } = { accounts: [] };

jest.mock('expo-router', () => ({
	useRouter: () => ({ replace: mockReplace, back: jest.fn(), push: jest.fn() }),
	Stack: { Screen: () => null },
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('react-native-safe-area-context', () => {
	const { View } = require('react-native');
	return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) };
});

jest.mock('react-i18next', () => ({
	useTranslation: () => ({
		t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
	}),
}));

jest.mock('../../components/cards/CardFace', () => () => null);

jest.mock('../../contexts/AccountsContext', () => ({
	useAccounts: () => ({
		accounts: mockAccounts.accounts,
		bankAccounts: (mockAccounts.accounts as Array<{ kind: string }>).filter((account) => account.kind !== 'credit_card'),
		createAccount: jest.fn(),
		saveAccount: jest.fn(),
		removeAccount: jest.fn(),
		adjustCardInvoices: jest.fn(),
		convertCardToDebit: jest.fn(),
		mergeCards: mockMergeCards,
	}),
}));

jest.mock('../../utils/dateUtils', () => ({ ...jest.requireActual('../../utils/dateUtils'), todayISO: () => '2026-11-07' }));

import { AccessibilityInfo, Alert, type AlertButton } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { Account } from '../../database/schema';
import CardEditScreen from '../CardEditScreen';

jest.setTimeout(20_000);
jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);

const account = (overrides: Partial<Account>): Account => ({
	id: 'x',
	name: 'Cartão',
	kind: 'credit_card',
	role: 'card',
	envelopeMonthlyCents: null,
	bankName: 'Nubank',
	color: '#820AD1',
	last4: '1111',
	network: null,
	closingDay: null,
	dueDay: null,
	closingDaysBefore: null,
	creditLimitCents: null,
	cardNames: null,
	yieldCdiBp: null,
	reservePurpose: null,
	packageName: null,
	accountKey: null,
	openingBalanceCents: 0,
	openingBalanceDate: '2026-10-31',
	sortOrder: 0,
	archived: false,
	updatedAt: '',
	...overrides,
});

const NUBANK = account({ id: 'nubank', name: 'Nubank Teste', closingDay: 25, closingDaysBefore: 7, creditLimitCents: 500_000 });
const DUPLICADO = account({ id: 'dup', name: 'NU PAGAMENTOS S.A. · cartão final 1111', bankName: 'NU PAGAMENTOS S.A.', sortOrder: 1 });
const CORRENTE = account({ id: 'corrente', name: 'Corrente', kind: 'checking', role: 'main', last4: null, sortOrder: 2 });

let renderer: ReactTestRenderer;

const pressables = (label: string): ReactTestInstance[] =>
	renderer.root.findAll((node) => typeof node.props.onPress === 'function' && node.props.accessibilityLabel === label);

const mount = async (cardId: string) => {
	await act(async () => {
		renderer = create(<CardEditScreen cardId={cardId} />);
	});
};

/** O botão de um `Alert.alert` pelo texto, na chamada `call`. */
const alertButton = (call: number, text: string): AlertButton => {
	const buttons = (alertSpy.mock.calls[call]?.[2] ?? []) as AlertButton[];
	const button = buttons.find((candidate) => candidate.text === text);
	if (!button) throw new Error(`sem o botão ${text} no alerta ${call}`);
	return button;
};

beforeEach(() => {
	jest.clearAllMocks();
	mockAccounts.accounts = [];
});

afterEach(() => {
	act(() => renderer.unmount());
});

describe('E2E-34 — juntar com outro cartão', () => {
	it('com um cartão só (e uma conta corrente), o botão não aparece', async () => {
		mockAccounts.accounts = [NUBANK, CORRENTE];
		await mount('nubank');
		expect(pressables('cards.edit.delete')).toHaveLength(1);
		expect(pressables('cards.edit.merge')).toHaveLength(0);
	});

	it('o outro cartão arquivado não conta: o botão não aparece', async () => {
		mockAccounts.accounts = [NUBANK, { ...DUPLICADO, archived: true }];
		await mount('nubank');
		expect(pressables('cards.edit.merge')).toHaveLength(0);
	});

	it('do duplicado: escolhe o Nubank Teste, confirma, e chama mergeCards(duplicado, Nubank Teste)', async () => {
		mockAccounts.accounts = [NUBANK, DUPLICADO, CORRENTE];
		await mount('dup');
		const [button] = pressables('cards.edit.merge');
		expect(button).toBeDefined();

		await act(async () => {
			button.props.onPress();
		});
		// Primeiro: para qual cartão. Só os outros cartões — nem ele, nem a conta corrente.
		const pick = (alertSpy.mock.calls[0]?.[2] ?? []) as AlertButton[];
		expect(pick.map((option) => option.text)).toEqual(['cards.cancel', 'Nubank Teste']);
		expect(mockMergeCards).not.toHaveBeenCalled();

		await act(async () => {
			alertButton(0, 'Nubank Teste').onPress?.();
		});
		// Depois: a confirmação diz o que sai e o que fica.
		expect(alertSpy.mock.calls[1]?.[1]).toBe(
			`cards.edit.mergeConfirm ${JSON.stringify({ from: DUPLICADO.name, into: NUBANK.name })}`
		);
		expect(mockMergeCards).not.toHaveBeenCalled();

		await act(async () => {
			await alertButton(1, 'cards.edit.mergeAction').onPress?.();
		});
		expect(mockMergeCards).toHaveBeenCalledTimes(1);
		expect(mockMergeCards).toHaveBeenCalledWith('dup', 'nubank');
		expect(mockReplace).toHaveBeenCalledWith({ pathname: '/cards/[id]', params: { id: 'nubank' } });
	});

	it('cancelar a confirmação não junta nada', async () => {
		mockAccounts.accounts = [NUBANK, DUPLICADO];
		await mount('dup');
		await act(async () => {
			pressables('cards.edit.merge')[0].props.onPress();
		});
		await act(async () => {
			alertButton(0, 'Nubank Teste').onPress?.();
		});
		await act(async () => {
			alertButton(1, 'cards.cancel').onPress?.();
		});
		expect(mockMergeCards).not.toHaveBeenCalled();
	});
});
