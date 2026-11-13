/**
 * Os meses das contas a pagar (v23, SPD-146) no SQL **de verdade** de `database.ts`.
 *
 * A tabela `bill_payments` guarda o mês pulado e o pago fora de ordem; ela nasce no passo 23
 * da escada, sobe no sync como as outras (suja até o servidor aceitar) e recebe o que vem do
 * servidor sem deixar uma versão velha passar por cima da nova. O `expo-sqlite` vira um banco
 * em memória do próprio Node (`node:sqlite`), como em `capturesSql.test.ts`. Sem
 * `NODE_OPTIONS=--experimental-sqlite` a suíte é pulada com um aviso.
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
}));

import type { SyncChanges, WireBillPayment } from '../../sync/types';
import {
	applyMigrations,
	applyPulledChanges,
	db,
	getBillPayments,
	getDirtyChanges,
	initDatabase,
	markChangesClean,
	migrationLadder,
	restoreBillPayment,
	saveBillPayments,
} from '../database';
import type { BillPaymentDraft } from '../schema';

const sqliteAvailable: boolean = jest.requireMock<{ mockSqliteAvailable: boolean }>(
	'expo-sqlite'
).mockSqliteAvailable;
if (!sqliteAvailable) {
	console.warn(
		'billPaymentsSql.test.ts pulado: rode com NODE_OPTIONS=--experimental-sqlite (Node 22.12).'
	);
}
const describeSql = sqliteAvailable ? describe : describe.skip;

const skipped = (overrides: Partial<BillPaymentDraft> = {}): BillPaymentDraft => ({
	id: 'plano-outubro',
	billId: 'plano',
	month: '2026-10',
	status: 'skipped',
	transactionId: null,
	amountCents: null,
	...overrides,
});

const paid = (overrides: Partial<BillPaymentDraft> = {}): BillPaymentDraft => ({
	id: 'plano-novembro',
	billId: 'plano',
	month: '2026-11',
	status: 'paid',
	transactionId: 'lancamento-novembro',
	amountCents: 50_000,
	...overrides,
});

const wire = (overrides: Partial<WireBillPayment> = {}): WireBillPayment => ({
	id: 'plano-outubro',
	billId: 'plano',
	month: '2026-10',
	status: 'skipped',
	transactionId: null,
	amountCents: null,
	updatedAt: '2026-11-11T12:00:00.000Z',
	deletedAt: null,
	...overrides,
});

const pulled = (billPayments: WireBillPayment[]): SyncChanges => ({
	categories: [],
	transactions: [],
	recurringTransactions: [],
	budgets: [],
	billPayments,
});

type Row = {
	id: string;
	month: string;
	status: string;
	transactionId: string | null;
	amountCents: number | null;
	updatedAt: string;
	deletedAt: string | null;
	dirty: number;
};
const rows = async (): Promise<Row[]> =>
	db.getAllAsync<Row>(
		'SELECT id, month, status, transactionId, amountCents, updatedAt, deletedAt, dirty FROM bill_payments ORDER BY month'
	);

describeSql('os meses das contas a pagar, SQL de verdade (SPD-146)', () => {
	beforeAll(async () => {
		jest.spyOn(console, 'log').mockImplementation(() => undefined);
		await initDatabase();
	});
	beforeEach(async () => {
		await db.execAsync('DELETE FROM bill_payments;');
	});

	it('o passo 23 da escada cria a tabela num banco que estava no v22', async () => {
		await db.execAsync('DROP TABLE bill_payments;');
		const versions: number[] = [];

		const reached = await applyMigrations(22, migrationLadder(), async (version) => {
			versions.push(version);
		});

		expect(reached).toBe(23);
		expect(versions).toEqual([23]);
		const columns = (
			await db.getAllAsync<{ name: string }>('PRAGMA table_info(bill_payments)')
		).map((c) => c.name);
		expect(columns.sort()).toEqual(
			[
				'amountCents',
				'billId',
				'deletedAt',
				'dirty',
				'id',
				'month',
				'status',
				'transactionId',
				'updatedAt',
			].sort()
		);
	});

	it('gravar um mês: entra sujo, e a leitura devolve os vivos em ordem de mês', async () => {
		await saveBillPayments([paid(), skipped()]);

		expect(
			(await getBillPayments()).map((payment) => [
				payment.month,
				payment.status,
				payment.transactionId,
			])
		).toEqual([
			['2026-10', 'skipped', null],
			['2026-11', 'paid', 'lancamento-novembro'],
		]);
		expect((await rows()).map((row) => row.dirty)).toEqual([1, 1]);
	});

	it('desfazer vira lápide: some da leitura, mas sobe no próximo push', async () => {
		await saveBillPayments([skipped()]);
		await saveBillPayments([], ['plano-outubro']);

		expect(await getBillPayments()).toEqual([]);
		const [row] = await rows();
		expect(row.deletedAt).not.toBeNull();
		expect(row.dirty).toBe(1);
		const dirty = await getDirtyChanges(100);
		expect(dirty.billPayments).toEqual([
			expect.objectContaining({ id: 'plano-outubro', status: 'skipped', deletedAt: row.deletedAt }),
		]);
	});

	it('marcar de novo o mesmo mês cai na mesma linha e tira a lápide', async () => {
		await saveBillPayments([skipped()]);
		await saveBillPayments([], ['plano-outubro']);
		const [tombstone] = await rows();
		await saveBillPayments([
			skipped({ status: 'paid', transactionId: 'pix', amountCents: 50_000 }),
		]);

		const [row] = await rows();
		expect(row).toMatchObject({
			id: 'plano-outubro',
			status: 'paid',
			transactionId: 'pix',
			amountCents: 50_000,
			deletedAt: null,
			dirty: 1,
		});
		// O carimbo anda para frente da lápide: o servidor fica com a volta, não com o desfazer.
		expect(row.updatedAt > tombstone.updatedAt).toBe(true);
	});

	it('o push leva o mês no formato do fio, e o que subiu sai limpo', async () => {
		await saveBillPayments([paid()]);
		const dirty = await getDirtyChanges(100);
		expect(dirty.billPayments).toEqual([
			{
				id: 'plano-novembro',
				billId: 'plano',
				month: '2026-11',
				status: 'paid',
				transactionId: 'lancamento-novembro',
				amountCents: 50_000,
				updatedAt: expect.any(String),
				deletedAt: null,
			},
		]);

		await markChangesClean(dirty);

		expect((await rows()).map((row) => row.dirty)).toEqual([0]);
		expect((await getDirtyChanges(100)).billPayments).toEqual([]);
	});

	it('mudou depois de subir: a linha continua suja (o carimbo não bate)', async () => {
		await saveBillPayments([paid()]);
		const dirty = await getDirtyChanges(100);
		await saveBillPayments([paid({ amountCents: 51_000 })]);

		await markChangesClean(dirty);

		expect((await rows()).map((row) => [row.amountCents, row.dirty])).toEqual([[51_000, 1]]);
	});

	it('o pull grava o mês limpo, e a lápide que chega desfaz aqui também', async () => {
		await applyPulledChanges(pulled([wire()]));
		expect((await getBillPayments()).map((payment) => payment.month)).toEqual(['2026-10']);
		expect((await rows())[0].dirty).toBe(0);

		await applyPulledChanges(
			pulled([
				wire({ updatedAt: '2026-11-12T12:00:00.000Z', deletedAt: '2026-11-12T12:00:00.000Z' }),
			])
		);

		expect(await getBillPayments()).toEqual([]);
		expect((await rows())[0]).toMatchObject({ deletedAt: '2026-11-12T12:00:00.000Z', dirty: 0 });
	});

	it('o pull não passa uma versão velha por cima da local mais nova', async () => {
		await saveBillPayments([skipped()]);
		const [local] = await rows();

		await applyPulledChanges(
			pulled([
				wire({
					status: 'paid',
					transactionId: 'velho',
					amountCents: 1,
					updatedAt: '2020-01-01T00:00:00.000Z',
				}),
			])
		);

		expect((await rows())[0]).toMatchObject({
			status: 'skipped',
			transactionId: null,
			updatedAt: local.updatedAt,
			dirty: 1,
		});
	});

	it('restaurar do backup grava com o id do arquivo, sujo, e passa por cima de uma lápide', async () => {
		await saveBillPayments([skipped()]);
		await saveBillPayments([], ['plano-outubro']);
		const [tombstone] = await rows();

		await restoreBillPayment(skipped());

		const [row] = await rows();
		expect(row).toMatchObject({
			id: 'plano-outubro',
			status: 'skipped',
			deletedAt: null,
			dirty: 1,
		});
		expect(row.updatedAt > tombstone.updatedAt).toBe(true);
	});
});
