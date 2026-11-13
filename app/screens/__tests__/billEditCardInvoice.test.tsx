/**
 * Aviso ao cadastrar a fatura do cartão como conta a pagar (SPD-137).
 *
 * "Fatura Nubank" em Contas a pagar soma no custo fixo junto com as parcelas do cartão — conta
 * em dobro — e o app já avisa o vencimento da fatura dos cartões cadastrados. A tela avisa,
 * perto do nome, quando ele parece fatura de cartão; não impede de salvar. O resto da tela é
 * dublê; as chaves de tradução aparecem cruas.
 */

const mockCreateBill = jest.fn(async () => undefined);
const mockAccounts: { accounts: unknown[] } = { accounts: [] };

jest.mock('expo-router', () => ({
	useRouter: () => ({ replace: jest.fn(), back: jest.fn(), push: jest.fn() }),
	// SPD-142: o cadastro de conta a pagar ouve o voltar do Android só em foco.
	useFocusEffect: () => undefined,
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

jest.mock('../../contexts/AccountsContext', () => ({
	useAccounts: () => ({ accounts: mockAccounts.accounts, bankAccounts: [] }),
}));

jest.mock('../../contexts/BillsContext', () => ({
	useBills: () => ({ bills: [], createBill: mockCreateBill, saveBill: jest.fn(), setBillActive: jest.fn(), removeBill: jest.fn() }),
}));

jest.mock('../../contexts/TransactionsContext', () => ({
	useTransactions: () => ({ transactions: [], categories: [] }),
}));

jest.mock('../../utils/dateUtils', () => ({ ...jest.requireActual('../../utils/dateUtils'), todayISO: () => '2026-11-07' }));

import { AccessibilityInfo, TextInput } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { Account } from '../../database/schema';
import BillEditScreen from '../BillEditScreen';

jest.setTimeout(20_000);
jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);

const account = (id: string, name: string, kind: Account['kind'], bankName: string): Account => ({
	id,
	name,
	kind,
	role: kind === 'credit_card' ? 'card' : 'main',
	envelopeMonthlyCents: null,
	bankName,
	color: '#820AD1',
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
});

let renderer: ReactTestRenderer;

const mount = async () => {
	await act(async () => {
		renderer = create(<BillEditScreen />);
	});
};

const typeInto = async (label: string, text: string) => {
	const field = renderer.root.find((node) => (node.type as unknown) === TextInput && node.props.accessibilityLabel === label);
	await act(async () => {
		field.props.onChangeText(text);
	});
};

const texts = (): string[] =>
	renderer.root.findAll((node: ReactTestInstance) => (node.type as unknown) === 'Text').map((node) => [node.props.children].flat().join(''));

const warned = () => texts().includes('bills.edit.cardInvoiceWarning');

beforeEach(() => {
	mockCreateBill.mockClear();
	// Um cartão cadastrado (Roxinho, do Nubank) e a corrente de outro banco.
	mockAccounts.accounts = [account('roxinho', 'Roxinho', 'credit_card', 'Nubank'), account('corrente', 'Corrente Teste', 'checking', 'Banco Teste')];
});

afterEach(() => {
	act(() => renderer.unmount());
});

describe('SPD-137 — conta a pagar que parece fatura de cartão', () => {
	it('"Fatura Nubank" avisa perto do nome; "Internet" não', async () => {
		await mount();
		expect(warned()).toBe(false);

		await typeInto('bills.edit.name', 'Fatura Nubank');
		expect(warned()).toBe(true);

		await typeInto('bills.edit.name', 'Internet');
		expect(warned()).toBe(false);
	});

	it('o nome ou o banco de um cartão cadastrado também avisa; "Cartório" e "Escola" não', async () => {
		await mount();
		await typeInto('bills.edit.name', 'Roxinho');
		expect(warned()).toBe(true);
		await typeInto('bills.edit.name', 'Nubank');
		expect(warned()).toBe(true);
		await typeInto('bills.edit.name', 'Cartório');
		expect(warned()).toBe(false);
		await typeInto('bills.edit.name', 'Escola');
		expect(warned()).toBe(false);
	});

	it('o nome do banco de uma conta que não é cartão não avisa', async () => {
		await mount();
		await typeInto('bills.edit.name', 'Banco Teste');
		expect(warned()).toBe(false);
	});

	it('o aviso não impede de salvar', async () => {
		await mount();
		await typeInto('bills.edit.name', 'Cartão de crédito do Itaú');
		await typeInto('bills.edit.dueDay', '15');
		expect(warned()).toBe(true);

		const save = renderer.root.find((node) => typeof node.props.onPress === 'function' && node.props.accessibilityLabel === 'bills.edit.save');
		await act(async () => {
			await save.props.onPress();
		});
		expect(mockCreateBill).toHaveBeenCalledTimes(1);
		expect(mockCreateBill).toHaveBeenCalledWith(expect.objectContaining({ name: 'Cartão de crédito do Itaú', dueDay: 15 }), false);
	});
});
