/**
 * O BillsContext (SPD-062): carrega as contas a pagar, grava pelas ações da tela e
 * remarca os lembretes depois de toda mudança e de todo recarregamento.
 *
 * O caso real: o usuário nunca recebeu aviso de vencimento. `scheduleBillReminders`
 * existe desde a onda 1, mas ninguém o chamava — a abertura do app, a baixa e o sync não
 * remarcavam nada. Aqui o banco é um array em memória, a agenda é mock e o resto
 * (`billRules`, `billEvents`) roda de verdade.
 */

import type { Bill, BillDraft } from '../../database/schema';

let mockStore: Bill[] = [];
let mockNextId = 1;
let mockLastSyncedAt: string | null = null;

const toBill = (id: string, draft: BillDraft): Bill => ({
	id,
	...draft,
	updatedAt: '2026-10-24T12:00:00.000Z',
});

jest.mock('../../database/database', () => ({
	initDatabase: jest.fn(async () => undefined),
	getBills: jest.fn(async () => mockStore.map((bill) => ({ ...bill }))),
	addBill: jest.fn(async (draft: BillDraft) => {
		const id = `bill-${mockNextId++}`;
		mockStore.push(toBill(id, draft));
		return id;
	}),
	updateBill: jest.fn(async (id: string, draft: BillDraft) => {
		mockStore = mockStore.map((bill) => (bill.id === id ? toBill(id, draft) : bill));
	}),
	deleteBill: jest.fn(async (id: string) => {
		mockStore = mockStore.filter((bill) => bill.id !== id);
	}),
}));

jest.mock('../../utils/notificationUtils', () => ({
	scheduleBillReminders: jest.fn(async () => 0),
}));

jest.mock('../../sync/queue', () => ({
	schedule: jest.fn(),
}));

jest.mock('../SyncContext', () => ({
	useSync: () => ({ lastSyncedAt: mockLastSyncedAt }),
}));

jest.mock('../../utils/dateUtils', () => ({
	...jest.requireActual('../../utils/dateUtils'),
	todayISO: () => '2026-10-24',
}));

import { AppState, type AppStateStatus } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { addBill, deleteBill, getBills, updateBill } from '../../database/database';
import * as syncQueue from '../../sync/queue';
import { emitBillsChanged, onBillsChanged } from '../../utils/billEvents';
import { scheduleBillReminders } from '../../utils/notificationUtils';
import { BillsProvider, useBills } from '../BillsContext';

const schedule = scheduleBillReminders as jest.Mock;
const loads = getBills as jest.Mock;

const bill = (overrides: Partial<Bill> = {}): Bill => ({
	id: 'plano',
	name: 'Plano de saúde',
	dueDay: 10,
	amountCents: 50_000,
	accountId: null,
	category: null,
	matchHint: null,
	debtId: null,
	paidThrough: '2026-09',
	paidByRef: null,
	active: true,
	sortOrder: 0,
	updatedAt: '2026-10-01T00:00:00.000Z',
	...overrides,
});

const FINANCING = bill({
	id: 'fin',
	name: 'Financiamento',
	dueDay: 5,
	amountCents: 180_000,
	accountId: 'inter',
	debtId: 'fin',
});

type Api = ReturnType<typeof useBills>;

let renderer: ReactTestRenderer | null = null;
let appStateHandler: ((state: AppStateStatus) => void) | null = null;

/** Monta o provider e devolve o valor do contexto, relido a cada render. */
const mount = async (): Promise<() => Api> => {
	let latest: Api | null = null;
	const Probe = () => {
		latest = useBills();
		return null;
	};
	const tree = () => (
		<BillsProvider>
			<Probe />
		</BillsProvider>
	);

	await act(async () => {
		renderer = create(tree());
	});

	return () => {
		if (!latest) throw new Error('provider não montou');
		return latest;
	};
};

/** Rerender com o mesmo provider: é assim que um `lastSyncedAt` novo chega. */
const rerender = async () => {
	await act(async () => {
		renderer?.update(<BillsProvider>{null}</BillsProvider>);
	});
};

/** O último lote entregue à agenda, só pelos ids. */
const lastScheduledIds = (): string[] =>
	(schedule.mock.calls.at(-1)?.[0] as Bill[]).map((item) => item.id);

beforeEach(() => {
	mockStore = [bill(), { ...FINANCING }];
	mockNextId = 1;
	mockLastSyncedAt = null;
	jest.clearAllMocks();
	appStateHandler = null;
	jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
		appStateHandler = handler as (state: AppStateStatus) => void;
		return { remove: jest.fn() } as unknown as ReturnType<typeof AppState.addEventListener>;
	});
});

afterEach(async () => {
	await act(async () => {
		renderer?.unmount();
	});
	renderer = null;
});

describe('remarca os lembretes', () => {
	it('na abertura: carrega as contas e agenda com elas', async () => {
		const api = await mount();
		expect(api().bills.map((item) => item.id)).toEqual(['plano', 'fin']);
		expect(schedule).toHaveBeenCalledTimes(1);
		expect(lastScheduledIds()).toEqual(['plano', 'fin']);
	});

	it('quando alguém de fora avisa que as contas mudaram (a baixa automática, a dívida)', async () => {
		await mount();
		mockStore.push(bill({ id: 'tim', name: 'TIM', amountCents: null }));
		await act(async () => {
			emitBillsChanged();
		});
		expect(lastScheduledIds()).toEqual(['plano', 'fin', 'tim']);
	});

	it('quando um sync termina', async () => {
		await mount();
		mockStore.push(bill({ id: 'mei', name: 'MaisMEI' }));
		mockLastSyncedAt = '2026-10-24T13:00:00.000Z';
		await rerender();
		expect(lastScheduledIds()).toEqual(['plano', 'fin', 'mei']);
	});

	it('quando o app volta para o primeiro plano', async () => {
		await mount();
		const before = schedule.mock.calls.length;
		await act(async () => {
			appStateHandler?.('active');
		});
		expect(schedule.mock.calls.length).toBe(before + 1);
	});

	it('quando a tela de ajustes pede (liga/desliga das notificações), com as contas atuais', async () => {
		const api = await mount();
		schedule.mockClear();
		await act(async () => {
			await api().rescheduleReminders();
		});
		expect(schedule).toHaveBeenCalledTimes(1);
		expect(lastScheduledIds()).toEqual(['plano', 'fin']);
	});
});

