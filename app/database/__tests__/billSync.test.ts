/**
 * Contas a pagar (v20), lidas pelo SQL que `database.ts` manda para o banco.
 *
 * Mesmo dublê de `captureSync.test.ts`: o `expo-sqlite` anota cada comando e responde o
 * que cada teste programar. O que está em jogo são comandos que precisam existir — a
 * tabela nova na escada, a lápide em vez do DELETE, a marca de "ainda não subiu" — e o
 * `ensureDebtBills`, que mantém uma conta a pagar por dívida ativa sem mexer no que só a
 * conta a pagar sabe (o mês pago).
 */

interface Statement {
	sql: string;
	params: unknown[];
}

const mockStatements: Statement[] = [];
/** Resposta programável do `getFirstAsync`, por teste. */
let mockOnFirst: (sql: string, params: unknown[]) => unknown = () => null;
/** Resposta programável do `getAllAsync`, por teste. */
let mockOnAll: (sql: string, params: unknown[]) => unknown[] = () => [];
/** O id que `generateUniqueId` devolve enquanto o teste roda. */
let mockNextId = 'bill-novo';

jest.mock('expo-sqlite', () => ({
	openDatabaseSync: () => ({
		execAsync: jest.fn(async (sql: string) => {
			mockStatements.push({ sql, params: [] });
		}),
		runAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
			mockStatements.push({ sql, params });
			return { changes: 0, lastInsertRowId: 0 };
		}),
		getFirstAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
			mockStatements.push({ sql, params });
			return mockOnFirst(sql, params);
		}),
		getAllAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
			mockStatements.push({ sql, params });
			return mockOnAll(sql, params);
		}),
		withTransactionAsync: jest.fn(async (body: () => Promise<void>) => {
			mockStatements.push({ sql: 'BEGIN', params: [] });
			await body();
			mockStatements.push({ sql: 'COMMIT', params: [] });
		}),
	}),
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
	getItem: jest.fn(async () => null),
	setItem: jest.fn(async () => undefined),
	removeItem: jest.fn(async () => undefined),
}));

jest.mock('../../utils/categoryEditUtils', () => ({
	__esModule: true,
	generateUniqueId: () => mockNextId,
	default: () => mockNextId,
}));

import type { SyncChanges, WireBill } from '../../sync/types';
import {
	addBill,
	applyMigrations,
	applyPulledChanges,
	deleteBill,
	ensureDebtBills,
	getBills,
	getDirtyChanges,
	markChangesClean,
	migrationLadder,
	resetDatabase,
	restoreBill,
	updateBill,
} from '../database';
import { type BillDraft, type Debt, SCHEMA_VERSION, SYNCED_TABLES } from '../schema';

const reset = () => {
	mockStatements.length = 0;
	mockOnFirst = () => null;
	mockOnAll = () => [];
	mockNextId = 'bill-novo';
};

beforeEach(reset);

/** Os comandos de um tipo, pelo que o SQL menciona. */
const matching = (...needles: string[]): Statement[] =>
	mockStatements.filter((statement) => needles.every((needle) => statement.sql.includes(needle)));

const flat = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

/** Uma linha de `bills` como a tabela a guarda. */
const billRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
	id: 'bill-1',
	name: 'Celular',
	dueDay: 10,
	amountCents: null,
	accountId: 'conta-1',
	category: 'phone',
	matchHint: 'tim,claro',
	debtId: null,
	paidThrough: '2026-09',
	paidByRef: 'tx-9',
	active: 1,
	sortOrder: 2,
	updatedAt: '2026-10-01T00:00:00.000Z',
	deletedAt: null,
	dirty: 1,
	...overrides,
});

const draft = (overrides: Partial<BillDraft> = {}): BillDraft => ({
	name: 'Internet',
	dueDay: 31,
	amountCents: 9_990,
	accountId: null,
	category: null,
	matchHint: null,
	debtId: null,
	paidThrough: null,
	paidByRef: null,
	active: true,
	sortOrder: 0,
	...overrides,
});

const debt = (overrides: Partial<Debt> = {}): Debt => ({
	id: 'debt-carro',
	name: 'Financiamento do carro',
	kind: 'financing',
	system: 'price',
	openingBalanceCents: 4_000_000,
	openingBalanceDate: '2026-09-15',
	installmentCents: 150_000,
	remainingAtOpening: 36,
	installmentsTotal: 48,
	dueDay: 15,
	rateBp: 1_800,
	feeCents: 0,
	adminFeeBp: null,
	accountId: 'conta-1',
	category: 'vehicle',
	archived: false,
	sortOrder: 0,
	updatedAt: '2026-09-15T00:00:00.000Z',
	...overrides,
});

