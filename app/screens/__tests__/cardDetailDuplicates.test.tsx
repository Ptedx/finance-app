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
const mockData: { transactions: unknown[]; summaries: Map<string, unknown>; accounts: unknown[]; transfers: unknown[] } = {
	transactions: [],
	summaries: new Map(),
	accounts: [],
	transfers: [],
};

jest.mock('@react-native-async-storage/async-storage', () =>
	require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
// O "Não é repetido" grava pela preferência que sobe no sync (SPD-100); aqui, só o AsyncStorage.
jest.mock('../../database/database', () => ({
	setPreference: (key: string, value: string) =>
		require('@react-native-async-storage/async-storage/jest/async-storage-mock').setItem(key, value),
	// Os pagamentos da fatura (SPD-124): as transferências que entram no cartão.
	getAccountTransfers: async () => mockData.transfers,
}));

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
import type { Account, Transaction, Transfer } from '../../database/schema';
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
	mockData.transfers = [];
	return summary;
};

/** Os lançamentos e os pagamentos da fatura: as transferências que entram no cartão. */
const loadWithPayments = (transactions: Transaction[], transfers: Transfer[]) => {
	mockData.accounts = [NUBANK];
	mockData.transactions = transactions;
	const movements = transfers.map((transfer) => ({ amountCents: transfer.amountCents, date: transfer.date, inbound: transfer.toAccountId === 'nubank' }));
	mockData.summaries = new Map([['nubank', buildCardSummary(NUBANK, transactions, movements, '2026-11-07')]]);
	mockData.transfers = transfers;
};

const transfer = (id: string, amountCents: number, date: string, fromAccountId: string | null): Transfer => ({
	id,
	fromAccountId,
	toAccountId: 'nubank',
	amountCents,
	date,
	note: '',
	updatedAt: '',
});

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

/**
 * SPD-124: o "Pagamento recebido" de R$ 1.234,56 em 05/11 duas vezes no Nubank Teste — o do
 * "Pagar fatura" e o do extrato, que juntar os cartões trouxe. O pagamento não é lançamento da
 * lista: os marcados aparecem logo abaixo do aviso, cada um com o par, e abrem a edição da
 * transferência, onde se apaga.
 */
describe('SPD-124 — pagamento de fatura repetido na tela do cartão', () => {
	const PAGOS = [transfer('t-pagar', 123_456, '2026-11-05', 'corrente'), transfer('t-extrato', 123_456, '2026-11-05', null)];
	const paymentLabel = `cards.duplicates.paymentLabel ${JSON.stringify({ date: formatDayMonth('2026-11-05') })}`;

	const mountAndSettle = async () => {
		await mount();
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
	};

	it('os dois pagamentos ficam marcados: o aviso conta 1 e diz que foram pagos R$ 1.234,56 a menos', async () => {
		loadWithPayments([], PAGOS);
		await mountAndSettle();

		const notice = pressablesByLabel('cards.duplicates.notice');
		expect(notice).toHaveLength(1);
		expect(notice[0].props.accessibilityLabel).toContain('cards.duplicates.notice {"count":1}');
		expect(texts()).toContain(`cards.duplicates.noticePayments ${JSON.stringify({ amount: formatCents(123_456) })}`);
		// Nenhuma compra está repetida: o corpo não fala de valor a mais na fatura.
		expect(texts()).toContain('cards.duplicates.noticeBodyPlain');

		const marks = pressablesByLabel('cards.duplicates.notDuplicate').map((node) => node.props.testID).sort();
		expect(marks).toEqual(['notDuplicate:t-extrato', 'notDuplicate:t-pagar']);
		const pairs = texts().filter((text) => text.startsWith('cards.duplicates.pairWith'));
		expect(pairs).toEqual([
			`cards.duplicates.pairWith ${JSON.stringify({ entries: paymentLabel })}`,
			`cards.duplicates.pairWith ${JSON.stringify({ entries: paymentLabel })}`,
		]);
	});

	it('tocar o pagamento marcado abre a edição da transferência, onde se apaga', async () => {
		loadWithPayments([], PAGOS);
		await mountAndSettle();

		const rows = pressablesByLabel(paymentLabel);
		expect(rows).toHaveLength(2);
		expect(rows[0].props.accessibilityLabel).toBe(`${paymentLabel}, ${formatCents(123_456)}`);
		await act(async () => {
			rows[0].props.onPress();
		});
		expect(mockPush).toHaveBeenCalledWith({ pathname: '/transaction/edit/[id]', params: { id: expect.any(String), kind: 'transfer' } });
	});

	it('"não é repetido" no pagamento guarda o par e tira o aviso', async () => {
		loadWithPayments([], PAGOS);
		await mountAndSettle();
		const mark = pressablesByLabel('cards.duplicates.notDuplicate').find((node) => node.props.testID === 'notDuplicate:t-pagar');
		await act(async () => {
			await mark?.props.onPress();
		});

		expect(JSON.parse((await AsyncStorage.getItem(CARD_DUPLICATE_DISMISSED_KEY)) as string)).toEqual([
			accountPairKey('t-pagar', 't-extrato'),
		]);
		expect(pressablesByLabel('cards.duplicates.notice')).toHaveLength(0);
		expect(pressablesByLabel(paymentLabel)).toHaveLength(0);
	});

	it('com a padaria repetida e o pagamento repetido, o aviso conta 2 e cada um fica no seu lugar', async () => {
		loadWithPayments(ACHADO.slice(0, 3), PAGOS);
		await mountAndSettle();

		expect(pressablesByLabel('cards.duplicates.notice')[0].props.accessibilityLabel).toContain('{"count":2}');
		expect(texts()).toContain(`cards.duplicates.noticeBody ${JSON.stringify({ amount: formatCents(5000) })}`);
		expect(pressablesByLabel('cards.duplicates.notDuplicate')).toHaveLength(4);
		const pairs = texts().filter((text) => text.startsWith('cards.duplicates.pairWith'));
		// A padaria aponta para a padaria; o pagamento, para o pagamento.
		expect(pairs.filter((text) => text.includes('PADARIA') || text.includes('Padaria'))).toHaveLength(2);
		expect(pairs.filter((text) => text.includes('paymentLabel'))).toHaveLength(2);
	});

	it('compra de R$ 1.234,56 no dia do pagamento de R$ 1.234,56: nenhum aviso, nenhuma marca', async () => {
		loadWithPayments([tx('notebook', 123_456, '2026-11-05', 'NOTEBOOK')], [PAGOS[0]]);
		await mountAndSettle();
		expect(pressablesByLabel('cards.duplicates.notice')).toHaveLength(0);
		expect(pressablesByLabel('cards.duplicates.notDuplicate')).toHaveLength(0);
	});

	it('estorno de R$ 1.234,56 no dia do pagamento de R$ 1.234,56: nenhum aviso, nenhuma marca', async () => {
		loadWithPayments([{ ...tx('estorno', 123_456, '2026-11-05', 'ESTORNO'), isIncome: true }], [PAGOS[0]]);
		await mountAndSettle();
		expect(pressablesByLabel('cards.duplicates.notice')).toHaveLength(0);
		expect(pressablesByLabel('cards.duplicates.notDuplicate')).toHaveLength(0);
	});

	it('um pagamento só não aparece na lista: o "Pago" da fatura já o mostra', async () => {
		loadWithPayments([], [PAGOS[0]]);
		await mountAndSettle();
		expect(pressablesByLabel(paymentLabel)).toHaveLength(0);
	});
});
