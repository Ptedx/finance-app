/**
 * Apagar uma categoria em uso (E2E-33): com destino, os lançamentos dela vão para a outra
 * categoria **antes** de ela sumir, e nada cai em "Sem categoria"; sem destino, fica como
 * era (o banco move o que sobrar para "Sem categoria"). O banco é mock.
 */

import type { Transaction } from '../../database/schema';

const mockCalls: string[] = [];
const mockUsing: Transaction[] = [];

jest.mock('../../database/database', () => ({
	initDatabase: jest.fn(async () => undefined),
	getCategories: jest.fn(async () => []),
	getTransactions: jest.fn(async () => []),
	getTransactionsByCategory: jest.fn(async () => [...mockUsing]),
	getMonthlyTransactions: jest.fn(async () => []),
	getTransactionsByDateRange: jest.fn(async () => []),
	getPeriodSummary: jest.fn(async () => ({ incomeCents: 0, expenseCents: 0, passThroughCents: 0, netCents: 0 })),
	getBalanceAsOf: jest.fn(async () => 0),
	getTotalByCategory: jest.fn(async () => []),
	addTransaction: jest.fn(async () => 'tx-novo'),
	updateTransaction: jest.fn(async (tx: { id: string; category: string }) => {
		mockCalls.push(`update ${tx.id} -> ${tx.category}`);
	}),
	deleteTransaction: jest.fn(async () => undefined),
	deleteTransactionsInGroup: jest.fn(async () => undefined),
	addCategory: jest.fn(async () => 'cat'),
	updateCategory: jest.fn(async () => undefined),
	deleteCategory: jest.fn(async (id: string) => {
		mockCalls.push(`delete ${id}`);
	}),
}));

jest.mock('../../utils/captureActions', () => ({
	settleBillPayment: jest.fn(async () => null),
	undoBillPayment: jest.fn(async () => undefined),
	resettleBillPayment: jest.fn(async () => null),
}));

jest.mock('../../sync/queue', () => ({ schedule: jest.fn() }));

jest.mock('../../hooks/useAfterPull', () => ({ useAfterPull: jest.fn() }));

// As categorias padrão no idioma do app (SPD-088) têm teste próprio.
jest.mock('../../utils/defaultCategoryNames', () => ({
	localizeDefaultCategories: jest.fn(async () => 0),
}));

jest.mock('../PeriodContext', () => ({
	usePeriod: () => ({ startDate: '2026-11-01', endDate: '2026-11-30' }),
}));

import { act, create } from 'react-test-renderer';
import { updateTransaction } from '../../database/database';
import { TransactionsProvider, useTransactions } from '../TransactionsContext';

type Api = ReturnType<typeof useTransactions>;

const mount = async (): Promise<() => Api> => {
	let latest: Api | null = null;
	const Probe = () => {
		latest = useTransactions();
		return null;
	};
	await act(async () => {
		create(
			<TransactionsProvider>
				<Probe />
			</TransactionsProvider>
		);
	});
	return () => {
		if (!latest) throw new Error('provider não montou');
		return latest;
	};
};

// A compra de R$ 200 em 12/11 do achado, numa conta e com cartão anotado.
const COMPRA: Transaction = {
	id: 'tx-compra',
	amountCents: 20_000,
	category: 'shopping',
	date: '2026-11-12',
	note: '',
	isIncome: false,
	accountId: 'nubank',
	cardLast4: '1234',
	updatedAt: '2026-11-12T15:00:00.000Z',
} as Transaction;

beforeEach(() => {
	mockCalls.length = 0;
	mockUsing.length = 0;
	jest.clearAllMocks();
});

it('com destino, move os lançamentos e só então apaga a categoria', async () => {
	mockUsing.push(COMPRA, { ...COMPRA, id: 'tx-outra', amountCents: 5_000 });
	const api = await mount();
	await act(async () => {
		await api().deleteCategory('shopping', 'food');
	});
	expect(mockCalls).toEqual(['update tx-compra -> food', 'update tx-outra -> food', 'delete shopping']);
	// O resto do lançamento continua igual: valor, data, conta e cartão.
	expect(updateTransaction).toHaveBeenCalledWith(expect.objectContaining({ id: 'tx-compra', amountCents: 20_000, date: '2026-11-12', accountId: 'nubank', cardLast4: '1234', category: 'food' }));
});

it('sem destino, só apaga (como antes)', async () => {
	mockUsing.push(COMPRA);
	const api = await mount();
	await act(async () => {
		await api().deleteCategory('shopping');
	});
	expect(mockCalls).toEqual(['delete shopping']);
});

it('se mover falhar, a categoria não é apagada', async () => {
	mockUsing.push(COMPRA);
	(updateTransaction as jest.Mock).mockRejectedValueOnce(new Error('disco cheio'));
	const api = await mount();
	await act(async () => {
		await expect(api().deleteCategory('shopping', 'food')).rejects.toThrow('disco cheio');
	});
	expect(mockCalls).not.toContain('delete shopping');
});
