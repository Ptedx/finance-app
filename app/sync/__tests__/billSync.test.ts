/**
 * Contas a pagar (v20) no motor do sync: a coleção `bills` sobe quando é a única coisa
 * suja, conta no total recebido, nasce com cursor zero ao herdar de uma versão que não a
 * conhecia, e um servidor que ainda não a conhece não a recebe — nem a faz quebrar.
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
} from '../types';

const emptyChanges = (overrides: Partial<SyncChanges> = {}): SyncChanges => ({
	categories: [],
	transactions: [],
	recurringTransactions: [],
	budgets: [],
	...overrides,
});

const bill = (id: string): WireBill => ({
	id,
	name: 'Celular',
	dueDay: 10,
	amountCents: null,
	accountId: null,
	category: null,
	matchHint: 'tim',
	debtId: null,
	paidThrough: null,
	paidByRef: null,
	active: true,
	sortOrder: 0,
	updatedAt: '2026-10-10T00:00:00.000Z',
	deletedAt: null,
});

beforeEach(() => {
	jest.clearAllMocks();
	(api.push as jest.Mock).mockResolvedValue({
		serverTime: '2026-10-24T00:00:00.000Z',
		applied: 1,
		rejected: [],
	});
	(getDirtyChanges as jest.Mock).mockResolvedValue(emptyChanges());
	(getSyncState as jest.Mock).mockResolvedValue(null);
});

describe('o contrato da coleção `bills`', () => {
	it('tem cursor próprio, desde o schema 20', () => {
		expect(EMPTY_CURSOR.bills).toBe(0);
		expect(COLLECTION_SINCE_SCHEMA.bills).toBe(20);
	});

	it('entra na remessa vazia e na contagem', () => {
		expect(EMPTY_CHANGES().bills).toEqual([]);
		expect(countChanges(emptyChanges({ bills: [bill('b1'), bill('b2')] }))).toBe(2);
	});

	it('o cursor herdado do v19 zera `bills` e mantém o resto', () => {
		const legacy: SyncCursor = { ...EMPTY_CURSOR, transactions: 500, captures: 40, bills: 77 };
		expect(inheritCursor(legacy, 19)).toEqual({ ...legacy, bills: 0 });
		expect(inheritCursor(legacy, 20)).toEqual(legacy);
	});

	it('um servidor que não conhece `bills` não as recebe — e elas continuam por enviar', () => {
		const known = new Set(Object.keys(EMPTY_CURSOR).filter((key) => key !== 'bills'));
		const filtered = onlyKnownCollections(emptyChanges({ bills: [bill('b1')] }), known);
		expect(filtered.bills).toEqual([]);
	});
});

describe('o push de contas a pagar', () => {
	it('sobe a conta a pagar mesmo quando é a única coisa suja', async () => {
		(getDirtyChanges as jest.Mock)
			.mockResolvedValueOnce(emptyChanges({ bills: [bill('b1')] }))
			.mockResolvedValue(emptyChanges());

		await pushAll();

		expect(api.push).toHaveBeenCalledTimes(1);
		const sent = (api.push as jest.Mock).mock.calls[0][0] as SyncChanges;
		expect(sent.bills).toEqual([bill('b1')]);
	});

	it('o que o servidor aceitou deixa de estar pendente; o recusado continua', async () => {
		(getDirtyChanges as jest.Mock)
			.mockResolvedValueOnce(emptyChanges({ bills: [bill('b1'), bill('b2')] }))
			.mockResolvedValue(emptyChanges());
		(api.push as jest.Mock).mockResolvedValue({
			serverTime: '2026-10-24T00:00:00.000Z',
			applied: 1,
			rejected: [
				{ collection: 'bills', id: 'b2', reason: 'invalid', message: 'dueDay fora de 1..31' },
			],
		});

		await pushAll();

		const cleaned = (markChangesClean as jest.Mock).mock.calls[0][0] as SyncChanges;
		expect(cleaned.bills?.map((row) => row.id)).toEqual(['b1']);
	});

	it('servidor antigo (sem `bills` no cursor): nada sobe, nada é limpo, e o push não quebra', async () => {
		const known = Object.keys(EMPTY_CURSOR).filter((key) => key !== 'bills');
		(getSyncState as jest.Mock).mockImplementation(async (key: string) =>
			key === 'serverCollections' ? JSON.stringify(known) : null
		);
		(getDirtyChanges as jest.Mock).mockResolvedValue(emptyChanges({ bills: [bill('b1')] }));

		await expect(pushAll()).resolves.toBe(0);

		expect(api.push).not.toHaveBeenCalled();
		expect(markChangesClean).not.toHaveBeenCalled();
	});
});

describe('o pull de contas a pagar', () => {
	it('aplica e conta as contas a pagar recebidas', async () => {
		(api.pull as jest.Mock).mockResolvedValue({
			serverTime: '2026-10-24T00:00:00.000Z',
			cursor: { ...EMPTY_CURSOR, bills: 2 },
			hasMore: false,
			changes: emptyChanges({ bills: [bill('b1'), bill('b2')] }),
		});

		expect(await pullAll()).toBe(2);
		expect((applyPulledChanges as jest.Mock).mock.calls[0][0].bills).toHaveLength(2);
	});

	it('servidor antigo: resposta sem `bills` nem cursor dela não quebra o pull', async () => {
		const { bills: _bills, ...oldCursor } = EMPTY_CURSOR;
		(api.pull as jest.Mock).mockResolvedValue({
			serverTime: '2026-10-24T00:00:00.000Z',
			cursor: { ...oldCursor, transactions: 3 },
			hasMore: false,
			changes: emptyChanges(),
		});

		await expect(pullAll()).resolves.toBe(0);
		expect(applyPulledChanges).toHaveBeenCalledTimes(1);
	});
});
