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
	updateBill: jest.fn(async (id: string, draft: BillDraft) => {
		mockBills = mockBills.map((bill) => (bill.id === id ? { ...bill, ...draft } : bill));
	}),
}));

jest.mock('../../sync/queue', () => ({
	schedule: jest.fn(),
}));

jest.mock('../SyncContext', () => ({
	useSync: () => ({ lastSyncedAt: null }),
}));

jest.mock('../../utils/dateUtils', () => ({
	...jest.requireActual('../../utils/dateUtils'),
	todayISO: () => '2026-10-24',
}));

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ensureDebtBills, updateBill } from '../../database/database';
import * as syncQueue from '../../sync/queue';
import { onBillsChanged } from '../../utils/billEvents';
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
