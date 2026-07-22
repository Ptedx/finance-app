import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SQLite from 'expo-sqlite';
import { generateUniqueId } from '../utils/categoryEditUtils';
import { addDays, nowTimestamp, todayISO } from '../utils/dateUtils';
import {
	firstDueOnOrAfter,
	nextDueAfter,
	occurrenceId,
	occurrencesBetween,
	type RecurrenceRule,
} from '../utils/recurrence';
import { STORAGE_KEYS } from '../utils/storageUtils';
import {
	type Budget,
	type Category,
	type CategoryDraft,
	type CategoryEdit,
	type CategoryType,
	CREATE_BUDGETS_TABLE,
	CREATE_CATEGORIES_TABLE,
	CREATE_INDEXES,
	CREATE_RECURRING_TRANSACTIONS_TABLE,
	CREATE_SYNC_STATE_TABLE,
	CREATE_TRANSACTIONS_TABLE,
	DATABASE_NAME,
	DEFAULT_CATEGORIES,
	LEGACY_INCOME_CATEGORY_IDS,
	type RecurringTransaction,
	type RecurringTransactionDraft,
	type RecurringTransactionEdit,
	SCHEMA_VERSION,
	SYNCED_TABLES,
	type SyncedTable,
	type Transaction,
	type TransactionDraft,
	type TransactionEdit,
} from './schema';
import type { SyncChanges } from '../sync/types';

const db = SQLite.openDatabaseSync(DATABASE_NAME);

interface SyncColumnsDB {
	updatedAt: string;
	deletedAt: string | null;
	dirty: number;
}

interface TransactionDB extends SyncColumnsDB {
	id: string;
	amountCents: number;
	category: string;
	date: string;
	note: string;
	isIncome: number;
}

interface RecurringTransactionDB extends SyncColumnsDB {
	id: string;
	amountCents: number;
	isIncome: number;
	note: string;
	category: string;
	recurrenceType: 'weekly' | 'monthly' | 'yearly';
	day: number | null;
	month: number | null;
	weekday: number | null;
	lastProcessed: string | null;
	nextDue: string | null;
	active: number;
}

interface BudgetDB extends SyncColumnsDB {
	id: string;
	year: number;
	month: number;
	amountCents: number;
}

/** Sync bookkeeping as the app sees it: `dirty` stays on the row, `deletedAt` unwraps. */
const convertSyncMeta = (row: SyncColumnsDB) => ({
	updatedAt: row.updatedAt,
	deletedAt: row.deletedAt ?? undefined,
});

const convertTransaction = (transaction: TransactionDB): Transaction => ({
	id: transaction.id,
	amountCents: transaction.amountCents,
	category: transaction.category,
	date: transaction.date,
	note: transaction.note,
	isIncome: Boolean(transaction.isIncome),
	...convertSyncMeta(transaction),
});

const convertRecurringTransaction = (
	transaction: RecurringTransactionDB
): RecurringTransaction => ({
	id: transaction.id,
	amountCents: transaction.amountCents,
	isIncome: Boolean(transaction.isIncome),
	note: transaction.note,
	category: transaction.category,
	recurrenceType: transaction.recurrenceType,
	day: transaction.day ?? undefined,
	month: transaction.month ?? undefined,
	weekday: transaction.weekday ?? undefined,
	lastProcessed: transaction.lastProcessed ?? undefined,
	nextDue: transaction.nextDue ?? undefined,
	active: Boolean(transaction.active),
	...convertSyncMeta(transaction),
});

const convertBudget = (budget: BudgetDB): Budget => ({
	id: budget.id,
	year: budget.year,
	month: budget.month,
	amountCents: budget.amountCents,
	...convertSyncMeta(budget),
});

const toRule = (transaction: RecurrenceRule): RecurrenceRule => ({
	recurrenceType: transaction.recurrenceType,
	day: transaction.day,
	month: transaction.month,
	weekday: transaction.weekday,
});

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

