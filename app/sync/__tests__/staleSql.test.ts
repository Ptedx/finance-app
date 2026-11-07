/**
 * Uma linha recusada como `stale` pelo servidor não fica pendente para sempre (E2E-36).
 *
 * O achado: três linhas foram gravadas no servidor com `updatedAt` no futuro (relógio de
 * teste adiantado). A importação do backup as regravou aqui com o carimbo de hoje, o
 * servidor respondeu `rejected: stale` e o app as manteve sujas — "3 alterações
 * aguardando envio … 3 itens ainda só existem neste aparelho", sem fim, embora o
 * servidor tivesse as três. O motor contava com o pull seguinte para trazer a versão
 * vencedora, mas o pull anda por cursor (`serverSeq`) e aquela versão já tinha descido
 * antes: ela nunca voltava.
 *
 * O motor é o de verdade e o banco é SQLite de verdade (`node:sqlite`, como em
 * `accountSql.test.ts`); só o servidor é de mentira. Sem `NODE_OPTIONS=--experimental-sqlite`
 * a suíte é pulada com um aviso.
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
import {
	addAccount,
	addTransfer,
	countDirtyRows,
	countUnsyncedRows,
	db,
	getTransfers,
	initDatabase,
	setSyncState,
} from '../../database/database';
import { type AccountDraft, SCHEMA_VERSION } from '../../database/schema';
import { syncNow } from '../engine';
import { EMPTY_CHANGES, EMPTY_CURSOR, type RejectedRow, type SyncChanges, type SyncCursor } from '../types';

const sqliteAvailable: boolean = jest.requireMock<{ mockSqliteAvailable: boolean }>('expo-sqlite').mockSqliteAvailable;
if (!sqliteAvailable) {
	console.warn('staleSql.test.ts pulado: rode com NODE_OPTIONS=--experimental-sqlite (Node 22.12).');
}
const describeSql = sqliteAvailable ? describe : describe.skip;

const CURSOR_KEY = `pullCursor@${SCHEMA_VERSION}`;
/** Até onde este aparelho já desceu: a versão do servidor (seq 41) já veio antes. */
const TRANSFERS_SEQ = 50;
const SERVER_TRANSFER_SEQ = 41;

const draft = (name: string): AccountDraft => ({
	name,
	kind: 'checking',
	role: 'main',
	envelopeMonthlyCents: null,
	bankName: null,
	color: '#000000',
	last4: null,
	network: null,
	closingDay: null,
	dueDay: null,
	closingDaysBefore: null,
	creditLimitCents: null,
	cardNames: null,
	yieldCdiBp: null,
	reservePurpose: null,
	packageName: null,
	accountKey: null,
	openingBalanceCents: 0,
	openingBalanceDate: '2026-01-01',
	sortOrder: 0,
	archived: false,
});

/** Um "servidor" que tem a transferência com carimbo no futuro e recusa a daqui. */
const fakeServer = (serverTransfer: Record<string, unknown>) => {
	(api.push as jest.Mock).mockImplementation(async (changes: SyncChanges) => {
		const rejected: RejectedRow[] = (changes.transfers ?? [])
			.filter((row) => row.id === serverTransfer.id)
			.map((row) => ({ collection: 'transfers', id: row.id, reason: 'stale' }));
		const total = Object.values(changes).reduce((sum, rows) => sum + (Array.isArray(rows) ? rows.length : 0), 0);
		return { serverTime: new Date().toISOString(), applied: total - rejected.length, rejected };
	});
	(api.pull as jest.Mock).mockImplementation(async (cursor: SyncCursor) => {
		// Por cursor, como o servidor: só desce o que tem `serverSeq` depois dele.
		const behind = cursor.transfers < SERVER_TRANSFER_SEQ;
		return {
			serverTime: new Date().toISOString(),
			cursor: { ...cursor, transfers: Math.max(cursor.transfers, behind ? TRANSFERS_SEQ : cursor.transfers) },
			hasMore: false,
			changes: { ...EMPTY_CHANGES(), transfers: behind ? [serverTransfer] : [] },
		};
	});
};

