/**
 * A edição de uma linha que desceu com carimbo no futuro não volta atrás depois do sync
 * (SPD-107).
 *
 * O achado no aparelho, em 07/11: uma transação criada com o relógio adiantado ficou com
 * `updatedAt` 2026-11-12T03:20:05 no servidor. O usuário mudou o valor de R$ 200 para
 * R$ 250; a edição carimbava agora, mais velho que o servidor, o push voltava `stale` e o
 * pull trazia R$ 200 de volta, sem aviso.
 *
 * O motor e o banco são os de verdade (`node:sqlite`, como em `staleSql.test.ts`); o
 * servidor é de mentira, mas decide `stale` como o de verdade (`isStale` em
 * `backend/src/controllers/sync.controller.ts`: recusa quando o que ele guardou é **mais
 * novo** que o que chega; empate vai para quem envia) e desce por cursor (`serverSeq`).
 * Sem `NODE_OPTIONS=--experimental-sqlite` a suíte é pulada com um aviso.
 */

jest.mock('expo-sqlite', () => {
	const { createRequire } = jest.requireActual('module');
	let DatabaseSync: (new (path: string) => {
		exec: (sql: string) => void;
		prepare: (sql: string) => {
			run: (...params: unknown[]) => { changes: number | bigint; lastInsertRowid: number | bigint };
			get: (...params: unknown[]) => unknown;
			all: (...params: unknown[]) => unknown[];
		};
	}) | null = null;
	try {
		DatabaseSync = createRequire(__filename)('node:sqlite').DatabaseSync;
	} catch {
		DatabaseSync = null;
	}
	const normalise = (params: unknown[] = []) =>
		params.map((value) => (typeof value === 'boolean' ? (value ? 1 : 0) : value === undefined ? null : value));
	return {
		mockSqliteAvailable: DatabaseSync !== null,
		openDatabaseSync: () => {
			if (!DatabaseSync) return {};
			const raw = new DatabaseSync(':memory:');
			return {
				execAsync: async (sql: string) => {
					raw.exec(sql);
				},
				runAsync: async (sql: string, params: unknown[] = []) => {
					const result = raw.prepare(sql).run(...normalise(params));
					return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
				},
				getFirstAsync: async (sql: string, params: unknown[] = []) => raw.prepare(sql).get(...normalise(params)) ?? null,
				getAllAsync: async (sql: string, params: unknown[] = []) => raw.prepare(sql).all(...normalise(params)),
				withTransactionAsync: async (body: () => Promise<void>) => {
					raw.exec('BEGIN');
					try {
						await body();
						raw.exec('COMMIT');
					} catch (error) {
						raw.exec('ROLLBACK');
						throw error;
					}
				},
			};
		},
	};
});

jest.mock('@react-native-async-storage/async-storage', () => ({
	getItem: jest.fn(async () => null),
	setItem: jest.fn(async () => undefined),
	removeItem: jest.fn(async () => undefined),
	multiRemove: jest.fn(async () => undefined),
	multiGet: jest.fn(async (keys: string[]) => keys.map((key) => [key, null])),
}));

jest.mock('../../api/sync', () => ({
	pull: jest.fn(),
	push: jest.fn(),
	fetchSyncStatus: jest.fn(),
}));

import * as api from '../../api/sync';
import { countDirtyRows, db, deleteTransaction, getTransactions, initDatabase, updateTransaction } from '../../database/database';
import type { TransactionDraft } from '../../database/schema';
import { syncNow } from '../engine';
import { EMPTY_CHANGES, type RejectedRow, type SyncChanges, type SyncCursor, type WireTransaction } from '../types';