const tableHasColumn = async (table: string, column: string): Promise<boolean> => {
	const columns = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`);
	return columns.some((c) => c.name === column);
};

const tableExists = async (table: string): Promise<boolean> => {
	const row = await db.getFirstAsync<{ name: string }>(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
		[table]
	);
	return Boolean(row);
};

/**
 * v0 -> v1: money moves from `amount REAL` to `amountCents INTEGER`.
 *
 * Rebuilds each table rather than using ALTER, so the result is identical to a fresh
 * install. `ROUND(amount * 100)` is done by SQLite in C doubles, which is exact for any
 * amount a user could have entered.
 */
const migrateMoneyToCents = async (): Promise<void> => {
	for (const table of ['transactions', 'recurring_transactions']) {
		if (!(await tableExists(table))) continue;
		if (!(await tableHasColumn(table, 'amount'))) continue;

		if (table === 'transactions') {
			await db.execAsync(`
        CREATE TABLE transactions_migrated (
          id TEXT PRIMARY KEY NOT NULL,
          amountCents INTEGER NOT NULL,
          category TEXT NOT NULL,
          date TEXT NOT NULL,
          note TEXT,
          isIncome INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO transactions_migrated (id, amountCents, category, date, note, isIncome)
          SELECT id, CAST(ROUND(amount * 100) AS INTEGER), category, date, note, isIncome
          FROM transactions;
        DROP TABLE transactions;
        ALTER TABLE transactions_migrated RENAME TO transactions;
      `);
		} else {
			await db.execAsync(`
        CREATE TABLE recurring_migrated (
          id TEXT PRIMARY KEY NOT NULL,
          amountCents INTEGER NOT NULL,
          isIncome INTEGER NOT NULL,
          note TEXT,
          category TEXT,
          recurrenceType TEXT NOT NULL,
          day INTEGER,
          month INTEGER,
          weekday INTEGER,
          lastProcessed TEXT,
          nextDue TEXT,
          active INTEGER NOT NULL DEFAULT 1
        );
        INSERT INTO recurring_migrated
          (id, amountCents, isIncome, note, category, recurrenceType, day, month, weekday, lastProcessed, nextDue, active)
          SELECT id, CAST(ROUND(amount * 100) AS INTEGER), isIncome, note, category, recurrenceType,
                 day, month, weekday, lastProcessed, nextDue, active
          FROM recurring_transactions;
        DROP TABLE recurring_transactions;
        ALTER TABLE recurring_migrated RENAME TO recurring_transactions;
      `);
		}

		console.log(`Migrated ${table} to integer cents`);
	}
};

/**
 * v1 -> v2: categories gain an explicit `type`.
 *
 * Existing rows are classified by the id list the app used to hardcode, so a database
 * created before this change keeps behaving the same. Anything unrecognised stays an
 * expense, which is what the old inference did anyway.
 */
const migrateCategoryTypes = async (): Promise<void> => {
	if (!(await tableExists('categories'))) return;
	if (await tableHasColumn('categories', 'type')) return;

	await db.execAsync("ALTER TABLE categories ADD COLUMN type TEXT NOT NULL DEFAULT 'expense'");

	const placeholders = LEGACY_INCOME_CATEGORY_IDS.map(() => '?').join(',');
	await db.runAsync(
		`UPDATE categories SET type = 'income' WHERE id IN (${placeholders})`,
		LEGACY_INCOME_CATEGORY_IDS
	);

	console.log('Migrated categories to typed rows');
};

/**
 * v2 -> v3: every synchronisable table gains `updatedAt`, `deletedAt` and `dirty`.
 *
 * Pre-existing rows are stamped with the migration's own timestamp and marked dirty:
 * they have never reached a server, so the first sync after signing in has to carry all
 * of them up. `updatedAt` cannot be NOT NULL in the ALTER (SQLite rejects adding a
 * NOT NULL column without a constant default), so it is added nullable and backfilled;
 * the constraint holds on freshly created databases, where it matters.
 */
const migrateSyncColumns = async (): Promise<void> => {
	const timestamp = nowTimestamp();

	for (const table of ['categories', 'transactions', 'recurring_transactions']) {
		if (!(await tableExists(table))) continue;
		if (await tableHasColumn(table, 'updatedAt')) continue;

		await db.execAsync(`
      ALTER TABLE ${table} ADD COLUMN updatedAt TEXT;
      ALTER TABLE ${table} ADD COLUMN deletedAt TEXT;
      ALTER TABLE ${table} ADD COLUMN dirty INTEGER NOT NULL DEFAULT 1;
    `);
		await db.runAsync(`UPDATE ${table} SET updatedAt = ?, dirty = 1`, [timestamp]);

		console.log(`Migrated ${table} to synchronisable rows`);
	}
};

/** The budget shape written to AsyncStorage before budgets became a table. */
interface LegacyStoredBudget {
	year: number;
	month: number;
	/** Present only in entries written before budgets moved to integer cents. */
	amount?: number;
	amountCents?: number;
}

/**
 * v3 -> v4: budgets move out of AsyncStorage into a table, plus `sync_state` is created.
 *
 * The AsyncStorage key is deliberately **left in place**. Deleting it would make a
 * downgrade — an OTA rollback, say — silently lose every budget, and an orphaned JSON
 * blob costs nothing. The importer is idempotent on top of that: it only runs when the
 * table is empty.
 */
const migrateBudgetsFromStorage = async (): Promise<void> => {
	await db.execAsync(`${CREATE_BUDGETS_TABLE}${CREATE_SYNC_STATE_TABLE}`);

	const existing = await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM budgets');
	if ((existing?.count ?? 0) > 0) return;

	let stored: string | null = null;
	try {
		stored = await AsyncStorage.getItem(STORAGE_KEYS.budgets);
	} catch (error) {
		// A budget is re-enterable in seconds; a database that refuses to open is not.
		console.warn('Could not read stored budgets, skipping import:', error);
		return;
	}

	if (!stored) return;

	let parsed: LegacyStoredBudget[];
	try {
		parsed = JSON.parse(stored) as LegacyStoredBudget[];
	} catch (error) {
		console.warn('Stored budgets were not valid JSON, skipping import:', error);
		return;
	}

	if (!Array.isArray(parsed) || parsed.length === 0) return;

	const timestamp = nowTimestamp();

	await db.withTransactionAsync(async () => {
		for (const budget of parsed) {
			// Entries written before the move to integer cents still hold a float.
			const amountCents =
				budget.amountCents ?? (typeof budget.amount === 'number' ? Math.round(budget.amount * 100) : null);

			if (amountCents === null || !Number.isFinite(budget.year) || !Number.isFinite(budget.month)) {
				continue;
			}

			await db.runAsync(
				`INSERT INTO budgets (id, year, month, amountCents, updatedAt, deletedAt, dirty)
         VALUES (?, ?, ?, ?, ?, NULL, 1)
         ON CONFLICT DO NOTHING`,
				[generateUniqueId(), budget.year, budget.month, amountCents, timestamp]
			);
		}
	});

	console.log(`Imported ${parsed.length} budgets from storage`);
};

/**
 * Inserts any default category that is missing, without touching the user's own edits.
 * Runs on every start so seeds added in later versions still reach existing installs.
 *
 * Seeded rows are dirty like any other: on a device that later signs in, the server has
 * its own copy under the same fixed id and last-write-wins settles which name survives.
 */
const seedMissingDefaultCategories = async (): Promise<void> => {
	// Includes tombstoned rows on purpose: a category the user deleted must not be
	// resurrected by the next launch.
	const existing = await db.getAllAsync<{ id: string }>('SELECT id FROM categories');
	const existingIds = new Set(existing.map((c) => c.id));
	const missing = DEFAULT_CATEGORIES.filter((c) => !existingIds.has(c.id));

	if (missing.length === 0) return;

	const timestamp = nowTimestamp();

	await db.withTransactionAsync(async () => {
		for (const category of missing) {
			await db.runAsync(
				`INSERT INTO categories (id, name, color, icon, type, updatedAt, deletedAt, dirty)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 1)`,
				[category.id, category.name, category.color, category.icon, category.type, timestamp]
			);
		}
	});
};

const runMigrations = async (): Promise<void> => {
	const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
	const version = row?.user_version ?? 0;

	if (version >= SCHEMA_VERSION) return;

	if (version < 1) await migrateMoneyToCents();
	if (version < 2) await migrateCategoryTypes();
	if (version < 3) await migrateSyncColumns();
	if (version < 4) await migrateBudgetsFromStorage();

	await db.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION}`);
};

