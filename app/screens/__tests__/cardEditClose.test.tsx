/**
 * Encerrar, apagar e reabrir na edição do cartão (SPD-144).
 *
 * "Encerrar cartão" ocupa o lugar de "Arquivar cartão". Devendo, não encerra: a confirmação
 * diz quanto e manda pagar a fatura antes. Zerado, encerra e diz que nada muda. Com crédito,
 * o crédito volta para uma conta (nunca outro cartão) numa transferência de hoje, e a
 * confirmação diz quanto. "Apagar cartão" com compras recusa e oferece Encerrar ou Juntar. O
 * contexto é dublê (as regras de verdade estão em `accountsCloseSql.test.tsx`); as chaves de
 * tradução aparecem cruas, com os parâmetros.
 */

const mockCloseAccount = jest.fn(async (_id: string, _to: string | null) => undefined);
const mockReopenAccount = jest.fn(async (_id: string) => undefined);
const mockRemoveAccount = jest.fn(async (_id: string) => undefined);
const mockPlanClose = jest.fn();
const mockLoadContents = jest.fn();
const mockRouter = {
	replace: jest.fn(),
	back: jest.fn(),
	push: jest.fn(),
	dismiss: jest.fn(),
	dismissTo: jest.fn(),
	dismissAll: jest.fn(),
	canGoBack: jest.fn(() => true),
};
const mockState: { accounts: unknown[]; balances: Map<string, number> } = {
	accounts: [],
	balances: new Map(),
};

