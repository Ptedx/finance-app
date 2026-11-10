/**
 * O painel "Datas" do cartão diz a regra do vencimento que o ciclo usa (SPD-119).
 *
 * Com o dia de vencimento digitado (`dueDay`), a fatura vence todo dia `dueDay` — e o texto diz
 * isso, não "vence N dias depois" (o prazo gravado vale para uma fatura só). Sem o dia, o prazo
 * gravado; sem o dia e sem prazo, o texto não diz prazo nenhum (antes dizia 7, suposto). O
 * resto da tela é dublê; as chaves de tradução aparecem cruas, com os parâmetros.
 */

const mockData: { summaries: Map<string, unknown>; accounts: unknown[]; today: string } = {
	summaries: new Map(),
	accounts: [],
	today: '2027-02-10',
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
jest.mock('../../components/TransactionItem', () => () => null);
jest.mock('../../utils/accountResolver', () => ({ findCheckingForCard: () => null }));

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
	useTransactions: () => ({ transactions: [], categories: [] }),
}));

jest.mock('../../utils/dateUtils', () => ({ ...jest.requireActual('../../utils/dateUtils'), todayISO: () => mockData.today }));

import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { Account } from '../../database/schema';
import { buildCardSummary } from '../../utils/cardMath';
import { formatDayMonth } from '../../utils/dateUtils';
import CardDetailScreen from '../CardDetailScreen';

jest.setTimeout(20_000);

/** Fecha 28 e vence 5, gravado em outubro (prazo de 8 dias na fatura aberta de então). */
const CARD: Account = {
	id: 'card',
	name: 'Cartão Teste',
	kind: 'credit_card',
	role: 'card',
	envelopeMonthlyCents: null,
	bankName: 'Banco XYZ',
	color: '#333333',
	last4: '1111',
	network: null,
	closingDay: 28,
	dueDay: 5,
	closingDaysBefore: 8,
	creditLimitCents: 500_000,
	cardNames: null,
	yieldCdiBp: null,
	reservePurpose: null,
	packageName: null,
	accountKey: null,
	openingBalanceCents: 0,
	openingBalanceDate: '2027-01-31',
	sortOrder: 0,
	archived: false,
	updatedAt: '',
};

let renderer: ReactTestRenderer;

const mount = async (account: Account) => {
	mockData.accounts = [account];
	mockData.summaries = new Map([[account.id, buildCardSummary(account, [], [], mockData.today)]]);
	await act(async () => {
		renderer = create(<CardDetailScreen cardId={account.id} />);
	});
	await act(async () => {
		await Promise.resolve();
	});
};

/** O texto do painel "Datas": a chave e os parâmetros. */
const explain = (): { key: string; params: Record<string, unknown> } => {
	const found = renderer.root
		.findAll((node) => (node.type as unknown) === 'Text')
		.flatMap((node) => node.children.filter((child): child is string => typeof child === 'string'))
		.filter((text) => text.startsWith('cards.dates.explain'));
	expect(found).toHaveLength(1);
	const [key, ...rest] = found[0].split(' ');
	return { key, params: JSON.parse(rest.join(' ')) };
};

const lines = (): string[] =>
	renderer.root
		.findAll(
			(node: ReactTestInstance) =>
				typeof node.type === 'string' &&
				typeof node.props.accessibilityLabel === 'string' &&
				node.props.accessibilityLabel.startsWith('cards.dates.')
		)
		.map((node) => node.props.accessibilityLabel as string);

afterEach(() => {
	act(() => renderer.unmount());
});

describe('painel "Datas" do cartão', () => {
	it('com o dia de vencimento: "vence todo dia 5", e a fatura de fevereiro vence 05/03 (não 08/03)', async () => {
		await mount(CARD);

		expect(explain()).toEqual({
			key: 'cards.dates.explainDueDay',
			params: { day: 28, dueDay: 5, best: formatDayMonth('2027-02-28') },
		});
		expect(lines()).toContain(`cards.dates.due, ${formatDayMonth('2027-03-05')}`);
	});

	it('sem o dia de vencimento: "vence 7 dias depois", o prazo gravado', async () => {
		await mount({ ...CARD, dueDay: null, closingDaysBefore: 7 });

		expect(explain()).toEqual({
			key: 'cards.dates.explain',
			params: { count: 7, day: 28, best: formatDayMonth('2027-02-28') },
		});
		// 28/02 + 7 = 07/03, domingo: segunda, 08/03.
		expect(lines()).toContain(`cards.dates.due, ${formatDayMonth('2027-03-08')}`);
	});

	it('sem o dia e sem prazo gravado: não diz prazo nenhum', async () => {
		await mount({ ...CARD, dueDay: null, closingDaysBefore: null });

		expect(explain()).toEqual({
			key: 'cards.dates.explainClosingOnly',
			params: { day: 28, best: formatDayMonth('2027-02-28') },
		});
	});
});