export const initDatabase = async (): Promise<void> => {
	try {
		await db.execAsync('PRAGMA journal_mode = WAL;');

		// Migrations run first so that CREATE TABLE IF NOT EXISTS below is a no-op for
		// already-migrated tables and only ever creates the current shape.
		await runMigrations();

		await db.execAsync(`
      ${CREATE_CATEGORIES_TABLE}
      ${CREATE_TRANSACTIONS_TABLE}
      ${CREATE_RECURRING_TRANSACTIONS_TABLE}
      ${CREATE_BUDGETS_TABLE}
      ${CREATE_SYNC_STATE_TABLE}
      ${CREATE_INDEXES}
    `);

		await seedMissingDefaultCategories();

		console.log('Database initialized successfully');
	} catch (error) {
		console.error('Error initializing database:', error);
		throw error;
	}
};

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export const getCategories = async (): Promise<Category[]> => {
	try {
		const categories = await db.getAllAsync<Category>(
			'SELECT * FROM categories WHERE deletedAt IS NULL ORDER BY name'
		);

		// Hide the "uncategorized" bucket until something actually lands in it.
		const orphanCount = await db.getFirstAsync<{ count: number }>(
			"SELECT COUNT(*) AS count FROM transactions WHERE category = 'uncategorized' AND deletedAt IS NULL"
		);

		return (orphanCount?.count ?? 0) > 0
			? categories
			: categories.filter((c) => c.id !== 'uncategorized');
	} catch (error) {
		console.error('Error fetching categories:', error);
		throw error;
	}
};

/** Categories of one side of the ledger, for the pickers in the transaction forms. */
export const getCategoriesByType = async (type: CategoryType): Promise<Category[]> => {
	try {
		return await db.getAllAsync<Category>(
			`SELECT * FROM categories
       WHERE type = ? AND id != 'uncategorized' AND deletedAt IS NULL
       ORDER BY name`,
			[type]
		);
	} catch (error) {
		console.error('Error fetching categories by type:', error);
		throw error;
	}
};

export const addCategory = async (category: CategoryDraft): Promise<string> => {
	const id = generateUniqueId();
	await db.runAsync(
		`INSERT INTO categories (id, name, color, icon, type, updatedAt, deletedAt, dirty)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 1)`,
		[id, category.name, category.color, category.icon, category.type, nowTimestamp()]
	);
	return id;
};

export const updateCategory = async (category: CategoryEdit): Promise<void> => {
	await db.runAsync(
		`UPDATE categories
     SET name = ?, color = ?, icon = ?, type = ?, updatedAt = ?, dirty = 1
     WHERE id = ?`,
		[category.name, category.color, category.icon, category.type, nowTimestamp(), category.id]
	);
};

export const deleteCategory = async (categoryId: string): Promise<void> => {
	if (categoryId === 'uncategorized') {
		throw new Error('Uncategorized category cannot be deleted');
	}

	const timestamp = nowTimestamp();

	await db.withTransactionAsync(async () => {
		// Reassign in one statement instead of a round trip per transaction. The moved
		// rows are dirtied too: without that, another device would keep showing them
		// under a category this one has already deleted.
		await db.runAsync(
			`UPDATE transactions SET category = 'uncategorized', updatedAt = ?, dirty = 1
       WHERE category = ? AND deletedAt IS NULL`,
			[timestamp, categoryId]
		);
		await db.runAsync(
			`UPDATE recurring_transactions SET category = 'uncategorized', updatedAt = ?, dirty = 1
       WHERE category = ? AND deletedAt IS NULL`,
			[timestamp, categoryId]
		);
		// Tombstone rather than DELETE, so the removal itself can be synced.
		await db.runAsync(
			'UPDATE categories SET deletedAt = ?, updatedAt = ?, dirty = 1 WHERE id = ?',
			[timestamp, timestamp, categoryId]
		);
	});
};

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

export const addTransaction = async (
	transaction: TransactionDraft,
	/**
	 * Supplied only by the recurrence poster, which derives a stable id per occurrence
	 * so two devices catching up on the same bill converge on one row.
	 */
	explicitId?: string
): Promise<string> => {
	const id = explicitId ?? generateUniqueId();
	try {
		await db.runAsync(
			`INSERT INTO transactions (id, amountCents, category, date, note, isIncome, updatedAt, deletedAt, dirty)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1)
       ON CONFLICT (id) DO NOTHING`,
			[
				id,
				transaction.amountCents,
				transaction.category,
				transaction.date,
				transaction.note,
				transaction.isIncome ? 1 : 0,
				nowTimestamp(),
			]
		);
		return id;
	} catch (error) {
		console.error('Error adding transaction:', error);
		throw error;
	}
};

