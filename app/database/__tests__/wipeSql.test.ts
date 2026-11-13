/**
 * "Apagar todos os dados" (SPD-082, DEC-35) no SQL **de verdade** de `database.ts`.
 *
 * A pergunta é o que sobra no disco depois do apagar, e isso só um SQLite responde: o
 * `expo-sqlite` vira um banco em memória do próprio Node (`node:sqlite`), como em
 * `accountSql.test.ts`. Sem `NODE_OPTIONS=--experimental-sqlite` a suíte é pulada com um
 * aviso.
 *
 * O que o DEC-35 pede: apagar de verdade (nada de lápide carregando conteúdo), manter as
 * categorias e o que o app aprendeu por estabelecimento, não deixar nada sujo para subir,
 * e lembrar só a impressão digital de cada aviso — para a mesma notificação do banco
 * nunca virar dinheiro duas vezes.
 */

jest.mock('expo-sqlite', () => {
	const { createRequire } = jest.requireActual('module');
	let DatabaseSync:
		| (new (
				path: string
		  ) => {
				exec: (sql: string) => void;
				prepare: (sql: string) => {
					run: (...params: unknown[]) => {
						changes: number | bigint;
						lastInsertRowid: number | bigint;
					};
					get: (...params: unknown[]) => unknown;
					all: (...params: unknown[]) => unknown[];
				};
		  })
		| null = null;
	try {
		DatabaseSync = createRequire(__filename)('node:sqlite').DatabaseSync;
	} catch {
		DatabaseSync = null;
	}
	const normalise = (params: unknown[] = []) =>
		params.map((value) =>
			typeof value === 'boolean' ? (value ? 1 : 0) : value === undefined ? null : value
		);
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
					return {
						changes: Number(result.changes),
						lastInsertRowId: Number(result.lastInsertRowid),
					};
				},
				getFirstAsync: async (sql: string, params: unknown[] = []) =>
					raw.prepare(sql).get(...normalise(params)) ?? null,
				getAllAsync: async (sql: string, params: unknown[] = []) =>
					raw.prepare(sql).all(...normalise(params)),
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

import AsyncStorage from '@react-native-async-storage/async-storage';
import { KNOWN_WIPE_AT_KEY } from '../../sync/types';
import { STORAGE_KEYS } from '../../utils/storageUtils';
import { getStatementFingerprints, hasCaptureFingerprint, insertCapture } from '../captures';
import {
	countDirtyRows,
	db,
	getSyncState,
	initDatabase,
	reconcilePreferences,
	setSyncState,
	WIPE_DELETED_TABLES,
	WIPE_KEPT_TABLES,
	wipeLocalData,
} from '../database';
import { type Capture, SYNCED_TABLES } from '../schema';

const sqliteAvailable: boolean = jest.requireMock<{ mockSqliteAvailable: boolean }>(
	'expo-sqlite'
).mockSqliteAvailable;
if (!sqliteAvailable) {
	console.warn('wipeSql.test.ts pulado: rode com NODE_OPTIONS=--experimental-sqlite (Node 22.12).');
}
const describeSql = sqliteAvailable ? describe : describe.skip;

const T = '2026-10-20T12:00:00.000Z';
const DEAD = '2026-10-21T12:00:00.000Z';

let counter = 0;
const capture = (overrides: Partial<Capture>): Omit<Capture, 'id' | 'createdAt' | 'updatedAt'> => {
	counter += 1;
	return {
		fingerprint: `fp-${counter}`,
		packageName: 'com.nu.production',
		appLabel: 'Nubank',
		title: 'Compra aprovada',
		text: 'Compra de R$ 52,90 na PADARIA, cartão final 6422',
		postedAt: '2026-10-20T12:00:00.000Z',
		amountCents: 5290,
		direction: 'out',
		kind: 'purchase',
		counterparty: 'PADARIA',
		merchantKey: 'padaria',
		cardLast4: '6422',
		status: 'pending',
		question: null,
		relatedId: null,
		suggestedCategory: 'food',
		transactionId: null,
		autoConfirmed: false,
		reason: null,
		accountId: null,
		transferId: null,
		installments: null,
		...overrides,
	};
};

/** Uma linha viva e uma lápide em cada tabela de dado, e a caixa de entrada com texto cru. */
const seedLedger = async () => {
	await db.execAsync(`
    INSERT INTO categories (id, name, color, icon, type, nature, updatedAt, deletedAt, dirty)
      VALUES ('minha', 'Minha categoria', '#000', 'star', 'expense', 'discretionary', '${T}', NULL, 0);
    INSERT INTO accounts (id, name, openingBalanceDate, updatedAt, deletedAt, dirty)
      VALUES ('a1', 'Nubank', '2026-01-01', '${T}', NULL, 1), ('a0', 'Velha', '2026-01-01', '${T}', '${DEAD}', 1);
    INSERT INTO transactions (id, amountCents, category, date, note, isIncome, accountId, updatedAt, deletedAt, dirty)
      VALUES ('t1', 5290, 'minha', '2026-10-20', 'padaria', 0, 'a1', '${T}', NULL, 1),
             ('t0', 100, 'food', '2026-10-01', 'apagada', 0, 'a1', '${T}', '${DEAD}', 1);
    INSERT INTO transfers (id, fromAccountId, toAccountId, amountCents, date, updatedAt, deletedAt, dirty)
      VALUES ('x1', 'a1', 'a0', 1000, '2026-10-20', '${T}', NULL, 1);
    INSERT INTO recurring_transactions (id, amountCents, isIncome, note, category, recurrenceType, day, updatedAt, deletedAt, dirty)
      VALUES ('r1', 15000, 0, 'aluguel', 'minha', 'monthly', 5, '${T}', NULL, 1);
    INSERT INTO budgets (id, year, month, amountCents, updatedAt, deletedAt, dirty)
      VALUES ('b1', 2026, 10, 300000, '${T}', NULL, 1);
    INSERT INTO retirement_goals (id, targetMonthlyCents, updatedAt, deletedAt, dirty)
      VALUES ('retirement', 1000000, '${T}', NULL, 1);
    INSERT INTO reserve_goals (id, targetMonths, updatedAt, deletedAt, dirty)
      VALUES ('emergency', 6, '${T}', NULL, 1);
    INSERT INTO debts (id, name, openingBalanceCents, openingBalanceDate, installmentCents, remainingAtOpening, installmentsTotal, dueDay, updatedAt, deletedAt, dirty)
      VALUES ('d1', 'Carro', 4000000, '2026-01-01', 150000, 30, 48, 10, '${T}', NULL, 1);
    INSERT INTO bills (id, name, dueDay, amountCents, debtId, updatedAt, deletedAt, dirty)
      VALUES ('c1', 'Luz', 15, 20000, NULL, '${T}', NULL, 1), ('c2', 'Carro', 10, 150000, 'd1', '${T}', NULL, 1);
    INSERT INTO merchant_rules (merchantKey, categoryId, treatAs, confirmations, updatedAt, deletedAt, dirty)
      VALUES ('padaria', 'minha', 'transaction', 3, '${T}', NULL, 0),
             ('app:com.whatsapp', NULL, 'ignore', 3, '${T}', NULL, 0);
    INSERT INTO preferences (key, value, updatedAt, deletedAt, dirty)
      VALUES ('${STORAGE_KEYS.selectedCurrency}', 'BRL', '${T}', NULL, 0),
             ('${STORAGE_KEYS.language}', 'pt', '${T}', NULL, 0),
             ('${STORAGE_KEYS.distinctAccountPairs}', '[["a1","a0"]]', '${T}', NULL, 0),
             ('${STORAGE_KEYS.businessFeeds}', '{"com.nu.production":"a1"}', '${T}', NULL, 1),
             ('${STORAGE_KEYS.captureChoices}', '{"com.nu.production|debit_unknown_last4|6422":"a1"}', '${T}', NULL, 0);
  `);
	// O que sobra de categoria e regra já subiu: só o que o apagar mexer pode ficar sujo.
	await db.execAsync('UPDATE categories SET dirty = 0;');

	await insertCapture(capture({ fingerprint: 'fp-pendente' }));
	await insertCapture(
		capture({
			fingerprint: 'fp-confirmada',
			status: 'confirmed',
			transactionId: 't1',
			accountId: 'a1',
		})
	);
	await insertCapture(capture({ fingerprint: 'fp-podada', status: 'dismissed', reason: 'manual' }));
	await db.runAsync(`UPDATE captures SET deletedAt = ? WHERE fingerprint = 'fp-podada'`, [DEAD]);
	await insertCapture(
		capture({ fingerprint: 'ofx:a1:FIT123', packageName: 'ofx', appLabel: 'Extrato' })
	);
};

const countRows = async (table: string): Promise<number> =>
	(await db.getFirstAsync<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`))?.count ?? 0;

describeSql('apagar todos os dados, SQL de verdade (SPD-082)', () => {
	beforeAll(async () => {
		jest.spyOn(console, 'log').mockImplementation(() => undefined);
		await initDatabase();
	});
	beforeEach(async () => {
		jest.clearAllMocks();
		for (const table of [
			...WIPE_DELETED_TABLES,
			'merchant_rules',
			'preferences',
			'sync_state',
			'seen_capture_fingerprints',
		]) {
			await db.execAsync(`DELETE FROM ${table};`);
		}
		await db.execAsync("DELETE FROM categories WHERE id = 'minha';");
		await seedLedger();
	});

	it('toda tabela sincronizada está numa das duas listas — uma tabela nova não fica de fora calada', () => {
		expect([...WIPE_DELETED_TABLES, ...WIPE_KEPT_TABLES].sort()).toEqual([...SYNCED_TABLES].sort());
		expect(WIPE_KEPT_TABLES).toEqual(['categories', 'merchant_rules', 'preferences']);
	});

	it('não sobra linha nenhuma nas tabelas de dado — nem viva, nem lápide', async () => {
		await wipeLocalData();

		for (const table of WIPE_DELETED_TABLES) {
			expect([table, await countRows(table)]).toEqual([table, 0]);
		}
	});

	it('as categorias ficam, as do usuário inclusive: as regras aprendidas apontam para elas', async () => {
		const before = await countRows('categories');
		await wipeLocalData();

		expect(await countRows('categories')).toBe(before);
		expect(await db.getFirstAsync("SELECT id FROM categories WHERE id = 'minha'")).toEqual({
			id: 'minha',
		});
	});

	it('o que o app aprendeu por estabelecimento fica, como estava', async () => {
		await wipeLocalData();

		const rules = await db.getAllAsync<{
			merchantKey: string;
			categoryId: string | null;
			confirmations: number;
		}>('SELECT merchantKey, categoryId, confirmations FROM merchant_rules ORDER BY merchantKey');
		expect(rules).toEqual([
			{ merchantKey: 'app:com.whatsapp', categoryId: null, confirmations: 3 },
			{ merchantKey: 'padaria', categoryId: 'minha', confirmations: 3 },
		]);
	});

	it('nada fica sujo para subir: nenhuma lápide, nada do que foi apagado', async () => {
		expect(await countDirtyRows()).toBeGreaterThan(0);

		await wipeLocalData();

		expect(await countDirtyRows()).toBe(0);
		expect(
			await db.getFirstAsync('SELECT COUNT(*) AS count FROM categories WHERE deletedAt IS NOT NULL')
		).toEqual({ count: 0 });
		expect(
			await db.getFirstAsync(
				'SELECT COUNT(*) AS count FROM merchant_rules WHERE deletedAt IS NOT NULL'
			)
		).toEqual({ count: 0 });
	});

	it('uma edição de categoria que ainda não subiu continua por subir: a categoria fica, a edição também', async () => {
		await db.execAsync("UPDATE categories SET dirty = 1 WHERE id = 'minha';");

		await wipeLocalData();

		expect(await db.getFirstAsync("SELECT dirty FROM categories WHERE id = 'minha'")).toEqual({
			dirty: 1,
		});
	});

	it('o aviso apagado continua conhecido: a mesma notificação não vira dinheiro de novo', async () => {
		await wipeLocalData();

		expect(await hasCaptureFingerprint('fp-pendente')).toBe(true);
		expect(await hasCaptureFingerprint('fp-confirmada')).toBe(true);
		expect(await hasCaptureFingerprint('fp-podada')).toBe(true);
		expect(await hasCaptureFingerprint('fp-nunca-visto')).toBe(false);
	});

	it('da captura sobra só a impressão digital: nem texto, nem valor, nem estabelecimento', async () => {
		await wipeLocalData();

		const columns = (
			await db.getAllAsync<{ name: string }>('PRAGMA table_info(seen_capture_fingerprints)')
		).map((c) => c.name);
		expect(columns.sort()).toEqual(['fingerprint', 'seenAt']);
	});

	it('os avisos que estavam na fila nativa, descartados sem virar captura, também ficam conhecidos', async () => {
		await wipeLocalData({ seenFingerprints: ['fp-na-fila', 'fp-pendente'] });

		expect(await hasCaptureFingerprint('fp-na-fila')).toBe(true);
		expect(await countRows('captures')).toBe(0);
	});

	it('a linha de extrato não fica: a conta dela foi apagada, e reimportar o extrato traz o mês de volta', async () => {
		await wipeLocalData();

		expect(await hasCaptureFingerprint('ofx:a1:FIT123')).toBe(false);
		expect(await getStatementFingerprints()).toEqual(new Set());
	});

	it('apagar duas vezes não falha: a impressão digital que já estava guardada não duplica', async () => {
		await wipeLocalData({ seenFingerprints: ['fp-x'] });
		await insertCapture(capture({ fingerprint: 'fp-x' }));
		await wipeLocalData({ seenFingerprints: ['fp-x'] });

		expect(
			await db.getFirstAsync(
				"SELECT COUNT(*) AS count FROM seen_capture_fingerprints WHERE fingerprint = 'fp-x'"
			)
		).toEqual({ count: 1 });
	});

	// SPD-132: as escolhas aprendidas nos avisos ambíguos (SPD-123) também guardam ids de
	// contas, que este apagar some com elas.
	it('preferências: saem só as três presas a contas, sem lápide; a configuração fica', async () => {
		await wipeLocalData();

		const rows = await db.getAllAsync<{ key: string; deletedAt: string | null }>(
			'SELECT key, deletedAt FROM preferences ORDER BY key'
		);
		expect(rows).toEqual([
			{ key: STORAGE_KEYS.language, deletedAt: null },
			{ key: STORAGE_KEYS.selectedCurrency, deletedAt: null },
		]);
		expect(AsyncStorage.multiRemove).toHaveBeenCalledWith(
			expect.arrayContaining([
				STORAGE_KEYS.distinctAccountPairs,
				STORAGE_KEYS.businessFeeds,
				STORAGE_KEYS.captureChoices,
			])
		);
		const removed = (AsyncStorage.multiRemove as jest.Mock).mock.calls.flat(2) as string[];
		for (const kept of [
			STORAGE_KEYS.selectedCurrency,
			STORAGE_KEYS.language,
			STORAGE_KEYS.cdiRate,
			STORAGE_KEYS.notificationsEnabled,
			STORAGE_KEYS.diagnosticsInstallId,
			STORAGE_KEYS.captureAccessDismissed,
			STORAGE_KEYS.accountReminderDismissed,
			'@spendr_biometric_enabled',
			'@spendr_onboarding_completed',
		]) {
			expect(removed).not.toContain(kept);
		}
	});

	it('depois do apagar, a conferência das preferências não inventa lápide para as chaves que saíram', async () => {
		await wipeLocalData();
		// O AsyncStorage depois do apagar: a configuração continua lá, as três chaves saíram.
		const left: Record<string, string> = {
			[STORAGE_KEYS.selectedCurrency]: 'BRL',
			[STORAGE_KEYS.language]: 'pt',
		};
		(AsyncStorage.multiGet as jest.Mock).mockImplementationOnce(async (keys: string[]) =>
			keys.map((key) => [key, left[key] ?? null])
		);

		expect(await reconcilePreferences()).toBe(0);
		expect(await countDirtyRows()).toBe(0);
	});

	it('com conta: o `dataWipedAt` do servidor fica guardado ao lado do cursor, que continua', async () => {
		await setSyncState('pullCursor@22', '{"transactions":42}');

		await wipeLocalData({ knownWipeAt: '2026-10-27T10:00:00.000Z' });

		expect(await getSyncState(KNOWN_WIPE_AT_KEY)).toBe('2026-10-27T10:00:00.000Z');
		expect(await getSyncState('pullCursor@22')).toBe('{"transactions":42}');
	});

	it('sem conta: não grava marca de apagar nenhuma', async () => {
		await wipeLocalData();

		expect(await getSyncState(KNOWN_WIPE_AT_KEY)).toBeNull();
	});
});