const wireBill = (overrides: Partial<WireBill> = {}): WireBill => ({
	id: 'bill-1',
	name: 'Celular',
	dueDay: 10,
	amountCents: null,
	accountId: null,
	category: null,
	matchHint: null,
	debtId: null,
	paidThrough: '2026-10',
	paidByRef: 'tx-10',
	active: true,
	sortOrder: 0,
	updatedAt: '2026-10-10T00:00:00.000Z',
	deletedAt: null,
	...overrides,
});

const emptyChanges = (overrides: Partial<SyncChanges> = {}): SyncChanges => ({
	categories: [],
	transactions: [],
	recurringTransactions: [],
	budgets: [],
	...overrides,
});

// ---------------------------------------------------------------------------
// A migração v20
// ---------------------------------------------------------------------------

describe('migração v20', () => {
	it('a escada chega ao v20 e o passo 20 cria a tabela `bills` com as colunas de sync', async () => {
		// O v21 (preferências) veio depois; o passo 20 continua no lugar dele.
		expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(20);
		const ladder = migrationLadder();
		expect(ladder.map(([version]) => version)).toEqual(
			Array.from({ length: SCHEMA_VERSION }, (_, index) => index + 1)
		);

		const [version, run] = ladder[19];
		expect(version).toBe(20);
		await run();

		const created = matching('CREATE TABLE IF NOT EXISTS bills');
		expect(created).toHaveLength(1);
		const sql = flat(created[0].sql);
		expect(sql).toContain('id TEXT PRIMARY KEY NOT NULL');
		expect(sql).toContain('amountCents INTEGER,');
		expect(sql).toContain('updatedAt TEXT NOT NULL');
		expect(sql).toContain('deletedAt TEXT');
		expect(sql).toContain('dirty INTEGER NOT NULL DEFAULT 1');
		// Aditiva: nada é reconstruído, alterado nem apagado.
		expect(matching('DROP')).toEqual([]);
		expect(matching('ALTER TABLE')).toEqual([]);
		expect(matching('DELETE FROM')).toEqual([]);
	});

	it('um banco v19 roda o passo 20 (e o 21, que veio depois) e grava a versão em cada um', async () => {
		const versions: number[] = [];
		const reached = await applyMigrations(19, migrationLadder(), async (target) => {
			versions.push(target);
		});

		expect(reached).toBe(SCHEMA_VERSION);
		expect(versions).toEqual([20, 21]);
		// Só os CREATE das tabelas novas: nenhum passo anterior repetido.
		expect(mockStatements.map((statement) => flat(statement.sql).split(' (')[0])).toEqual([
			'CREATE TABLE IF NOT EXISTS bills',
			'CREATE TABLE IF NOT EXISTS preferences',
		]);
	});

	it('um banco v20 não refaz o passo 20', async () => {
		const versions: number[] = [];
		const reached = await applyMigrations(20, migrationLadder(), async (target) => {
			versions.push(target);
		});

		expect(reached).toBe(SCHEMA_VERSION);
		expect(versions).not.toContain(20);
		expect(matching('bills')).toEqual([]);
	});

	it('`bills` entra no sync', () => {
		expect(SYNCED_TABLES).toContain('bills');
	});
});

