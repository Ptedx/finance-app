/**
 * A linha "Falta pagar" no painel da fatura (SPD-108).
 *
 * O painel mostra o valor da fatura e as linhas que mexem nele — saldo anterior, valor
 * informado, pago ou antecipado —, mas não o resultado: quanto ainda falta pagar. O número
 * tem de ser o do lembrete e da tela inicial (`invoiceDueCents`; na fechada, o "a pagar"
 * do resumo). O Nubank Teste foi cadastrado em 07/11 com a fatura de novembro em
 * R$ 1.234,56 (âncora no fim de 06/11); depois entraram R$ 400 em compras de 07/11 e o
 * "Pagamento recebido" de R$ 1.234,56 de 05/11, que já está no valor informado (E2E-38,
 * E2E-41). O resto da tela é dublê; as chaves de tradução aparecem cruas.
 */

const mockData: { transactions: unknown[]; summaries: Map<string, unknown>; accounts: unknown[]; today: string } = {
	transactions: [],
	summaries: new Map(),
	accounts: [],
	today: '2026-11-07',
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

jest.mock('../../utils/dateUtils', () => ({ ...jest.requireActual('../../utils/dateUtils'), todayISO: () => mockData.today }));

import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { Account, Transaction } from '../../database/schema';
import { cardInvoicesDue } from '../../utils/billReminders';
import { buildCardSummary, type CardMovement, type CardSummary } from '../../utils/cardMath';
import { formatMonthLong } from '../../utils/dateUtils';
import { formatCents } from '../../utils/money';
import CardDetailScreen from '../CardDetailScreen';

jest.setTimeout(20_000);

/** Fecha dia 10, vence 7 dias depois: em 07/11 a aberta é a de novembro (vence 17/11). */
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

/** Fecha dia 5, vence 7 dias depois: em 07/11 a de novembro (vence 12/11) já fechou. */
const INTER: Account = { ...NUBANK, id: 'inter', name: 'Inter Teste', closingDay: 5, openingBalanceCents: -200_000, openingBalanceDate: '2026-11-04' };

const tx = (id: string, amountCents: number, date: string, accountId = 'nubank'): Transaction => ({
	id,
	amountCents,
	category: 'food',
	date,
	note: id,
	isIncome: false,
	accountId,
	installmentGroup: null,
	installmentIndex: null,
	installmentCount: null,
	cardLast4: null,
	updatedAt: '',
});

const PURCHASES = [tx('mercado', 10_000, '2026-11-07'), tx('notebook', 30_000, '2026-11-07')];
const payment = (date: string, amountCents: number): CardMovement => ({ date, amountCents, inbound: true });

const load = (account: Account, transactions: Transaction[], movements: CardMovement[], today: string): CardSummary => {
	mockData.today = today;
	mockData.accounts = [account];
	mockData.transactions = transactions;
	const summary = buildCardSummary(account, transactions, movements, today);
	mockData.summaries = new Map([[account.id, summary]]);
	return summary;
};

/** O que o lembrete anunciaria para a fatura `key` (`cardReminders` usa `cardInvoicesDue`). */
const reminderOf = (summary: CardSummary, key: string): number | undefined =>
	cardInvoicesDue(summary).find((due) => due.invoice === key)?.amountCents;

let renderer: ReactTestRenderer;

const mount = async (cardId: string) => {
	await act(async () => {
		renderer = create(<CardDetailScreen cardId={cardId} />);
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

/** Toca na aba da fatura que vence no mês `key`. */
const selectInvoice = async (key: string) => {
	const prefix = `cards.invoice.of ${JSON.stringify({ month: formatMonthLong(`${key}-01`) })}`;
	const tab = renderer.root.find(
		(node: ReactTestInstance) =>
			typeof node.props.onPress === 'function' &&
			node.props.accessibilityRole === 'tab' &&
			typeof node.props.accessibilityLabel === 'string' &&
			node.props.accessibilityLabel.startsWith(prefix)
	);
	await act(async () => {
		tab.props.onPress();
	});
};

const LEFT = 'cards.invoice.leftToPay';
/** A linha "Paga" — e não o "Pago R$ X" do pagamento (`paidRow`). */
const paidLines = (): string[] => labels('cards.invoice.paid').filter((label) => label === 'cards.invoice.paid');

afterEach(() => {
	act(() => renderer.unmount());
});

describe('"Falta pagar" na fatura aberta: o mesmo número do lembrete', () => {
	it('valor informado R$ 1.234,56, compras R$ 400 e o pagamento de 05/11 já no valor: falta pagar R$ 1.634,56', async () => {
		const summary = load(NUBANK, PURCHASES, [payment('2026-11-05', 123_456)], '2026-11-07');
		expect(reminderOf(summary, '2026-11')).toBe(163_456);
		await mount('nubank');

		expect(labels(LEFT)).toEqual([`${LEFT}, ${formatCents(163_456)}`]);
		expect(texts()).toContain(LEFT);
	});

	it('pagamento de R$ 1.000 em 08/11, depois da fatura informada: falta pagar R$ 634,56', async () => {
		const summary = load(NUBANK, PURCHASES, [payment('2026-11-05', 123_456), payment('2026-11-08', 100_000)], '2026-11-08');
		expect(reminderOf(summary, '2026-11')).toBe(63_456);
		await mount('nubank');

		expect(labels('cards.invoice.advance')).toEqual([`cards.invoice.advance, ${formatCents(100_000)}`]);
		expect(labels(LEFT)).toEqual([`${LEFT}, ${formatCents(63_456)}`]);
	});

	it('só compras, sem pagamento, valor informado nem saldo anterior: a linha não repete o valor da fatura', async () => {
		load({ ...NUBANK, openingBalanceCents: 0 }, PURCHASES, [], '2026-11-07');
		await mount('nubank');

		expect(texts()).toContain(formatCents(40_000));
		expect(labels(LEFT)).toEqual([]);
	});

	it('antecipado cobre a fatura inteira: diz "Paga" em vez de "Falta pagar R$ 0,00"', async () => {
		const summary = load({ ...NUBANK, openingBalanceCents: 0 }, PURCHASES, [payment('2026-11-08', 40_000)], '2026-11-08');
		expect(reminderOf(summary, '2026-11')).toBeUndefined();
		await mount('nubank');

		expect(labels(LEFT)).toEqual([]);
		expect(labels('cards.invoice.advance')).toEqual([`cards.invoice.advance, ${formatCents(40_000)}`]);
		expect(paidLines()).toEqual(['cards.invoice.paid']);
	});
});

describe('"Falta pagar" na fatura fechada: o "a pagar" do resumo', () => {
	// Inter informado em 04/11 com R$ 2.000; o pagamento de 03/11 já está no valor, o de 06/11 abate.
	it('valor informado R$ 2.000 e pagamento de R$ 500 em 06/11: falta pagar R$ 1.500', async () => {
		const summary = load(INTER, [], [payment('2026-11-03', 200_000), payment('2026-11-06', 50_000)], '2026-11-07');
		expect(summary.toPayCents).toBe(150_000);
		expect(reminderOf(summary, '2026-11')).toBe(150_000);
		await mount('inter');
		await selectInvoice('2026-11');

		expect(labels('cards.invoice.paidRow')).toEqual([`cards.invoice.paidRow, ${formatCents(50_000)}`]);
		expect(labels(LEFT)).toEqual([`${LEFT}, ${formatCents(150_000)}`]);
	});

	it('paga inteira: o status já diz "Paga", sem linha a mais', async () => {
		load(INTER, [], [payment('2026-11-06', 200_000)], '2026-11-07');
		await mount('inter');
		await selectInvoice('2026-11');

		expect(texts()).toContain('cards.invoice.paid');
		expect(labels(LEFT)).toEqual([]);
		expect(paidLines()).toEqual([]);
	});
});

describe('pagamento depois da âncora e antes do fechamento, com a anterior zerada (SPD-120)', () => {
	// Fecha dia 10 e vence dia 17; informado em 01/11 com R$ 0. R$ 300 de compras em 03/11 e
	// 04/11 (fatura de novembro) e o pagamento de 05/11, na janela da de outubro, que é zero.
	const AFTER_ANCHOR: Account = { ...NUBANK, dueDay: 17, openingBalanceCents: 0, openingBalanceDate: '2026-11-01' };
	const NOVEMBER = [tx('mercado', 10_000, '2026-11-03'), tx('farmacia', 20_000, '2026-11-04')];

	it('paga em parte: a fechada mostra "Pago R$ 200" e falta pagar R$ 100, o número do lembrete', async () => {
		const summary = load(AFTER_ANCHOR, NOVEMBER, [payment('2026-11-05', 20_000)], '2026-11-12');
		expect(reminderOf(summary, '2026-11')).toBe(10_000);
		await mount('nubank');
		await selectInvoice('2026-11');

		expect(labels('cards.invoice.paidRow')).toEqual([`cards.invoice.paidRow, ${formatCents(20_000)}`]);
		expect(labels(LEFT)).toEqual([`${LEFT}, ${formatCents(10_000)}`]);
	});

	it('paga inteira: a fechada diz "Paga" e mostra o pagamento', async () => {
		const summary = load(AFTER_ANCHOR, NOVEMBER, [payment('2026-11-05', 30_000)], '2026-11-12');
		expect(reminderOf(summary, '2026-11')).toBeUndefined();
		await mount('nubank');
		await selectInvoice('2026-11');

		expect(texts()).toContain('cards.invoice.paid');
		expect(labels('cards.invoice.paidRow')).toEqual([`cards.invoice.paidRow, ${formatCents(30_000)}`]);
		expect(labels(LEFT)).toEqual([]);
	});
});
