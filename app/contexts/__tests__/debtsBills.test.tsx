/**
 * Financiamento e consórcio viram contas a pagar (SPD-062): o DebtsContext chama
 * `ensureDebtBills` depois de carregar e de criar, editar ou quitar uma dívida, e avisa
 * quem mostra as contas (`emitBillsChanged`).
 *
 * O caso real: as duas dívidas do usuário nunca deram aviso de vencimento — e a onda 1
 * deixou `ensureDebtBills` pronto sem ninguém chamando. Aqui o banco é mock; `billRules`
 * e `billEvents` rodam de verdade.
 */

import type { Bill, BillDraft, Debt, DebtDraft } from '../../database/schema';

let mockDebts: Debt[] = [];
let mockBills: Bill[] = [];
let mockEnsureWrites = 0;

jest.mock('../../database/database', () => ({
	initDatabase: jest.fn(async () => undefined),
	getDebts: jest.fn(async () => mockDebts.map((debt) => ({ ...debt }))),
	addDebt: jest.fn(async () => 'nova'),
	updateDebt: jest.fn(async () => undefined),
	deleteDebt: jest.fn(async () => undefined),
	ensureDebtBills: jest.fn(async () => mockEnsureWrites),
	getBills: jest.fn(async () => mockBills.map((bill) => ({ ...bill }))),
	getBillPayments: jest.fn(async () => []),
	updateBill: jest.fn(async (id: string, draft: BillDraft) => {
		mockBills = mockBills.map((bill) => (bill.id === id ? { ...bill, ...draft } : bill));
	}),
}));

// O aviso de "o banco mudou por fora" (`hooks/useAfterPull.ts`) de verdade, numa fila de mentira.
jest.mock('../../sync/queue', () => {
	type MockState = { pulledVersion: number };
	const listeners = new Set<(state: MockState) => void>();
	let state: MockState = { pulledVersion: 0 };
	return {
		schedule: jest.fn(),
		getState: () => state,
		subscribe: (listener: (next: MockState) => void) => {
			listeners.add(listener);
			listener(state);
			return () => listeners.delete(listener);
		},
		notifyDataChanged: () => {
			state = { pulledVersion: state.pulledVersion + 1 };
			for (const listener of listeners) listener(state);
		},
	};
});

jest.mock('../SyncContext', () => ({
	useSync: () => ({ lastSyncedAt: null }),
}));

jest.mock('../../utils/dateUtils', () => ({
	...jest.requireActual('../../utils/dateUtils'),
	todayISO: () => '2026-10-24',
}));

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ensureDebtBills, getDebts, updateBill } from '../../database/database';
import * as syncQueue from '../../sync/queue';
import { emitBillsChanged, onBillsChanged } from '../../utils/billEvents';
import { DebtsProvider, draftOf, useDebts } from '../DebtsContext';

const ensure = ensureDebtBills as jest.Mock;

const debt = (overrides: Partial<Debt> = {}): Debt => ({
	id: 'fin',
	name: 'Financiamento',
	kind: 'financing',
	system: 'price',
	openingBalanceCents: 10_000_000,
	openingBalanceDate: '2026-01-15',
	installmentCents: 180_000,
	remainingAtOpening: 100,
	installmentsTotal: 120,
	dueDay: 5,
	rateBp: 1_200,
	feeCents: 0,
	adminFeeBp: null,
	accountId: null,
	category: null,
	archived: false,
	sortOrder: 0,
	updatedAt: '2026-01-15T00:00:00.000Z',
	...overrides,
});

const debtBill = (overrides: Partial<Bill> = {}): Bill => ({
	id: 'fin',
	name: 'Financiamento',
	dueDay: 5,
	amountCents: 180_000,
	accountId: null,
	category: null,
	matchHint: null,
	debtId: 'fin',
	paidThrough: null,
	paidByRef: null,
	active: true,
	sortOrder: 0,
	updatedAt: '2026-10-24T00:00:00.000Z',
	...overrides,
});

type Api = ReturnType<typeof useDebts>;

let renderer: ReactTestRenderer | null = null;
let changed: jest.Mock;
let unsubscribe: () => void;

const mount = async (): Promise<() => Api> => {
	let latest: Api | null = null;
	const Probe = () => {
		latest = useDebts();
		return null;
	};
	await act(async () => {
		renderer = create(
			<DebtsProvider>
				<Probe />
			</DebtsProvider>
		);
	});
	return () => {
		if (!latest) throw new Error('provider não montou');
		return latest;
	};
};

beforeEach(() => {
	mockDebts = [debt()];
	mockBills = [];
	mockEnsureWrites = 0;
	jest.clearAllMocks();
	changed = jest.fn();
	unsubscribe = onBillsChanged(changed);
});

afterEach(async () => {
	unsubscribe();
	await act(async () => {
		renderer?.unmount();
	});
	renderer = null;
});

