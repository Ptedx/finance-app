/**
 * Encerrar, apagar, juntar e reabrir na tela da conta (SPD-144).
 *
 * "Encerrar conta" ocupa o lugar de "Arquivar": exige saldo zero, ou leva o saldo para outra
 * conta numa transferência de hoje, e cada confirmação diz o efeito em R$. "Apagar" só apaga
 * conta vazia; com conteúdo, diz por quê e oferece Encerrar ou Juntar. Juntar só com conta do
 * mesmo papel, e diz com quanto a conta que fica termina. O contexto é dublê (as regras de
 * verdade estão em `accountsCloseSql.test.tsx`); as chaves de tradução aparecem cruas, com os
 * parâmetros.
 */

const mockCloseAccount = jest.fn(async (_id: string, _to: string | null) => undefined);
const mockReopenAccount = jest.fn(async (_id: string) => undefined);
const mockRemoveAccount = jest.fn(async (_id: string) => undefined);
const mockMergeAccounts = jest.fn(async (_from: string, _into: string) => undefined);
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

jest.mock('expo-router', () => ({
	useRouter: () => mockRouter,
	useLocalSearchParams: () => ({}),
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

jest.mock('../../database/database', () => ({}));
jest.mock('../../database/captures', () => ({}));
jest.mock('../../utils/businessFeedPreference', () => ({
	getBusinessFeeds: jest.fn(async () => ({})),
}));
jest.mock('../../utils/balanceUnsetDismissals', () => ({
	getDismissedBalanceUnset: jest.fn(async () => new Set()),
	dismissBalanceUnset: jest.fn(async () => new Set()),
}));
jest.mock('../../components/TransactionItem', () => () => null);

jest.mock('../../contexts/AccountsContext', () => ({
	useAccounts: () => ({
		accounts: mockState.accounts,
		balances: mockState.balances,
		accruedYield: new Map(),
		cdi: null,
		periodSpentByAccount: new Map(),
		month: null,
		createAccount: jest.fn(),
		saveAccount: jest.fn(),
		removeAccount: mockRemoveAccount,
		mergeAccounts: mockMergeAccounts,
		closeAccount: mockCloseAccount,
		reopenAccount: mockReopenAccount,
		planClose: mockPlanClose,
		loadAccountContents: mockLoadContents,
		takeNotifications: jest.fn(),
		takeBusinessNotifications: jest.fn(),
		adjustAccountMonth: jest.fn(),
	}),
}));

jest.mock('../../contexts/TransactionsContext', () => ({
	useTransactions: () => ({ transactions: [] }),
}));

jest.mock('../../contexts/PeriodContext', () => ({
	usePeriod: () => ({ selectedYear: 2026, selectedMonth: 11 }),
}));

jest.mock('../../utils/dateUtils', () => ({
	...jest.requireActual('../../utils/dateUtils'),
	todayISO: () => '2026-11-11',
}));

import { AccessibilityInfo, Alert, type AlertButton } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import Sheet from '../../components/cards/Sheet';
import type { Account } from '../../database/schema';
import { AccountInUseError } from '../../utils/accountClosing';
import { configureMoney } from '../../utils/money';
import AccountEditScreen from '../AccountEditScreen';

jest.setTimeout(20_000);
jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
configureMoney({ locale: 'pt-BR', currencyCode: 'BRL', currencySymbol: 'R$' });

const account = (overrides: Partial<Account>): Account => ({
	id: 'x',
	name: 'Conta',
	kind: 'checking',
	role: 'main',
	envelopeMonthlyCents: null,
	bankName: null,
	color: '#FF7A00',
	last4: null,
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
	openingBalanceDate: '2026-09-30',
	sortOrder: 0,
	archived: false,
	updatedAt: '',
	...overrides,
});

const CORRENTE = account({ id: 'corrente', name: 'Corrente', openingBalanceCents: 100_000 });
const CARTEIRA = account({ id: 'carteira', name: 'Carteira', kind: 'cash', sortOrder: 1 });
const RESERVA = account({
	id: 'reserva',
	name: 'Reserva',
	kind: 'savings',
	role: 'reserve',
	sortOrder: 2,
});
const PJ = account({ id: 'pj', name: 'PJ', role: 'external', sortOrder: 3 });
const CARTAO = account({
	id: 'cartao',
	name: 'Nubank',
	kind: 'credit_card',
	role: 'card',
	sortOrder: 4,
});
const VELHA = account({ id: 'velha', name: 'Velha', archived: true, sortOrder: 5 });
const VAZIA = account({ id: 'vazia', name: 'Vazia', sortOrder: 6 });
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

const mount = async (accountId: string) => {
	await act(async () => {
		renderer = create(<AccountEditScreen accountId={accountId} />);
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
	mockState.accounts = [CORRENTE, CARTEIRA, RESERVA, PJ, CARTAO, VELHA, VAZIA];
	mockState.balances = new Map([
		['corrente', 100_000],
		['carteira', 45_000],
		['reserva', 30_000],
		['velha', 30_000],
		['vazia', 0],
	]);
});

afterEach(() => {
	act(() => renderer.unmount());
});

describe('Encerrar conta', () => {
	it('é a ação no lugar de "Arquivar"', async () => {
		await mount('carteira');
		expect(pressables('accounts.edit.close')).toHaveLength(1);
		expect(pressables('accounts.edit.archive')).toHaveLength(0);
	});

	it('saldo zero: confirma que nada muda e encerra sem transferência', async () => {
		mockPlanClose.mockResolvedValueOnce({ kind: 'direct' });
		await mount('vazia');
		await press('accounts.edit.close');

		expect(mockPlanClose).toHaveBeenCalledWith('vazia');
		expect(lastAlert()?.[1]).toContain('accounts.edit.closeDirect');
		expect(alertButtons().map((button) => button.text)).toEqual([
			'accounts.edit.cancel',
			'accounts.edit.closeAction',
		]);
		expect(mockCloseAccount).not.toHaveBeenCalled();
		await pressAlert('accounts.edit.closeAction');
		expect(mockCloseAccount).toHaveBeenCalledWith('vazia', null);
	});

	it('R$ 450 na Carteira: escolhe para onde vão (nem cartão, nem PJ, nem encerrada), e a confirmação diz R$ 450 e que o patrimônio não muda', async () => {
		mockPlanClose.mockResolvedValueOnce({
			kind: 'transfer',
			direction: 'out',
			amountCents: 45_000,
		});
		await mount('carteira');
		await press('accounts.edit.close');

		expect(alertSpy).not.toHaveBeenCalled();
		expect(openSheet()?.props.subtitle).toBe(
			`accounts.edit.closePick ${JSON.stringify({ amount: 'R$ 450,00', name: 'Carteira' })}`
		);
		expect(targetNames()).toEqual(['Corrente', 'Reserva', 'Vazia']);

		await pickTarget('Corrente');
		expect(openSheet()).toBeUndefined();
		expect(lastAlert()?.[1]).toBe(
			`accounts.edit.closeTransferOut ${JSON.stringify({ amount: 'R$ 450,00', name: 'Carteira', target: 'Corrente' })}`
		);
		await pressAlert('accounts.edit.closeAction');
		expect(mockCloseAccount).toHaveBeenCalledWith('carteira', 'corrente');
	});

	it('Reserva para a Corrente: a confirmação avisa que, com papéis diferentes, a transferência entra no mês', async () => {
		mockPlanClose.mockResolvedValueOnce({
			kind: 'transfer',
			direction: 'out',
			amountCents: 30_000,
		});
		await mount('reserva');
		await press('accounts.edit.close');
		await pickTarget('Corrente');
		expect(lastAlert()?.[1]).toContain('accounts.edit.closeRoleNote');
	});

	it('compra a revisar: diz o porquê e não encerra', async () => {
		mockPlanClose.mockResolvedValueOnce({
			kind: 'blocked',
			reason: 'pendingCaptures',
			amountCents: 0,
			count: 2,
		});
		await mount('carteira');
		await press('accounts.edit.close');
		expect(lastAlert()?.[1]).toBe(
			`accounts.edit.closeBlockedPending ${JSON.stringify({ count: 2, name: 'Carteira' })}`
		);
		expect(openSheet()).toBeUndefined();
		expect(mockCloseAccount).not.toHaveBeenCalled();
	});
});

describe('Apagar conta', () => {
	it('com 42 lançamentos: não apaga, diz por quê e oferece Encerrar ou Juntar', async () => {
		mockLoadContents.mockResolvedValueOnce({ ...EMPTY, transactions: 42 });
		await mount('carteira');
		await press('accounts.edit.delete');

		expect(lastAlert()?.[1]).toContain(
			`accounts.edit.deleteRefusedEntries ${JSON.stringify({ count: 42, name: 'Carteira' })}`
		);
		expect(lastAlert()?.[1]).toContain('accounts.edit.deleteRefusedWhy');
		expect(alertButtons().map((button) => button.text)).toEqual([
			'accounts.edit.cancel',
			'accounts.edit.close',
			'accounts.edit.merge',
		]);
		expect(mockRemoveAccount).not.toHaveBeenCalled();

		mockPlanClose.mockResolvedValueOnce({ kind: 'direct' });
		await pressAlert('accounts.edit.close');
		expect(mockPlanClose).toHaveBeenCalledWith('carteira');
	});

	it('vazia: a confirmação diz que nada muda; confirmado, apaga e fecha a tela', async () => {
		mockLoadContents.mockResolvedValueOnce({ ...EMPTY, bills: 1 });
		await mount('vazia');
		await press('accounts.edit.delete');

		expect(lastAlert()?.[1]).toContain(
			`accounts.edit.deleteEmptyConfirm ${JSON.stringify({ name: 'Vazia' })}`
		);
		expect(lastAlert()?.[1]).toContain('accounts.edit.deleteLinked');
		expect(alertButtons().map((button) => button.style)).toEqual(['cancel', 'destructive']);
		await pressAlert('accounts.edit.delete');
		expect(mockRemoveAccount).toHaveBeenCalledWith('vazia');
		expect(mockRouter.back).toHaveBeenCalled();
	});

	it('ganhou conteúdo entre a pergunta e o toque: o banco recusa, a tela diz e fica', async () => {
		mockLoadContents.mockResolvedValueOnce(EMPTY);
		mockRemoveAccount.mockRejectedValueOnce(new AccountInUseError());
		await mount('vazia');
		await press('accounts.edit.delete');
		await pressAlert('accounts.edit.delete');
		expect(lastAlert()?.[1]).toBe(
			`accounts.edit.deleteChanged ${JSON.stringify({ name: 'Vazia' })}`
		);
		expect(mockRouter.back).not.toHaveBeenCalled();
	});
});

describe('Juntar com outra conta', () => {
	it('só com o mesmo papel, e a confirmação diz com quanto a que fica termina', async () => {
		await mount('carteira');
		await press('accounts.edit.merge');
		expect(targetNames()).toEqual(['Corrente', 'Vazia']);

		await pickTarget('Corrente');
		expect(lastAlert()?.[1]).toBe(
			`accounts.edit.mergeConfirm ${JSON.stringify({ from: 'Carteira', into: 'Corrente', total: 'R$ 1.450,00' })}`
		);
		await pressAlert('accounts.edit.mergeAction');
		expect(mockMergeAccounts).toHaveBeenCalledWith('carteira', 'corrente');
	});

	it('a reserva não tem com quem juntar aqui: o botão não aparece', async () => {
		await mount('reserva');
		expect(pressables('accounts.edit.merge')).toHaveLength(0);
	});
});

describe('Conta encerrada', () => {
	it('mostra o saldo que ficou de fora dos totais, oferece acertar e reabrir', async () => {
		await mount('velha');
		expect(pressables('accounts.edit.close')).toHaveLength(0);
		expect(pressables('accounts.edit.merge')).toHaveLength(0);
		expect(texts()).toContain(
			`accounts.edit.closedWithBalance ${JSON.stringify({ amount: 'R$ 300,00' })}`
		);

		mockPlanClose.mockResolvedValueOnce({
			kind: 'transfer',
			direction: 'out',
			amountCents: 30_000,
		});
		await press('accounts.edit.settle');
		await pickTarget('Corrente');
		expect(lastAlert()?.[1]).toBe(
			`accounts.edit.settleOut ${JSON.stringify({ amount: 'R$ 300,00', name: 'Velha', target: 'Corrente' })}`
		);
		await pressAlert('accounts.edit.closeAction');
		expect(mockCloseAccount).toHaveBeenCalledWith('velha', 'corrente');
	});

	it('reabrir com saldo: avisa que os R$ 300 voltam aos totais; confirmado, reabre', async () => {
		await mount('velha');
		await press('accounts.edit.reopen');
		expect(lastAlert()?.[1]).toBe(
			`accounts.edit.reopenBalance ${JSON.stringify({ name: 'Velha', amount: 'R$ 300,00' })}`
		);
		expect(mockReopenAccount).not.toHaveBeenCalled();
		await pressAlert('accounts.edit.reopen');
		expect(mockReopenAccount).toHaveBeenCalledWith('velha');
	});

	it('reabrir com saldo zero: reabre direto', async () => {
		mockState.balances.set('velha', 0);
		await mount('velha');
		await press('accounts.edit.reopen');
		expect(alertSpy).not.toHaveBeenCalled();
		expect(mockReopenAccount).toHaveBeenCalledWith('velha');
	});
});
