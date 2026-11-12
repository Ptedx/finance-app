/**
 * Os meses das contas a pagar (v23, SPD-146) no motor do sync: a coleção `billPayments` sobe
 * quando é a única coisa suja, conta no total recebido, nasce com cursor zero ao herdar de uma
 * versão que não a conhecia — e o servidor em produção, que ainda não a conhece, não a recebe:
 * as linhas ficam sujas aqui, sem perda, até ele conhecer.
 */

jest.mock('../../api/sync', () => ({
	pull: jest.fn(),
	push: jest.fn(),
	fetchSyncStatus: jest.fn(),
}));

jest.mock('../../database/database', () => ({
	applyPulledChanges: jest.fn(async () => undefined),
	countDirtyRows: jest.fn(async () => 0),
	getDirtyChanges: jest.fn(async () => ({
		categories: [],
		transactions: [],
		recurringTransactions: [],
		budgets: [],
	})),
	getSyncedIds: jest.fn(async () => new Set<string>()),
	getSyncState: jest.fn(async () => null),
	hasCategory: jest.fn(async () => false),
	markCategoryDirty: jest.fn(async () => undefined),
	markChangesClean: jest.fn(async () => undefined),
	reassignToUncategorized: jest.fn(async () => undefined),
	reconcilePreferences: jest.fn(async () => 0),
	repairPhantomAppAccounts: jest.fn(async () => 0),
	setSyncState: jest.fn(async () => undefined),
	stampEverything: jest.fn(async () => undefined),
}));

import * as api from '../../api/sync';
import {
	applyPulledChanges,
	getDirtyChanges,
	getSyncState,
	markChangesClean,
} from '../../database/database';
import { pullAll, pushAll } from '../engine';
import { COLLECTIONS, TABLE_OF } from '../replace';
import {
	COLLECTION_SINCE_SCHEMA,
	countChanges,
	EMPTY_CHANGES,
	EMPTY_CURSOR,
	inheritCursor,
	onlyKnownCollections,
	type SyncChanges,
	type SyncCursor,
	type WireBill,
	type WireBillPayment,
} from '../types';

const emptyChanges = (overrides: Partial<SyncChanges> = {}): SyncChanges => ({
	categories: [],
	transactions: [],
	recurringTransactions: [],
	budgets: [],
	...overrides,
});

const month = (id: string, overrides: Partial<WireBillPayment> = {}): WireBillPayment => ({
	id,
	billId: 'plano',
	month: '2026-10',
	status: 'skipped',
	transactionId: null,
	amountCents: null,
	updatedAt: '2026-11-11T12:00:00.000Z',
	deletedAt: null,
	...overrides,
});

const bill = (id: string): WireBill => ({
	id,
	name: 'Plano',
	dueDay: 10,
	amountCents: 50_000,
	accountId: null,
	category: null,
	matchHint: null,
	debtId: null,
	paidThrough: '2026-10',
	paidByRef: null,
	active: true,
	sortOrder: 0,
	updatedAt: '2026-11-11T12:00:00.000Z',
	deletedAt: null,
});

/** O servidor que está em produção: conhece tudo até `preferences`, não `billPayments`. */
const serverWithout = (...missing: string[]) => {
	const known = Object.keys(EMPTY_CURSOR).filter((key) => !missing.includes(key));
	(getSyncState as jest.Mock).mockImplementation(async (key: string) =>
		key === 'serverCollections' ? JSON.stringify(known) : null
	);
};

beforeEach(() => {
	jest.clearAllMocks();
	(api.push as jest.Mock).mockResolvedValue({
		serverTime: '2026-11-11T12:00:00.000Z',
		applied: 1,
		rejected: [],
	});
	(getDirtyChanges as jest.Mock).mockResolvedValue(emptyChanges());
	(getSyncState as jest.Mock).mockResolvedValue(null);
});

describe('o contrato da coleção `billPayments`', () => {
	it('tem cursor próprio, desde o schema 23', () => {
		expect(EMPTY_CURSOR.billPayments).toBe(0);
		expect(COLLECTION_SINCE_SCHEMA.billPayments).toBe(23);
	});

	it('entra na remessa vazia e na contagem', () => {
		expect(EMPTY_CHANGES().billPayments).toEqual([]);
		expect(countChanges(emptyChanges({ billPayments: [month('m1'), month('m2')] }))).toBe(2);
	});

	it('o cursor herdado do v22 zera `billPayments` e mantém o resto', () => {
		const legacy: SyncCursor = { ...EMPTY_CURSOR, transactions: 500, bills: 9, billPayments: 77 };
		expect(inheritCursor(legacy, 22)).toEqual({ ...legacy, billPayments: 0 });
		expect(inheritCursor(legacy, 23)).toEqual(legacy);
	});

	it('"subir deste aparelho" também cobre a coleção, na tabela `bill_payments`', () => {
		expect(COLLECTIONS).toContain('billPayments');
		expect(TABLE_OF.billPayments).toBe('bill_payments');
	});

	it('um servidor que não conhece `billPayments` não os recebe', () => {
		const known = new Set(Object.keys(EMPTY_CURSOR).filter((key) => key !== 'billPayments'));
		const filtered = onlyKnownCollections(
			emptyChanges({ billPayments: [month('m1')], bills: [bill('plano')] }),
			known
		);
		expect(filtered.billPayments).toEqual([]);
		expect(filtered.bills).toEqual([bill('plano')]);
	});
});

