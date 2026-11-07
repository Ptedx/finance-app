/**
 * Os títulos das telas de lançamento (E2E-11): "Add Expense", "Edit Transaction"… eram
 * texto fixo em inglês. Agora vêm do bloco `transactionForm` do i18n (chave crua aqui).
 * O formulário em si é um dublê: o que se testa é o título que a tela dá ao cabeçalho.
 */

const mockParams: { current: Record<string, string> } = { current: {} };
const mockTitles: string[] = [];

jest.mock('expo-router', () => ({
	useRouter: () => ({ back: jest.fn() }),
	useLocalSearchParams: () => mockParams.current,
	Stack: {
		Screen: ({ options }: { options: { title: string } }) => {
			mockTitles.push(options.title);
			return null;
		},
	},
}));

jest.mock('react-native-safe-area-context', () => {
	const { View } = require('react-native');
	return { SafeAreaView: View };
});

jest.mock('react-i18next', () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock('../../components/TransactionForm', () => () => null);

// A mesma lista a cada render, como o contexto de verdade: as telas a têm como dependência.
const mockTransactions = [
	{ id: 'despesa', isIncome: false },
	{ id: 'receita', isIncome: true },
];

jest.mock('../../contexts/TransactionsContext', () => ({
	useTransactions: () => ({ transactions: mockTransactions }),
}));

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import EditTransactionScreen from '../../transaction/edit/[id]';
import AddTransactionScreen from '../AddTransactionScreen';

let renderer: ReactTestRenderer | null = null;

const lastTitle = async (element: React.ReactElement, params: Record<string, string>): Promise<string | undefined> => {
	mockParams.current = params;
	mockTitles.length = 0;
	await act(async () => {
		renderer = create(element as Parameters<typeof create>[0]);
	});
	return mockTitles[mockTitles.length - 1];
};

afterEach(() => {
	act(() => renderer?.unmount());
	renderer = null;
});

describe('títulos das telas de lançamento', () => {
	it.each([
		[{}, 'transactionForm.titleAdd'],
		[{ type: 'income' }, 'transactionForm.titleAddIncome'],
		[{ type: 'expense' }, 'transactionForm.titleAddExpense'],
		[{ transactionId: 'despesa' }, 'transactionForm.titleEdit'],
	])('novo lançamento %j', async (params, title) => {
		expect(await lastTitle(<AddTransactionScreen />, params)).toBe(title);
	});

	it.each([
		['despesa', 'transactionForm.titleEditExpense'],
		['receita', 'transactionForm.titleEditIncome'],
	])('edição de %s', async (id, title) => {
		expect(await lastTitle(<EditTransactionScreen />, { id })).toBe(title);
	});
});