export const getTransactions = async (): Promise<Transaction[]> => {
	try {
		const transactions = await db.getAllAsync<TransactionDB>(
			'SELECT * FROM transactions WHERE deletedAt IS NULL ORDER BY date DESC'
		);
		return transactions.map(convertTransaction);
	} catch (error) {
		console.error('Error fetching transactions:', error);
		throw error;
	}
};

export const getTransactionsByCategory = async (categoryId: string): Promise<Transaction[]> => {
	try {
		const transactions = await db.getAllAsync<TransactionDB>(
			'SELECT * FROM transactions WHERE category = ? AND deletedAt IS NULL ORDER BY date DESC',
			[categoryId]
		);
		return transactions.map(convertTransaction);
	} catch (error) {
		console.error('Error fetching transactions by category:', error);
		throw error;
	}
};

export const getTransactionsByDateRange = async (
	startDate: string,
	endDate: string,
	transactionType?: 'income' | 'expense'
): Promise<Transaction[]> => {
	try {
		let query = 'SELECT * FROM transactions WHERE date BETWEEN ? AND ? AND deletedAt IS NULL';
		const params: string[] = [startDate, endDate];

		if (transactionType === 'income') query += ' AND isIncome = 1';
		else if (transactionType === 'expense') query += ' AND isIncome = 0';

		query += ' ORDER BY date DESC';

		const transactions = await db.getAllAsync<TransactionDB>(query, params);
		return transactions.map(convertTransaction);
	} catch (error) {
		console.error('Error fetching transactions by date range:', error);
		throw error;
	}
};

export const updateTransaction = async (transaction: TransactionEdit): Promise<void> => {
	try {
		await db.runAsync(
			`UPDATE transactions
       SET amountCents = ?, category = ?, date = ?, note = ?, isIncome = ?, updatedAt = ?, dirty = 1
       WHERE id = ?`,
			[
				transaction.amountCents,
				transaction.category,
				transaction.date,
				transaction.note,
				transaction.isIncome ? 1 : 0,
				nowTimestamp(),
				transaction.id,
			]
		);
	} catch (error) {
		console.error('Error updating transaction:', error);
		throw error;
	}
};

export const deleteTransaction = async (id: string): Promise<void> => {
	const timestamp = nowTimestamp();
	try {
		// Tombstone: the row has to outlive the delete so other devices hear about it.
		await db.runAsync(
			'UPDATE transactions SET deletedAt = ?, updatedAt = ?, dirty = 1 WHERE id = ?',
			[timestamp, timestamp, id]
		);
	} catch (error) {
		console.error('Error deleting transaction:', error);
		throw error;
	}
};

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

export interface PeriodSummary {
	incomeCents: number;
	expenseCents: number;
	/** Income minus expenses **within the period**. */
	netCents: number;
}

/**
 * Income, expenses and result for a single period.
 *
 * Aggregated in SQL rather than by pulling rows into JS — the previous implementation
 * loaded every transaction since 1970 on each period change just to compute a total.
 */
export const getPeriodSummary = async (
	startDate: string,
	endDate: string
): Promise<PeriodSummary> => {
	try {
		const row = await db.getFirstAsync<{ income: number; expense: number }>(
			`SELECT
         COALESCE(SUM(CASE WHEN isIncome = 1 THEN amountCents ELSE 0 END), 0) AS income,
         COALESCE(SUM(CASE WHEN isIncome = 0 THEN amountCents ELSE 0 END), 0) AS expense
       FROM transactions
       WHERE date BETWEEN ? AND ? AND deletedAt IS NULL`,
			[startDate, endDate]
		);

		const incomeCents = row?.income ?? 0;
		const expenseCents = row?.expense ?? 0;

		return { incomeCents, expenseCents, netCents: incomeCents - expenseCents };
	} catch (error) {
		console.error('Error computing period summary:', error);
		throw error;
	}
};

/**
 * Cumulative balance across every transaction dated on or before `asOfDate`.
 * This is net worth to date, deliberately distinct from a period's result.
 */
export const getBalanceAsOf = async (asOfDate: string): Promise<number> => {
	try {
		const row = await db.getFirstAsync<{ balance: number }>(
			`SELECT COALESCE(SUM(CASE WHEN isIncome = 1 THEN amountCents ELSE -amountCents END), 0) AS balance
       FROM transactions
       WHERE date <= ? AND deletedAt IS NULL`,
			[asOfDate]
		);
		return row?.balance ?? 0;
	} catch (error) {
		console.error('Error computing balance:', error);
		throw error;
	}
};

export const getTotalByCategory = async (
	startDate?: string,
	endDate?: string,
	transactionType?: 'income' | 'expense'
): Promise<{ categoryId: string; totalCents: number }[]> => {
	try {
		let query = `
      SELECT category AS categoryId, SUM(amountCents) AS totalCents
      FROM transactions
      WHERE deletedAt IS NULL`;

		const params: string[] = [];

		if (startDate && endDate) {
			query += ' AND date BETWEEN ? AND ?';
			params.push(startDate, endDate);
		}

		if (transactionType === 'income') query += ' AND isIncome = 1';
		else if (transactionType === 'expense') query += ' AND isIncome = 0';

		query += ' GROUP BY category';

		return await db.getAllAsync<{ categoryId: string; totalCents: number }>(query, params);
	} catch (error) {
		console.error('Error fetching total by category:', error);
		throw error;
	}
};

/**
 * Monthly totals for a year, always twelve entries.
 *
 * Months with no activity are returned as zero rather than omitted. The previous
 * version returned only months that had rows, so the reports chart paired the Nth
 * income point with the Nth expense point regardless of which months those were —
 * February's income could be drawn above January's expenses.
 */
