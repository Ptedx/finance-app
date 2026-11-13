/**
 * O detalhe de um lançamento em português: tipo, valor, data, observação e botões vinham
 * fixos em inglês. Agora mostra também a conta, o cartão (pelo nome dado ao final, ou
 * "final 1234") e, se for parcela, "2 de 5". O `t` daqui resolve no português de verdade,
 * então o teste também falha se a chave não existir.
 */

import pt from '../../i18n/locales/pt';

/** `t` mínimo: busca a chave no português e interpola `{{assim}}`, como o i18next. */
const mockT = (key: string, options: Record<string, unknown> = {}): string => {
	const found = key
		.split('.')
		.reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], pt as unknown);
	if (typeof found !== 'string') throw new Error(`chave de tradução ausente: ${key}`);
	return found.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options[name]));
};

// Estáveis entre renders, como no app: o efeito da tela depende deles.
const mockTransactions = [
	{
		id: 'parcela',
		amountCents: 30_000,
		category: 'shopping',
		date: '2026-11-12',
		note: 'Geladeira',
		isIncome: false,
		accountId: 'nubank',
		cardLast4: '1234',
		installmentGroup: 'g-1',
		installmentIndex: 2,
		installmentCount: 5,
	},
	{ id: 'avulsa', amountCents: 5_000, category: 'shopping', date: '2026-11-12', note: '', isIncome: false, accountId: null },
	{ id: 'final', amountCents: 5_000, category: 'shopping', date: '2026-11-12', note: '', isIncome: false, accountId: 'nubank', cardLast4: '9876' },
	{ id: 'removida', amountCents: 5_000, category: 'shopping', date: '2026-11-12', note: '', isIncome: true, accountId: 'apagada' },
];
const mockCategories = [{ id: 'shopping', name: 'Compras', color: '#50E3C2', icon: 'cart', type: 'expense', nature: 'discretionary' }];
const mockAccounts = [{ id: 'nubank', name: 'Nubank', cardNames: JSON.stringify({ '1234': 'Virtual' }) }];
let mockId = 'parcela';

jest.mock('expo-router', () => ({
	Stack: { Screen: () => null },
	useLocalSearchParams: () => ({ id: mockId }),
	useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('react-native-safe-area-context', () => {
	const { View } = require('react-native');
	return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) };
});

jest.mock('react-i18next', () => ({
	useTranslation: () => ({ t: mockT }),
}));

jest.mock('../../contexts/TransactionsContext', () => ({
	useTransactions: () => ({
		transactions: mockTransactions,
		categories: mockCategories,
		removeTransaction: jest.fn(),
		removeInstallmentGroup: jest.fn(),
	}),
}));

jest.mock('../../contexts/AccountsContext', () => ({
	useAccounts: () => ({ accounts: mockAccounts }),
}));

import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import TransactionDetailScreen from '../../transaction/[id]';
import { configureDateLocale } from '../../utils/dateUtils';

jest.setTimeout(20_000);

let renderer: ReactTestRenderer;

const render = async (id: string): Promise<string[]> => {
	mockId = id;
	await act(async () => {
		renderer = create(<TransactionDetailScreen />);
	});
	return renderer.root
		.findAll((node: ReactTestInstance) => (node.type as unknown) === 'Text')
		.map((node) => [node.props.children].flat().join(''));
};

beforeEach(() => {
	configureDateLocale('pt-BR');
});

afterEach(() => {
	act(() => renderer.unmount());
	configureDateLocale('en-US');
});

it('parcela no cartão com nome: tudo em português, com conta, cartão e "2 de 5"', async () => {
	const texts = await render('parcela');
	for (const text of ['Despesa', 'Valor', 'Data', 'Observação', 'Geladeira', 'Conta', 'Nubank', 'Cartão', 'Virtual', 'Parcela', '2 de 5', 'Editar', 'Apagar']) {
		expect(texts).toContain(text);
	}
	for (const english of ['Expense', 'Income', 'Amount', 'Date', 'Note', 'Edit', 'Delete']) {
		expect(texts).not.toContain(english);
	}
});

it('lançamento sem conta diz "Sem conta" e não mostra cartão nem parcela', async () => {
	const texts = await render('avulsa');
	expect(texts).toContain('Sem conta');
	expect(texts).not.toContain('Cartão');
	expect(texts).not.toContain('Parcela');
});

it('cartão sem nome aparece pelo final', async () => {
	const texts = await render('final');
	expect(texts).toContain('final 9876');
});

it('conta apagada e receita', async () => {
	const texts = await render('removida');
	expect(texts).toContain('Conta removida');
	expect(texts).toContain('Receita');
});
