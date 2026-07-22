export type CategoryType = 'expense' | 'income';

/**
 * Bookkeeping every synchronisable row carries.
 *
 * `updatedAt` is an ISO 8601 **instant** (unlike `Transaction.date`, which is a calendar
 * day) because it orders edits across devices — that is exactly the case where a local
 * calendar day would be ambiguous. It is written by whoever made the change, client
 * included, since it is what decides last-write-wins.
 *
 * Deletes are tombstones: the row stays with `deletedAt` set, so a device that has been
 * offline learns the row is gone instead of resurrecting it on the next push.
 */
export interface SyncMeta {
	updatedAt: string;
	deletedAt?: string;
}

/** Row shape as stored, including the flag that never leaves the device. */
export interface SyncRow extends SyncMeta {
	/** 1 while the row still has to reach the server. Local-only, never sent. */
	dirty: boolean;
}

export interface Category extends SyncMeta {
	id: string;
	name: string;
	color: string;
	icon: string;
	/**
	 * Whether the category belongs to money coming in or going out.
	 *
	 * Stored on the row rather than inferred from a hardcoded list of ids, which is how
	 * it worked before: any category the user created was silently treated as an expense.
	 */
	type: CategoryType;
}

export interface Transaction extends SyncMeta {
	id: string;
	/** Integer cents. Never a float — see `app/utils/money.ts`. */
	amountCents: number;
	category: string;
	/** Calendar date as `YYYY-MM-DD`, local. */
	date: string;
	note: string;
	isIncome: boolean;
}

export interface RecurringTransaction extends SyncMeta {
	id: string;
	/** Integer cents. Never a float — see `app/utils/money.ts`. */
	amountCents: number;
	isIncome: boolean;
	note: string;
	category: string;
	recurrenceType: 'weekly' | 'monthly' | 'yearly';
	day?: number;
	month?: number;
	weekday?: number;
	lastProcessed?: string;
	nextDue?: string;
	active: boolean;
}

/**
 * A monthly spending target.
 *
 * Lived in AsyncStorage under `monthlyBudgets` until budgets had to sync: keeping them
 * there would have meant a second sync path with its own conflict rules, for data that
 * belongs to the same profile as everything else.
 */
export interface Budget extends SyncMeta {
	id: string;
	year: number;
	/** 1-12. */
	month: number;
	/** Integer cents. */
	amountCents: number;
}

export const DATABASE_NAME = 'spendr.db';

/**
 * Bumped whenever the physical schema changes. `runMigrations` in `database.ts` walks
 * `PRAGMA user_version` up to this number, applying one step at a time.
 *
 * 1 — money moves from `amount REAL` to `amountCents INTEGER`.
 * 2 — categories gain an explicit `type` column, and income categories are seeded.
 * 3 — every table gains `updatedAt` / `deletedAt` / `dirty`, so rows can be synced.
 * 4 — budgets move out of AsyncStorage into a table, and `sync_state` is created.
 */
export const SCHEMA_VERSION = 4;

/** Tables that take part in the delta sync, in foreign-key-safe order. */
export const SYNCED_TABLES = [
	'categories',
	'transactions',
	'recurring_transactions',
	'budgets',
] as const;

export type SyncedTable = (typeof SYNCED_TABLES)[number];

/**
 * Columns appended to every synchronisable table.
 *
 * `dirty` defaults to 1 so a plain INSERT that forgets to mention it still gets picked
 * up by the next push — losing a write is far worse than pushing one twice, which the
 * server's upsert absorbs anyway.
 */
export const SYNC_COLUMNS_SQL = `
    updatedAt TEXT NOT NULL,
    deletedAt TEXT,
    dirty INTEGER NOT NULL DEFAULT 1`;

export const CREATE_CATEGORIES_TABLE = `
  CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    icon TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'expense',
${SYNC_COLUMNS_SQL}
  );
`;

/**
 * The ids the app used to hardcode as income before `categories.type` existed.
 * Kept only so the v1 -> v2 migration can classify pre-existing rows.
 */
export const LEGACY_INCOME_CATEGORY_IDS = [
	'salary',
	'freelance',
	'investment',
	'gift',
	'refund',
	'other_income',
];

export const CREATE_TRANSACTIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY NOT NULL,
    amountCents INTEGER NOT NULL,
    category TEXT NOT NULL,
    date TEXT NOT NULL,
    note TEXT,
    isIncome INTEGER NOT NULL DEFAULT 0,
${SYNC_COLUMNS_SQL},
    FOREIGN KEY (category) REFERENCES categories (id)
  );
`;

export const CREATE_RECURRING_TRANSACTIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS recurring_transactions (
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
    active INTEGER NOT NULL DEFAULT 1,
${SYNC_COLUMNS_SQL},
    FOREIGN KEY (category) REFERENCES categories (id)
  );
`;

/**
 * Budgets are unique per calendar month, but only among rows that are still alive:
 * a deleted budget keeps its tombstone, and setting a new one for the same month must
 * not collide with it. Hence the partial index rather than a UNIQUE column constraint.
 */
export const CREATE_BUDGETS_TABLE = `
  CREATE TABLE IF NOT EXISTS budgets (
    id TEXT PRIMARY KEY NOT NULL,
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,
    amountCents INTEGER NOT NULL,
${SYNC_COLUMNS_SQL}
  );
`;