describe('as contas a pagar das dívidas', () => {
	it('ao carregar: garante as contas com a lista inteira de dívidas', async () => {
		await mount();
		expect(ensure).toHaveBeenCalledTimes(1);
		expect(ensure.mock.calls[0][0].map((item: Debt) => item.id)).toEqual(['fin']);
	});

	it('gravou alguma conta: sobe no sync e avisa quem mostra as contas', async () => {
		mockEnsureWrites = 1;
		await mount();
		expect(syncQueue.schedule).toHaveBeenCalled();
		expect(changed).toHaveBeenCalledTimes(1);
	});

	it('o banco mudou por fora ("Apagar todos os dados", backup): a lista relê', async () => {
		const api = await mount();
		mockDebts = [];
		await act(async () => {
			syncQueue.notifyDataChanged();
		});
		expect(api().debts).toEqual([]);
	});

	it('nada mudou: não avisa nem suja a fila', async () => {
		await mount();
		expect(changed).not.toHaveBeenCalled();
		expect(syncQueue.schedule).not.toHaveBeenCalled();
	});

	it('depois de criar, editar e quitar uma dívida, garante de novo', async () => {
		const api = await mount();
		ensure.mockClear();
		const draft: DebtDraft = draftOf(debt());
		await act(async () => {
			await api().createDebt({ ...draft, name: 'Consórcio', kind: 'consortium' });
		});
		await act(async () => {
			await api().saveDebt('fin', { ...draft, name: 'Financiamento Caixa' });
		});
		await act(async () => {
			await api().saveDebt('fin', { ...draft, archived: true });
		});
		expect(ensure).toHaveBeenCalledTimes(3);
	});

	it('conta de dívida recém-criada: vencimento do mês já passou → nasce com o mês atual pago', async () => {
		// Dia 5, hoje 24/10: a parcela de outubro já venceu; o padrão é "já está pago",
		// o mesmo da pergunta da tela, para não acender "atrasada" no primeiro dia.
		mockEnsureWrites = 1;
		mockBills = [debtBill()];
		await mount();
		expect((updateBill as jest.Mock).mock.calls[0][0]).toBe('fin');
		expect((updateBill as jest.Mock).mock.calls[0][1]).toMatchObject({
			paidThrough: '2026-10',
			debtId: 'fin',
		});
		expect(changed).toHaveBeenCalledTimes(1);
	});

	it('conta de dívida recém-criada: vencimento ainda por vir → nasce com o mês anterior pago', async () => {
		mockEnsureWrites = 1;
		mockDebts = [debt({ dueDay: 28 })];
		mockBills = [debtBill({ dueDay: 28 })];
		await mount();
		expect((updateBill as jest.Mock).mock.calls[0][1].paidThrough).toBe('2026-09');
	});

	it('conta de dívida que já teve baixa não é tocada', async () => {
		mockBills = [
			debtBill({ paidThrough: '2026-08' }),
			debtBill({ id: 'outra', debtId: 'outra', paidByRef: 'tx-1' }),
		];
		await mount();
		expect(updateBill).not.toHaveBeenCalled();
	});

	it('uma falha ao garantir as contas não esconde as dívidas', async () => {
		const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
		ensure.mockRejectedValueOnce(new Error('disco cheio'));
		const api = await mount();
		expect(api().debts.map((item) => item.id)).toEqual(['fin']);
		spy.mockRestore();
	});
});

/** Deixa as recargas disparadas pelo aviso (`void refresh()`) terminarem. */
const settle = async () => {
	for (let i = 0; i < 6; i++) {
		await act(async () => {
			await new Promise((resolve) => setImmediate(resolve));
		});
	}
};

/*
 * Juntar contas leva a dívida da conta que sai para a que fica (SPD-099) e avisa com
 * `emitBillsChanged`. A lista em memória tem que reler: `recordExtraPayment` regrava a dívida
 * a partir dela, e a cópia velha devolvia a dívida à conta apagada.
 */
describe('o aviso de contas a pagar recarrega as dívidas', () => {
	it('juntar contas avisou: a dívida passa a mostrar a conta que ficou', async () => {
		mockDebts = [debt({ accountId: 'inter-pf' })];
		const api = await mount();
		mockDebts = [debt({ accountId: 'inter' })];
		await act(async () => {
			emitBillsChanged();
		});
		await settle();
		expect(api().debts.map((item) => item.accountId)).toEqual(['inter']);
	});

	it('o próprio aviso não recarrega de novo: o laço para depois de uma volta', async () => {
		// Pior caso: `ensureDebtBills` sempre diz que gravou. Se a recarga dependesse de ele
		// parar de gravar, isto rodaria sem fim.
		mockEnsureWrites = 1;
		await mount();
		await settle();
		expect(getDebts).toHaveBeenCalledTimes(1);
		expect(ensure).toHaveBeenCalledTimes(1);
		expect(changed).toHaveBeenCalledTimes(1);

		// Um aviso de fora (juntar contas): uma volta só — relê, garante, avisa, e para.
		await act(async () => {
			emitBillsChanged();
		});
		await settle();
		expect(getDebts).toHaveBeenCalledTimes(2);
		expect(ensure).toHaveBeenCalledTimes(2);
		// O de fora e o da segunda volta.
		expect(changed).toHaveBeenCalledTimes(3);
	});
});
