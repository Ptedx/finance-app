/**
 * Os títulos das telas de lançamento (E2E-11): "Add Expense", "Edit Transaction"… eram
 * texto fixo em inglês. Agora vêm do bloco `transactionForm` do i18n (chave crua aqui).
 * O formulário em si é um dublê: o que se testa é o título que a tela dá ao cabeçalho.
 */

const mockParams: { current: Record<string, string> } = { current: {} };
const mockTitles: string[] = [];
// O mesmo roteador a cada render, como o de verdade: a tela de edição o tem como dependência.
const mockRouter = { back: jest.fn() };

jest.mock('expo-router', () => ({
	useRouter: () => mockRouter,
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

// A transferência (E2E-28) mora em outra tabela: a edição a busca no banco.
const mockTransferForms: Array<{ initialTransfer?: { id: string } }> = [];
jest.mock('../../components/TransferForm', () => (props: { initialTransfer?: { id: string } }) => {
	mockTransferForms.push(props);
	return null;
});
const mockGetTransfer = jest.fn(async (id: string) =>
	id === 'transf'
		? { id, fromAccountId: 'corrente', toAccountId: 'reserva', amountCents: 100_000, date: '2026-11-07', note: '', updatedAt: 'u1', deletedAt: null }
		: id === 'apagada'
			? { id, fromAccountId: 'corrente', toAccountId: 'reserva', amountCents: 100_000, date: '2026-11-07', note: '', updatedAt: 'u1', deletedAt: 'd1' }
			: null
);
jest.mock('../../database/database', () => ({ getTransfer: (id: string) => mockGetTransfer(id) }));

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

describe('editar uma transferência a partir de Lançamentos (E2E-28)', () => {
	beforeEach(() => {
		mockRouter.back.mockClear();
		mockTransferForms.length = 0;
	});

	const settle = () =>
		act(async () => {
			await Promise.resolve();
		});

	it.each([[{ id: 'transf', kind: 'transfer' }], [{ id: 'transf' }]])('%j abre o formulário de transferência com o título dela', async (params) => {
		await lastTitle(<EditTransactionScreen />, params);
		await settle();
		expect(mockTitles[mockTitles.length - 1]).toBe('transactionForm.transfer.titleEdit');
		expect(mockTransferForms[mockTransferForms.length - 1]?.initialTransfer?.id).toBe('transf');
		expect(mockRouter.back).not.toHaveBeenCalled();
	});

	it.each(['apagada', 'nenhuma'])('transferência %s: volta', async (id) => {
		await lastTitle(<EditTransactionScreen />, { id, kind: 'transfer' });
		await settle();
		expect(mockTransferForms).toHaveLength(0);
		expect(mockRouter.back).toHaveBeenCalled();
	});
});
