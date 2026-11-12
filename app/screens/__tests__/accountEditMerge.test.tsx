/**
 * "Juntar com outra conta" e "Conta não encontrada" na tela da conta (E2E-39, E2E-40).
 *
 * O destino era perguntado num Alert com um botão por conta: no Android o Alert mostra no
 * máximo três botões, e com quatro contas para receber uma sumia. Agora é uma folha com
 * todas; a confirmação continua no Alert, com dois botões. Juntar ou excluir fecha a tela
 * da conta que sumiu (`back`), sem empilhar nada por cima. Aberta com uma conta que não
 * existe mais, a tela diz isso com o voltar no cabeçalho, em vez do formulário de conta
 * nova. O resto da tela é dublê; as chaves de tradução aparecem cruas.
 */

const mockMergeAccounts = jest.fn(async (_fromId: string, _intoId: string) => undefined);
const mockRemoveAccount = jest.fn(async (_id: string) => undefined);
const mockRouter = {
	replace: jest.fn(),
	back: jest.fn(),
	push: jest.fn(),
	dismiss: jest.fn(),
	dismissTo: jest.fn(),
	dismissAll: jest.fn(),
	canGoBack: jest.fn(() => true),
};
const mockAccounts: { accounts: unknown[] } = { accounts: [] };