export const getMonthlyTransactions = async (
	year: number,
	transactionType?: 'income' | 'expense'
): Promise<{ month: number; totalCents: number }[]> => {
	try {
		let query = `
      SELECT CAST(strftime('%m', date) AS INTEGER) AS month,
             SUM(amountCents) AS totalCents
      FROM transactions
      WHERE strftime('%Y', date) = ? AND deletedAt IS NULL`;

		const params: string[] = [year.toString()];

		if (transactionType === 'income') query += ' AND isIncome = 1';
		else if (transactionType === 'expense') query += ' AND isIncome = 0';

		query += ' GROUP BY month';

		const rows = await db.getAllAsync<{ month: number; totalCents: number }>(query, params);
		const byMonth = new Map(rows.map((r) => [r.month, r.totalCents]));

		return Array.from({ length: 12 }, (_, index) => ({
			month: index + 1,
			totalCents: byMonth.get(index + 1) ?? 0,
		}));
	} catch (error) {
		console.error('Error fetching monthly transactions:', error);
		throw error;
	}
};

// ---------------------------------------------------------------------------
// Recurring transactions
// ---------------------------------------------------------------------------

export const addRecurringTransaction = async (
	transaction: RecurringTransactionDraft
): Promise<string> => {
	const id = generateUniqueId();
	// A new rule never backfills: its first occurrence is the first one on or after today.
	const nextDue = firstDueOnOrAfter(toRule(transaction), todayISO());

	try {
		await db.runAsync(
			`INSERT INTO recurring_transactions
       (id, amountCents, isIncome, note, category, recurrenceType, day, month, weekday,
        lastProcessed, nextDue, active, updatedAt, deletedAt, dirty)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)`,
			[
				id,
				transaction.amountCents,
				transaction.isIncome ? 1 : 0,
				transaction.note,
				transaction.category,
				transaction.recurrenceType,
				transaction.day ?? null,
				transaction.month ?? null,
				transaction.weekday ?? null,
				null,
				nextDue,
				transaction.active ? 1 : 0,
				nowTimestamp(),
			]
		);
		return id;
	} catch (error) {
		console.error('Error adding recurring transaction:', error);
		throw error;
	}
};

export const getRecurringTransactions = async (): Promise<RecurringTransaction[]> => {
	try {
		const transactions = await db.getAllAsync<RecurringTransactionDB>(
			'SELECT * FROM recurring_transactions WHERE deletedAt IS NULL ORDER BY nextDue ASC'
		);
		return transactions.map(convertRecurringTransaction);
	} catch (error) {
		console.error('Error fetching recurring transactions:', error);
		throw error;
	}
};

export const getRecurringTransactionById = async (
	id: string
): Promise<RecurringTransaction | null> => {
	try {
		const transaction = await db.getFirstAsync<RecurringTransactionDB>(
			'SELECT * FROM recurring_transactions WHERE id = ? AND deletedAt IS NULL',
			[id]
		);
		return transaction ? convertRecurringTransaction(transaction) : null;
	} catch (error) {
		console.error('Error fetching recurring transaction:', error);
		throw error;
	}
};

/**
 * Computes where a rule stands next, from its own definition.
 *
 * Always derived rather than trusted from the caller: editing a rule's day used to
 * leave the previously stored `nextDue` in place, so the change took effect a cycle late.
 */
const resolveNextDue = (transaction: RecurringTransactionEdit): string => {
	const rule = toRule(transaction);
	const anchor = transaction.lastProcessed ? addDays(transaction.lastProcessed, 1) : todayISO();
	return firstDueOnOrAfter(rule, anchor);
};

export const updateRecurringTransaction = async (
	transaction: RecurringTransactionEdit
): Promise<void> => {
	const nextDue = resolveNextDue(transaction);

	try {
		await db.runAsync(
			`UPDATE recurring_transactions
       SET amountCents = ?, isIncome = ?, note = ?, category = ?,
           recurrenceType = ?, day = ?, month = ?, weekday = ?,
           lastProcessed = ?, nextDue = ?, active = ?, updatedAt = ?, dirty = 1
       WHERE id = ?`,
			[
				transaction.amountCents,
				transaction.isIncome ? 1 : 0,
				transaction.note,
				transaction.category,
				transaction.recurrenceType,
				transaction.day ?? null,
				transaction.month ?? null,
				transaction.weekday ?? null,
				transaction.lastProcessed ?? null,
				nextDue,
				transaction.active ? 1 : 0,
				nowTimestamp(),
				transaction.id,
			]
		);
	} catch (error) {
		console.error('Error updating recurring transaction:', error);
		throw error;
	}
};

export const deleteRecurringTransaction = async (id: string): Promise<void> => {
	const timestamp = nowTimestamp();
	try {
		await db.runAsync(
			'UPDATE recurring_transactions SET deletedAt = ?, updatedAt = ?, dirty = 1 WHERE id = ?',
			[timestamp, timestamp, id]
		);
	} catch (error) {
		console.error('Error deleting recurring transaction:', error);
		throw error;
	}
};

/**
 * Posts every occurrence that has come due, one transaction per occurrence, each dated
 * on its own due date.
 *
 * Two fixes over the previous behaviour: a three-month absence now produces three
 * months of rent instead of one, and a bill due 30 June opened on 2 July is booked in
 * June where it belongs rather than distorting both months.
 */
