/**
 * Todo push diz qual "apagar todos os dados" este aparelho conhece (SPD-082, DEC-35).
 *
 * O servidor recusa (409 `data_wiped`) o push de um aparelho que não sabe do último apagar
 * da conta — sem isso, o celular que ficou sem rede subiria de volta o que o outro acabou
 * de apagar. O `knownWipeAt` mora em `sync_state`, ao lado do cursor, e vai em **todo**
 * push: `null` quando este aparelho nunca apagou. O servidor que está em produção ignora
 * o campo, então mandá-lo é inofensivo lá. O que fazer com o 409 é o SPD-083.
 */

jest.mock('../../api/sync', () => ({
	pull: jest.fn(),
	push: jest.fn(),
	fetchSyncStatus: jest.fn(),
}));

const mockSyncState = new Map<string, string>();

jest.mock('../../database/database', () => ({
	applyPulledChanges: jest.fn(async () => undefined),
	countDirtyRows: jest.fn(async () => 0),
	getDirtyChanges: jest.fn(),
	getSyncedIds: jest.fn(async () => new Set<string>()),
	getSyncState: jest.fn(async (key: string) => mockSyncState.get(key) ?? null),
	hasCategory: jest.fn(async () => false),
	markCategoryDirty: jest.fn(async () => undefined),
	markChangesClean: jest.fn(async () => undefined),
	reassignToUncategorized: jest.fn(async () => undefined),
	reconcilePreferences: jest.fn(async () => 0),
	repairPhantomAppAccounts: jest.fn(async () => 0),
	setSyncState: jest.fn(async (key: string, value: string | null) => {
		if (value === null) mockSyncState.delete(key);
		else mockSyncState.set(key, value);
	}),
	stampEverything: jest.fn(async () => undefined),
}));

import * as api from '../../api/sync';
import { getDirtyChanges } from '../../database/database';
import { getKnownWipeAt, pushAll, replaceAccountWithDevice } from '../engine';
import { EMPTY_CURSOR, KNOWN_WIPE_AT_KEY, type SyncChanges } from '../types';

const changes = (overrides: Partial<SyncChanges> = {}): SyncChanges => ({
	categories: [],
	transactions: [],
	recurringTransactions: [],
	budgets: [],
	...overrides,
});

const tx = {
	id: 't1',
	amountCents: 5290,
	category: 'food',
	date: '2026-10-27',
	note: '',
	isIncome: false,
	updatedAt: '2026-10-27T10:00:00.000Z',
	deletedAt: null,
} as never;

beforeEach(() => {
	jest.clearAllMocks();
	mockSyncState.clear();
	(api.push as jest.Mock).mockResolvedValue({
		serverTime: '2026-10-27T10:00:01.000Z',
		applied: 1,
		rejected: [],
	});
	(api.pull as jest.Mock).mockResolvedValue({
		serverTime: '2026-10-27T10:00:01.000Z',
		cursor: EMPTY_CURSOR,
		hasMore: false,
		changes: changes(),
	});
	(getDirtyChanges as jest.Mock)
		.mockResolvedValueOnce(changes({ transactions: [tx] }))
		.mockResolvedValue(changes());
});

describe('o push leva o apagar que este aparelho conhece', () => {
	it('nunca apagou: vai `null`, explícito', async () => {
		await pushAll();

		expect(api.push).toHaveBeenCalledTimes(1);
		expect((api.push as jest.Mock).mock.calls[0][1]).toBeNull();
	});

	it('apagou: vai o `dataWipedAt` que o servidor devolveu', async () => {
		mockSyncState.set(KNOWN_WIPE_AT_KEY, '2026-10-27T09:00:00.000Z');

		await pushAll();

		expect((api.push as jest.Mock).mock.calls[0][1]).toBe('2026-10-27T09:00:00.000Z');
		expect(await getKnownWipeAt()).toBe('2026-10-27T09:00:00.000Z');
	});

	it('"subir deste aparelho" também leva, nas lápides e no resto', async () => {
		mockSyncState.set(KNOWN_WIPE_AT_KEY, '2026-10-27T09:00:00.000Z');
		(api.pull as jest.Mock).mockResolvedValue({
			serverTime: '2026-10-27T10:00:01.000Z',
			cursor: EMPTY_CURSOR,
			hasMore: false,
			changes: changes({ transactions: [{ ...(tx as object), id: 'so-na-conta' } as never] }),
		});

		await replaceAccountWithDevice();

		expect((api.push as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(2);
		for (const call of (api.push as jest.Mock).mock.calls) {
			expect(call[1]).toBe('2026-10-27T09:00:00.000Z');
		}
	});
});
