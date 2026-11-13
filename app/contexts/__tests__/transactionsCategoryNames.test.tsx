/**
 * Quando o app põe as categorias padrão no idioma dele (SPD-088, E2E-11): na abertura, depois
 * de cada pull (a conta pode trazer as padrão em inglês, como o servidor as semeia) e ao trocar
 * o idioma. A regra de o que renomear mora em `utils/defaultCategoryNames.ts` (testada lá e no
 * SQL); aqui só a ligação com o provider. O banco é mock.
 */

const mockLocalize = jest.fn();
let mockAfterPull: (() => unknown) | null = null;

jest.mock('../../database/database', () => ({
	initDatabase: jest.fn(async () => undefined),
	getCategories: jest.fn(async () => []),
	getTransactions: jest.fn(async () => []),
	getMonthlyTransactions: jest.fn(async () => []),
	getTransactionsByDateRange: jest.fn(async () => []),
	getPeriodSummary: jest.fn(async () => ({
		incomeCents: 0,
		expenseCents: 0,
		passThroughCents: 0,
		netCents: 0,
	})),
	getBalanceAsOf: jest.fn(async () => 0),
	getTotalByCategory: jest.fn(async () => []),
}));

jest.mock('../../utils/defaultCategoryNames', () => ({
	localizeDefaultCategories: () => mockLocalize(),
}));

jest.mock('../../utils/captureActions', () => ({
	settleBillPayment: jest.fn(async () => null),
	undoBillPayment: jest.fn(async () => undefined),
	resettleBillPayment: jest.fn(async () => null),
}));

jest.mock('../../sync/queue', () => ({ schedule: jest.fn() }));

jest.mock('../../hooks/useAfterPull', () => ({
	useAfterPull: (reload: () => unknown) => {
		mockAfterPull = reload;
	},
}));

jest.mock('../PeriodContext', () => ({
	usePeriod: () => ({ startDate: '2026-11-01', endDate: '2026-11-30' }),
}));

import i18next from 'i18next';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { getCategories, initDatabase } from '../../database/database';
import { schedule } from '../../sync/queue';
import { TransactionsProvider } from '../TransactionsContext';

let renderer: ReactTestRenderer;

const mount = async () => {
	await act(async () => {
		renderer = create(<TransactionsProvider>{null}</TransactionsProvider>);
	});
};

beforeEach(() => {
	jest.clearAllMocks();
	mockAfterPull = null;
	mockLocalize.mockResolvedValue(0);
});

afterEach(() => {
	act(() => renderer?.unmount());
});

it('na abertura, depois de o banco ficar pronto e antes de ler as categorias', async () => {
	const order: string[] = [];
	(initDatabase as jest.Mock).mockImplementationOnce(async () => {
		order.push('init');
	});
	mockLocalize.mockImplementationOnce(async () => {
		order.push('localize');
		return 0;
	});
	(getCategories as jest.Mock).mockImplementationOnce(async () => {
		order.push('categories');
		return [];
	});

	await mount();

	expect(order).toEqual(['init', 'localize', 'categories']);
});

it('depois de um pull: localiza o que veio da conta e manda subir o que renomeou', async () => {
	await mount();
	mockLocalize.mockClear();
	mockLocalize.mockResolvedValueOnce(3);

	await act(async () => {
		await mockAfterPull?.();
	});

	expect(mockLocalize).toHaveBeenCalledTimes(1);
	expect(schedule).toHaveBeenCalled();
});

it('ao trocar o idioma: localiza, relê as categorias e manda subir', async () => {
	await mount();
	mockLocalize.mockClear();
	(getCategories as jest.Mock).mockClear();
	mockLocalize.mockResolvedValueOnce(15);

	await act(async () => {
		i18next.emit('languageChanged', 'pt');
		await new Promise((resolve) => setTimeout(resolve, 0));
	});

	expect(mockLocalize).toHaveBeenCalledTimes(1);
	expect(getCategories).toHaveBeenCalled();
	expect(schedule).toHaveBeenCalled();
});

it('ao trocar o idioma sem nada a renomear, não pede sync', async () => {
	await mount();
	(schedule as jest.Mock).mockClear();

	await act(async () => {
		i18next.emit('languageChanged', 'pt');
		await new Promise((resolve) => setTimeout(resolve, 0));
	});

	expect(schedule).not.toHaveBeenCalled();
});