export const processRecurringTransactions = async (): Promise<number> => {
	try {
		const today = todayISO();
		const dueTransactions = await db.getAllAsync<RecurringTransactionDB>(
			`SELECT * FROM recurring_transactions
       WHERE active = 1 AND nextDue IS NOT NULL AND nextDue <= ? AND deletedAt IS NULL
       ORDER BY nextDue ASC`,
			[today]
		);

		if (dueTransactions.length === 0) return 0;

		let posted = 0;

		await db.withTransactionAsync(async () => {
			for (const dbTransaction of dueTransactions) {
				const transaction = convertRecurringTransaction(dbTransaction);
				const rule = toRule(transaction);

				// Resume from the day after the last posting; a rule that has never run
				// starts at its scheduled first occurrence.
				const windowStart = transaction.lastProcessed
					? addDays(transaction.lastProcessed, 1)
					: (transaction.nextDue ?? today);

				const dueDates = occurrencesBetween(rule, windowStart, today);

				for (const dueDate of dueDates) {
					// The id is derived from the rule and the due date, so a second device
					// posting the same occurrence writes the same row instead of a duplicate.
					// `addTransaction` inserts with ON CONFLICT DO NOTHING for exactly this.
					await addTransaction(
						{
							amountCents: transaction.amountCents,
							category: transaction.category,
							date: dueDate,
							note: `[Auto] ${transaction.note}`,
							isIncome: transaction.isIncome,
						},
						occurrenceId(transaction.id, dueDate)
					);
					posted += 1;
				}

				const lastPosted = dueDates.length > 0 ? dueDates[dueDates.length - 1] : undefined;

				await db.runAsync(
					`UPDATE recurring_transactions
           SET lastProcessed = ?, nextDue = ?, updatedAt = ?, dirty = 1
           WHERE id = ?`,
					[
						lastPosted ?? transaction.lastProcessed ?? null,
						lastPosted ? nextDueAfter(rule, lastPosted) : firstDueOnOrAfter(rule, today),
						nowTimestamp(),
						transaction.id,
					]
				);
			}
		});

		return posted;
	} catch (error) {
		console.error('Error processing recurring transactions:', error);
		throw error;
	}
};

// ---------------------------------------------------------------------------
// Currency conversion
// ---------------------------------------------------------------------------

/** Whether the ledger holds anything at all, used to decide if a switch needs converting. */
export const hasFinancialData = async (): Promise<boolean> => {
	const row = await db.getFirstAsync<{ count: number }>(
		`SELECT (SELECT COUNT(*) FROM transactions WHERE deletedAt IS NULL)
          + (SELECT COUNT(*) FROM recurring_transactions WHERE deletedAt IS NULL) AS count`
	);
	return (row?.count ?? 0) > 0;
};

/**
 * Rescales every stored amount by an exchange rate.
 *
 * Rounding happens once per row, in SQLite, so the result is the same integer cents
 * the app would have computed itself. Wrapped in a transaction: a half-converted
 * ledger would be worse than either currency.
 */
export const convertAllAmounts = async (rate: number): Promise<void> => {
	if (!Number.isFinite(rate) || rate <= 0) {
		throw new Error(`Refusing to convert amounts by a non-positive rate: ${rate}`);
	}

	const timestamp = nowTimestamp();

	await db.withTransactionAsync(async () => {
		// Every rescaled row is a genuine change and has to reach the other devices,
		// otherwise they would keep the old currency's numbers under the new symbol.
		await db.runAsync(
			`UPDATE transactions
       SET amountCents = CAST(ROUND(amountCents * ?) AS INTEGER), updatedAt = ?, dirty = 1
       WHERE deletedAt IS NULL`,
			[rate, timestamp]
		);
		await db.runAsync(
			`UPDATE recurring_transactions
       SET amountCents = CAST(ROUND(amountCents * ?) AS INTEGER), updatedAt = ?, dirty = 1
       WHERE deletedAt IS NULL`,
			[rate, timestamp]
		);
		await db.runAsync(
			`UPDATE budgets
       SET amountCents = CAST(ROUND(amountCents * ?) AS INTEGER), updatedAt = ?, dirty = 1
       WHERE deletedAt IS NULL`,
			[rate, timestamp]
		);
	});
};

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

export const getBudgets = async (): Promise<Budget[]> => {
	try {
		const budgets = await db.getAllAsync<BudgetDB>(
			'SELECT * FROM budgets WHERE deletedAt IS NULL ORDER BY year DESC, month DESC'
		);
		return budgets.map(convertBudget);
	} catch (error) {
		console.error('Error fetching budgets:', error);
		throw error;
	}
};

/**
 * Sets the budget for a calendar month, replacing whatever was there.
 *
 * An UPSERT on the live row rather than delete-then-insert: reusing the existing id
 * keeps the server's copy of that month as one row across its whole history, so the
 * last-write-wins comparison has something to compare against.
 */
export const setBudget = async (
	year: number,
	month: number,
	amountCents: number
): Promise<string> => {
	const timestamp = nowTimestamp();

	const existing = await db.getFirstAsync<{ id: string }>(
		'SELECT id FROM budgets WHERE year = ? AND month = ? AND deletedAt IS NULL',
		[year, month]
	);

	if (existing) {
		await db.runAsync('UPDATE budgets SET amountCents = ?, updatedAt = ?, dirty = 1 WHERE id = ?', [
			amountCents,
			timestamp,
			existing.id,
		]);
		return existing.id;
	}

	const id = generateUniqueId();
	await db.runAsync(
		`INSERT INTO budgets (id, year, month, amountCents, updatedAt, deletedAt, dirty)
     VALUES (?, ?, ?, ?, ?, NULL, 1)`,
		[id, year, month, amountCents, timestamp]
	);
	return id;
};

export const clearBudget = async (year: number, month: number): Promise<void> => {
	const timestamp = nowTimestamp();
	await db.runAsync(
		`UPDATE budgets SET deletedAt = ?, updatedAt = ?, dirty = 1
     WHERE year = ? AND month = ? AND deletedAt IS NULL`,
		[timestamp, timestamp, year, month]
	);
};

// ---------------------------------------------------------------------------
// Sync state
// ---------------------------------------------------------------------------

/**
 * Linhas que ainda não chegaram ao servidor, no formato do protocolo.
 *
 * Inclui as lápides: apagar é uma mudança que precisa subir como qualquer outra. O
 * limite existe porque quem usou o app meses sem conta tem milhares de linhas sujas de
 * uma vez, e o servidor recusa remessas acima de `SYNC_PAGE_SIZE`.
 */