describe('a abertura do banco', () => {
	const openAt = async (userVersion: number): Promise<string[]> => {
		mockOnFirst = (sql) =>
			sql.includes('PRAGMA user_version') ? { user_version: userVersion } : null;
		// Um módulo novo por abertura: `initDatabase` guarda a promessa da primeira.
		let fresh: typeof import('../database') | null = null;
		jest.isolateModules(() => {
			fresh = require('../database');
		});
		await (fresh as unknown as typeof import('../database')).initDatabase();
		return mockStatements.map((statement) => flat(statement.sql));
	};

	it('v19 migra para o v20, e a abertura também garante a tabela', async () => {
		const statements = await openAt(19);
		expect(statements).toContain('PRAGMA user_version = 20');
		expect(statements).toContain('PRAGMA user_version = 21');
		expect(
			statements.filter((sql) => sql.includes('CREATE TABLE IF NOT EXISTS bills'))
		).toHaveLength(2);
		expect(statements.some((sql) => sql.includes('idx_bills_dirty'))).toBe(true);
	});

	it('v20 migra para o v21 sem tocar em `bills` além do CREATE IF NOT EXISTS da abertura', async () => {
		const statements = await openAt(20);
		expect(statements).toContain('PRAGMA user_version = 21');
		expect(statements.filter((sql) => sql.includes('CREATE TABLE IF NOT EXISTS bills'))).toHaveLength(1);
		expect(statements.filter((sql) => sql.includes('CREATE TABLE IF NOT EXISTS preferences'))).toHaveLength(2);
	});

	it('a versão atual não grava versão nenhuma', async () => {
		const statements = await openAt(SCHEMA_VERSION);
		expect(statements.filter((sql) => sql.startsWith('PRAGMA user_version ='))).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

describe('CRUD de contas a pagar', () => {
	it('lista só as vivas, por sortOrder e nome, convertendo os tipos', async () => {
		mockOnAll = () => [
			billRow(),
			billRow({ id: 'bill-2', name: 'Luz', amountCents: 12_000, active: 0 }),
		];

		const bills = await getBills();

		const read = matching('FROM bills');
		expect(read).toHaveLength(1);
		expect(flat(read[0].sql)).toBe(
			'SELECT * FROM bills WHERE deletedAt IS NULL ORDER BY sortOrder ASC, name ASC'
		);
		expect(bills[0]).toEqual({
			id: 'bill-1',
			name: 'Celular',
			dueDay: 10,
			amountCents: null,
			accountId: 'conta-1',
			category: 'phone',
			matchHint: 'tim,claro',
			debtId: null,
			paidThrough: '2026-09',
			paidByRef: 'tx-9',
			active: true,
			sortOrder: 2,
			updatedAt: '2026-10-01T00:00:00.000Z',
			deletedAt: undefined,
		});
		expect(bills[1].active).toBe(false);
		expect(bills[1].amountCents).toBe(12_000);
	});

	it('adicionar grava suja, com id novo, e o valor nulo continua nulo', async () => {
		const id = await addBill(draft({ amountCents: null, matchHint: 'vivo' }));

		expect(id).toBe('bill-novo');
		const inserted = matching('INSERT INTO bills');
		expect(inserted).toHaveLength(1);
		expect(flat(inserted[0].sql)).toContain('NULL, 1)');
		expect(inserted[0].params[0]).toBe('bill-novo');
		// name, dueDay, amountCents, accountId, category, matchHint, debtId, paidThrough,
		// paidByRef, active, sortOrder, updatedAt
		expect(inserted[0].params.slice(1, 12)).toEqual([
			'Internet',
			31,
			null,
			null,
			null,
			'vivo',
			null,
			null,
			null,
			1,
			0,
		]);
	});

	it('atualizar marca suja e avança o updatedAt', async () => {
		await updateBill(
			'bill-1',
			draft({ paidThrough: '2026-10', paidByRef: 'tx-10', active: false })
		);

		const updated = matching('UPDATE bills');
		expect(updated).toHaveLength(1);
		const sql = flat(updated[0].sql);
		expect(sql).toContain('updatedAt = ?');
		expect(sql).toContain('dirty = 1');
		expect(sql).toContain('WHERE id = ?');
		expect(updated[0].params).toContain('2026-10');
		expect(updated[0].params).toContain('tx-10');
		expect(updated[0].params.at(-1)).toBe('bill-1');
	});

	it('apagar é lápide suja, nunca DELETE', async () => {
		await deleteBill('bill-1');

		expect(matching('DELETE FROM bills')).toEqual([]);
		const tombstoned = matching('UPDATE bills SET deletedAt = ?');
		expect(tombstoned).toHaveLength(1);
		expect(flat(tombstoned[0].sql)).toContain('dirty = 1');
		expect(flat(tombstoned[0].sql)).toContain('deletedAt IS NULL');
		expect(tombstoned[0].params.at(-1)).toBe('bill-1');
	});

	it('restaurar do backup ressuscita a lápide e grava com o id do arquivo', async () => {
		await restoreBill(draft(), 'bill-do-arquivo');

		const removed = matching('DELETE FROM bills');
		expect(removed).toHaveLength(1);
		expect(removed[0].sql).toContain('deletedAt IS NOT NULL');
		expect(removed[0].params).toEqual(['bill-do-arquivo']);
		const inserted = matching('INSERT INTO bills');
		expect(inserted[0].params[0]).toBe('bill-do-arquivo');
	});

	it('"apagar meus dados" põe lápide nas contas a pagar também', async () => {
		await resetDatabase();
		const tombstoned = matching('UPDATE bills SET deletedAt = ?');
		expect(tombstoned).toHaveLength(1);
		expect(tombstoned[0].sql).toContain('WHERE deletedAt IS NULL');
	});
});

// ---------------------------------------------------------------------------
// Sync: coleta e aplicação
// ---------------------------------------------------------------------------

describe('o sync de contas a pagar', () => {
	it('coleta as sujas no formato do fio', async () => {
		mockOnAll = (sql) =>
			sql.includes('FROM bills') ? [billRow({ deletedAt: '2026-10-02T00:00:00.000Z' })] : [];

		const changes = await getDirtyChanges(500);

		expect(matching('FROM bills WHERE dirty = 1')).toHaveLength(1);
		expect(changes.bills).toEqual([
			{
				id: 'bill-1',
				name: 'Celular',
				dueDay: 10,
				amountCents: null,
				accountId: 'conta-1',
				category: 'phone',
				matchHint: 'tim,claro',
				debtId: null,
				paidThrough: '2026-09',
				paidByRef: 'tx-9',
				active: true,
				sortOrder: 2,
				updatedAt: '2026-10-01T00:00:00.000Z',
				deletedAt: '2026-10-02T00:00:00.000Z',
			},
		]);
	});

	it('aplica a remota mais nova e a grava limpa', async () => {
		mockOnFirst = (sql) =>
			sql.includes('FROM bills') ? { updatedAt: '2026-10-01T00:00:00.000Z' } : null;

		await applyPulledChanges(
			emptyChanges({ bills: [wireBill({ amountCents: 8_900, active: false })] })
		);

		const upserts = matching('INSERT INTO bills');
		expect(upserts).toHaveLength(1);
		const sql = flat(upserts[0].sql);
		expect(sql).toContain('ON CONFLICT (id) DO UPDATE SET');
		expect(sql).toContain('paidThrough = excluded.paidThrough');
		expect(sql).toContain('dirty = 0');
		expect(upserts[0].params).toEqual([
			'bill-1',
			'Celular',
			10,
			8_900,
			null,
			null,
			null,
			null,
			'2026-10',
			'tx-10',
			0,
			0,
			'2026-10-10T00:00:00.000Z',
			null,
		]);
	});

	it('last-write-wins: a local mais nova (ou empatada) fica', async () => {
		mockOnFirst = (sql) =>
			sql.includes('FROM bills') ? { updatedAt: '2026-10-10T00:00:00.000Z' } : null;

		await applyPulledChanges(emptyChanges({ bills: [wireBill()] }));

		expect(matching('INSERT INTO bills')).toEqual([]);
	});

	it('uma remota sem `deletedAt` (servidor que omite o campo) entra viva', async () => {
		const { deletedAt: _omitted, ...withoutDeletedAt } = wireBill();
		await applyPulledChanges(emptyChanges({ bills: [withoutDeletedAt as WireBill] }));

		expect(matching('INSERT INTO bills')[0].params.at(-1)).toBeNull();
	});

	it('o que o servidor aceitou fica limpo, pela versão que subiu', async () => {
		await markChangesClean(emptyChanges({ bills: [wireBill()] }));

		const cleaned = matching('UPDATE bills SET dirty = 0');
		expect(cleaned).toHaveLength(1);
		expect(cleaned[0].sql).toContain('WHERE id = ? AND updatedAt = ?');
		expect(cleaned[0].params).toEqual(['bill-1', '2026-10-10T00:00:00.000Z']);
	});
});

// ---------------------------------------------------------------------------
// Uma conta a pagar por dívida ativa
// ---------------------------------------------------------------------------

describe('ensureDebtBills', () => {
	/** As contas a pagar ligadas que o banco devolve. */
	const linked = (...rows: Array<ReturnType<typeof billRow>>) => {
		mockOnAll = (sql) => (sql.includes('FROM bills') ? rows : []);
	};

	const writes = () => [...matching('INSERT INTO bills'), ...matching('UPDATE bills')];

	it('cria a conta a pagar de uma dívida ativa que não tem nenhuma', async () => {
		linked();

		expect(await ensureDebtBills([debt()])).toBe(1);

		const inserted = matching('INSERT INTO bills');
		expect(inserted).toHaveLength(1);
		// O id é o da dívida: dois aparelhos que criam a mesma conta a pagar offline
		// convergem para uma linha só no sync, em vez de duas.
		expect(inserted[0].params.slice(0, 12)).toEqual([
			'debt-carro',
			'Financiamento do carro',
			15,
			150_000,
			'conta-1',
			'vehicle',
			null,
			'debt-carro',
			null,
			null,
			1,
			0,
		]);
		expect(flat(inserted[0].sql)).toContain('dirty');
	});

	it('não cria para dívida arquivada nem apagada', async () => {
		linked();

		expect(
			await ensureDebtBills([
				debt({ id: 'quitada', archived: true }),
				debt({ id: 'apagada', deletedAt: '2026-10-01T00:00:00.000Z' }),
			])
		).toBe(0);
		expect(writes()).toEqual([]);
	});

	it('atualiza nome, dia, valor e conta quando mudaram na dívida — e nada mais', async () => {
		linked(
			billRow({
				id: 'bill-carro',
				name: 'Carro',
				dueDay: 10,
				amountCents: 140_000,
				accountId: 'conta-velha',
				category: 'outra',
				debtId: 'debt-carro',
				paidThrough: '2026-09',
				paidByRef: 'tx-9',
			})
		);

		expect(await ensureDebtBills([debt()])).toBe(1);

		const updated = matching('UPDATE bills');
		expect(updated).toHaveLength(1);
		const sql = flat(updated[0].sql);
		expect(sql).toContain('dirty = 1');
		// O mês pago é da conta a pagar, não da dívida.
		expect(sql).not.toContain('paidThrough');
		expect(sql).not.toContain('paidByRef');
		expect(sql).not.toContain('category');
		expect(updated[0].params).toEqual([
			'Financiamento do carro',
			15,
			150_000,
			'conta-1',
			1,
			expect.any(String),
			'bill-carro',
		]);
	});

	it('é idempotente: nada mudou, nada é gravado', async () => {
		linked(
			billRow({
				id: 'debt-carro',
				name: 'Financiamento do carro',
				dueDay: 15,
				amountCents: 150_000,
				accountId: 'conta-1',
				debtId: 'debt-carro',
			})
		);

		expect(await ensureDebtBills([debt()])).toBe(0);
		expect(writes()).toEqual([]);
	});

	it('dívida arquivada desativa a conta a pagar dela', async () => {
		linked(billRow({ id: 'bill-carro', debtId: 'debt-carro', active: 1 }));

		expect(await ensureDebtBills([debt({ archived: true })])).toBe(1);

		const updated = matching('UPDATE bills');
		expect(updated).toHaveLength(1);
		expect(flat(updated[0].sql)).not.toContain('paidThrough');
		expect(updated[0].params.slice(0, 5)).toEqual(['Celular', 10, null, 'conta-1', 0]);
	});

	it('dívida apagada (lápide ou fora da lista) desativa a conta a pagar dela', async () => {
		linked(
			billRow({ id: 'bill-a', debtId: 'debt-apagada', active: 1 }),
			billRow({ id: 'bill-b', debtId: 'debt-sumiu', active: 1 })
		);

		expect(
			await ensureDebtBills([debt({ id: 'debt-apagada', deletedAt: '2026-10-01T00:00:00.000Z' })])
		).toBe(2);

		const updated = matching('UPDATE bills');
		expect(updated.map((statement) => statement.params.at(-1))).toEqual(['bill-a', 'bill-b']);
		for (const statement of updated) expect(statement.params[4]).toBe(0);
	});

	it('já desativada continua quieta', async () => {
		linked(billRow({ id: 'bill-carro', debtId: 'debt-carro', active: 0 }));

		expect(await ensureDebtBills([debt({ archived: true })])).toBe(0);
		expect(writes()).toEqual([]);
	});

	it('dívida desarquivada reativa a conta a pagar dela', async () => {
		linked(
			billRow({
				id: 'bill-carro',
				name: 'Financiamento do carro',
				dueDay: 15,
				amountCents: 150_000,
				accountId: 'conta-1',
				debtId: 'debt-carro',
				active: 0,
			})
		);

		expect(await ensureDebtBills([debt()])).toBe(1);
		expect(matching('UPDATE bills')[0].params[4]).toBe(1);
	});

	it('só olha as ligadas e vivas, dentro de uma transação', async () => {
		linked();
		await ensureDebtBills([debt()]);

		const read = matching('FROM bills');
		expect(flat(read[0].sql)).toBe(
			'SELECT * FROM bills WHERE debtId IS NOT NULL AND deletedAt IS NULL'
		);
		const begin = mockStatements.findIndex((s) => s.sql === 'BEGIN');
		const insert = mockStatements.indexOf(matching('INSERT INTO bills')[0]);
		expect(insert).toBeGreaterThan(begin);
	});
});