describe('o push dos meses', () => {
	it('sobe o mês mesmo quando é a única coisa suja', async () => {
		(getDirtyChanges as jest.Mock)
			.mockResolvedValueOnce(emptyChanges({ billPayments: [month('m1')] }))
			.mockResolvedValue(emptyChanges());

		await pushAll();

		expect(api.push).toHaveBeenCalledTimes(1);
		const sent = (api.push as jest.Mock).mock.calls[0][0] as SyncChanges;
		expect(sent.billPayments).toEqual([month('m1')]);
	});

	it('o que o servidor aceitou deixa de estar pendente; o recusado continua', async () => {
		(getDirtyChanges as jest.Mock)
			.mockResolvedValueOnce(
				emptyChanges({ billPayments: [month('m1'), month('m2', { month: '2026-11' })] })
			)
			.mockResolvedValue(emptyChanges());
		(api.push as jest.Mock).mockResolvedValue({
			serverTime: '2026-11-11T12:00:00.000Z',
			applied: 1,
			rejected: [{ collection: 'billPayments', id: 'm2', reason: 'invalid', message: 'status' }],
		});

		await pushAll();

		const cleaned = (markChangesClean as jest.Mock).mock.calls[0][0] as SyncChanges;
		expect(cleaned.billPayments?.map((row) => row.id)).toEqual(['m1']);
	});

	it('servidor em produção (sem `billPayments`): a conta sobe e é limpa, os meses ficam sujos, sem perda', async () => {
		serverWithout('billPayments');
		(getDirtyChanges as jest.Mock)
			.mockResolvedValueOnce(emptyChanges({ bills: [bill('plano')], billPayments: [month('m1')] }))
			.mockResolvedValue(emptyChanges({ billPayments: [month('m1')] }));

		await pushAll();

		expect(api.push).toHaveBeenCalledTimes(1);
		const sent = (api.push as jest.Mock).mock.calls[0][0] as SyncChanges;
		expect(sent.bills).toEqual([bill('plano')]);
		expect(sent.billPayments).toEqual([]);
		// Só o que subiu sai limpo: o mês não está na lista, e continua sujo no banco.
		for (const [changes] of (markChangesClean as jest.Mock).mock.calls as [SyncChanges][]) {
			expect(changes.billPayments ?? []).toEqual([]);
		}
	});

	it('servidor em produção, só meses sujos: nada sobe, nada é limpo, e o push não quebra', async () => {
		serverWithout('billPayments');
		(getDirtyChanges as jest.Mock).mockResolvedValue(emptyChanges({ billPayments: [month('m1')] }));

		await expect(pushAll()).resolves.toBe(0);

		expect(api.push).not.toHaveBeenCalled();
		expect(markChangesClean).not.toHaveBeenCalled();
	});
});

describe('o pull dos meses', () => {
	it('aplica e conta os meses recebidos', async () => {
		(api.pull as jest.Mock).mockResolvedValue({
			serverTime: '2026-11-11T12:00:00.000Z',
			cursor: { ...EMPTY_CURSOR, billPayments: 2 },
			hasMore: false,
			changes: emptyChanges({
				billPayments: [month('m1'), month('m2', { month: '2026-11', status: 'paid' })],
			}),
		});

		expect(await pullAll()).toBe(2);
		expect((applyPulledChanges as jest.Mock).mock.calls[0][0].billPayments).toHaveLength(2);
	});

	it('servidor em produção: resposta sem `billPayments` nem cursor dela não quebra o pull', async () => {
		const { billPayments: _billPayments, ...oldCursor } = EMPTY_CURSOR;
		(api.pull as jest.Mock).mockResolvedValue({
			serverTime: '2026-11-11T12:00:00.000Z',
			cursor: { ...oldCursor, bills: 3 },
			hasMore: false,
			changes: emptyChanges({ bills: [bill('plano')] }),
		});

		await expect(pullAll()).resolves.toBe(1);
		expect(applyPulledChanges).toHaveBeenCalledTimes(1);
	});
});