jest.mock('@react-native-async-storage/async-storage', () =>
	require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('../../database/database', () => ({}));

jest.mock('expo-router', () => ({
	useRouter: () => mockRouter,
	Stack: { Screen: () => null },
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('react-native-safe-area-context', () => {
	const { View } = require('react-native');
	return {
		SafeAreaView: View,
		useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
	};
});

jest.mock('react-i18next', () => ({
	useTranslation: () => ({
		t: (key: string, params?: Record<string, unknown>) =>
			params ? `${key} ${JSON.stringify(params)}` : key,
	}),
}));

jest.mock('../../components/cards/CardFace', () => () => null);

jest.mock('../../contexts/AccountsContext', () => ({
	useAccounts: () => ({
		accounts: mockState.accounts,
		bankAccounts: (mockState.accounts as Array<{ kind: string }>).filter(
			(account) => account.kind !== 'credit_card'
		),
		balances: mockState.balances,
		createAccount: jest.fn(),
		saveAccount: jest.fn(),
		removeAccount: mockRemoveAccount,
		closeAccount: mockCloseAccount,
		reopenAccount: mockReopenAccount,
		planClose: mockPlanClose,
		loadAccountContents: mockLoadContents,
		adjustCardInvoices: jest.fn(),
		convertCardToDebit: jest.fn(),
		mergeCards: jest.fn(),
	}),
}));

jest.mock('../../contexts/TransactionsContext', () => ({
	useTransactions: () => ({ transactions: [] }),
}));

jest.mock('../../utils/dateUtils', () => ({
	...jest.requireActual('../../utils/dateUtils'),
	todayISO: () => '2026-11-11',
}));

import { AccessibilityInfo, Alert, type AlertButton } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import Sheet from '../../components/cards/Sheet';
import type { Account } from '../../database/schema';
import { configureMoney } from '../../utils/money';
import CardEditScreen from '../CardEditScreen';

jest.setTimeout(20_000);
jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
configureMoney({ locale: 'pt-BR', currencyCode: 'BRL', currencySymbol: 'R$' });

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
	closingDay: 3,
	dueDay: 10,
	closingDaysBefore: 7,
	creditLimitCents: 500_000,
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

const NUBANK = account({ id: 'nubank', name: 'Nubank Teste' });
const INTER = account({
	id: 'inter',
	name: 'Inter Teste',
	bankName: 'Inter',
	last4: '2222',
	sortOrder: 1,
});
const CORRENTE = account({
	id: 'corrente',
	name: 'Corrente',
	kind: 'checking',
	role: 'main',
	bankName: null,
	last4: null,
	closingDay: null,
	dueDay: null,
	closingDaysBefore: null,
	creditLimitCents: null,
	sortOrder: 2,
});
const PJ = account({
	id: 'pj',
	name: 'PJ',
	kind: 'checking',
	role: 'external',
	bankName: null,
	last4: null,
	closingDay: null,
	dueDay: null,
	closingDaysBefore: null,
	creditLimitCents: null,
	sortOrder: 3,
});
const EMPTY = {
	transactions: 0,
	transfers: 0,
	captures: 0,
	openingBalanceCents: 0,
	bills: 0,
	debts: 0,
};

let renderer: ReactTestRenderer;

const pressables = (label: string): ReactTestInstance[] =>
	renderer.root.findAll(
		(node) => typeof node.props.onPress === 'function' && node.props.accessibilityLabel === label
	);

const press = async (label: string) => {
	const [target] = pressables(label);
	if (!target) throw new Error(`nada tocável com ${label}`);
	await act(async () => {
		await target.props.onPress();
	});
};

const mount = async (cardId: string) => {
	await act(async () => {
		renderer = create(<CardEditScreen cardId={cardId} />);
	});
};

const openSheet = (): ReactTestInstance | undefined =>
	renderer.root.findAll((node) => node.type === Sheet && node.props.visible === true)[0];

const targetNames = (): string[] => {
	const sheet = openSheet();
	if (!sheet) return [];
	return sheet
		.findAll(
			(node) =>
				typeof node.props.onPress === 'function' &&
				typeof node.props.accessibilityLabel === 'string'
		)
		.map((node) => node.props.accessibilityLabel as string)
		.filter((label, index, all) => label !== 'cards.close' && all.indexOf(label) === index);
};

const pickTarget = async (name: string) => {
	const sheet = openSheet();
	if (!sheet) throw new Error('a folha não está aberta');
	const [row] = sheet.findAll(
		(node) => typeof node.props.onPress === 'function' && node.props.accessibilityLabel === name
	);
	await act(async () => {
		row.props.onPress();
	});
};

const lastAlert = () => alertSpy.mock.calls[alertSpy.mock.calls.length - 1];
const alertButtons = (): AlertButton[] => (lastAlert()?.[2] ?? []) as AlertButton[];
const pressAlert = async (text: string) => {
	const button = alertButtons().find((candidate) => candidate.text === text);
	if (!button?.onPress) throw new Error(`sem o botão ${text}`);
	const onPress = button.onPress as () => unknown;
	await act(async () => {
		await onPress();
	});
};

const texts = (): string[] =>
	renderer.root
		.findAll((node) => (node.type as unknown) === 'Text')
		.map((node) => [node.props.children].flat().join(''));

beforeEach(() => {
	jest.clearAllMocks();
	mockState.accounts = [NUBANK, INTER, CORRENTE, PJ];
	mockState.balances = new Map([
		['nubank', -50_000],
		['inter', 0],
		['corrente', 100_000],
	]);
});

afterEach(() => {
	act(() => renderer.unmount());
});

describe('Encerrar cartão', () => {
	it('é a ação no lugar de "Arquivar cartão"', async () => {
		await mount('nubank');
		expect(pressables('cards.edit.close')).toHaveLength(1);
		expect(pressables('cards.edit.archive')).toHaveLength(0);
	});

	it('devendo R$ 500: diz quanto, manda pagar a fatura antes e não encerra', async () => {
		mockPlanClose.mockResolvedValueOnce({
			kind: 'blocked',
			reason: 'cardOwes',
			amountCents: 50_000,
			count: 0,
		});
		await mount('nubank');
		await press('cards.edit.close');
		expect(mockPlanClose).toHaveBeenCalledWith('nubank');
		expect(lastAlert()?.[1]).toBe(
			`cards.edit.closeBlockedOwes ${JSON.stringify({ amount: 'R$ 500,00', name: 'Nubank Teste' })}`
		);
		expect(alertButtons()).toEqual([]);
		expect(mockCloseAccount).not.toHaveBeenCalled();
	});

	it('zerado: confirma que nada muda, encerra sem transferência e volta', async () => {
		mockPlanClose.mockResolvedValueOnce({ kind: 'direct' });
		await mount('inter');
		await press('cards.edit.close');
		expect(lastAlert()?.[1]).toBe(
			`cards.edit.closeDirect ${JSON.stringify({ name: 'Inter Teste' })}`
		);
		expect(alertButtons().map((button) => button.text)).toEqual([
			'cards.cancel',
			'cards.edit.closeAction',
		]);
		await pressAlert('cards.edit.closeAction');
		expect(mockCloseAccount).toHaveBeenCalledWith('inter', null);
		expect(mockRouter.back).toHaveBeenCalled();
	});

	it('com crédito de R$ 40: o crédito volta para uma conta (nem cartão, nem PJ), e a confirmação diz R$ 40', async () => {
		mockState.balances.set('nubank', 4_000);
		mockPlanClose.mockResolvedValueOnce({ kind: 'transfer', direction: 'out', amountCents: 4_000 });
		await mount('nubank');
		await press('cards.edit.close');

		expect(openSheet()?.props.subtitle).toBe(
			`cards.edit.closePick ${JSON.stringify({ amount: 'R$ 40,00', name: 'Nubank Teste' })}`
		);
		expect(targetNames()).toEqual(['Corrente']);
		await pickTarget('Corrente');
		expect(lastAlert()?.[1]).toBe(
			`cards.edit.closeTransferOut ${JSON.stringify({ amount: 'R$ 40,00', name: 'Nubank Teste', target: 'Corrente' })}`
		);
		await pressAlert('cards.edit.closeAction');
		expect(mockCloseAccount).toHaveBeenCalledWith('nubank', 'corrente');
	});
});

describe('Apagar cartão', () => {
	it('com 7 compras: não apaga, diz por quê e oferece Encerrar ou Juntar', async () => {
		mockLoadContents.mockResolvedValueOnce({ ...EMPTY, transactions: 7, transfers: 1 });
		await mount('nubank');
		await press('cards.edit.delete');
		expect(lastAlert()?.[1]).toBe(
			`cards.edit.deleteRefusedEntries ${JSON.stringify({ count: 7, name: 'Nubank Teste' })} cards.edit.deleteRefusedWhy`
		);
		expect(alertButtons().map((button) => button.text)).toEqual([
			'cards.cancel',
			'cards.edit.close',
			'cards.edit.merge',
		]);
		expect(mockRemoveAccount).not.toHaveBeenCalled();
	});

	it('só com a fatura informada de R$ 800: recusa pela fatura, com o valor', async () => {
		mockLoadContents.mockResolvedValueOnce({ ...EMPTY, openingBalanceCents: -80_000 });
		await mount('nubank');
		await press('cards.edit.delete');
		expect(lastAlert()?.[1]).toContain(
			`cards.edit.deleteRefusedOpening ${JSON.stringify({ amount: 'R$ 800,00', name: 'Nubank Teste' })}`
		);
	});

	it('vazio: diz que nada muda e apaga', async () => {
		mockLoadContents.mockResolvedValueOnce(EMPTY);
		await mount('inter');
		await press('cards.edit.delete');
		expect(lastAlert()?.[1]).toBe(
			`cards.edit.deleteEmptyConfirm ${JSON.stringify({ name: 'Inter Teste' })} cards.edit.deleteContinue`
		);
		await pressAlert('cards.edit.delete');
		expect(mockRemoveAccount).toHaveBeenCalledWith('inter');
		expect(mockRouter.dismissTo).toHaveBeenCalledWith({
			pathname: '/cards/[id]',
			params: { id: 'inter' },
		});
	});
});

describe('Cartão encerrado', () => {
	it('encerrado devendo R$ 500: mostra a dívida, oferece reabrir (avisando que ela volta aos totais), sem encerrar de novo', async () => {
		mockState.accounts = [{ ...NUBANK, archived: true }, INTER, CORRENTE];
		await mount('nubank');
		expect(pressables('cards.edit.close')).toHaveLength(0);
		expect(pressables('cards.edit.merge')).toHaveLength(0);
		expect(texts()).toContain(`cards.edit.closedOwing ${JSON.stringify({ amount: 'R$ 500,00' })}`);
		expect(pressables('cards.edit.settle')).toHaveLength(0);

		await press('cards.edit.reopen');
		expect(lastAlert()?.[1]).toBe(
			`cards.edit.reopenOwing ${JSON.stringify({ name: 'Nubank Teste', amount: 'R$ 500,00' })}`
		);
		await pressAlert('cards.edit.reopen');
		expect(mockReopenAccount).toHaveBeenCalledWith('nubank');
	});
});
