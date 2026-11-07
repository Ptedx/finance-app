/**
 * "Provável repetido" na tela do cartão (E2E-34, SPD-098).
 *
 * O Nubank Teste ficou com a padaria e o mercado duas vezes (à mão e do extrato): a fatura
 * dá R$ 345,90 e o banco diz R$ 195,90. A tela avisa quantos lançamentos podem estar
 * repetidos na fatura aberta, marca cada um com o provável par e deixa o dono dizer "não é
 * repetido". Nada é apagado aqui: o lançamento abre e se apaga pela tela dele. O resto da
 * tela é dublê; as chaves de tradução aparecem cruas.
 */

const mockPush = jest.fn();
const mockData: { transactions: unknown[]; summaries: Map<string, unknown>; accounts: unknown[] } = {
	transactions: [],
	summaries: new Map(),
	accounts: [],
};

jest.mock('@react-native-async-storage/async-storage', () =>
	require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

jest.mock('expo-router', () => ({
	useRouter: () => ({ replace: jest.fn(), back: jest.fn(), push: mockPush }),
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

// O item da lista vira um botão com o id: é o que se toca para abrir o lançamento.
jest.mock('../../components/TransactionItem', () => {
	const { Pressable, Text } = require('react-native');
	return ({ transaction, onPress }: { transaction: { id: string; note: string }; onPress: (tx: unknown) => void }) => (
		<Pressable accessibilityLabel={`item:${transaction.id}`} onPress={() => onPress(transaction)}>
			<Text>{transaction.note}</Text>
		</Pressable>
	);
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

import AsyncStorage from '@react-native-async-storage/async-storage';
import { AccessibilityInfo } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { Account, Transaction } from '../../database/schema';
import { accountPairKey } from '../../utils/accountBinding';
import { CARD_DUPLICATE_DISMISSED_KEY } from '../../utils/cardDuplicateDismissals';
import { buildCardSummary } from '../../utils/cardMath';
import { formatDayMonth } from '../../utils/dateUtils';
import { formatCents } from '../../utils/money';
import CardDetailScreen from '../CardDetailScreen';

jest.setTimeout(20_000);
jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);

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
	closingDay: 25,
	dueDay: null,
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
};

const tx = (id: string, amountCents: number, date: string, note: string, cardLast4: string | null = null): Transaction => ({
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
	cardLast4,
	updatedAt: '',
});

const ACHADO = [
	tx('m-padaria', 5000, '2026-11-01', 'Padaria'),
	tx('x-padaria', 5000, '2026-11-01', 'PADARIA', '1111'),
	tx('x-drogasil', 4590, '2026-11-06', 'DROGASIL', '1111'),
	tx('m-mercado', 10_000, '2026-11-07', 'Mercado'),
	tx('x-mercado', 10_000, '2026-11-08', 'SUPERMERCADO', '1111'),
];

const load = (transactions: Transaction[]) => {
	mockData.accounts = [NUBANK];
	mockData.transactions = transactions;
	const summary = buildCardSummary(NUBANK, transactions, [], '2026-11-07');
	mockData.summaries = new Map([['nubank', summary]]);
	return summary;
};

let renderer: ReactTestRenderer;

const mount = async () => {
	await act(async () => {
		renderer = create(<CardDetailScreen cardId="nubank" />);
	});
	// A leitura do "não é repetido" guardado é assíncrona.
	await act(async () => {
		await Promise.resolve();
	});
};

const byLabel = (prefix: string): ReactTestInstance[] =>
	renderer.root.findAll(
		(node) =>
			typeof node.type === 'string' &&
			typeof node.props.accessibilityLabel === 'string' &&
			node.props.accessibilityLabel.startsWith(prefix)
	);

const pressablesByLabel = (prefix: string): ReactTestInstance[] =>
	renderer.root.findAll(
		(node) =>
			typeof node.props.onPress === 'function' &&
			typeof node.props.accessibilityLabel === 'string' &&
			node.props.accessibilityLabel.startsWith(prefix)
	);

const texts = (): string[] =>
	renderer.root.findAll((node) => (node.type as unknown) === 'Text').flatMap((node) =>
		node.children.filter((child): child is string => typeof child === 'string')
	);

const listed = () => byLabel('item:').map((node) => node.props.accessibilityLabel as string);

beforeEach(async () => {
	jest.clearAllMocks();
	await AsyncStorage.clear();
});

afterEach(() => {
	act(() => renderer.unmount());
});

describe('E2E-34 — provável repetido na tela do cartão', () => {
	it('a fatura de R$ 345,90 avisa que 2 lançamentos podem estar repetidos, com R$ 150,00 a mais', async () => {
		const summary = load(ACHADO);
		expect(summary.openInvoiceCents).toBe(34_590);
		await mount();

		const notice = pressablesByLabel('cards.duplicates.notice');
		expect(notice).toHaveLength(1);
		expect(notice[0].props.accessibilityLabel).toContain('cards.duplicates.notice {"count":2}');
		expect(texts()).toContain(`cards.duplicates.noticeBody ${JSON.stringify({ amount: formatCents(15_000) })}`);
	});

	it('cada lançamento marcado diz com qual pode ser o mesmo; a drogaria não é marcada', async () => {
		load(ACHADO);
		await mount();

		const marks = pressablesByLabel('cards.duplicates.notDuplicate');
		expect(marks).toHaveLength(4);
		const pairs = texts().filter((text) => text.startsWith('cards.duplicates.pairWith'));
		expect(pairs).toHaveLength(4);
		// A padaria de à mão aponta para a do extrato, no mesmo dia.
		expect(pairs).toContain(`cards.duplicates.pairWith ${JSON.stringify({ entries: `PADARIA, ${formatDayMonth('2026-11-01')}` })}`);
		expect(pairs).toContain(`cards.duplicates.pairWith ${JSON.stringify({ entries: `Mercado, ${formatDayMonth('2026-11-07')}` })}`);
		expect(pairs.some((text) => text.includes('DROGASIL'))).toBe(false);
	});

	it('tocar o lançamento marcado abre a tela dele, onde se apaga', async () => {
		load(ACHADO);
		await mount();
		await act(async () => {
			pressablesByLabel('item:x-padaria')[0].props.onPress();
		});
		expect(mockPush).toHaveBeenCalledWith({ pathname: '/transaction/[id]', params: { id: 'x-padaria' } });
	});

	it('o aviso leva aos lançamentos: mostra só os marcados, e tocar de novo mostra todos', async () => {
		load(ACHADO);
		await mount();
		expect(listed()).toHaveLength(5);

		await act(async () => {
			pressablesByLabel('cards.duplicates.notice')[0].props.onPress();
		});
		expect(listed().sort()).toEqual(['item:m-mercado', 'item:m-padaria', 'item:x-mercado', 'item:x-padaria']);

		await act(async () => {
			pressablesByLabel('cards.duplicates.notice')[0].props.onPress();
		});
		expect(listed()).toHaveLength(5);
	});

	it('mercado em 07/11 e 09/11, padaria só uma: nenhum aviso, nenhuma marca', async () => {
		load([
			tx('m-padaria', 5000, '2026-11-01', 'Padaria'),
			tx('m-mercado', 10_000, '2026-11-07', 'Mercado'),
			tx('x-mercado', 10_000, '2026-11-09', 'SUPERMERCADO', '1111'),
		]);
		await mount();
		expect(pressablesByLabel('cards.duplicates.notice')).toHaveLength(0);
		expect(pressablesByLabel('cards.duplicates.notDuplicate')).toHaveLength(0);
	});

	it('"não é repetido" na padaria tira o par, guarda neste aparelho e o aviso cai para 1', async () => {
		load(ACHADO);
		await mount();
		const padaria = pressablesByLabel('cards.duplicates.notDuplicate').find((node) => node.props.testID === 'notDuplicate:m-padaria');
		expect(padaria).toBeDefined();
		await act(async () => {
			await padaria?.props.onPress();
		});

		expect(JSON.parse((await AsyncStorage.getItem(CARD_DUPLICATE_DISMISSED_KEY)) as string)).toEqual([
			accountPairKey('m-padaria', 'x-padaria'),
		]);
		expect(pressablesByLabel('cards.duplicates.notice')[0].props.accessibilityLabel).toContain('{"count":1}');
		expect(pressablesByLabel('cards.duplicates.notDuplicate')).toHaveLength(2);
	});

	it('o par já dispensado não volta ao abrir a tela', async () => {
		await AsyncStorage.setItem(CARD_DUPLICATE_DISMISSED_KEY, JSON.stringify([accountPairKey('m-mercado', 'x-mercado')]));
		load(ACHADO);
		await mount();
		expect(pressablesByLabel('cards.duplicates.notice')[0].props.accessibilityLabel).toContain('{"count":1}');
		expect(texts()).toContain(`cards.duplicates.noticeBody ${JSON.stringify({ amount: formatCents(5000) })}`);
	});
});
