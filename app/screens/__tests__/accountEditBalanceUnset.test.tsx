/**
 * "Saldo não informado" na tela da conta (SPD-114).
 *
 * Quem toca no selo da lista chega aqui com o "Acertar com o banco" já aberto. Na tela, o
 * aviso troca o "Saldo definido em" (que era falso: ninguém definiu nada) e tem o "Dispensar",
 * que fica só neste aparelho. Acertar o saldo também tira o selo — mesmo quando o valor
 * digitado é o que a tela já mostrava e a âncora não anda. O resto da tela é dublê; as
 * chaves de tradução aparecem cruas.
 */

const mockParams: { setBalance?: string } = {};
const mockAdjust = jest.fn(async (_id: string, _input: unknown) => undefined);
const mockAccounts: { accounts: unknown[] } = { accounts: [] };

jest.mock('@react-native-async-storage/async-storage', () =>
	require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

jest.mock('expo-router', () => ({
	useRouter: () => ({ replace: jest.fn(), back: jest.fn(), push: jest.fn(), canGoBack: () => true }),
	useLocalSearchParams: () => mockParams,
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
jest.mock('../../components/TransactionItem', () => () => null);
jest.mock('../../components/MergeTargetSheet', () => () => null);

// A folha do "Acertar com o banco": aberta, mostra um botão que confirma o saldo da tela.
jest.mock('../../components/accounts/AdjustAccountSheet', () => {
	const { Pressable, Text } = require('react-native');
	return ({ visible, balanceCents, onConfirm }: { visible: boolean; balanceCents: number; onConfirm: (input: unknown) => Promise<void> }) =>
		visible ? (
			<Pressable accessibilityLabel="folha-acertar" onPress={() => onConfirm({ spentCents: 0, balanceCents })}>
				<Text>folha-acertar</Text>
			</Pressable>
		) : null;
});

jest.mock('../../contexts/AccountsContext', () => ({
	useAccounts: () => ({
		accounts: mockAccounts.accounts,
		balances: new Map(),
		accruedYield: new Map(),
		cdi: null,
		periodSpentByAccount: new Map(),
		month: null,
		createAccount: jest.fn(),
		saveAccount: jest.fn(),
		removeAccount: jest.fn(),
		mergeAccounts: jest.fn(),
		takeNotifications: jest.fn(),
		takeBusinessNotifications: jest.fn(),
		adjustAccountMonth: mockAdjust,
	}),
}));

jest.mock('../../contexts/TransactionsContext', () => ({
	useTransactions: () => ({ transactions: [] }),
}));

jest.mock('../../contexts/PeriodContext', () => ({
	usePeriod: () => ({ selectedYear: 2026, selectedMonth: 11 }),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { AccessibilityInfo } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { Account } from '../../database/schema';
import { getDismissedBalanceUnset } from '../../utils/balanceUnsetDismissals';
import AccountEditScreen from '../AccountEditScreen';

jest.setTimeout(20_000);
jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);

const FROM_CAPTURE: Account = {
	id: 'captura',
	name: 'Banco Teste',
	kind: 'checking',
	role: 'main',
	envelopeMonthlyCents: null,
	network: null,
	bankName: 'Banco Teste',
	color: '#4CAF50',
	last4: null,
	closingDay: null,
	dueDay: null,
	closingDaysBefore: null,
	creditLimitCents: null,
	cardNames: null,
	packageName: 'br.com.bancoteste',
	accountKey: null,
	openingBalanceCents: 0,
	openingBalanceDate: '2026-11-05',
	sortOrder: 0,
	archived: false,
	updatedAt: '',
};

let renderer: ReactTestRenderer;

const hasText = (text: string): boolean =>
	renderer.root.findAll((node) => (node.type as unknown) === 'Text' && node.props.children === text).length > 0;

const startsWith = (prefix: string): boolean =>
	renderer.root.findAll(
		(node) => (node.type as unknown) === 'Text' && typeof node.props.children === 'string' && node.props.children.startsWith(prefix)
	).length > 0;

const pressable = (label: string): ReactTestInstance | undefined =>
	renderer.root.findAll((node) => typeof node.props.onPress === 'function' && node.props.accessibilityLabel === label)[0];

const press = async (label: string) => {
	const target = pressable(label);
	if (!target) throw new Error(`nada tocável em ${label}`);
	await act(async () => {
		await target.props.onPress();
	});
};

const mount = async () => {
	await act(async () => {
		renderer = create(<AccountEditScreen accountId="captura" />);
	});
};

beforeEach(async () => {
	jest.clearAllMocks();
	await AsyncStorage.clear();
	delete mockParams.setBalance;
	mockAccounts.accounts = [FROM_CAPTURE];
});

afterEach(() => {
	act(() => renderer.unmount());
});

describe('tela da conta criada pela captura', () => {
	it('mostra o aviso no lugar do "Saldo definido em", com o "Dispensar"', async () => {
		await mount();
		expect(hasText('accounts.balanceUnset.badge')).toBe(true);
		expect(hasText('accounts.balanceUnset.body')).toBe(true);
		expect(startsWith('accounts.anchoredOn')).toBe(false);
		expect(pressable('accounts.balanceUnset.dismiss')).toBeDefined();
		expect(pressable('folha-acertar')).toBeUndefined();
	});

	it('vinda do selo, abre já no "Acertar com o banco"', async () => {
		mockParams.setBalance = '1';
		await mount();
		expect(pressable('folha-acertar')).toBeDefined();
	});

	it('"Dispensar" guarda neste aparelho e tira o aviso', async () => {
		await mount();
		await press('accounts.balanceUnset.dismiss');
		expect([...(await getDismissedBalanceUnset())]).toEqual(['captura']);
		expect(hasText('accounts.balanceUnset.badge')).toBe(false);
	});

	it('acertar o saldo com o valor que a tela já mostrava também tira o selo', async () => {
		mockParams.setBalance = '1';
		await mount();
		await press('folha-acertar');
		expect(mockAdjust).toHaveBeenCalledWith('captura', { spentCents: 0, balanceCents: 0 });
		expect([...(await getDismissedBalanceUnset())]).toEqual(['captura']);
	});

	it('conta com saldo definido mostra o "Saldo definido em", sem aviso', async () => {
		mockAccounts.accounts = [{ ...FROM_CAPTURE, openingBalanceCents: 150_000 }];
		await mount();
		expect(hasText('accounts.balanceUnset.badge')).toBe(false);
		expect(startsWith('accounts.anchoredOn')).toBe(true);
	});
});