jest.mock('expo-router', () => ({
	useRouter: () => mockRouter,
	useLocalSearchParams: () => ({}),
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

jest.mock('../../database/database', () => ({}));
jest.mock('../../database/captures', () => ({}));
jest.mock('../../utils/businessFeedPreference', () => ({ getBusinessFeeds: jest.fn(async () => ({})) }));
jest.mock('../../utils/balanceUnsetDismissals', () => ({
	getDismissedBalanceUnset: jest.fn(async () => new Set()),
	dismissBalanceUnset: jest.fn(async () => new Set()),
}));
jest.mock('../../components/TransactionItem', () => () => null);

jest.mock('../../contexts/AccountsContext', () => ({
	useAccounts: () => ({
		accounts: mockAccounts.accounts,
		balances: new Map(),
		accruedYield: new Map(),
		cdi: { annualBp: 1_365, date: '2026-11-05' },
		periodSpentByAccount: new Map(),
		month: null,
		createAccount: jest.fn(),
		saveAccount: jest.fn(),
		removeAccount: mockRemoveAccount,
		mergeAccounts: mockMergeAccounts,
		closeAccount: jest.fn(),
		reopenAccount: jest.fn(),
		planClose: jest.fn(),
		// Apagar só conta vazia (SPD-144): aqui todas são.
		loadAccountContents: jest.fn(async () => ({ transactions: 0, transfers: 0, captures: 0, openingBalanceCents: 0, bills: 0, debts: 0 })),
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

jest.mock('../../utils/dateUtils', () => ({ ...jest.requireActual('../../utils/dateUtils'), todayISO: () => '2026-11-07' }));

import { AccessibilityInfo, Alert, type AlertButton } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import Sheet from '../../components/cards/Sheet';
import type { Account } from '../../database/schema';
import { formatCents } from '../../utils/money';
import AccountEditScreen from '../AccountEditScreen';

jest.setTimeout(20_000);
jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);

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
	openingBalanceDate: '2026-10-31',
	sortOrder: 0,
	archived: false,
	updatedAt: '',
	...overrides,
});

const CORRENTE = account({ id: 'corrente', name: 'Corrente Teste', bankName: 'Nubank' });
const DUPLICADA = account({ id: 'dup', name: 'Nubank', bankName: 'Nubank', sortOrder: 1 });
const INTER = account({ id: 'inter', name: 'Inter Teste', bankName: 'Inter', sortOrder: 2 });
const RESERVA = account({ id: 'reserva', name: 'Reserva', kind: 'savings', role: 'reserve', sortOrder: 3 });
const CARTEIRA = account({ id: 'carteira', name: 'Carteira', kind: 'cash', sortOrder: 4 });
const CARTAO = account({ id: 'cartao', name: 'Nubank Teste', kind: 'credit_card', role: 'card', sortOrder: 5 });
const C6 = account({ id: 'c6', name: 'C6 Teste', bankName: 'C6', sortOrder: 6 });

let renderer: ReactTestRenderer;

const pressables = (label: string): ReactTestInstance[] =>
	renderer.root.findAll((node) => typeof node.props.onPress === 'function' && node.props.accessibilityLabel === label);

const mount = async (accountId?: string) => {
	await act(async () => {
		renderer = create(<AccountEditScreen accountId={accountId} />);
	});
};

/** A folha de escolher o destino, se está aberta. */
const openSheet = (): ReactTestInstance | undefined =>
	renderer.root.findAll((node) => node.type === Sheet && node.props.visible === true)[0];

/** Os destinos que a folha oferece, na ordem da tela (o X de fechar fica de fora). */
const targetNames = (): string[] => {
	const sheet = openSheet();
	if (!sheet) return [];
	return sheet
		.findAll((node) => typeof node.props.onPress === 'function' && typeof node.props.accessibilityLabel === 'string')
		.map((node) => node.props.accessibilityLabel as string)
		.filter((label, index, all) => label !== 'cards.close' && all.indexOf(label) === index);
};

const pickTarget = async (name: string) => {
	const sheet = openSheet();
	if (!sheet) throw new Error('a folha de destinos não está aberta');
	const [row] = sheet.findAll((node) => typeof node.props.onPress === 'function' && node.props.accessibilityLabel === name);
	if (!row) throw new Error(`sem ${name} na folha`);
	await act(async () => {
		row.props.onPress();
	});
};

const alertButton = (call: number, text: string): AlertButton => {
	const buttons = (alertSpy.mock.calls[call]?.[2] ?? []) as AlertButton[];
	const button = buttons.find((candidate) => candidate.text === text);
	if (!button) throw new Error(`sem o botão ${text} no alerta ${call}`);
	return button;
};

/** Todas as chamadas ao router, menos as perguntas (`canGoBack`). */
const routerCalls = (): Array<[string, unknown[]]> =>
	(Object.entries(mockRouter) as Array<[string, jest.Mock]>)
		.flatMap(([name, fn]) => fn.mock.calls.map((args, index) => ({ name, args, order: fn.mock.invocationCallOrder[index] })))
		.filter((call) => call.name !== 'canGoBack')
		.sort((a, b) => a.order - b.order)
		.map((call) => [call.name, call.args]);

beforeEach(() => {
	jest.clearAllMocks();
	mockRouter.canGoBack.mockReturnValue(true);
	mockAccounts.accounts = [];
});

afterEach(() => {
	act(() => renderer.unmount());
});

describe('E2E-39 — juntar com outra conta: os destinos numa folha', () => {
	it('com 4 contas para receber, a folha mostra as 4 (a reserva e o cartão, de outro papel, ficam de fora — SPD-144)', async () => {
		mockAccounts.accounts = [CORRENTE, DUPLICADA, INTER, RESERVA, CARTEIRA, CARTAO, C6];
		await mount('dup');
		await act(async () => {
			pressables('accounts.edit.merge')[0].props.onPress();
		});

		expect(alertSpy).not.toHaveBeenCalled();
		expect(openSheet()?.props.title).toBe('accounts.edit.merge');
		expect(openSheet()?.props.subtitle).toBe(`accounts.edit.mergePick ${JSON.stringify({ name: DUPLICADA.name })}`);
		expect(targetNames()).toEqual(['Corrente Teste', 'Inter Teste', 'Carteira', 'C6 Teste']);
	});

	it('escolher fecha a folha e confirma num Alert de dois botões; confirmado, junta e fecha a tela', async () => {
		mockAccounts.accounts = [CORRENTE, DUPLICADA, INTER, RESERVA, CARTEIRA];
		await mount('dup');
		await act(async () => {
			pressables('accounts.edit.merge')[0].props.onPress();
		});
		await pickTarget('Carteira');

		expect(openSheet()).toBeUndefined();
		expect(alertSpy.mock.calls[0]?.[1]).toBe(
			`accounts.edit.mergeConfirm ${JSON.stringify({ from: DUPLICADA.name, into: CARTEIRA.name, total: formatCents(0) })}`
		);
		expect((alertSpy.mock.calls[0]?.[2] as AlertButton[]).map((button) => button.text)).toEqual([
			'accounts.edit.cancel',
			'accounts.edit.mergeAction',
		]);
		expect(mockMergeAccounts).not.toHaveBeenCalled();

		await act(async () => {
			await alertButton(0, 'accounts.edit.mergeAction').onPress?.();
		});
		expect(mockMergeAccounts).toHaveBeenCalledWith('dup', 'carteira');
		// A tela da conta que saiu é a de cima: fechá-la não deixa nada dela na pilha (E2E-40).
		expect(routerCalls()).toEqual([['back', []]]);
	});

	it('SPD-152: o banco recusou por papéis diferentes (o papel mudou no outro aparelho) — diz por quê e não fecha a tela', async () => {
		mockMergeAccounts.mockImplementationOnce(async () => {
			const error = new Error('papéis diferentes');
			error.name = 'MergeRoleError';
			throw error;
		});
		mockAccounts.accounts = [CORRENTE, DUPLICADA, CARTEIRA];
		await mount('dup');
		await act(async () => {
			pressables('accounts.edit.merge')[0].props.onPress();
		});
		await pickTarget('Carteira');
		await act(async () => {
			await alertButton(0, 'accounts.edit.mergeAction').onPress?.();
		});
		expect(mockMergeAccounts).toHaveBeenCalledWith('dup', 'carteira');
		expect(alertSpy.mock.calls[1]?.[1]).toBe(
			`accounts.edit.mergeRoleBlocked ${JSON.stringify({ from: DUPLICADA.name, into: CARTEIRA.name })}`
		);
		expect(AccessibilityInfo.announceForAccessibility).not.toHaveBeenCalled();
		expect(routerCalls()).toEqual([]);
	});

	it('fechar a folha não junta nada', async () => {
		mockAccounts.accounts = [CORRENTE, DUPLICADA];
		await mount('dup');
		await act(async () => {
			pressables('accounts.edit.merge')[0].props.onPress();
		});
		await act(async () => {
			openSheet()?.props.onClose();
		});
		expect(openSheet()).toBeUndefined();
		expect(alertSpy).not.toHaveBeenCalled();
		expect(mockMergeAccounts).not.toHaveBeenCalled();
	});
});

describe('E2E-40 — a conta que sumiu', () => {
	it('apagar (a conta vazia) fecha a tela da conta, sem abrir nada por cima', async () => {
		mockAccounts.accounts = [CORRENTE, DUPLICADA];
		await mount('dup');
		await act(async () => {
			pressables('accounts.edit.delete')[0].props.onPress();
		});
		await act(async () => {
			await alertButton(0, 'accounts.edit.delete').onPress?.();
		});
		expect(mockRemoveAccount).toHaveBeenCalledWith('dup');
		expect(routerCalls()).toEqual([['back', []]]);
	});

	it('aberta com uma conta que não existe: diz isso no cabeçalho, com voltar, e não mostra o formulário de conta nova', async () => {
		mockAccounts.accounts = [CORRENTE];
		await mount('dup');

		const header = renderer.root.findAll(
			(node) => node.props.accessibilityRole === 'header' && node.props.children === 'accounts.edit.notFound'
		);
		expect(header.length).toBeGreaterThan(0);
		expect(pressables('accounts.edit.save')).toHaveLength(0);
		expect(renderer.root.findAll((node) => node.props.children === 'accounts.edit.newTitle')).toHaveLength(0);

		const [back] = pressables('accounts.back');
		expect(back).toBeDefined();
		await act(async () => {
			back.props.onPress();
		});
		expect(routerCalls()).toEqual([['back', []]]);
	});

	it('sem tela antes (aberta direto), voltar leva à lista de contas', async () => {
		mockRouter.canGoBack.mockReturnValue(false);
		mockAccounts.accounts = [CORRENTE];
		await mount('dup');
		await act(async () => {
			pressables('accounts.back')[0].props.onPress();
		});
		expect(routerCalls()).toEqual([['replace', ['/accounts']]]);
	});

	it('a tela de conta nova (sem id) continua sendo o formulário', async () => {
		await mount();
		expect(renderer.root.findAll((node) => node.props.children === 'accounts.edit.newTitle').length).toBeGreaterThan(0);
		expect(renderer.root.findAll((node) => node.props.children === 'accounts.edit.notFound')).toHaveLength(0);
	});
});
