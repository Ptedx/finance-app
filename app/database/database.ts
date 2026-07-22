import * as SQLite from 'expo-sqlite';
import { generateUniqueId } from '../utils/categoryEditUtils';
import { addDays, todayISO } from '../utils/dateUtils';
import {
	firstDueOnOrAfter,
	nextDueAfter,
	occurrencesBetween,
	type RecurrenceRule,
} from '../utils/recurrence';
import {
	type Category,
	type CategoryType,
	CREATE_CATEGORIES_TABLE,
	CREATE_INDEXES,
	CREATE_RECURRING_TRANSACTIONS_TABLE,
	CREATE_TRANSACTIONS_TABLE,
	DATABASE_NAME,
	DEFAULT_CATEGORIES,
	LEGACY_INCOME_CATEGORY_IDS,
	type RecurringTransaction,
	SCHEMA_VERSION,
	type Transaction,
} from './schema';

const db = SQLite.openDatabaseSync(DATABASE_NAME);

interface TransactionDB {
	id: string;
	amountCents: number;
	category: string;
	date: string;
	note: string;
	isIncome: number;
}

interface RecurringTransactionDB {
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

const convertTransaction = (transaction: TransactionDB): Transaction => ({
	...transaction,
	isIncome: Boolean(transaction.isIncome),
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
 * Inserts any default category that is missing, without touching the user's own edits.
 * Runs on every start so seeds added in later versions still reach existing installs.
 */
const seedMissingDefaultCategories = async (): Promise<void> => {
	const existing = await db.getAllAsync<{ id: string }>('SELECT id FROM categories');
	const existingIds = new Set(existing.map((c) => c.id));
	const missing = DEFAULT_CATEGORIES.filter((c) => !existingIds.has(c.id));

	if (missing.length === 0) return;

	await db.withTransactionAsync(async () => {
		for (const category of missing) {
			await db.runAsync(
				'INSERT INTO categories (id, name, color, icon, type) VALUES (?, ?, ?, ?, ?)',
				[category.id, category.name, category.color, category.icon, category.type]
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
		const categories = await db.getAllAsync<Category>('SELECT * FROM categories ORDER BY name');

		// Hide the "uncategorized" bucket until something actually lands in it.
		const orphanCount = await db.getFirstAsync<{ count: number }>(
			"SELECT COUNT(*) AS count FROM transactions WHERE category = 'uncategorized'"
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
			"SELECT * FROM categories WHERE type = ? AND id != 'uncategorized' ORDER BY name",
			[type]
		);
	} catch (error) {
		console.error('Error fetching categories by type:', error);
		throw error;
	}
};

export const addCategory = async (category: Omit<Category, 'id'>): Promise<string> => {
	const id = generateUniqueId();
	await db.runAsync('INSERT INTO categories (id, name, color, icon, type) VALUES (?, ?, ?, ?, ?)', [
		id,
		category.name,
		category.color,
		category.icon,
		category.type,
	]);
	return id;
};

export const updateCategory = async (category: Category): Promise<void> => {
	await db.runAsync('UPDATE categories SET name = ?, color = ?, icon = ?, type = ? WHERE id = ?', [
		category.name,
		category.color,
		category.icon,
		category.type,
		category.id,
	]);
};

export const deleteCategory = async (categoryId: string): Promise<void> => {
	if (categoryId === 'uncategorized') {
		throw new Error('Uncategorized category cannot be deleted');
	}

	await db.withTransactionAsync(async () => {
		// Reassign in one statement instead of a round trip per transaction.
		await db.runAsync("UPDATE transactions SET category = 'uncategorized' WHERE category = ?", [
			categoryId,
		]);
		await db.runAsync(
			"UPDATE recurring_transactions SET category = 'uncategorized' WHERE category = ?",
			[categoryId]
		);
		await db.runAsync('DELETE FROM categories WHERE id = ?', [categoryId]);
	});
};

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

export const addTransaction = async (transaction: Omit<Transaction, 'id'>): Promise<string> => {
	const id = generateUniqueId();
	try {
		await db.runAsync(
			'INSERT INTO transactions (id, amountCents, category, date, note, isIncome) VALUES (?, ?, ?, ?, ?, ?)',
			[
				id,
				transaction.amountCents,
				transaction.category,
				transaction.date,
				transaction.note,
				transaction.isIncome ? 1 : 0,
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
			'SELECT * FROM transactions ORDER BY date DESC'
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
			'SELECT * FROM transactions WHERE category = ? ORDER BY date DESC',
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
		let query = 'SELECT * FROM transactions WHERE date BETWEEN ? AND ?';
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

export const updateTransaction = async (transaction: Transaction): Promise<void> => {
	try {
		await db.runAsync(
			'UPDATE transactions SET amountCents = ?, category = ?, date = ?, note = ?, isIncome = ? WHERE id = ?',
			[
				transaction.amountCents,
				transaction.category,
				transaction.date,
				transaction.note,
				transaction.isIncome ? 1 : 0,
				transaction.id,
			]
		);
	} catch (error) {
		console.error('Error updating transaction:', error);
		throw error;
	}
};

export const deleteTransaction = async (id: string): Promise<void> => {
	try {
		await db.runAsync('DELETE FROM transactions WHERE id = ?', [id]);
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
       WHERE date BETWEEN ? AND ?`,
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
       WHERE date <= ?`,
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
      WHERE 1=1`;

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
      WHERE strftime('%Y', date) = ?`;

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
	transaction: Omit<RecurringTransaction, 'id' | 'lastProcessed' | 'nextDue'>
): Promise<string> => {
	const id = generateUniqueId();
	// A new rule never backfills: its first occurrence is the first one on or after today.
	const nextDue = firstDueOnOrAfter(toRule(transaction), todayISO());

	try {
		await db.runAsync(
			`INSERT INTO recurring_transactions
       (id, amountCents, isIncome, note, category, recurrenceType, day, month, weekday, lastProcessed, nextDue, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
			'SELECT * FROM recurring_transactions ORDER BY nextDue ASC'
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
			'SELECT * FROM recurring_transactions WHERE id = ?',
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
const resolveNextDue = (transaction: RecurringTransaction): string => {
	const rule = toRule(transaction);
	const anchor = transaction.lastProcessed ? addDays(transaction.lastProcessed, 1) : todayISO();
	return firstDueOnOrAfter(rule, anchor);
};

export const updateRecurringTransaction = async (
	transaction: RecurringTransaction
): Promise<void> => {
	const nextDue = resolveNextDue(transaction);

	try {
		await db.runAsync(
			`UPDATE recurring_transactions
       SET amountCents = ?, isIncome = ?, note = ?, category = ?,
           recurrenceType = ?, day = ?, month = ?, weekday = ?,
           lastProcessed = ?, nextDue = ?, active = ?
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
				transaction.id,
			]
		);
	} catch (error) {
		console.error('Error updating recurring transaction:', error);
		throw error;
	}
};

export const deleteRecurringTransaction = async (id: string): Promise<void> => {
	try {
		await db.runAsync('DELETE FROM recurring_transactions WHERE id = ?', [id]);
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
       WHERE active = 1 AND nextDue IS NOT NULL AND nextDue <= ?
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
					await addTransaction({
						amountCents: transaction.amountCents,
						category: transaction.category,
						date: dueDate,
						note: `[Auto] ${transaction.note}`,
						isIncome: transaction.isIncome,
					});
					posted += 1;
				}

				const lastPosted = dueDates.length > 0 ? dueDates[dueDates.length - 1] : undefined;

				await db.runAsync(
					'UPDATE recurring_transactions SET lastProcessed = ?, nextDue = ? WHERE id = ?',
					[
						lastPosted ?? transaction.lastProcessed ?? null,
						lastPosted ? nextDueAfter(rule, lastPosted) : firstDueOnOrAfter(rule, today),
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
		`SELECT (SELECT COUNT(*) FROM transactions) + (SELECT COUNT(*) FROM recurring_transactions) AS count`
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

	await db.withTransactionAsync(async () => {
		await db.runAsync(
			'UPDATE transactions SET amountCents = CAST(ROUND(amountCents * ?) AS INTEGER)',
			[rate]
		);
		await db.runAsync(
			'UPDATE recurring_transactions SET amountCents = CAST(ROUND(amountCents * ?) AS INTEGER)',
			[rate]
		);
	});
};

export const resetDatabase = async (): Promise<void> => {
	try {
		await db.withTransactionAsync(async () => {
			await db.runAsync('DELETE FROM transactions');
			await db.runAsync('DELETE FROM recurring_transactions');
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
	hasFinancialData,
	convertAllAmounts,
	resetDatabase,
};