export const getDirtyChanges = async (limit: number): Promise<SyncChanges> => {
	const [categories, transactions, recurring, budgets] = await Promise.all([
		db.getAllAsync<Category & { dirty: number; deletedAt: string | null }>(
			'SELECT * FROM categories WHERE dirty = 1 ORDER BY updatedAt ASC LIMIT ?',
			[limit]
		),
		db.getAllAsync<TransactionDB>(
			'SELECT * FROM transactions WHERE dirty = 1 ORDER BY updatedAt ASC LIMIT ?',
			[limit]
		),
		db.getAllAsync<RecurringTransactionDB>(
			'SELECT * FROM recurring_transactions WHERE dirty = 1 ORDER BY updatedAt ASC LIMIT ?',
			[limit]
		),
		db.getAllAsync<BudgetDB>(
			'SELECT * FROM budgets WHERE dirty = 1 ORDER BY updatedAt ASC LIMIT ?',
			[limit]
		),
	]);

	return {
		categories: categories.map((row) => ({
			id: row.id,
			name: row.name,
			color: row.color,
			icon: row.icon,
			type: row.type,
			updatedAt: row.updatedAt,
			deletedAt: row.deletedAt ?? null,
		})),
		transactions: transactions.map((row) => ({
			id: row.id,
			amountCents: row.amountCents,
			category: row.category,
			date: row.date,
			note: row.note ?? null,
			isIncome: Boolean(row.isIncome),
			updatedAt: row.updatedAt,
			deletedAt: row.deletedAt,
		})),
		recurringTransactions: recurring.map((row) => ({
			id: row.id,
			amountCents: row.amountCents,
			isIncome: Boolean(row.isIncome),
			note: row.note ?? null,
			category: row.category,
			recurrenceType: row.recurrenceType,
			day: row.day,
			month: row.month,
			weekday: row.weekday,
			lastProcessed: row.lastProcessed,
			nextDue: row.nextDue,
			active: Boolean(row.active),
			updatedAt: row.updatedAt,
			deletedAt: row.deletedAt,
		})),
		budgets: budgets.map((row) => ({
			id: row.id,
			year: row.year,
			month: row.month,
			amountCents: row.amountCents,
			updatedAt: row.updatedAt,
			deletedAt: row.deletedAt,
		})),
	};
};

/** Quantas linhas ainda faltam subir. Alimenta o indicador de status do sync. */
export const countDirtyRows = async (): Promise<number> => {
	const row = await db.getFirstAsync<{ count: number }>(
		SYNCED_TABLES.map((table) => `(SELECT COUNT(*) FROM ${table} WHERE dirty = 1)`).join(' + ') +
			' AS count'
	);
	return row?.count ?? 0;
};

/**
 * Marca como limpas as linhas que o servidor aceitou.
 *
 * Compara `updatedAt` em vez de limpar pelo id sozinho: se o usuário editou a linha
 * enquanto o push estava no ar, a versão que subiu já é antiga, e apagar a marca faria
 * a edição mais recente nunca sair deste aparelho.
 */
export const markChangesClean = async (changes: SyncChanges): Promise<void> => {
	const byTable: Array<[SyncedTable, Array<{ id: string; updatedAt: string }>]> = [
		['categories', changes.categories],
		['transactions', changes.transactions],
		['recurring_transactions', changes.recurringTransactions],
		['budgets', changes.budgets],
	];

	await db.withTransactionAsync(async () => {
		for (const [table, rows] of byTable) {
			for (const row of rows) {
				await db.runAsync(`UPDATE ${table} SET dirty = 0 WHERE id = ? AND updatedAt = ?`, [
					row.id,
					row.updatedAt,
				]);
			}
		}
	});
};

/**
 * Grava as linhas vindas do servidor, resolvendo o conflito linha a linha.
 *
 * A versão do servidor só vence quando é estritamente mais nova; no empate o local
 * permanece, porque ele pode ter edições que ainda não subiram. Quando o servidor vence,
 * `dirty` volta a 0: aquela linha já está lá em cima, do jeito que acabou de chegar.
 */
