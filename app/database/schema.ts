export type CategoryType = 'expense' | 'income';

export interface Category {
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

export interface Transaction {
	id: string;
	/** Integer cents. Never a float — see `app/utils/money.ts`. */
	amountCents: number;
	category: string;
	/** Calendar date as `YYYY-MM-DD`, local. */
	date: string;
	note: string;
	isIncome: boolean;
}

export interface RecurringTransaction {
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

export const DATABASE_NAME = 'spendr.db';

/**
 * Bumped whenever the physical schema changes. `runMigrations` in `database.ts` walks
 * `PRAGMA user_version` up to this number, applying one step at a time.
 *
 * 1 — money moves from `amount REAL` to `amountCents INTEGER`.
 * 2 — categories gain an explicit `type` column, and income categories are seeded.
 */
export const SCHEMA_VERSION = 2;

export const CREATE_CATEGORIES_TABLE = `
  CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    icon TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'expense'
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
    FOREIGN KEY (category) REFERENCES categories (id)
  );
`;

/** Queries filter by date range constantly; without these they are full scans. */
export const CREATE_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions (date);
  CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions (category);
  CREATE INDEX IF NOT EXISTS idx_recurring_next_due ON recurring_transactions (active, nextDue);
`;

export const DEFAULT_CATEGORIES: Category[] = [
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
	LEGACY_INCOME_CATEGORY_IDS,
	CREATE_CATEGORIES_TABLE,
	CREATE_TRANSACTIONS_TABLE,
	CREATE_RECURRING_TRANSACTIONS_TABLE,
	CREATE_INDEXES,
	DEFAULT_CATEGORIES,
};