describeSql('stale no SQL de verdade (E2E-36)', () => {
	beforeAll(async () => {
		jest.spyOn(console, 'log').mockImplementation(() => undefined);
		await initDatabase();
	});

	beforeEach(async () => {
		jest.clearAllMocks();
		await db.execAsync('DELETE FROM transfers; DELETE FROM accounts; DELETE FROM sync_state;');
	});

	it('push devolve a transferência como stale: depois do ciclo ela não está suja, vale a do servidor e o contador vai a 0', async () => {
		const inter = await addAccount(draft('Inter'));
		const nubank = await addAccount(draft('Nubank'));
		// A transferência de 17/11 regravada hoje pela importação: R$ 300,00, suja.
		const id = await addTransfer({ fromAccountId: inter, toAccountId: nubank, amountCents: 30_000, date: '2026-11-17', note: '' });
		await setSyncState(CURSOR_KEY, JSON.stringify({ ...EMPTY_CURSOR, transfers: TRANSFERS_SEQ }));
		// A versão do servidor, gravada com o relógio adiantado: carimbo no futuro.
		const future = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000).toISOString();
		fakeServer({
			id,
			fromAccountId: inter,
			toAccountId: nubank,
			amountCents: 31_500,
			date: '2026-11-17',
			note: 'servidor',
			updatedAt: future,
			deletedAt: null,
		});

		const result = await syncNow();

		expect(api.push).toHaveBeenCalled();
		expect(result.pendingAfter).toBe(0);
		expect(await countDirtyRows()).toBe(0);
		expect(await countUnsyncedRows()).toBe(0);
		// A versão que venceu é a do servidor, e é ela que a tela mostra.
		const [transfer] = (await getTransfers()).filter((t) => t.id === id);
		expect(transfer).toMatchObject({ amountCents: 31_500, note: 'servidor', updatedAt: future });

		// E o próximo ciclo não reenvia nada: a linha não volta a ficar presa.
		(api.push as jest.Mock).mockClear();
		const again = await syncNow();
		expect(again.pendingAfter).toBe(0);
		expect(api.push).not.toHaveBeenCalled();
	});

	it('a linha editada aqui depois do envio continua suja: a edição nova ainda tem que subir', async () => {
		const inter = await addAccount(draft('Inter'));
		const nubank = await addAccount(draft('Nubank'));
		const id = await addTransfer({ fromAccountId: inter, toAccountId: nubank, amountCents: 30_000, date: '2026-11-17', note: '' });
		await setSyncState(CURSOR_KEY, JSON.stringify({ ...EMPTY_CURSOR, transfers: TRANSFERS_SEQ }));
		const future = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000).toISOString();
		const serverTransfer = { id, fromAccountId: inter, toAccountId: nubank, amountCents: 31_500, date: '2026-11-17', note: 'servidor', updatedAt: future, deletedAt: null };
		fakeServer(serverTransfer);
		// O usuário edita a transferência enquanto o push está no ar, com um carimbo depois
		// até do servidor (o relógio do aparelho também pode estar adiantado).
		const later = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
		(api.push as jest.Mock).mockImplementationOnce(async (changes: SyncChanges) => {
			await db.runAsync('UPDATE transfers SET amountCents = 32000, updatedAt = ?, dirty = 1 WHERE id = ?', [later, id]);
			const rejected: RejectedRow[] = [{ collection: 'transfers', id, reason: 'stale' }];
			const total = Object.values(changes).reduce((sum, rows) => sum + (Array.isArray(rows) ? rows.length : 0), 0);
			return { serverTime: new Date().toISOString(), applied: total - 1, rejected };
		});

		await syncNow();

		const [transfer] = (await getTransfers()).filter((t) => t.id === id);
		expect(transfer).toMatchObject({ amountCents: 32_000, updatedAt: later });
		expect(await countDirtyRows()).toBe(1);
	});
});
