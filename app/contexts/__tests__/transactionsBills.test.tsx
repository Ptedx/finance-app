/**
 * Lançamento digitado e conta a pagar (REM-04): a despesa lançada à mão que é o pagamento
 * de uma conta dá baixa nela, e apagar esse lançamento desfaz a baixa.
 *
 * O casamento e a gravação moram em `captureActions` (testados lá); aqui o que importa é a
 * ligação: o provider chama a baixa com o lançamento certo, só para despesa à vista, e o
 * desfazer com a data do lançamento apagado. O banco é mock.
 */

import type { Transaction } from '../../database/schema';

const mockStored: Transaction[] = [];

jest.mock('../../database/database', () => ({
	initDatabase: jest.fn(async () => undefined),
	getCategories: jest.fn(async () => []),
	getTransactions: jest.fn(async () => [...mockStored]),
	getMonthlyTransactions: jest.fn(async () => []),
	getTransactionsByDateRange: jest.fn(async () => []),
	getPeriodSummary: jest.fn(async () => ({ incomeCents: 0, expenseCents: 0, passThroughCents: 0, netCents: 0 })),
	getBalanceAsOf: jest.fn(async () => 0),
	getTotalByCategory: jest.fn(async () => []),
	addTransaction: jest.fn(async () => 'tx-novo'),
	updateTransaction: jest.fn(async () => undefined),
	deleteTransaction: jest.fn(async () => undefined),
	deleteTransactionsInGroup: jest.fn(async () => undefined),
	addCategory: jest.fn(async () => 'cat'),
	updateCategory: jest.fn(async () => undefined),
	deleteCategory: jest.fn(async () => undefined),
}));

jest.mock('../../utils/captureActions', () => ({
	settleBillPayment: jest.fn(async () => null),
	undoBillPayment: jest.fn(async () => undefined),
	resettleBillPayment: jest.fn(async () => null),
}));

jest.mock('../../sync/queue', () => ({ schedule: jest.fn() }));

jest.mock('../../hooks/useAfterPull', () => ({ useAfterPull: jest.fn() }));

jest.mock('../PeriodContext', () => ({
	usePeriod: () => ({ startDate: '2026-10-01', endDate: '2026-10-31' }),
}));

import { act, create } from 'react-test-renderer';
import { deleteTransaction, updateTransaction } from '../../database/database';
import { resettleBillPayment, settleBillPayment, undoBillPayment } from '../../utils/captureActions';
import { TransactionsProvider, useTransactions } from '../TransactionsContext';

type Api = ReturnType<typeof useTransactions>;

/** Monta o provider e devolve o valor do contexto, relido a cada render. */
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

const TIM_PAYMENT = {
	amountCents: 13_517,
	category: 'bills',
	date: '2026-10-14',
	note: 'TIM celular',
	isIncome: false,
	accountId: 'nubank',
};

beforeEach(() => {
	mockStored.length = 0;
	jest.clearAllMocks();
});

describe('lançar uma despesa', () => {
	it('procura a conta a pagar que ela paga, com o id e o texto do lançamento', async () => {
		const api = await mount();

		await act(async () => {
			await api().addNewTransaction(TIM_PAYMENT);
		});

		expect(settleBillPayment).toHaveBeenCalledTimes(1);
		expect(settleBillPayment).toHaveBeenCalledWith({
			id: 'tx-novo',
			amountCents: 13_517,
			date: '2026-10-14',
			accountId: 'nubank',
			text: 'TIM celular',
			isExpense: true,
		});
	});

	it('sem conta de origem, vai como conta nenhuma', async () => {
		const api = await mount();

		await act(async () => {
			await api().addNewTransaction({ ...TIM_PAYMENT, accountId: undefined });
		});

		expect(settleBillPayment).toHaveBeenCalledWith(expect.objectContaining({ accountId: null }));
	});

	it('receita não procura conta a pagar', async () => {
		const api = await mount();

		await act(async () => {
			await api().addNewTransaction({ ...TIM_PAYMENT, isIncome: true });
		});

		expect(settleBillPayment).not.toHaveBeenCalled();
	});

	it('parcela de compra parcelada não procura conta a pagar', async () => {
		const api = await mount();

		await act(async () => {
			await api().addNewTransaction({
				...TIM_PAYMENT,
				installmentGroup: 'compra',
				installmentIndex: 1,
				installmentCount: 3,
			});
		});

		expect(settleBillPayment).not.toHaveBeenCalled();
	});
});