const sqliteAvailable: boolean = jest.requireMock<{ mockSqliteAvailable: boolean }>('expo-sqlite').mockSqliteAvailable;
if (!sqliteAvailable) {
	console.warn('clockAheadSql.test.ts pulado: rode com NODE_OPTIONS=--experimental-sqlite (Node 22.12).');
}
const describeSql = sqliteAvailable ? describe : describe.skip;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Um servidor de uma coleção só (`transactions`), com a regra de `stale` do de verdade. */
const fakeServer = () => {
	const rows = new Map<string, { row: WireTransaction; seq: number }>();
	let seq = 0;
	const store = (row: WireTransaction) => {
		seq += 1;
		rows.set(row.id, { row, seq });
	};

	(api.push as jest.Mock).mockImplementation(async (changes: SyncChanges) => {
		const rejected: RejectedRow[] = [];
		let applied = 0;
		for (const [collection, list] of Object.entries(changes)) {
			if (!Array.isArray(list)) continue;
			for (const row of list as WireTransaction[]) {
				if (collection !== 'transactions') {
					applied += 1;
					continue;
				}
				const current = rows.get(row.id);
				if (current && new Date(current.row.updatedAt) > new Date(row.updatedAt)) {
					rejected.push({ collection: 'transactions', id: row.id, reason: 'stale' });
					continue;
				}
				store(row);
				applied += 1;
			}
		}
		return { serverTime: new Date().toISOString(), applied, rejected };
	});

	(api.pull as jest.Mock).mockImplementation(async (cursor: SyncCursor) => {
		const fresh = [...rows.values()].filter((entry) => entry.seq > cursor.transactions);
		return {
			serverTime: new Date().toISOString(),
			cursor: { ...cursor, transactions: Math.max(cursor.transactions, ...fresh.map((entry) => entry.seq)) },
			hasMore: false,
			changes: { ...EMPTY_CHANGES(), transactions: fresh.map((entry) => entry.row) },
		};
	});

	return { store, get: (id: string) => rows.get(id)?.row };
};

const draft: TransactionDraft = { amountCents: 20_000, category: 'food', date: '2026-11-05', note: '', isIncome: false };

describeSql('relógio adiantado: a edição sobrevive ao push e ao pull (SPD-107)', () => {
	beforeAll(async () => {
		jest.spyOn(console, 'log').mockImplementation(() => undefined);
		jest.spyOn(console, 'warn').mockImplementation(() => undefined);
		await initDatabase();
	});

	beforeEach(async () => {
		jest.clearAllMocks();
		await db.execAsync('DELETE FROM transactions; DELETE FROM accounts; DELETE FROM sync_state;');
	});

	/** A transação de R$ 200 gravada por um relógio cinco dias adiantado, já neste aparelho. */
	const pulledFromTheFuture = async () => {
		const server = fakeServer();
		const future = new Date(Date.now() + 5 * DAY_MS).toISOString();
		server.store({
			id: 'tx-adiantada',
			amountCents: 20_000,
			category: 'food',
			date: '2026-11-05',
			note: '',
			isIncome: false,
			accountId: null,
			installmentGroup: null,
			installmentIndex: null,
			installmentCount: null,
			cardLast4: null,
			updatedAt: future,
			deletedAt: null,
		} as WireTransaction);
		await syncNow();
		const [local] = await getTransactions();
		expect(local).toMatchObject({ id: 'tx-adiantada', amountCents: 20_000, updatedAt: future });
		return { server, future };
	};

	it('R$ 200 → R$ 250: o servidor aceita, e depois do sync a tela continua com R$ 250', async () => {
		const { server, future } = await pulledFromTheFuture();

		await updateTransaction({ ...draft, amountCents: 25_000, id: 'tx-adiantada' });
		await syncNow();

		const [local] = await getTransactions();
		expect(local.amountCents).toBe(25_000);
		expect(local.updatedAt > future).toBe(true);
		expect(server.get('tx-adiantada')).toMatchObject({ amountCents: 25_000, updatedAt: local.updatedAt });
		expect(await countDirtyRows()).toBe(0);

		// E o ciclo seguinte não desfaz nada nem tem o que subir.
		(api.push as jest.Mock).mockClear();
		await syncNow();
		expect((await getTransactions())[0].amountCents).toBe(25_000);
		expect(api.push).not.toHaveBeenCalled();
	});

	it('apagar: a lápide chega ao servidor e o lançamento não volta no pull', async () => {
		const { server } = await pulledFromTheFuture();

		await deleteTransaction('tx-adiantada');
		await syncNow();

		expect(await getTransactions()).toEqual([]);
		expect(server.get('tx-adiantada')?.deletedAt).not.toBeNull();
		expect(await countDirtyRows()).toBe(0);
	});
});