export const applyPulledChanges = async (changes: SyncChanges): Promise<void> => {
	const isStale = async (table: SyncedTable, id: string, updatedAt: string): Promise<boolean> => {
		const local = await db.getFirstAsync<{ updatedAt: string }>(
			`SELECT updatedAt FROM ${table} WHERE id = ?`,
			[id]
		);
		// Sem linha local a resposta é não: é uma criação, e ela tem que entrar.
		// Timestamps ISO 8601 UTC comparam corretamente como texto.
		return local !== null && local.updatedAt >= updatedAt;
	};

	await db.withTransactionAsync(async () => {
		// Categorias primeiro: um lançamento pode vir na mesma leva que a categoria dele.
		for (const row of changes.categories) {
			if (await isStale('categories', row.id, row.updatedAt)) continue;

			await db.runAsync(
				`INSERT INTO categories (id, name, color, icon, type, updatedAt, deletedAt, dirty)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT (id) DO UPDATE SET
           name = excluded.name, color = excluded.color, icon = excluded.icon,
           type = excluded.type, updatedAt = excluded.updatedAt,
           deletedAt = excluded.deletedAt, dirty = 0`,
				[row.id, row.name, row.color, row.icon, row.type, row.updatedAt, row.deletedAt]
			);
		}

		for (const row of changes.transactions) {
			if (await isStale('transactions', row.id, row.updatedAt)) continue;

			await db.runAsync(
				`INSERT INTO transactions (id, amountCents, category, date, note, isIncome, updatedAt, deletedAt, dirty)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT (id) DO UPDATE SET
           amountCents = excluded.amountCents, category = excluded.category,
           date = excluded.date, note = excluded.note, isIncome = excluded.isIncome,
           updatedAt = excluded.updatedAt, deletedAt = excluded.deletedAt, dirty = 0`,
				[
					row.id,
					row.amountCents,
					row.category,
					row.date,
					row.note ?? '',
					row.isIncome ? 1 : 0,
					row.updatedAt,
					row.deletedAt,
				]
			);
		}

		for (const row of changes.recurringTransactions) {
			if (await isStale('recurring_transactions', row.id, row.updatedAt)) continue;

			await db.runAsync(
				`INSERT INTO recurring_transactions
           (id, amountCents, isIncome, note, category, recurrenceType, day, month, weekday,
            lastProcessed, nextDue, active, updatedAt, deletedAt, dirty)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT (id) DO UPDATE SET
           amountCents = excluded.amountCents, isIncome = excluded.isIncome,
           note = excluded.note, category = excluded.category,
           recurrenceType = excluded.recurrenceType, day = excluded.day,
           month = excluded.month, weekday = excluded.weekday,
           lastProcessed = excluded.lastProcessed, nextDue = excluded.nextDue,
           active = excluded.active, updatedAt = excluded.updatedAt,
           deletedAt = excluded.deletedAt, dirty = 0`,
				[
					row.id,
					row.amountCents,
					row.isIncome ? 1 : 0,
					row.note ?? '',
					row.category,
					row.recurrenceType,
					row.day,
					row.month,
					row.weekday,
					row.lastProcessed,
					row.nextDue,
					row.active ? 1 : 0,
					row.updatedAt,
					row.deletedAt,
				]
			);
		}

		for (const row of changes.budgets) {
			if (await isStale('budgets', row.id, row.updatedAt)) continue;

			// O índice único cobre apenas as linhas vivas, então um orçamento do servidor
			// para um mês que este aparelho também preencheu offline colidiria. A lápide
			// local perde para a linha do servidor, que é a que os dois vão compartilhar.
			if (!row.deletedAt) {
				await db.runAsync(
					`UPDATE budgets SET deletedAt = ?, dirty = 0
           WHERE year = ? AND month = ? AND id != ? AND deletedAt IS NULL`,
					[row.updatedAt, row.year, row.month, row.id]
				);
			}

			await db.runAsync(
				`INSERT INTO budgets (id, year, month, amountCents, updatedAt, deletedAt, dirty)
         VALUES (?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT (id) DO UPDATE SET
           year = excluded.year, month = excluded.month,
           amountCents = excluded.amountCents, updatedAt = excluded.updatedAt,
           deletedAt = excluded.deletedAt, dirty = 0`,
				[row.id, row.year, row.month, row.amountCents, row.updatedAt, row.deletedAt]
			);
		}
	});
};

export const getSyncState = async (key: string): Promise<string | null> => {
	const row = await db.getFirstAsync<{ value: string | null }>(
		'SELECT value FROM sync_state WHERE key = ?',
		[key]
	);
	return row?.value ?? null;
};

export const setSyncState = async (key: string, value: string | null): Promise<void> => {
	await db.runAsync(
		'INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
		[key, value]
	);
};

export const clearSyncState = async (): Promise<void> => {
	await db.runAsync('DELETE FROM sync_state');
};

/**
 * Marks every live row as needing to be pushed.
 *
 * Used when claiming local data into a freshly linked account: nothing on the device has
 * ever been to the server, so the whole ledger is pending regardless of its flags.
 */
export const markEverythingDirty = async (): Promise<void> => {
	await db.withTransactionAsync(async () => {
		for (const table of SYNCED_TABLES) {
			await db.runAsync(`UPDATE ${table} SET dirty = 1`);
		}
	});
};

/**
 * Drops all synchronisable rows outright, tombstones included.
 *
 * This is the "discard this device's data" branch of first sign-in, where the local
 * ledger is meant to disappear rather than propagate — so DELETE, not tombstones.
 */
export const clearSyncedData = async (): Promise<void> => {
	await db.withTransactionAsync(async () => {
		for (const table of SYNCED_TABLES) {
			await db.runAsync(`DELETE FROM ${table}`);
		}
	});
};

export const resetDatabase = async (): Promise<void> => {
	const timestamp = nowTimestamp();

	try {
		// Tombstones rather than DELETE: if the device is signed in, "erase my data" has
		// to reach the profile too, and a plain delete would be undone by the next pull.
		await db.withTransactionAsync(async () => {
			for (const table of ['transactions', 'recurring_transactions', 'budgets']) {
				await db.runAsync(
					`UPDATE ${table} SET deletedAt = ?, updatedAt = ?, dirty = 1 WHERE deletedAt IS NULL`,
					[timestamp, timestamp]
				);
			}
		});

		console.log('Database reset successfully');
	} catch (error) {
		console.error('Error resetting database:', error);
		throw error;
	}
};

export default {
	initDatabase,
	getCategories,
	getCategoriesByType,
	addCategory,
	updateCategory,
	deleteCategory,
	addTransaction,
	getTransactions,
	getTransactionsByCategory,
	getTransactionsByDateRange,
	updateTransaction,
	deleteTransaction,
	getPeriodSummary,
	getBalanceAsOf,
	getTotalByCategory,
	getMonthlyTransactions,
	addRecurringTransaction,
	getRecurringTransactions,
	getRecurringTransactionById,
	updateRecurringTransaction,
	deleteRecurringTransaction,
	processRecurringTransactions,
	getBudgets,
	setBudget,
	clearBudget,
	getDirtyChanges,
	countDirtyRows,
	markChangesClean,
	applyPulledChanges,
	getSyncState,
	setSyncState,
	clearSyncState,
	markEverythingDirty,
	clearSyncedData,
	hasFinancialData,
	convertAllAmounts,
	resetDatabase,
};