describe('apagar um lançamento', () => {
	it('desfaz a baixa que ele tenha dado, com a data dele', async () => {
		mockStored.push({
			...TIM_PAYMENT,
			id: 'tx-tim',
			accountId: 'nubank',
			installmentGroup: null,
			installmentIndex: null,
			installmentCount: null,
			cardLast4: null,
			updatedAt: '',
		});
		const api = await mount();

		await act(async () => {
			await api().removeTransaction('tx-tim');
		});

		expect(deleteTransaction).toHaveBeenCalledWith('tx-tim');
		expect(undoBillPayment).toHaveBeenCalledWith('tx-tim', '2026-10-14');
	});

	it('lançamento que a tela não conhece desfaz sem a data', async () => {
		const api = await mount();

		await act(async () => {
			await api().removeTransaction('tx-sumido');
		});

		expect(undoBillPayment).toHaveBeenCalledWith('tx-sumido', null);
	});
});

describe('editar um lançamento (SPD-067)', () => {
	const STORED: Transaction = {
		...TIM_PAYMENT,
		id: 'tx-tim',
		accountId: 'nubank',
		installmentGroup: null,
		installmentIndex: null,
		installmentCount: null,
		cardLast4: null,
		updatedAt: '',
	};

	it('refaz a baixa com o lançamento de antes e o de depois', async () => {
		mockStored.push(STORED);
		const api = await mount();

		await act(async () => {
			await api().updateExistingTransaction({ ...TIM_PAYMENT, id: 'tx-tim', amountCents: 20_000, date: '2026-11-14' });
		});

		expect(updateTransaction).toHaveBeenCalledTimes(1);
		expect(resettleBillPayment).toHaveBeenCalledTimes(1);
		expect(resettleBillPayment).toHaveBeenCalledWith(
			{ id: 'tx-tim', amountCents: 13_517, date: '2026-10-14', accountId: 'nubank', text: 'TIM celular', isExpense: true },
			{ id: 'tx-tim', amountCents: 20_000, date: '2026-11-14', accountId: 'nubank', text: 'TIM celular', isExpense: true }
		);
	});

	it('conta de origem não informada na edição é a que já estava gravada', async () => {
		mockStored.push(STORED);
		const api = await mount();

		await act(async () => {
			await api().updateExistingTransaction({ ...TIM_PAYMENT, id: 'tx-tim', accountId: undefined });
		});

		expect(resettleBillPayment).toHaveBeenCalledWith(
			expect.objectContaining({ accountId: 'nubank' }),
			expect.objectContaining({ accountId: 'nubank' })
		);
	});

	it('virar receita também passa pela baixa, que se desfaz lá', async () => {
		mockStored.push(STORED);
		const api = await mount();

		await act(async () => {
			await api().updateExistingTransaction({ ...TIM_PAYMENT, id: 'tx-tim', isIncome: true });
		});

		expect(resettleBillPayment).toHaveBeenCalledWith(
			expect.objectContaining({ isExpense: true }),
			expect.objectContaining({ isExpense: false })
		);
	});

	it('parcela de compra parcelada não mexe em conta a pagar', async () => {
		mockStored.push({ ...STORED, installmentGroup: 'compra', installmentIndex: 1, installmentCount: 3 });
		const api = await mount();

		await act(async () => {
			await api().updateExistingTransaction({ ...TIM_PAYMENT, id: 'tx-tim', amountCents: 20_000 });
		});

		expect(updateTransaction).toHaveBeenCalledTimes(1);
		expect(resettleBillPayment).not.toHaveBeenCalled();
	});

	it('lançamento que a tela não conhece vai sem o "antes"', async () => {
		const api = await mount();

		await act(async () => {
			await api().updateExistingTransaction({ ...TIM_PAYMENT, id: 'tx-sumido' });
		});

		expect(resettleBillPayment).toHaveBeenCalledWith(
			null,
			expect.objectContaining({ id: 'tx-sumido', accountId: 'nubank' })
		);
	});
});
