/**
 * Pagamento de antes da fatura informada na tela do cartão (E2E-38, SPD-102).
 *
 * O Nubank Teste foi cadastrado em 07/11 com a fatura de novembro em R$ 1.234,56 (âncora no
 * fim de 06/11). O "Pagamento recebido" de R$ 1.234,56 de 05/11 veio do extrato: já está no
 * valor informado e não abate a fatura — a tela dizia "Pagamento antecipado". Agora ele
 * aparece junto das compras de antes. O resto da tela é dublê; as chaves de tradução
 * aparecem cruas.
 */

const mockData: { transactions: unknown[]; summaries: Map<string, unknown>; accounts: unknown[] } = {
	transactions: [],
	summaries: new Map(),
	accounts: [],
};

jest.mock('@react-native-async-storage/async-storage', () =>
	require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('../../database/database', () => ({
	setPreference: (key: string, value: string) =>
		require('@react-native-async-storage/async-storage/jest/async-storage-mock').setItem(key, value),
}));

jest.mock('expo-router', () => ({
	useRouter: () => ({ replace: jest.fn(), back: jest.fn(), push: jest.fn() }),
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
jest.mock('../../components/cards/RenameCardSheet', () => () => null);
jest.mock('../../components/cards/Sheet', () => () => null);
jest.mock('../../components/HorizontalCategoryPicker', () => () => null);
jest.mock('../../utils/accountResolver', () => ({ findCheckingForCard: () => null }));

jest.mock('../../components/TransactionItem', () => {
	const { Text } = require('react-native');
	return ({ transaction }: { transaction: { id: string; note: string } }) => <Text>{`item:${transaction.id}`}</Text>;
});

jest.mock('../../contexts/AccountsContext', () => ({
	useAccounts: () => ({
		accounts: mockData.accounts,
		bankAccounts: [],
		cardSummaries: mockData.summaries,
		recordCardPayment: jest.fn(),
		adjustCardInvoices: jest.fn(),
		addCardCharge: jest.fn(),
		addExistingInstallments: jest.fn(),
		renameCard: jest.fn(),
	}),
}));

jest.mock('../../contexts/TransactionsContext', () => ({
	useTransactions: () => ({ transactions: mockData.transactions, categories: [] }),
}));

jest.mock('../../utils/dateUtils', () => ({ ...jest.requireActual('../../utils/dateUtils'), todayISO: () => '2026-11-07' }));

import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { Account, Transaction } from '../../database/schema';
import { buildCardSummary, type CardMovement } from '../../utils/cardMath';
import { formatDayMonth } from '../../utils/dateUtils';
import { formatCents } from '../../utils/money';
import CardDetailScreen from '../CardDetailScreen';

jest.setTimeout(20_000);

const NUBANK: Account = {
	id: 'nubank',
	name: 'Nubank Teste',
	kind: 'credit_card',
	role: 'card',
	envelopeMonthlyCents: null,
	bankName: 'Nubank',
	color: '#820AD1',
	last4: '1111',
	network: null,
	closingDay: 10,
	dueDay: null,
	closingDaysBefore: 7,
	creditLimitCents: 500_000,
	cardNames: null,
	yieldCdiBp: null,
	reservePurpose: null,
	packageName: null,
	accountKey: null,
	openingBalanceCents: -123_456,
	openingBalanceDate: '2026-11-06',
	sortOrder: 0,
	archived: false,
	updatedAt: '',
};

const tx = (id: string, amountCents: number, date: string, note: string): Transaction => ({
	id,
	amountCents,
	category: 'food',
	date,
	note,
	isIncome: false,
	accountId: 'nubank',
	installmentGroup: null,
	installmentIndex: null,
	installmentCount: null,
	cardLast4: null,
	updatedAt: '',
});

const PURCHASES = [tx('mercado', 10_000, '2026-11-07', 'Mercado'), tx('notebook', 30_000, '2026-11-07', 'Notebook (2/5)')];
const payment = (date: string, amountCents: number): CardMovement => ({ date, amountCents, inbound: true });

const load = (movements: CardMovement[]) => {
	mockData.accounts = [NUBANK];
	mockData.transactions = PURCHASES;
	const summary = buildCardSummary(NUBANK, PURCHASES, movements, '2026-11-07');
	mockData.summaries = new Map([['nubank', summary]]);
	return summary;
};

let renderer: ReactTestRenderer;

const mount = async () => {
	await act(async () => {
		renderer = create(<CardDetailScreen cardId="nubank" />);
	});
	await act(async () => {
		await Promise.resolve();
	});
};

const labels = (prefix: string): string[] =>
	renderer.root
		.findAll(
			(node: ReactTestInstance) =>
				typeof node.type === 'string' &&
				typeof node.props.accessibilityLabel === 'string' &&
				node.props.accessibilityLabel.startsWith(prefix)
		)
		.map((node) => node.props.accessibilityLabel as string);

const texts = (): string[] =>
	renderer.root.findAll((node) => (node.type as unknown) === 'Text').flatMap((node) =>
		node.children.filter((child): child is string => typeof child === 'string')
	);

afterEach(() => {
	act(() => renderer.unmount());
});

describe('E2E-38 — pagamento de antes da fatura informada', () => {
	it('o pagamento de 05/11 aparece como já no valor informado, não como pagamento antecipado', async () => {
		const summary = load([payment('2026-11-05', 123_456)]);
		expect(summary.openInvoiceCents).toBe(163_456);
		await mount();

		expect(labels('cards.invoice.advance')).toEqual([]);
		expect(texts()).not.toContain('cards.invoice.advance');
		const covered = `cards.invoice.paymentCovered ${JSON.stringify({ date: formatDayMonth('2026-11-05') })}`;
		expect(texts()).toContain(covered);
		expect(labels(covered)).toEqual([`${covered}, ${formatCents(123_456)}`]);
		// As compras de 07/11 continuam na fatura, que soma R$ 1.634,56.
		expect(texts()).toEqual(expect.arrayContaining(['item:mercado', 'item:notebook', formatCents(163_456)]));
	});

	it('o pagamento do dia do cadastro abate: é pagamento antecipado, e o de 05/11 continua à parte', async () => {
		load([payment('2026-11-05', 123_456), payment('2026-11-07', 100_000)]);
		await mount();

		expect(labels('cards.invoice.advance')).toEqual([`cards.invoice.advance, ${formatCents(100_000)}`]);
		expect(texts()).toContain(`cards.invoice.paymentCovered ${JSON.stringify({ date: formatDayMonth('2026-11-05') })}`);
	});

	it('cartão cadastrado sem fatura: o pagamento de antes do início não entra nesta fatura', async () => {
		const zero = { ...NUBANK, openingBalanceCents: 0 };
		mockData.accounts = [zero];
		mockData.transactions = PURCHASES;
		mockData.summaries = new Map([['nubank', buildCardSummary(zero, PURCHASES, [payment('2026-11-05', 50_000)], '2026-11-07')]]);
		await mount();

		expect(labels('cards.invoice.advance')).toEqual([]);
		expect(texts()).toContain(`cards.invoice.paymentBeforeStart ${JSON.stringify({ date: formatDayMonth('2026-11-05') })}`);
	});
});