/**
 * `sync_state` holds the pull cursor. It is a table rather than an AsyncStorage key so
 * that advancing the cursor and applying the rows it covers happen in one SQLite
 * transaction — a cursor saved without its data would silently skip those changes forever.
 */
export const CREATE_SYNC_STATE_TABLE = `
  CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT
  );
`;

/**
 * Queries filter by date range constantly; without these they are full scans.
 * The `dirty` indexes keep the push's "what changed?" scan off the full table.
 */
export const CREATE_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions (date);
  CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions (category);
  CREATE INDEX IF NOT EXISTS idx_recurring_next_due ON recurring_transactions (active, nextDue);
  CREATE INDEX IF NOT EXISTS idx_categories_dirty ON categories (dirty);
  CREATE INDEX IF NOT EXISTS idx_transactions_dirty ON transactions (dirty);
  CREATE INDEX IF NOT EXISTS idx_recurring_dirty ON recurring_transactions (dirty);
  CREATE INDEX IF NOT EXISTS idx_budgets_dirty ON budgets (dirty);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_budgets_period
    ON budgets (year, month) WHERE deletedAt IS NULL;
`;

/**
 * What the UI hands to the database when creating a row.
 *
 * Sync bookkeeping is deliberately absent: `updatedAt` is stamped by the write itself,
 * so a screen can never set it to a stale value and quietly lose the edit to the
 * last-write-wins comparison.
 */
export type CategoryDraft = Omit<Category, 'id' | keyof SyncMeta>;
export type TransactionDraft = Omit<Transaction, 'id' | keyof SyncMeta>;
export type RecurringTransactionDraft = Omit<
	RecurringTransaction,
	'id' | 'lastProcessed' | 'nextDue' | keyof SyncMeta
>;

/**
 * What an edit needs to carry: the draft's fields plus the id being edited.
 *
 * The row's existing `updatedAt` is not required, because an update overwrites it with
 * the moment of the edit — asking callers for it would only invite passing a stale one.
 */
export type CategoryEdit = CategoryDraft & { id: string };
export type TransactionEdit = TransactionDraft & { id: string };
export type RecurringTransactionEdit = RecurringTransactionDraft & {
	id: string;
	/** Kept because `nextDue` is recomputed from where the rule last ran. */
	lastProcessed?: string;
	nextDue?: string;
};

/** A seed row: the category's own fields, before sync bookkeeping is stamped on it. */
export type CategorySeed = Omit<Category, keyof SyncMeta>;

export const DEFAULT_CATEGORIES: CategorySeed[] = [
	// Expense categories
	{ id: 'food', name: 'Food', color: '#50E3C2', icon: 'fast-food', type: 'expense' },
	{ id: 'transport', name: 'Transportation', color: '#5E5CE6', icon: 'car', type: 'expense' },
	{ id: 'entertainment', name: 'Entertainment', color: '#FF6B6B', icon: 'film', type: 'expense' },
	{ id: 'shopping', name: 'Shopping', color: '#FFCC5C', icon: 'cart', type: 'expense' },
	{ id: 'utilities', name: 'Utilities', color: '#4DACF7', icon: 'flash', type: 'expense' },
	{ id: 'health', name: 'Health', color: '#FF9FB1', icon: 'medical', type: 'expense' },
	{ id: 'education', name: 'Education', color: '#A78BFA', icon: 'school', type: 'expense' },
	{
		id: 'other_expense',
		name: 'Other Expense',
		color: '#9CA3AF',
		icon: 'ellipsis-horizontal',
		type: 'expense',
	},

	// Income categories. These ids were referenced throughout the app but had never
	// actually been seeded, so the income category list was always empty.
	{ id: 'salary', name: 'Salary', color: '#4CAF50', icon: 'wallet', type: 'income' },
	{ id: 'freelance', name: 'Freelance', color: '#15E8FE', icon: 'briefcase', type: 'income' },
	{ id: 'investment', name: 'Investment', color: '#FFD166', icon: 'trending-up', type: 'income' },
	{ id: 'gift', name: 'Gift', color: '#F78FB3', icon: 'gift', type: 'income' },
	{ id: 'refund', name: 'Refund', color: '#7BDFF2', icon: 'return-down-back', type: 'income' },
	{
		id: 'other_income',
		name: 'Other Income',
		color: '#A0E7A0',
		icon: 'ellipsis-horizontal',
		type: 'income',
	},

	// Fallback bucket for transactions whose category was deleted.
	{
		id: 'uncategorized',
		name: 'Uncategorized',
		color: '#9CA3AF',
		icon: 'help-circle',
		type: 'expense',
	},
];

export default {
	DATABASE_NAME,
	SCHEMA_VERSION,
	SYNCED_TABLES,
	LEGACY_INCOME_CATEGORY_IDS,
	CREATE_CATEGORIES_TABLE,
	CREATE_TRANSACTIONS_TABLE,
	CREATE_RECURRING_TRANSACTIONS_TABLE,
	CREATE_BUDGETS_TABLE,
	CREATE_SYNC_STATE_TABLE,
	CREATE_INDEXES,
	DEFAULT_CATEGORIES,
};
