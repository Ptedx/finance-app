/**
 * O saldo no cadastro da conta (E2E-02, SPD-087): "Saldo hoje · opcional" só na criação.
 *
 * O número digitado vira a âncora, como no "Acertar com o banco": o saldo do fim de ontem
 * (`setAccountBalanceToday`), para o que entrar ou sair hoje continuar somando por cima.
 * Nenhum lançamento é criado — não é receita do mês. O resto da tela é dublê; as chaves
 * de tradução aparecem cruas.
 */

const mockCreateAccount = jest.fn(async (_draft: unknown) => 'nova');
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
	useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock('../../database/database', () => ({}));
jest.mock('../../database/captures', () => ({}));
jest.mock('../../utils/businessFeedPreference', () => ({ getBusinessFeeds: jest.fn(async () => ({})) }));
jest.mock('../../components/TransactionItem', () => () => null);

jest.mock('../../contexts/AccountsContext', () => ({
	useAccounts: () => ({
		accounts: mockAccounts.accounts,
		balances: new Map(),
		accruedYield: new Map(),
		cdi: { annualBp: 1_365, date: '2026-11-05' },
		periodSpentByAccount: new Map(),
		month: null,
		createAccount: mockCreateAccount,
		saveAccount: jest.fn(),
		removeAccount: jest.fn(),
		mergeAccounts: jest.fn(),
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

// O dia do teste no aparelho.
jest.mock('../../utils/dateUtils', () => ({ ...jest.requireActual('../../utils/dateUtils'), todayISO: () => '2026-11-07' }));

import { AccessibilityInfo } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { Account } from '../../database/schema';
import { configureMoney } from '../../utils/money';
import AccountEditScreen from '../AccountEditScreen';

jest.setTimeout(20_000);
jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);

let renderer: ReactTestRenderer;

const input = (label: string): ReactTestInstance | undefined =>
	renderer.root.findAll((node) => (node.type as unknown) === 'TextInput' && node.props.accessibilityLabel === label)[0];

const typeInto = async (label: string, text: string) => {
	const field = input(label);
	if (!field) throw new Error(`sem o campo ${label}`);
	let typed = '';
	for (const letter of text) {
		await act(async () => {
			field.props.onChangeText(typed + letter);
		});
		typed = input(label)?.props.value;
	}
};

const press = async (label: string) => {
	const text = renderer.root.find((node) => (node.type as unknown) === 'Text' && node.props.children === label);
	let target: ReactTestInstance | null = text;
	while (target && !target.props.onPress) target = target.parent;
	if (!target) throw new Error(`nada tocável em ${label}`);
	const onPress = target.props.onPress as () => unknown;
	await act(async () => {
		await onPress();
	});
};

const mount = async (accountId?: string) => {
	await act(async () => {
		renderer = create(<AccountEditScreen accountId={accountId} />);
	});
};

beforeEach(() => {
	jest.clearAllMocks();
	mockAccounts.accounts = [];
	configureMoney({ locale: 'pt-BR', currencyCode: 'BRL', currencySymbol: 'R$' });
});

afterEach(() => {
	act(() => renderer.unmount());
	configureMoney({ locale: 'en-US', currencyCode: 'USD', currencySymbol: '$' });
});

describe('E2E-02 — nova conta com o saldo de hoje', () => {
	it('R$ 5.000 no cadastro: a conta nasce com R$ 5.000 no fim de ontem, sem lançamento', async () => {
		await mount();
		await typeInto('accounts.edit.name', 'Corrente Teste');
		await typeInto('accounts.edit.openingBalance', '5000');
		expect(input('accounts.edit.openingBalance')?.props.value).toBe('5.000');
		await press('accounts.edit.save');

		expect(mockCreateAccount).toHaveBeenCalledTimes(1);
		expect(mockCreateAccount.mock.calls[0][0]).toEqual(
			expect.objectContaining({ name: 'Corrente Teste', openingBalanceCents: 500_000, openingBalanceDate: '2026-11-06' })
		);
		expect(mockReplace).toHaveBeenCalledWith({ pathname: '/accounts/[id]', params: { id: 'nova' } });
	});

	it('em branco: a conta nasce zerada, com a mesma âncora de ontem', async () => {
		await mount();
		await typeInto('accounts.edit.name', 'Corrente Teste');
		await press('accounts.edit.save');

		expect(mockCreateAccount.mock.calls[0][0]).toEqual(
			expect.objectContaining({ openingBalanceCents: 0, openingBalanceDate: '2026-11-06' })
		);
	});

	it('editar uma conta que já existe não mostra o campo: lá o caminho é o "Acertar com o banco"', async () => {
		const existing: Account = {
			id: 'corrente',
			name: 'Corrente Teste',
			kind: 'checking',
			role: 'main',
			envelopeMonthlyCents: null,
			network: null,
			bankName: null,
			color: '#000',
			last4: null,
			closingDay: null,
			closingDaysBefore: null,
			dueDay: null,
			creditLimitCents: null,
			cardNames: null,
			packageName: null,
			accountKey: null,
			openingBalanceCents: 500_000,
			openingBalanceDate: '2026-11-06',
			sortOrder: 0,
			archived: false,
			updatedAt: '',
		};
		mockAccounts.accounts = [existing];
		await mount('corrente');
		expect(input('accounts.edit.openingBalance')).toBeUndefined();
		expect(input('accounts.edit.name')).toBeDefined();
	});
});