describe('criar', () => {
	it('nasce com o mês anterior pago, avisa a mudança, sobe no sync e remarca', async () => {
		const api = await mount();
		const changed = jest.fn();
		const unsubscribe = onBillsChanged(changed);
		await act(async () => {
			await api().createBill(
				{
					name: 'MaisMEI',
					dueDay: 20,
					amountCents: 7_600,
					accountId: null,
					category: null,
					matchHint: 'das',
				},
				false
			);
		});
		unsubscribe();

		expect((addBill as jest.Mock).mock.calls[0][0]).toMatchObject({
			name: 'MaisMEI',
			paidThrough: '2026-09',
			debtId: null,
			active: true,
		});
		expect(changed).toHaveBeenCalledTimes(1);
		expect(syncQueue.schedule).toHaveBeenCalled();
		expect(lastScheduledIds()).toEqual(['plano', 'fin', 'bill-1']);
	});

	it('"este mês já está pago" → nasce com o mês atual pago', async () => {
		const api = await mount();
		await act(async () => {
			await api().createBill(
				{
					name: 'Plano',
					dueDay: 10,
					amountCents: 50_000,
					accountId: null,
					category: null,
					matchHint: null,
				},
				true
			);
		});
		expect((addBill as jest.Mock).mock.calls[0][0].paidThrough).toBe('2026-10');
	});

	it('o próprio aviso não recarrega duas vezes', async () => {
		const api = await mount();
		const before = loads.mock.calls.length;
		await act(async () => {
			await api().createBill(
				{
					name: 'X',
					dueDay: 1,
					amountCents: null,
					accountId: null,
					category: null,
					matchHint: null,
				},
				false
			);
		});
		expect(loads.mock.calls.length).toBe(before + 1);
	});
});

describe('a conta que vem de uma dívida viva', () => {
	it('não apaga', async () => {
		const api = await mount();
		let removed = true;
		await act(async () => {
			removed = await api().removeBill('fin');
		});
		expect(removed).toBe(false);
		expect(deleteBill).not.toHaveBeenCalled();
	});

	it('não desliga', async () => {
		const api = await mount();
		await act(async () => {
			await api().setBillActive('fin', false);
		});
		expect(updateBill).not.toHaveBeenCalled();
	});

	it('editar não muda nome, dia, valor nem conta', async () => {
		const api = await mount();
		await act(async () => {
			await api().saveBill('fin', {
				name: 'Outro',
				dueDay: 20,
				amountCents: 1,
				accountId: null,
				category: 'housing',
				matchHint: 'caixa',
			});
		});
		expect((updateBill as jest.Mock).mock.calls[0][1]).toMatchObject({
			name: 'Financiamento',
			dueDay: 5,
			amountCents: 180_000,
			accountId: 'inter',
			category: 'housing',
			matchHint: 'caixa',
		});
	});

	it('a cadastrada à mão apaga, avisa e remarca', async () => {
		const api = await mount();
		const changed = jest.fn();
		const unsubscribe = onBillsChanged(changed);
		let removed = false;
		await act(async () => {
			removed = await api().removeBill('plano');
		});
		unsubscribe();
		expect(removed).toBe(true);
		expect(deleteBill).toHaveBeenCalledWith('plano');
		expect(changed).toHaveBeenCalledTimes(1);
		expect(lastScheduledIds()).toEqual(['fin']);
	});
});

describe('"Já paguei" e desfazer', () => {
	it('"Já paguei" marca o mês atual e remarca (os avisos do mês somem)', async () => {
		const api = await mount();
		await act(async () => {
			await api().markPaid('plano');
		});
		expect((updateBill as jest.Mock).mock.calls[0][1].paidThrough).toBe('2026-10');
		const scheduled = schedule.mock.calls.at(-1)?.[0] as Bill[];
		expect(scheduled.find((item) => item.id === 'plano')?.paidThrough).toBe('2026-10');
		expect(api().month.rows.find((row) => row.bill.id === 'plano')?.status).toBe('paid');
	});

	it('desfazer volta ao mês pago de antes', async () => {
		mockStore = [bill({ paidThrough: '2026-08' })];
		const api = await mount();
		await act(async () => {
			await api().markPaid('plano');
		});
		await act(async () => {
			await api().undoPaid('plano');
		});
		expect((updateBill as jest.Mock).mock.calls[1][1].paidThrough).toBe('2026-08');
		expect(api().month.rows[0].status).toBe('late');
	});
});

describe('as contas do mês', () => {
	it('expõe o total ainda a pagar das ativas do mês corrente', async () => {
		mockStore = [
			bill(),
			bill({ id: 'tim', name: 'TIM', amountCents: null, dueDay: 28 }),
			bill({ id: 'off', active: false }),
		];
		const api = await mount();
		expect(api().month.month).toBe('2026-10');
		expect(api().month.dueCents).toBe(50_000);
		expect(api().month.variableCount).toBe(1);
		expect(api().activeBills.map((item) => item.id)).toEqual(['plano', 'tim']);
	});
});
