import { planDebitCardConversions } from '../utils/cardNames';
import { planLedgerRepair } from '../utils/notificationTarget';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SQLite from 'expo-sqlite';
import { generateUniqueId } from '../utils/categoryEditUtils';
import { addDays, nowTimestamp, todayISO } from '../utils/dateUtils';
import {
	firstDueOnOrAfter,
	nextDueAfter,
	nextDueAfterEdit,
	occurrenceId,
	occurrencesBetween,
	type RecurrenceRule,
} from '../utils/recurrence';
import { STORAGE_KEYS } from '../utils/storageUtils';
import {
	type Budget,
	type Capture,
	type Category,
	type CategoryDraft,
	type CategoryEdit,
	type CategoryType,
	CREATE_BUDGETS_TABLE,
	CREATE_CAPTURES_TABLE,
	CREATE_CATEGORIES_TABLE,
	CREATE_INDEXES,
	CREATE_MERCHANT_RULES_TABLE,
	CREATE_RECURRING_TRANSACTIONS_TABLE,
	CREATE_DEBTS_TABLE,
	CREATE_RETIREMENT_GOALS_TABLE,
	CREATE_SYNC_STATE_TABLE,
	CREATE_TRANSACTIONS_TABLE,
	DATABASE_NAME,
	DEFAULT_CATEGORIES,
	ESSENTIAL_DEFAULT_CATEGORY_IDS,
	LEGACY_INCOME_CATEGORY_IDS,
	type RecurringTransaction,
	type RecurringTransactionDraft,
	type RecurringTransactionEdit,
	type Debt,
	type DebtDraft,
	RETIREMENT_GOAL_ID,
	type RetirementGoalRow,
	SCHEMA_VERSION,
	SYNCED_TABLES,
	type SyncedTable,
	type Transaction,
	type TransactionDraft,
	type TransactionEdit,
	type Account,
	type AccountDraft,
	type AccountEdit,
	type Transfer,
	type TransferDraft,
	type TransferEdit,
	ACCOUNT_V8_COLUMNS,
	ACCOUNT_V9_COLUMNS,
	ACCOUNT_V10_COLUMNS,
	ACCOUNT_V13_COLUMNS,
	TRANSACTION_V13_COLUMNS,
	DEFAULT_CLOSING_DAYS_BEFORE,
	defaultRoleFor,
	CAPTURE_V7_COLUMNS,
	CREATE_ACCOUNTS_TABLE,
	CREATE_TRANSFERS_TABLE,
	TRANSACTION_V7_COLUMNS,
} from './schema';
import type { SyncChanges } from '../sync/types';

/**
 * O único handle do banco. Exportado para módulos irmãos (`captures.ts`) que têm suas
 * próprias tabelas; telas e contexts continuam passando pelas funções deste arquivo.
 */
export const db = SQLite.openDatabaseSync(DATABASE_NAME);

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
	accountId: string | null;
	installmentGroup: string | null;
	installmentIndex: number | null;
	installmentCount: number | null;
	cardLast4: string | null;
}

interface AccountDB extends SyncColumnsDB {
	id: string;
	name: string;
	kind: Account['kind'];
	role: Account['role'];
	envelopeMonthlyCents: number | null;
	network: string | null;
	bankName: string | null;
	color: string;
	last4: string | null;
	closingDay: number | null;
	dueDay: number | null;
	closingDaysBefore: number | null;
	creditLimitCents: number | null;
	cardNames: string | null;
	packageName: string | null;
	accountKey: string | null;
	openingBalanceCents: number;
	openingBalanceDate: string;
	sortOrder: number;
	archived: number;
}

interface TransferDB extends SyncColumnsDB {
	id: string;
	fromAccountId: string | null;
	toAccountId: string | null;
	amountCents: number;
	date: string;
	note: string | null;
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

interface DebtDB extends SyncColumnsDB {
	id: string;
	name: string;
	kind: Debt['kind'];
	system: Debt['system'];
	openingBalanceCents: number;
	openingBalanceDate: string;
	installmentCents: number;
	remainingAtOpening: number;
	installmentsTotal: number;
	dueDay: number;
	rateBp: number;
	adminFeeBp: number | null;
	accountId: string | null;
	category: string | null;
	archived: number;
	sortOrder: number;
}

interface RetirementGoalDB extends SyncColumnsDB {
	id: string;
	targetMonthlyCents: number;
	reinvestBp: number;
	expectedYieldBp: number;
	outsideCapitalCents: number;
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
	accountId: transaction.accountId ?? null,
	installmentGroup: transaction.installmentGroup ?? null,
	installmentIndex: transaction.installmentIndex ?? null,
	installmentCount: transaction.installmentCount ?? null,
	cardLast4: transaction.cardLast4 ?? null,
	...convertSyncMeta(transaction),
});

const convertAccount = (account: AccountDB): Account => ({
	id: account.id,
	name: account.name,
	kind: account.kind,
	role: account.role ?? defaultRoleFor(account.kind),
	envelopeMonthlyCents: account.envelopeMonthlyCents ?? null,
	network: account.network ?? null,
	bankName: account.bankName,
	color: account.color,
	last4: account.last4,
	closingDay: account.closingDay,
	dueDay: account.dueDay,
	closingDaysBefore: account.closingDaysBefore ?? null,
	creditLimitCents: account.creditLimitCents,
	cardNames: account.cardNames ?? null,
	packageName: account.packageName,
	accountKey: account.accountKey,
	openingBalanceCents: account.openingBalanceCents,
	openingBalanceDate: account.openingBalanceDate,
	sortOrder: account.sortOrder,
	archived: Boolean(account.archived),
	...convertSyncMeta(account),
});

const convertTransfer = (transfer: TransferDB): Transfer => ({
	id: transfer.id,
	fromAccountId: transfer.fromAccountId,
	toAccountId: transfer.toAccountId,
	amountCents: transfer.amountCents,
	date: transfer.date,
	note: transfer.note ?? '',
	...convertSyncMeta(transfer),
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
 * v4 -> v5: categories gain `nature`, the needs/wants tag.
 *
 * Added with a constant default, which SQLite accepts on a NOT NULL column, so every
 * pre-existing row lands as `discretionary` — the deliberate choice: calling a past
 * expense essential on the user's behalf would inflate their "needs" without them ever
 * having said so. The known defaults are then promoted to match a fresh install, so the
 * same database seeded before and after this version classifies identically.
 *
 * Rows are **not** dirtied. The column is new on both sides and the server fills it with
 * the same default, so marking every category as pending would push a change that changes
 * nothing — while genuinely losing an edit made offline is the only failure that matters
 * here, and re-running the migration cannot happen (`user_version` gates it).
 */
const migrateCategoryNature = async (): Promise<void> => {
	if (!(await tableExists('categories'))) return;
	if (await tableHasColumn('categories', 'nature')) return;

	await db.execAsync(
		"ALTER TABLE categories ADD COLUMN nature TEXT NOT NULL DEFAULT 'discretionary'"
	);

	const placeholders = ESSENTIAL_DEFAULT_CATEGORY_IDS.map(() => '?').join(',');
	await db.runAsync(
		`UPDATE categories SET nature = 'essential' WHERE id IN (${placeholders})`,
		ESSENTIAL_DEFAULT_CATEGORY_IDS
	);

	console.log('Migrated categories to needs/wants tagging');
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
				`INSERT INTO categories (id, name, color, icon, type, nature, updatedAt, deletedAt, dirty)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1)`,
				[
					category.id,
					category.name,
					category.color,
					category.icon,
					category.type,
					category.nature,
					timestamp,
				]
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
	if (version < 5) await migrateCategoryNature();
	if (version < 6) await migrateCaptureTables();
	if (version < 7) await migrateAccounts();
	if (version < 8) await migrateAccountRoles();
	if (version < 9) await migrateCardsApart();
	if (version < 10) await migrateCardCycleFromDueDay();
	if (version < 11) await migrateCardCycleToClosingDay();
	if (version < 12) await migrateCardPurchasesToRealCard();
	if (version < 13) await migrateCardsPerPurchase();
	if (version < 14) await migrateRetirementGoals();
	if (version < 15) await migrateDebts();

	await db.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION}`);
};

/**
 * v7 -> v8: o papel de cada conta e o valor mensal do envelope.
 *
 * Contas já existentes ganham o papel pelo tipo — cartão é `card`, poupança e
 * investimento são `reserve`, o resto é `main` — o mesmo padrão de uma conta nova.
 * O usuário muda depois na tela da conta.
 */
/**
 * v8 -> v9: cartões separados de contas, e a bandeira do cartão.
 *
 * Normaliza `kind` e `role`: papel "cartão" vira tipo cartão de crédito, e vice-versa.
 * Uma conta corrente marcada com papel "cartão" guardava o que o usuário digitou como
 * **saldo** positivo; num cartão o mesmo número significa **valor a pagar**, que na
 * âncora é negativo. O sinal é invertido nesses casos, e só neles. As linhas mexidas
 * ficam sujas com `updatedAt` novo, para a correção subir no próximo sync.
 */
const migrateCardsApart = async (): Promise<void> => {
	if (!(await tableExists('accounts'))) return;

	for (const [name, sql] of ACCOUNT_V9_COLUMNS) {
		if (await tableHasColumn('accounts', name)) continue;
		await db.execAsync(`ALTER TABLE accounts ADD COLUMN ${name} ${sql}`);
	}

	const timestamp = nowTimestamp();
	await db.runAsync(
		`UPDATE accounts
     SET kind = 'credit_card',
         openingBalanceCents = CASE WHEN openingBalanceCents > 0 THEN -openingBalanceCents ELSE openingBalanceCents END,
         updatedAt = ?, dirty = 1
     WHERE role = 'card' AND kind <> 'credit_card'`,
		[timestamp]
	);
	await db.runAsync(
		`UPDATE accounts SET role = 'card', updatedAt = ?, dirty = 1
     WHERE kind = 'credit_card' AND role <> 'card'`,
		[timestamp]
	);

	console.log('Migrated cards apart from accounts');
};

/**
 * v9 -> v10: o ciclo do cartão sai do vencimento.
 *
 * Bancos brasileiros fecham a fatura um número fixo de dias antes do vencimento (o
 * Nubank, 7), e o vencimento pula para o próximo dia útil. Um dia fixo de fechamento
 * erra nos meses em que o vencimento anda. Cartões com fechamento e vencimento
 * informados ganham a distância entre eles; só com fechamento, vencimento 7 dias
 * depois. Distâncias fora de 1..20 viram 7, o padrão do mercado.
 */
const migrateCardCycleFromDueDay = async (): Promise<void> => {
	if (!(await tableExists('accounts'))) return;

	for (const [name, sql] of ACCOUNT_V10_COLUMNS) {
		if (await tableHasColumn('accounts', name)) continue;
		await db.execAsync(`ALTER TABLE accounts ADD COLUMN ${name} ${sql}`);
	}

	const timestamp = nowTimestamp();
	await db.runAsync(
		`UPDATE accounts
     SET dueDay = CASE WHEN closingDay + 7 > 30 THEN closingDay + 7 - 30 ELSE closingDay + 7 END,
         closingDaysBefore = 7, updatedAt = ?, dirty = 1
     WHERE kind = 'credit_card' AND closingDay IS NOT NULL AND dueDay IS NULL`,
		[timestamp]
	);
	await db.runAsync(
		`UPDATE accounts
     SET closingDaysBefore = CASE
           WHEN (CASE WHEN dueDay > closingDay THEN dueDay - closingDay ELSE dueDay + 30 - closingDay END) BETWEEN 1 AND 20
             THEN (CASE WHEN dueDay > closingDay THEN dueDay - closingDay ELSE dueDay + 30 - closingDay END)
           ELSE 7 END,
         updatedAt = ?, dirty = 1
     WHERE kind = 'credit_card' AND closingDay IS NOT NULL AND closingDaysBefore IS NULL`,
		[timestamp]
	);
	await db.runAsync(
		`UPDATE accounts SET closingDaysBefore = 7, updatedAt = ?, dirty = 1
     WHERE kind = 'credit_card' AND dueDay IS NOT NULL AND closingDaysBefore IS NULL`,
		[timestamp]
	);

	console.log('Migrated card cycles to due day');
};

/**
 * v12 -> v13: cada compra sabe qual cartão a fez, e débito vira cartão da conta.
 *
 * - `transactions.cardLast4` vem da captura que criou o lançamento (a transação ou todas
 *   as parcelas do grupo). A fatura continua sendo da conta de crédito; o final serve para
 *   ver quanto gastou cada cartão, físico ou virtual.
 * - Um "cartão de crédito" cujo nome diz débito ("Débito Inter") nunca teve fatura: os
 *   lançamentos vão para a conta corrente do mesmo banco, com o final do cartão, e o nome
 *   fica como o nome do cartão de débito daquela conta. Pagamentos para ele não existiram.
 */
/** v14 -> v15: debts (financing, consortium, loan) get their own synced table. */
const migrateDebts = async (): Promise<void> => {
	await db.execAsync(CREATE_DEBTS_TABLE);
};

/** v13 -> v14: the financial-independence goal gets its own synced table. */
const migrateRetirementGoals = async (): Promise<void> => {
	await db.execAsync(CREATE_RETIREMENT_GOALS_TABLE);
};

const migrateCardsPerPurchase = async (): Promise<void> => {
	if (!(await tableExists('transactions')) || !(await tableExists('accounts'))) return;

	for (const [name, sql] of TRANSACTION_V13_COLUMNS) {
		if (await tableHasColumn('transactions', name)) continue;
		await db.execAsync(`ALTER TABLE transactions ADD COLUMN ${name} ${sql}`);
	}
	for (const [name, sql] of ACCOUNT_V13_COLUMNS) {
		if (await tableHasColumn('accounts', name)) continue;
		await db.execAsync(`ALTER TABLE accounts ADD COLUMN ${name} ${sql}`);
	}

	const timestamp = nowTimestamp();
	if (await tableExists('captures')) {
		await db.runAsync(
			`UPDATE transactions
       SET cardLast4 = (
             SELECT c.cardLast4 FROM captures c
             WHERE c.cardLast4 IS NOT NULL AND (c.transactionId = transactions.id OR c.id = transactions.installmentGroup)
             LIMIT 1
           ),
           updatedAt = ?, dirty = 1
       WHERE cardLast4 IS NULL AND EXISTS (
             SELECT 1 FROM captures c
             WHERE c.cardLast4 IS NOT NULL AND (c.transactionId = transactions.id OR c.id = transactions.installmentGroup)
           )`,
			[timestamp]
		);
	}

	const accounts = (await db.getAllAsync<AccountDB>('SELECT * FROM accounts WHERE deletedAt IS NULL')).map(convertAccount);
	for (const plan of planDebitCardConversions(accounts)) {
		const { card, checking } = plan;
		await db.withTransactionAsync(async () => {
			await db.runAsync(
				`UPDATE transactions SET accountId = ?, cardLast4 = COALESCE(cardLast4, ?), updatedAt = ?, dirty = 1
         WHERE accountId = ? AND deletedAt IS NULL`,
				[checking.id, card.last4, timestamp, card.id]
			);
			if (await tableExists('captures')) {
				await db.runAsync('UPDATE captures SET accountId = ? WHERE accountId = ?', [checking.id, card.id]);
			}
			await db.runAsync(
				'UPDATE transfers SET deletedAt = ?, updatedAt = ?, dirty = 1 WHERE (fromAccountId = ? OR toAccountId = ?) AND deletedAt IS NULL',
				[timestamp, timestamp, card.id, card.id]
			);
			if (plan.cardNames !== checking.cardNames) {
				await db.runAsync('UPDATE accounts SET cardNames = ?, updatedAt = ?, dirty = 1 WHERE id = ?', [plan.cardNames, timestamp, checking.id]);
			}
			await db.runAsync('UPDATE accounts SET deletedAt = ?, updatedAt = ?, dirty = 1 WHERE id = ?', [timestamp, timestamp, card.id]);
		});
	}

	console.log('Migrated card per purchase');
};

/**
 * v11 -> v12: compras de cartão registradas pelas regras antigas vão para o cartão certo.
 * A decisão é de `planLedgerRepair` (puro, testado); aqui só se aplica. Tudo o que muda
 * fica sujo, para subir no próximo sync.
 */
const migrateCardPurchasesToRealCard = async (): Promise<void> => {
	if (!(await tableExists('accounts')) || !(await tableExists('captures'))) return;

	const accounts = (await db.getAllAsync<AccountDB>('SELECT * FROM accounts')).map(convertAccount);
	const captures = await db.getAllAsync<Omit<Capture, 'autoConfirmed'> & { autoConfirmed: number }>(
		"SELECT * FROM captures WHERE cardLast4 IS NOT NULL AND status IN ('pending', 'confirmed')"
	);
	const plan = planLedgerRepair(
		accounts,
		captures.map((row) => ({ ...row, autoConfirmed: Boolean(row.autoConfirmed) }))
	);
	if (plan.mergeCards.length === 0 && plan.moveCaptures.length === 0) return;

	const timestamp = nowTimestamp();
	await db.withTransactionAsync(async () => {
		for (const { fromId, toId } of plan.mergeCards) {
			await db.runAsync(
				'UPDATE transactions SET accountId = ?, updatedAt = ?, dirty = 1 WHERE accountId = ? AND deletedAt IS NULL',
				[toId, timestamp, fromId]
			);
			await db.runAsync('UPDATE captures SET accountId = ? WHERE accountId = ?', [toId, fromId]);
			await db.runAsync(
				'UPDATE transfers SET toAccountId = ?, updatedAt = ?, dirty = 1 WHERE toAccountId = ? AND deletedAt IS NULL',
				[toId, timestamp, fromId]
			);
			await db.runAsync(
				'UPDATE transfers SET fromAccountId = ?, updatedAt = ?, dirty = 1 WHERE fromAccountId = ? AND deletedAt IS NULL',
				[toId, timestamp, fromId]
			);
			await db.runAsync('UPDATE accounts SET deletedAt = ?, updatedAt = ?, dirty = 1 WHERE id = ?', [timestamp, timestamp, fromId]);
		}
		for (const { captureId, transactionId, toId } of plan.moveCaptures) {
			await db.runAsync('UPDATE captures SET accountId = ? WHERE id = ?', [toId, captureId]);
			await db.runAsync(
				'UPDATE transactions SET accountId = ?, updatedAt = ?, dirty = 1 WHERE (id = ? OR installmentGroup = ?) AND deletedAt IS NULL',
				[toId, timestamp, transactionId ?? '', captureId]
			);
		}
	});

	console.log(`Repaired card purchases: ${plan.mergeCards.length} cards merged, ${plan.moveCaptures.length} purchases moved`);
};

/**
 * v10 -> v11: o ciclo volta a partir do dia de fechamento.
 *
 * O banco dá nome à fatura pelo mês em que ela fecha, e o usuário conhece o dia do
 * fechamento. Cartões salvos na v10 só com vencimento ganham o fechamento derivado dele
 * (vencimento menos a distância, voltando para o mês anterior quando passa do dia 1).
 * Quem já tinha fechamento continua com ele.
 */
const migrateCardCycleToClosingDay = async (): Promise<void> => {
	if (!(await tableExists('accounts'))) return;

	await db.runAsync(
		`UPDATE accounts
     SET closingDay = CASE
           WHEN dueDay - COALESCE(closingDaysBefore, 7) >= 1 THEN dueDay - COALESCE(closingDaysBefore, 7)
           ELSE dueDay - COALESCE(closingDaysBefore, 7) + 30 END,
         closingDaysBefore = COALESCE(closingDaysBefore, 7),
         updatedAt = ?, dirty = 1
     WHERE kind = 'credit_card' AND closingDay IS NULL AND dueDay IS NOT NULL`,
		[nowTimestamp()]
	);

	console.log('Migrated card cycles to closing day');
};

const migrateAccountRoles = async (): Promise<void> => {
	if (!(await tableExists('accounts'))) return;

	for (const [name, sql] of ACCOUNT_V8_COLUMNS) {
		if (await tableHasColumn('accounts', name)) continue;
		await db.execAsync(`ALTER TABLE accounts ADD COLUMN ${name} ${sql}`);
	}

	await db.execAsync(`
    UPDATE accounts SET role = CASE
      WHEN kind = 'credit_card' THEN 'card'
      WHEN kind IN ('savings', 'investment') THEN 'reserve'
      ELSE 'main'
    END
    WHERE role = 'main';
  `);

	console.log('Migrated accounts to roles');
};

/**
 * v6 -> v7: contas e cartões.
 *
 * `accounts` e `transfers` nascem vazias; as contas são criadas sozinhas conforme as
 * notificações e extratos chegam, e os lançamentos antigos ficam sem conta
 * (`accountId` NULL), o que a tela mostra como "sem conta" em vez de inventar uma.
 * As colunas novas são todas anuláveis, então o ALTER é aceito e nada é reescrito.
 */
const migrateAccounts = async (): Promise<void> => {
	await db.execAsync(`${CREATE_ACCOUNTS_TABLE}${CREATE_TRANSFERS_TABLE}`);

	for (const [table, columns] of [
		['transactions', TRANSACTION_V7_COLUMNS],
		['captures', CAPTURE_V7_COLUMNS],
	] as const) {
		if (!(await tableExists(table))) continue;
		for (const [name, sql] of columns) {
			if (await tableHasColumn(table, name)) continue;
			await db.execAsync(`ALTER TABLE ${table} ADD COLUMN ${name} ${sql}`);
		}
	}

	console.log('Migrated to accounts and transfers');
};

/**
 * v5 -> v6: a caixa de entrada de notificações e as regras por estabelecimento.
 *
 * Tabelas novas, sem dado a converter: o passo existe para a versão do schema contar a
 * história completa, e o `CREATE TABLE IF NOT EXISTS` da inicialização faria o mesmo.
 */
const migrateCaptureTables = async (): Promise<void> => {
	await db.execAsync(`${CREATE_CAPTURES_TABLE}${CREATE_MERCHANT_RULES_TABLE}`);
	console.log('Created capture inbox tables');
};

const runInitDatabase = async (): Promise<void> => {
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
      ${CREATE_CAPTURES_TABLE}
      ${CREATE_MERCHANT_RULES_TABLE}
      ${CREATE_ACCOUNTS_TABLE}
      ${CREATE_TRANSFERS_TABLE}
      ${CREATE_RETIREMENT_GOALS_TABLE}
      ${CREATE_DEBTS_TABLE}
      ${CREATE_INDEXES}
    `);

		await seedMissingDefaultCategories();

		console.log('Database initialized successfully');
	} catch (error) {
		console.error('Error initializing database:', error);
		throw error;
	}
};

/** A inicialização em curso, se já houver uma. Ver `initDatabase`. */
let initialisation: Promise<void> | null = null;

/**
 * Abre e migra o banco. Uma vez só, por mais vezes que seja chamada.
 *
 * A inicialização é disparada de dois lugares — `app/_layout.tsx`, que segura a splash
 * até ela terminar, e `TransactionsContext`, que precisa dela antes da primeira carga —
 * e em desenvolvimento o Strict Mode ainda duplica cada efeito. Sem esta guarda, duas
 * execuções simultâneas leem `PRAGMA user_version` **antes** de qualquer uma gravar o
 * número novo, ambas concluem que a migração falta e ambas rodam o mesmo
 * `ALTER TABLE ... ADD COLUMN`: a segunda morre com "duplicate column name", e o que o
 * usuário vê é um alerta genérico de alguma tela que estava lendo o banco naquele
 * instante. Guardar a promessa transforma toda chamada extra numa espera pela primeira.
 *
 * É também o sinal de "banco pronto" para quem lê cedo: um contexto pode `await`
 * esta função em vez de torcer para que alguém já tenha inicializado.
 *
 * A promessa é descartada quando falha — memorizar o erro condenaria a sessão inteira,
 * quando uma nova tentativa poderia funcionar.
 */
export const initDatabase = (): Promise<void> => {
	if (!initialisation) {
		initialisation = runInitDatabase().catch((error) => {
			initialisation = null;
			throw error;
		});
	}

	return initialisation;
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

export const addCategory = async (
	category: CategoryDraft,
	/**
	 * Fornecido só pela restauração de backup, que precisa manter o id original: os
	 * lançamentos do arquivo apontam para ele, e um id novo os deixaria órfãos.
	 */
	explicitId?: string
): Promise<string> => {
	const id = explicitId ?? generateUniqueId();
	// O conflito só acontece com id explícito: a restauração pode trazer de volta uma
	// categoria que este aparelho apagou (lápide). O backup é a verdade nesse caso, então
	// a lápide é revivida em vez de derrubar a importação inteira no meio.
	await db.runAsync(
		`INSERT INTO categories (id, name, color, icon, type, nature, updatedAt, deletedAt, dirty)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1)
     ON CONFLICT (id) DO UPDATE SET
       name = excluded.name, color = excluded.color, icon = excluded.icon,
       type = excluded.type, nature = excluded.nature, updatedAt = excluded.updatedAt,
       deletedAt = NULL, dirty = 1`,
		[
			id,
			category.name,
			category.color,
			category.icon,
			category.type,
			category.nature,
			nowTimestamp(),
		]
	);
	return id;
};

export const updateCategory = async (category: CategoryEdit): Promise<void> => {
	await db.runAsync(
		`UPDATE categories
     SET name = ?, color = ?, icon = ?, type = ?, nature = ?, updatedAt = ?, dirty = 1
     WHERE id = ?`,
		[
			category.name,
			category.color,
			category.icon,
			category.type,
			category.nature,
			nowTimestamp(),
			category.id,
		]
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
			`INSERT INTO transactions
         (id, amountCents, category, date, note, isIncome, accountId,
          installmentGroup, installmentIndex, installmentCount, cardLast4, updatedAt, deletedAt, dirty)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)
       ON CONFLICT (id) DO NOTHING`,
			[
				id,
				transaction.amountCents,
				transaction.category,
				transaction.date,
				transaction.note,
				transaction.isIncome ? 1 : 0,
				transaction.accountId ?? null,
				transaction.installmentGroup ?? null,
				transaction.installmentIndex ?? null,
				transaction.installmentCount ?? null,
				transaction.cardLast4 ?? null,
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
		// `accountId` só muda quando a edição diz qual é; `undefined` preserva o atual.
		// As colunas de parcela nunca mudam numa edição: são da compra, não da parcela.
		await db.runAsync(
			`UPDATE transactions
       SET amountCents = ?, category = ?, date = ?, note = ?, isIncome = ?,
           accountId = CASE WHEN ? THEN ? ELSE accountId END,
           updatedAt = ?, dirty = 1
       WHERE id = ?`,
			[
				transaction.amountCents,
				transaction.category,
				transaction.date,
				transaction.note,
				transaction.isIncome ? 1 : 0,
				transaction.accountId === undefined ? 0 : 1,
				transaction.accountId ?? null,
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
// Accounts
// ---------------------------------------------------------------------------

export const getAccounts = async (): Promise<Account[]> => {
	const rows = await db.getAllAsync<AccountDB>(
		'SELECT * FROM accounts WHERE deletedAt IS NULL ORDER BY sortOrder ASC, name ASC'
	);
	return rows.map(convertAccount);
};

export const getAccount = async (id: string): Promise<Account | null> => {
	const row = await db.getFirstAsync<AccountDB>('SELECT * FROM accounts WHERE id = ?', [id]);
	return row ? convertAccount(row) : null;
};

/** A conta ligada a um app do banco e, para cartões, ao final do cartão. */
export const findAccountBySource = async (
	packageName: string,
	last4: string | null
): Promise<Account | null> => {
	const row = last4
		? await db.getFirstAsync<AccountDB>(
				'SELECT * FROM accounts WHERE packageName = ? AND last4 = ? AND deletedAt IS NULL',
				[packageName, last4]
			)
		: await db.getFirstAsync<AccountDB>(
				"SELECT * FROM accounts WHERE packageName = ? AND last4 IS NULL AND kind <> 'credit_card' AND deletedAt IS NULL",
				[packageName]
			);
	return row ? convertAccount(row) : null;
};

/** A conta ligada a uma conta de extrato OFX (`banco:conta`). */
export const findAccountByKey = async (accountKey: string): Promise<Account | null> => {
	const row = await db.getFirstAsync<AccountDB>(
		'SELECT * FROM accounts WHERE accountKey = ? AND deletedAt IS NULL',
		[accountKey]
	);
	return row ? convertAccount(row) : null;
};

/**
 * Cartão é cartão e conta é conta: `kind = credit_card` e `role = card` andam juntos,
 * sempre. Antes as duas coisas eram escolhidas em campos separados, e um "cartão" salvo
 * como conta corrente aparecia com saldo em vez de limite. Toda gravação passa por aqui.
 * Também completa campos que backups e aparelhos antigos não trazem.
 */
export const normalizeAccountDraft = (account: AccountDraft): AccountDraft => {
	const isCard = account.kind === 'credit_card' || account.role === 'card';
	const kind = isCard ? 'credit_card' : account.kind;
	const role = isCard
		? 'card'
		: account.role && account.role !== 'card'
			? account.role
			: defaultRoleFor(kind);
	return {
		...account,
		kind,
		role,
		envelopeMonthlyCents: role === 'envelope' ? (account.envelopeMonthlyCents ?? null) : null,
		network: isCard ? (account.network ?? null) : null,
		bankName: account.bankName ?? null,
		last4: account.last4 ?? null,
		closingDay: isCard ? (account.closingDay ?? null) : null,
		dueDay: isCard ? (account.dueDay ?? null) : null,
		closingDaysBefore:
			isCard && account.closingDay ? (account.closingDaysBefore ?? DEFAULT_CLOSING_DAYS_BEFORE) : null,
		creditLimitCents: isCard ? (account.creditLimitCents ?? null) : null,
		cardNames: account.cardNames ?? null,
		packageName: account.packageName ?? null,
		accountKey: account.accountKey ?? null,
		sortOrder: account.sortOrder ?? 0,
		archived: Boolean(account.archived),
	};
};

const accountValues = (account: AccountDraft): Array<string | number | null> => [
	account.name,
	account.kind,
	account.role,
	account.envelopeMonthlyCents,
	account.network,
	account.bankName,
	account.color,
	account.last4,
	account.closingDay,
	account.dueDay,
	account.closingDaysBefore,
	account.creditLimitCents,
	account.cardNames,
	account.packageName,
	account.accountKey,
	account.openingBalanceCents,
	account.openingBalanceDate,
	account.sortOrder,
	account.archived ? 1 : 0,
];

export const addAccount = async (draft: AccountDraft, explicitId?: string): Promise<string> => {
	const id = explicitId ?? generateUniqueId();
	const account = normalizeAccountDraft(draft);
	await db.runAsync(
		`INSERT INTO accounts
       (name, kind, role, envelopeMonthlyCents, network, bankName, color, last4, closingDay, dueDay,
        closingDaysBefore, creditLimitCents, cardNames, packageName, accountKey, openingBalanceCents, openingBalanceDate,
        sortOrder, archived, id, updatedAt, deletedAt, dirty)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)
     ON CONFLICT (id) DO NOTHING`,
		[...accountValues(account), id, nowTimestamp()]
	);
	return id;
};

export const updateAccount = async (edit: AccountEdit): Promise<void> => {
	const { id, ...draft } = edit;
	const account = normalizeAccountDraft(draft);
	await db.runAsync(
		`UPDATE accounts
     SET name = ?, kind = ?, role = ?, envelopeMonthlyCents = ?, network = ?, bankName = ?, color = ?,
         last4 = ?, closingDay = ?, dueDay = ?, closingDaysBefore = ?, creditLimitCents = ?, cardNames = ?, packageName = ?, accountKey = ?,
         openingBalanceCents = ?, openingBalanceDate = ?, sortOrder = ?, archived = ?,
         updatedAt = ?, dirty = 1
     WHERE id = ?`,
		[...accountValues(account), nowTimestamp(), id]
	);
};

/** Lápide, como nas demais tabelas sincronizadas. Os lançamentos ficam "sem conta". */
export const deleteAccount = async (id: string): Promise<void> => {
	const timestamp = nowTimestamp();
	await db.withTransactionAsync(async () => {
		await db.runAsync('UPDATE accounts SET deletedAt = ?, updatedAt = ?, dirty = 1 WHERE id = ?', [
			timestamp,
			timestamp,
			id,
		]);
		await db.runAsync(
			'UPDATE transactions SET accountId = NULL, updatedAt = ?, dirty = 1 WHERE accountId = ? AND deletedAt IS NULL',
			[timestamp, id]
		);
	});
};

/**
 * Leva os lançamentos e capturas de uma conta para outra. Serve para desfazer um
 * cartão de débito cadastrado como cartão: débito sai direto da conta, então o que foi
 * lançado nele pertence à conta.
 */
export const moveAccountLedger = async (fromId: string, toId: string, cardLast4: string | null = null): Promise<void> => {
	const timestamp = nowTimestamp();
	await db.withTransactionAsync(async () => {
		// Lançamento sem final de cartão ganha o do cartão que está saindo: o histórico
		// continua sabendo que foi aquele cartão.
		await db.runAsync(
			'UPDATE transactions SET accountId = ?, cardLast4 = COALESCE(cardLast4, ?), updatedAt = ?, dirty = 1 WHERE accountId = ? AND deletedAt IS NULL',
			[toId, cardLast4, timestamp, fromId]
		);
		await db.runAsync('UPDATE captures SET accountId = ? WHERE accountId = ?', [toId, fromId]);
	});
};

/**
 * Leva o que uma captura pôs no livro — a transação, ou todas as parcelas do grupo — para
 * outra conta. Usado quando o aviso do banco revela o cartão de uma compra que o Samsung
 * Pay avisou antes.
 */
export const reassignCaptureLedger = async (
	transactionId: string | null,
	installmentGroup: string,
	accountId: string | null
): Promise<void> => {
	await db.runAsync(
		'UPDATE transactions SET accountId = ?, updatedAt = ?, dirty = 1 WHERE (id = ? OR installmentGroup = ?) AND deletedAt IS NULL',
		[accountId, nowTimestamp(), transactionId ?? '', installmentGroup]
	);
};

/** O que passou por uma conta num intervalo, nas quatro direções. Tudo em centavos. */
export interface AccountActivity {
	incomeCents: number;
	expenseCents: number;
	/** Parte de `expenseCents` em categorias de repasse (`nature = 'passthrough'`). */
	passThroughCents: number;
	transfersInCents: number;
	transfersOutCents: number;
}

export const getAccountActivity = async (
	accountId: string,
	startDate: string,
	endDate: string
): Promise<AccountActivity> => {
	const [tx, transfers] = await Promise.all([
		db.getFirstAsync<{ income: number; expense: number; passThrough: number }>(
			`SELECT
         COALESCE(SUM(CASE WHEN t.isIncome = 1 THEN t.amountCents ELSE 0 END), 0) AS income,
         COALESCE(SUM(CASE WHEN t.isIncome = 0 THEN t.amountCents ELSE 0 END), 0) AS expense,
         COALESCE(SUM(CASE WHEN t.isIncome = 0 AND c.nature = 'passthrough' THEN t.amountCents ELSE 0 END), 0) AS passThrough
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category
       WHERE t.accountId = ? AND t.date BETWEEN ? AND ? AND t.deletedAt IS NULL`,
			[accountId, startDate, endDate]
		),
		db.getFirstAsync<{ inbound: number; outbound: number }>(
			`SELECT
         COALESCE(SUM(CASE WHEN toAccountId = ? THEN amountCents ELSE 0 END), 0) AS inbound,
         COALESCE(SUM(CASE WHEN fromAccountId = ? THEN amountCents ELSE 0 END), 0) AS outbound
       FROM transfers
       WHERE (toAccountId = ? OR fromAccountId = ?) AND date BETWEEN ? AND ? AND deletedAt IS NULL`,
			[accountId, accountId, accountId, accountId, startDate, endDate]
		),
	]);

	return {
		incomeCents: tx?.income ?? 0,
		expenseCents: tx?.expense ?? 0,
		passThroughCents: tx?.passThrough ?? 0,
		transfersInCents: transfers?.inbound ?? 0,
		transfersOutCents: transfers?.outbound ?? 0,
	};
};

/**
 * Saldo de cada conta no fim de `asOfDate`: a âncora mais tudo que veio depois dela.
 * Uma só consulta para todas as contas; a tela inicial chama isto a cada recarga.
 */
export const getAccountBalances = async (asOfDate: string): Promise<Map<string, number>> => {
	const rows = await db.getAllAsync<{ accountId: string; balanceCents: number }>(
		`SELECT a.id AS accountId,
            a.openingBalanceCents
            + COALESCE((SELECT SUM(CASE WHEN t.isIncome = 1 THEN t.amountCents ELSE -t.amountCents END)
                        FROM transactions t
                        WHERE t.accountId = a.id AND t.deletedAt IS NULL
                          AND t.date > a.openingBalanceDate AND t.date <= ?), 0)
            - COALESCE((SELECT SUM(x.amountCents) FROM transfers x
                        WHERE x.fromAccountId = a.id AND x.deletedAt IS NULL
                          AND x.date > a.openingBalanceDate AND x.date <= ?), 0)
            + COALESCE((SELECT SUM(x.amountCents) FROM transfers x
                        WHERE x.toAccountId = a.id AND x.deletedAt IS NULL
                          AND x.date > a.openingBalanceDate AND x.date <= ?), 0) AS balanceCents
     FROM accounts a
     WHERE a.deletedAt IS NULL`,
		[asOfDate, asOfDate, asOfDate]
	);
	return new Map(rows.map((row) => [row.accountId, row.balanceCents]));
};

/** Receita e despesa dos lançamentos sem conta num período. */
export const getUnassignedPeriodSummary = async (
	startDate: string,
	endDate: string
): Promise<{ incomeCents: number; expenseCents: number; passThroughCents: number }> => {
	const row = await db.getFirstAsync<{ income: number; expense: number; passThrough: number }>(
		`SELECT
       COALESCE(SUM(CASE WHEN t.isIncome = 1 THEN t.amountCents ELSE 0 END), 0) AS income,
       COALESCE(SUM(CASE WHEN t.isIncome = 0 THEN t.amountCents ELSE 0 END), 0) AS expense,
       COALESCE(SUM(CASE WHEN t.isIncome = 0 AND c.nature = 'passthrough' THEN t.amountCents ELSE 0 END), 0) AS passThrough
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category
     WHERE t.accountId IS NULL AND t.date BETWEEN ? AND ? AND t.deletedAt IS NULL`,
		[startDate, endDate]
	);
	return { incomeCents: row?.income ?? 0, expenseCents: row?.expense ?? 0, passThroughCents: row?.passThrough ?? 0 };
};

/**
 * Valor cheio das compras **feitas** num cartão no período: as à vista datadas nele,
 * mais o total de cada compra parcelada cuja primeira parcela cai nele. É a métrica
 * "quanto comprei este mês", diferente de "quanto cai na fatura".
 */
export const getCardPurchasesOriginated = async (
	accountId: string,
	startDate: string,
	endDate: string
): Promise<number> => {
	const [single, groups] = await Promise.all([
		db.getFirstAsync<{ total: number }>(
			`SELECT COALESCE(SUM(amountCents), 0) AS total FROM transactions
       WHERE accountId = ? AND isIncome = 0 AND installmentGroup IS NULL
         AND date BETWEEN ? AND ? AND deletedAt IS NULL`,
			[accountId, startDate, endDate]
		),
		db.getFirstAsync<{ total: number }>(
			`SELECT COALESCE(SUM(t.amountCents), 0) AS total FROM transactions t
       WHERE t.accountId = ? AND t.isIncome = 0 AND t.deletedAt IS NULL
         AND t.installmentGroup IN (
           SELECT installmentGroup FROM transactions
           WHERE accountId = ? AND installmentIndex = 1 AND date BETWEEN ? AND ? AND deletedAt IS NULL
         )`,
			[accountId, accountId, startDate, endDate]
		),
	]);
	return (single?.total ?? 0) + (groups?.total ?? 0);
};

/** Dá uma conta a todos os lançamentos que não têm nenhuma. Devolve quantos mudaram. */
export const assignUnassignedTransactions = async (accountId: string): Promise<number> => {
	const result = await db.runAsync(
		'UPDATE transactions SET accountId = ?, updatedAt = ?, dirty = 1 WHERE accountId IS NULL AND deletedAt IS NULL',
		[accountId, nowTimestamp()]
	);
	return result.changes;
};

/** Receita menos despesa dos lançamentos sem conta, até `asOfDate`. */
export const getUnassignedNet = async (asOfDate: string): Promise<number> => {
	const row = await db.getFirstAsync<{ net: number }>(
		`SELECT COALESCE(SUM(CASE WHEN isIncome = 1 THEN amountCents ELSE -amountCents END), 0) AS net
     FROM transactions WHERE accountId IS NULL AND date <= ? AND deletedAt IS NULL`,
		[asOfDate]
	);
	return row?.net ?? 0;
};

/**
 * "Meu saldo agora é X": move a âncora para ontem, com o valor que faz o saldo de hoje
 * bater com X depois de somar o que já aconteceu hoje. Lançamentos que entrarem mais
 * tarde hoje continuam somando por cima, porque são datados depois da âncora.
 */
/** Âncora explícita: o saldo (num cartão, negativo = deve) no fim de `date`. */
export const setAccountAnchor = async (accountId: string, balanceCents: number, date: string): Promise<void> => {
	await db.runAsync(
		`UPDATE accounts SET openingBalanceCents = ?, openingBalanceDate = ?, updatedAt = ?, dirty = 1
     WHERE id = ?`,
		[balanceCents, date, nowTimestamp(), accountId]
	);
};

export const setAccountBalanceToday = async (accountId: string, balanceCents: number): Promise<void> => {
	const today = todayISO();
	const activity = await getAccountActivity(accountId, today, today);
	const todayNet =
		activity.incomeCents - activity.expenseCents + activity.transfersInCents - activity.transfersOutCents;

	await db.runAsync(
		`UPDATE accounts SET openingBalanceCents = ?, openingBalanceDate = ?, updatedAt = ?, dirty = 1
     WHERE id = ?`,
		[balanceCents - todayNet, addDays(today, -1), nowTimestamp(), accountId]
	);
};

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

export const addTransfer = async (transfer: TransferDraft, explicitId?: string): Promise<string> => {
	const id = explicitId ?? generateUniqueId();
	await db.runAsync(
		`INSERT INTO transfers (id, fromAccountId, toAccountId, amountCents, date, note, updatedAt, deletedAt, dirty)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1)
     ON CONFLICT (id) DO NOTHING`,
		[id, transfer.fromAccountId, transfer.toAccountId, transfer.amountCents, transfer.date, transfer.note, nowTimestamp()]
	);
	return id;
};

export const updateTransfer = async (transfer: TransferEdit): Promise<void> => {
	await db.runAsync(
		`UPDATE transfers SET fromAccountId = ?, toAccountId = ?, amountCents = ?, date = ?, note = ?,
       updatedAt = ?, dirty = 1
     WHERE id = ?`,
		[transfer.fromAccountId, transfer.toAccountId, transfer.amountCents, transfer.date, transfer.note, nowTimestamp(), transfer.id]
	);
};

export const getTransfer = async (id: string): Promise<Transfer | null> => {
	const row = await db.getFirstAsync<TransferDB>('SELECT * FROM transfers WHERE id = ?', [id]);
	return row ? convertTransfer(row) : null;
};

export const deleteTransfer = async (id: string): Promise<void> => {
	const timestamp = nowTimestamp();
	await db.runAsync('UPDATE transfers SET deletedAt = ?, updatedAt = ?, dirty = 1 WHERE id = ?', [
		timestamp,
		timestamp,
		id,
	]);
};

/**
 * Uma transferência viva que já registra este movimento: mesmo valor, poucos dias de
 * diferença, e os lados conhecidos batem — um lado nulo (conta que o app não
 * acompanha, ou ainda não identificada) casa com qualquer coisa. É o que impede o
 * pagamento da fatura de virar duas transferências quando a conta e o cartão avisam.
 */
/** Nomes dos cartões de uma conta (`cardNames`, JSON). */
export const setAccountCardNames = async (accountId: string, cardNames: string | null): Promise<void> => {
	await db.runAsync('UPDATE accounts SET cardNames = ?, updatedAt = ?, dirty = 1 WHERE id = ?', [
		cardNames,
		nowTimestamp(),
		accountId,
	]);
};

/** Lápide em todas as transferências que entram ou saem de uma conta. */
export const deleteTransfersOf = async (accountId: string): Promise<void> => {
	const timestamp = nowTimestamp();
	await db.runAsync(
		'UPDATE transfers SET deletedAt = ?, updatedAt = ?, dirty = 1 WHERE (fromAccountId = ? OR toAccountId = ?) AND deletedAt IS NULL',
		[timestamp, timestamp, accountId, accountId]
	);
};

/** Um pagamento para o cartão, de mesmo valor e perto da data, venha de qual conta vier. */
export const findCardPayment = async (cardId: string, amountCents: number, date: string, windowDays: number): Promise<Transfer | null> => {
	const row = await db.getFirstAsync<TransferDB>(
		`SELECT * FROM transfers
     WHERE toAccountId = ? AND amountCents = ? AND date BETWEEN ? AND ? AND deletedAt IS NULL
     ORDER BY date DESC LIMIT 1`,
		[cardId, amountCents, addDays(date, -windowDays), addDays(date, windowDays)]
	);
	return row ? convertTransfer(row) : null;
};

export const findLiveTransfer = async (match: {
	amountCents: number;
	fromAccountId: string | null;
	toAccountId: string | null;
	dateFrom: string;
	dateTo: string;
}): Promise<Transfer | null> => {
	const row = await db.getFirstAsync<TransferDB>(
		`SELECT * FROM transfers
     WHERE amountCents = ? AND date BETWEEN ? AND ? AND deletedAt IS NULL
       AND (fromAccountId IS NULL OR ? IS NULL OR fromAccountId = ?)
       AND (toAccountId IS NULL OR ? IS NULL OR toAccountId = ?)
       AND ((? IS NOT NULL AND fromAccountId = ?) OR (? IS NOT NULL AND toAccountId = ?))
     ORDER BY date DESC LIMIT 1`,
		[
			match.amountCents,
			match.dateFrom,
			match.dateTo,
			match.fromAccountId,
			match.fromAccountId,
			match.toAccountId,
			match.toAccountId,
			match.fromAccountId,
			match.fromAccountId,
			match.toAccountId,
			match.toAccountId,
		]
	);
	return row ? convertTransfer(row) : null;
};

/** Apaga (com lápide) todas as parcelas de uma compra parcelada. */
export const deleteTransactionsInGroup = async (installmentGroup: string): Promise<void> => {
	const timestamp = nowTimestamp();
	await db.runAsync(
		'UPDATE transactions SET deletedAt = ?, updatedAt = ?, dirty = 1 WHERE installmentGroup = ? AND deletedAt IS NULL',
		[timestamp, timestamp, installmentGroup]
	);
};

/** Dá conta a um lançamento que ainda não tem: o extrato sabe de onde ele saiu. */
export const assignTransactionAccount = async (id: string, accountId: string): Promise<void> => {
	await db.runAsync(
		'UPDATE transactions SET accountId = ?, updatedAt = ?, dirty = 1 WHERE id = ? AND accountId IS NULL',
		[accountId, nowTimestamp(), id]
	);
};

/** Todos os lançamentos vivos de uma conta ou cartão, inclusive parcelas futuras. */
export const getAccountTransactions = async (accountId: string): Promise<Transaction[]> => {
	const rows = await db.getAllAsync<TransactionDB>(
		'SELECT * FROM transactions WHERE accountId = ? AND deletedAt IS NULL ORDER BY date DESC',
		[accountId]
	);
	return rows.map(convertTransaction);
};

/** Transferências vivas que entram ou saem de uma conta ou cartão. */
export const getAccountTransfers = async (accountId: string): Promise<Transfer[]> => {
	const rows = await db.getAllAsync<TransferDB>(
		'SELECT * FROM transfers WHERE (fromAccountId = ? OR toAccountId = ?) AND deletedAt IS NULL ORDER BY date DESC',
		[accountId, accountId]
	);
	return rows.map(convertTransfer);
};

export const getTransfers = async (): Promise<Transfer[]> => {
	const rows = await db.getAllAsync<TransferDB>(
		'SELECT * FROM transfers WHERE deletedAt IS NULL ORDER BY date DESC'
	);
	return rows.map(convertTransfer);
};

export const getTransfersByDateRange = async (startDate: string, endDate: string): Promise<Transfer[]> => {
	const rows = await db.getAllAsync<TransferDB>(
		'SELECT * FROM transfers WHERE date BETWEEN ? AND ? AND deletedAt IS NULL ORDER BY date DESC',
		[startDate, endDate]
	);
	return rows.map(convertTransfer);
};

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

export interface PeriodSummary {
	/** Receita líquida: o que entrou menos os repasses. */
	incomeCents: number;
	/** Gasto sem os repasses. */
	expenseCents: number;
	/** O que só passou pela conta (categorias de repasse): fora da receita e do gasto. */
	passThroughCents: number;
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
		const row = await db.getFirstAsync<{ income: number; expense: number; passThrough: number }>(
			`SELECT
         COALESCE(SUM(CASE WHEN t.isIncome = 1 THEN t.amountCents ELSE 0 END), 0) AS income,
         COALESCE(SUM(CASE WHEN t.isIncome = 0 THEN t.amountCents ELSE 0 END), 0) AS expense,
         COALESCE(SUM(CASE WHEN t.isIncome = 0 AND c.nature = 'passthrough' THEN t.amountCents ELSE 0 END), 0) AS passThrough
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category
       WHERE t.date BETWEEN ? AND ? AND t.deletedAt IS NULL`,
			[startDate, endDate]
		);

		// Um repasse entrou e saiu sem ser seu: fica fora dos dois lados.
		const passThroughCents = row?.passThrough ?? 0;
		const incomeCents = (row?.income ?? 0) - passThroughCents;
		const expenseCents = (row?.expense ?? 0) - passThroughCents;

		return { incomeCents, expenseCents, passThroughCents, netCents: incomeCents - expenseCents };
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
// Monthly aggregates for the reports
// ---------------------------------------------------------------------------

/** Receita, despesa e repasse de cada conta por mês (`accountId` nulo = sem conta). */
export interface MonthAccountActivityRow {
	/** `YYYY-MM`. */
	month: string;
	accountId: string | null;
	incomeCents: number;
	expenseCents: number;
	passThroughCents: number;
}

/**
 * Uma consulta para o histórico inteiro: os relatórios montam um quadro do mês por mês
 * a partir daqui em vez de repetir `getAccountActivity` conta a conta, mês a mês.
 * `GROUP BY accountId` junta as linhas sem conta numa só, que é o que se quer.
 */
export const getMonthlyAccountActivity = (startDate: string, endDate: string): Promise<MonthAccountActivityRow[]> =>
	db.getAllAsync<MonthAccountActivityRow>(
		`SELECT substr(t.date, 1, 7) AS month,
            t.accountId,
            COALESCE(SUM(CASE WHEN t.isIncome = 1 THEN t.amountCents ELSE 0 END), 0) AS incomeCents,
            COALESCE(SUM(CASE WHEN t.isIncome = 0 THEN t.amountCents ELSE 0 END), 0) AS expenseCents,
            COALESCE(SUM(CASE WHEN t.isIncome = 0 AND c.nature = 'passthrough' THEN t.amountCents ELSE 0 END), 0) AS passThroughCents
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category
     WHERE t.date BETWEEN ? AND ? AND t.deletedAt IS NULL
     GROUP BY month, t.accountId
     ORDER BY month ASC`,
		[startDate, endDate]
	);

/** O que entrou e saiu de cada conta por transferência, por mês. */
export interface MonthTransferActivityRow {
	month: string;
	accountId: string;
	inCents: number;
	outCents: number;
}

export const getMonthlyTransferActivity = (startDate: string, endDate: string): Promise<MonthTransferActivityRow[]> =>
	db.getAllAsync<MonthTransferActivityRow>(
		`SELECT month, accountId, SUM(inCents) AS inCents, SUM(outCents) AS outCents FROM (
       SELECT substr(date, 1, 7) AS month, toAccountId AS accountId, amountCents AS inCents, 0 AS outCents
       FROM transfers WHERE toAccountId IS NOT NULL AND date BETWEEN ? AND ? AND deletedAt IS NULL
       UNION ALL
       SELECT substr(date, 1, 7) AS month, fromAccountId AS accountId, 0 AS inCents, amountCents AS outCents
       FROM transfers WHERE fromAccountId IS NOT NULL AND date BETWEEN ? AND ? AND deletedAt IS NULL
     )
     GROUP BY month, accountId
     ORDER BY month ASC`,
		[startDate, endDate, startDate, endDate]
	);

export interface MonthCategoryTotalRow {
	month: string;
	categoryId: string;
	totalCents: number;
}

export const getMonthlyCategoryTotals = (startDate: string, endDate: string, transactionType: 'income' | 'expense'): Promise<MonthCategoryTotalRow[]> =>
	db.getAllAsync<MonthCategoryTotalRow>(
		`SELECT substr(date, 1, 7) AS month, category AS categoryId, SUM(amountCents) AS totalCents
     FROM transactions
     WHERE date BETWEEN ? AND ? AND deletedAt IS NULL AND isIncome = ?
     GROUP BY month, category
     ORDER BY month ASC`,
		[startDate, endDate, transactionType === 'income' ? 1 : 0]
	);

/** Todas as linhas vivas de um conjunto de contas — as faturas de vários meses saem daqui. */
export const getTransactionsForAccounts = async (accountIds: string[]): Promise<Transaction[]> => {
	if (accountIds.length === 0) return [];
	const placeholders = accountIds.map(() => '?').join(', ');
	const rows = await db.getAllAsync<TransactionDB>(
		`SELECT * FROM transactions WHERE accountId IN (${placeholders}) AND deletedAt IS NULL ORDER BY date ASC`,
		accountIds
	);
	return rows.map(convertTransaction);
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
 * The rule itself — "a cycle already charged only charges again next cycle" — lives in
 * `nextDueAfterEdit`, where it is unit tested; this only feeds it today's date.
 */
const resolveNextDue = (transaction: RecurringTransactionEdit): string =>
	nextDueAfterEdit(toRule(transaction), transaction.lastProcessed, todayISO());

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

				// Resume from the day after the last posting, but never before `nextDue`:
				// after an edit, `nextDue` already skips the rest of the cycle that was
				// charged, and re-scanning from `lastProcessed + 1` would post the new day
				// in that same cycle. A rule that has never run starts at its first occurrence.
				const resumeFrom = transaction.lastProcessed
					? addDays(transaction.lastProcessed, 1)
					: (transaction.nextDue ?? today);
				const windowStart =
					transaction.nextDue && transaction.nextDue > resumeFrom ? transaction.nextDue : resumeFrom;

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
		await db.runAsync(
			`UPDATE retirement_goals
       SET targetMonthlyCents = CAST(ROUND(targetMonthlyCents * ?) AS INTEGER),
           outsideCapitalCents = CAST(ROUND(outsideCapitalCents * ?) AS INTEGER),
           updatedAt = ?, dirty = 1
       WHERE deletedAt IS NULL`,
			[rate, rate, timestamp]
		);
		await db.runAsync(
			`UPDATE debts
       SET openingBalanceCents = CAST(ROUND(openingBalanceCents * ?) AS INTEGER),
           installmentCents = CAST(ROUND(installmentCents * ?) AS INTEGER),
           updatedAt = ?, dirty = 1
       WHERE deletedAt IS NULL`,
			[rate, rate, timestamp]
		);
	});
};

// ---------------------------------------------------------------------------
// Debts
// ---------------------------------------------------------------------------

const convertDebt = (row: DebtDB): Debt => ({
	id: row.id,
	name: row.name,
	kind: row.kind,
	system: row.system,
	openingBalanceCents: row.openingBalanceCents,
	openingBalanceDate: row.openingBalanceDate,
	installmentCents: row.installmentCents,
	remainingAtOpening: row.remainingAtOpening,
	installmentsTotal: row.installmentsTotal,
	dueDay: row.dueDay,
	rateBp: row.rateBp,
	adminFeeBp: row.adminFeeBp ?? null,
	accountId: row.accountId ?? null,
	category: row.category ?? null,
	archived: Boolean(row.archived),
	sortOrder: row.sortOrder,
	updatedAt: row.updatedAt,
	deletedAt: row.deletedAt ?? undefined,
});

/** As dívidas vivas, quitadas inclusive (a tela separa). */
export const getDebts = async (): Promise<Debt[]> => {
	const rows = await db.getAllAsync<DebtDB>('SELECT * FROM debts WHERE deletedAt IS NULL ORDER BY archived ASC, sortOrder ASC, name ASC');
	return rows.map(convertDebt);
};

const DEBT_COLUMNS = [
	'name',
	'kind',
	'system',
	'openingBalanceCents',
	'openingBalanceDate',
	'installmentCents',
	'remainingAtOpening',
	'installmentsTotal',
	'dueDay',
	'rateBp',
	'adminFeeBp',
	'accountId',
	'category',
	'archived',
	'sortOrder',
] as const;

const debtValues = (draft: DebtDraft) =>
	DEBT_COLUMNS.map((column) => {
		const value = draft[column];
		return typeof value === 'boolean' ? (value ? 1 : 0) : (value ?? null);
	});

export const addDebt = async (draft: DebtDraft): Promise<string> => {
	const id = generateUniqueId();
	await db.runAsync(
		`INSERT INTO debts (id, ${DEBT_COLUMNS.join(', ')}, updatedAt, deletedAt, dirty)
     VALUES (?, ${DEBT_COLUMNS.map(() => '?').join(', ')}, ?, NULL, 1)`,
		[id, ...debtValues(draft), nowTimestamp()]
	);
	return id;
};

export const updateDebt = async (id: string, draft: DebtDraft): Promise<void> => {
	await db.runAsync(
		`UPDATE debts SET ${DEBT_COLUMNS.map((column) => `${column} = ?`).join(', ')}, updatedAt = ?, dirty = 1 WHERE id = ?`,
		[...debtValues(draft), nowTimestamp(), id]
	);
};

/** Lápide: some aqui e, no próximo sync, dos outros aparelhos. */
export const deleteDebt = async (id: string): Promise<void> => {
	const timestamp = nowTimestamp();
	await db.runAsync('UPDATE debts SET deletedAt = ?, updatedAt = ?, dirty = 1 WHERE id = ? AND deletedAt IS NULL', [timestamp, timestamp, id]);
};

// ---------------------------------------------------------------------------
// Retirement goal
// ---------------------------------------------------------------------------

export type RetirementGoalDraft = Omit<RetirementGoalRow, 'id' | 'updatedAt' | 'deletedAt'>;

const convertRetirementGoal = (row: RetirementGoalDB): RetirementGoalRow => ({
	id: row.id,
	targetMonthlyCents: row.targetMonthlyCents,
	reinvestBp: row.reinvestBp,
	expectedYieldBp: row.expectedYieldBp,
	outsideCapitalCents: row.outsideCapitalCents,
	updatedAt: row.updatedAt,
	deletedAt: row.deletedAt ?? undefined,
});

/** A meta de aposentadoria, ou nula enquanto o usuário não definiu (ou limpou) uma. */
export const getRetirementGoal = async (): Promise<RetirementGoalRow | null> => {
	const row = await db.getFirstAsync<RetirementGoalDB>(
		'SELECT * FROM retirement_goals WHERE id = ? AND deletedAt IS NULL',
		[RETIREMENT_GOAL_ID]
	);
	return row ? convertRetirementGoal(row) : null;
};

/** Define (ou redefine) a meta. Uma meta limpa antes volta à vida na mesma linha. */
export const setRetirementGoal = async (draft: RetirementGoalDraft): Promise<void> => {
	await db.runAsync(
		`INSERT INTO retirement_goals (id, targetMonthlyCents, reinvestBp, expectedYieldBp, outsideCapitalCents, updatedAt, deletedAt, dirty)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 1)
     ON CONFLICT (id) DO UPDATE SET
       targetMonthlyCents = excluded.targetMonthlyCents, reinvestBp = excluded.reinvestBp,
       expectedYieldBp = excluded.expectedYieldBp, outsideCapitalCents = excluded.outsideCapitalCents,
       updatedAt = excluded.updatedAt, deletedAt = NULL, dirty = 1`,
		[RETIREMENT_GOAL_ID, draft.targetMonthlyCents, draft.reinvestBp, draft.expectedYieldBp, draft.outsideCapitalCents, nowTimestamp()]
	);
};

export const clearRetirementGoal = async (): Promise<void> => {
	const timestamp = nowTimestamp();
	await db.runAsync('UPDATE retirement_goals SET deletedAt = ?, updatedAt = ?, dirty = 1 WHERE id = ? AND deletedAt IS NULL', [
		timestamp,
		timestamp,
		RETIREMENT_GOAL_ID,
	]);
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
	const [categories, accounts, transactions, recurring, budgets, transfers, retirementGoals, debts] = await Promise.all([
		db.getAllAsync<Category & { dirty: number; deletedAt: string | null }>(
			'SELECT * FROM categories WHERE dirty = 1 ORDER BY updatedAt ASC LIMIT ?',
			[limit]
		),
		db.getAllAsync<AccountDB>('SELECT * FROM accounts WHERE dirty = 1 ORDER BY updatedAt ASC LIMIT ?', [
			limit,
		]),
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
		db.getAllAsync<TransferDB>('SELECT * FROM transfers WHERE dirty = 1 ORDER BY updatedAt ASC LIMIT ?', [
			limit,
		]),
		db.getAllAsync<RetirementGoalDB>('SELECT * FROM retirement_goals WHERE dirty = 1 ORDER BY updatedAt ASC LIMIT ?', [
			limit,
		]),
		db.getAllAsync<DebtDB>('SELECT * FROM debts WHERE dirty = 1 ORDER BY updatedAt ASC LIMIT ?', [limit]),
	]);

	return {
		categories: categories.map((row) => ({
			id: row.id,
			name: row.name,
			color: row.color,
			icon: row.icon,
			type: row.type,
			nature: row.nature,
			updatedAt: row.updatedAt,
			deletedAt: row.deletedAt ?? null,
		})),
		accounts: accounts.map((row) => ({
			id: row.id,
			name: row.name,
			kind: row.kind,
			role: row.role ?? 'main',
			envelopeMonthlyCents: row.envelopeMonthlyCents ?? null,
			network: row.network ?? null,
			bankName: row.bankName,
			color: row.color,
			last4: row.last4,
			closingDay: row.closingDay,
			dueDay: row.dueDay,
			closingDaysBefore: row.closingDaysBefore ?? null,
			creditLimitCents: row.creditLimitCents,
			cardNames: row.cardNames ?? null,
			packageName: row.packageName,
			accountKey: row.accountKey,
			openingBalanceCents: row.openingBalanceCents,
			openingBalanceDate: row.openingBalanceDate,
			sortOrder: row.sortOrder,
			archived: Boolean(row.archived),
			updatedAt: row.updatedAt,
			deletedAt: row.deletedAt,
		})),
		transactions: transactions.map((row) => ({
			id: row.id,
			amountCents: row.amountCents,
			category: row.category,
			date: row.date,
			note: row.note ?? null,
			isIncome: Boolean(row.isIncome),
			accountId: row.accountId ?? null,
			installmentGroup: row.installmentGroup ?? null,
			installmentIndex: row.installmentIndex ?? null,
			installmentCount: row.installmentCount ?? null,
			cardLast4: row.cardLast4 ?? null,
			updatedAt: row.updatedAt,
			deletedAt: row.deletedAt,
		})),
		transfers: transfers.map((row) => ({
			id: row.id,
			fromAccountId: row.fromAccountId,
			toAccountId: row.toAccountId,
			amountCents: row.amountCents,
			date: row.date,
			note: row.note ?? null,
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
		retirementGoals: retirementGoals.map((row) => ({
			id: row.id,
			targetMonthlyCents: row.targetMonthlyCents,
			reinvestBp: row.reinvestBp,
			expectedYieldBp: row.expectedYieldBp,
			outsideCapitalCents: row.outsideCapitalCents,
			updatedAt: row.updatedAt,
			deletedAt: row.deletedAt,
		})),
		debts: debts.map((row) => ({
			id: row.id,
			name: row.name,
			kind: row.kind,
			system: row.system,
			openingBalanceCents: row.openingBalanceCents,
			openingBalanceDate: row.openingBalanceDate,
			installmentCents: row.installmentCents,
			remainingAtOpening: row.remainingAtOpening,
			installmentsTotal: row.installmentsTotal,
			dueDay: row.dueDay,
			rateBp: row.rateBp,
			adminFeeBp: row.adminFeeBp ?? null,
			accountId: row.accountId ?? null,
			category: row.category ?? null,
			archived: Boolean(row.archived),
			sortOrder: row.sortOrder,
			updatedAt: row.updatedAt,
			deletedAt: row.deletedAt,
		})),
	};
};

/** Quantas linhas ainda faltam subir. Alimenta o indicador de status do sync. */
export const countDirtyRows = async (): Promise<number> => {
	const subqueries = SYNCED_TABLES.map(
		(table) => `(SELECT COUNT(*) FROM ${table} WHERE dirty = 1)`
	).join(' + ');

	const row = await db.getFirstAsync<{ count: number }>(`SELECT ${subqueries} AS count`);
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
		['accounts', changes.accounts ?? []],
		['transactions', changes.transactions],
		['recurring_transactions', changes.recurringTransactions],
		['budgets', changes.budgets],
		['transfers', changes.transfers ?? []],
		['retirement_goals', changes.retirementGoals ?? []],
		['debts', changes.debts ?? []],
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
 * Se a categoria existe neste aparelho, apagada ou não.
 *
 * As lápides contam: o servidor também considera uma categoria apagada como conhecida,
 * e reenviá-la é o que faz um lançamento que a referencia ser aceito.
 */
export const hasCategory = async (categoryId: string): Promise<boolean> => {
	const row = await db.getFirstAsync<{ id: string }>('SELECT id FROM categories WHERE id = ?', [
		categoryId,
	]);
	return row !== null;
};

/**
 * Pede para uma categoria subir de novo no próximo push, sem mexer no `updatedAt`.
 *
 * É a resposta ao servidor dizer que não conhece uma categoria que um lançamento
 * daqui usa. Bumpar o `updatedAt` seria fingir uma edição, e poderia atropelar no
 * last-write-wins uma alteração legítima feita em outro aparelho; reenviar a linha
 * idêntica é inofensivo, porque o empate é resolvido a favor de quem envia.
 */
export const markCategoryDirty = async (categoryId: string): Promise<void> => {
	await db.runAsync('UPDATE categories SET dirty = 1 WHERE id = ?', [categoryId]);
};

/**
 * Move um lançamento ou recorrência para 'uncategorized' — o mesmo destino que
 * `deleteCategory` dá a eles — quando a categoria original não existe mais nem aqui.
 *
 * É uma edição de verdade, então `updatedAt` avança e a linha volta a ficar suja:
 * é ela, e não a versão órfã, que os outros aparelhos precisam receber.
 */
export const reassignToUncategorized = async (
	table: 'transactions' | 'recurring_transactions',
	id: string
): Promise<void> => {
	await db.runAsync(
		`UPDATE ${table} SET category = 'uncategorized', updatedAt = ?, dirty = 1 WHERE id = ?`,
		[nowTimestamp(), id]
	);
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
				`INSERT INTO categories (id, name, color, icon, type, nature, updatedAt, deletedAt, dirty)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT (id) DO UPDATE SET
           name = excluded.name, color = excluded.color, icon = excluded.icon,
           type = excluded.type, nature = excluded.nature, updatedAt = excluded.updatedAt,
           deletedAt = excluded.deletedAt, dirty = 0`,
				[
					row.id,
					row.name,
					row.color,
					row.icon,
					row.type,
					// Um servidor anterior à coluna — ou um aparelho ainda na versão velha,
					// cuja linha o servidor apenas repassa — não manda `nature`. Cair no
					// padrão aqui evita gravar NULL numa coluna NOT NULL e desmontar o pull.
					row.nature ?? 'discretionary',
					row.updatedAt,
					row.deletedAt,
				]
			);
		}

		// Contas antes dos lançamentos, pelo mesmo motivo das categorias.
		for (const row of changes.accounts ?? []) {
			if (await isStale('accounts', row.id, row.updatedAt)) continue;

			await db.runAsync(
				`INSERT INTO accounts
           (id, name, kind, role, envelopeMonthlyCents, network, bankName, color, last4, closingDay, dueDay,
            closingDaysBefore, creditLimitCents, cardNames, packageName, accountKey, openingBalanceCents, openingBalanceDate,
            sortOrder, archived, updatedAt, deletedAt, dirty)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT (id) DO UPDATE SET
           name = excluded.name, kind = excluded.kind, role = excluded.role,
           envelopeMonthlyCents = excluded.envelopeMonthlyCents, network = excluded.network,
           bankName = excluded.bankName,
           color = excluded.color, last4 = excluded.last4, closingDay = excluded.closingDay,
           dueDay = excluded.dueDay, closingDaysBefore = excluded.closingDaysBefore,
           creditLimitCents = excluded.creditLimitCents, cardNames = excluded.cardNames,
           packageName = excluded.packageName, accountKey = excluded.accountKey,
           openingBalanceCents = excluded.openingBalanceCents,
           openingBalanceDate = excluded.openingBalanceDate, sortOrder = excluded.sortOrder,
           archived = excluded.archived, updatedAt = excluded.updatedAt,
           deletedAt = excluded.deletedAt, dirty = 0`,
				[
					row.id,
					row.name,
					row.kind,
					row.role ?? 'main',
					row.envelopeMonthlyCents ?? null,
					row.network ?? null,
					row.bankName,
					row.color,
					row.last4,
					row.closingDay,
					row.dueDay,
					row.closingDaysBefore ?? null,
					row.creditLimitCents,
					row.cardNames ?? null,
					row.packageName,
					row.accountKey,
					row.openingBalanceCents,
					row.openingBalanceDate,
					row.sortOrder,
					row.archived ? 1 : 0,
					row.updatedAt,
					row.deletedAt,
				]
			);
		}

		for (const row of changes.transactions) {
			if (await isStale('transactions', row.id, row.updatedAt)) continue;

			await db.runAsync(
				`INSERT INTO transactions
           (id, amountCents, category, date, note, isIncome, accountId,
            installmentGroup, installmentIndex, installmentCount, cardLast4, updatedAt, deletedAt, dirty)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT (id) DO UPDATE SET
           amountCents = excluded.amountCents, category = excluded.category,
           date = excluded.date, note = excluded.note, isIncome = excluded.isIncome,
           accountId = excluded.accountId, installmentGroup = excluded.installmentGroup,
           installmentIndex = excluded.installmentIndex, installmentCount = excluded.installmentCount,
           cardLast4 = excluded.cardLast4,
           updatedAt = excluded.updatedAt, deletedAt = excluded.deletedAt, dirty = 0`,
				[
					row.id,
					row.amountCents,
					row.category,
					row.date,
					row.note ?? '',
					row.isIncome ? 1 : 0,
					row.accountId ?? null,
					row.installmentGroup ?? null,
					row.installmentIndex ?? null,
					row.installmentCount ?? null,
					row.cardLast4 ?? null,
					row.updatedAt,
					row.deletedAt,
				]
			);
		}

		for (const row of changes.transfers ?? []) {
			if (await isStale('transfers', row.id, row.updatedAt)) continue;

			await db.runAsync(
				`INSERT INTO transfers (id, fromAccountId, toAccountId, amountCents, date, note, updatedAt, deletedAt, dirty)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT (id) DO UPDATE SET
           fromAccountId = excluded.fromAccountId, toAccountId = excluded.toAccountId,
           amountCents = excluded.amountCents, date = excluded.date, note = excluded.note,
           updatedAt = excluded.updatedAt, deletedAt = excluded.deletedAt, dirty = 0`,
				[
					row.id,
					row.fromAccountId,
					row.toAccountId,
					row.amountCents,
					row.date,
					row.note ?? '',
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

		// A meta tem id fixo: o upsert é o merge inteiro.
		for (const row of changes.retirementGoals ?? []) {
			if (await isStale('retirement_goals', row.id, row.updatedAt)) continue;

			await db.runAsync(
				`INSERT INTO retirement_goals (id, targetMonthlyCents, reinvestBp, expectedYieldBp, outsideCapitalCents, updatedAt, deletedAt, dirty)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT (id) DO UPDATE SET
           targetMonthlyCents = excluded.targetMonthlyCents, reinvestBp = excluded.reinvestBp,
           expectedYieldBp = excluded.expectedYieldBp, outsideCapitalCents = excluded.outsideCapitalCents,
           updatedAt = excluded.updatedAt, deletedAt = excluded.deletedAt, dirty = 0`,
				[row.id, row.targetMonthlyCents, row.reinvestBp, row.expectedYieldBp, row.outsideCapitalCents, row.updatedAt, row.deletedAt]
			);
		}

		for (const row of changes.debts ?? []) {
			if (await isStale('debts', row.id, row.updatedAt)) continue;

			const values = [
				row.name,
				row.kind,
				row.system,
				row.openingBalanceCents,
				row.openingBalanceDate,
				row.installmentCents,
				row.remainingAtOpening,
				row.installmentsTotal,
				row.dueDay,
				row.rateBp,
				row.adminFeeBp ?? null,
				row.accountId ?? null,
				row.category ?? null,
				row.archived ? 1 : 0,
				row.sortOrder,
			];
			await db.runAsync(
				`INSERT INTO debts (id, ${DEBT_COLUMNS.join(', ')}, updatedAt, deletedAt, dirty)
         VALUES (?, ${DEBT_COLUMNS.map(() => '?').join(', ')}, ?, ?, 0)
         ON CONFLICT (id) DO UPDATE SET
           ${DEBT_COLUMNS.map((column) => `${column} = excluded.${column}`).join(', ')},
           updatedAt = excluded.updatedAt, deletedAt = excluded.deletedAt, dirty = 0`,
				[row.id, ...values, row.updatedAt, row.deletedAt ?? null]
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
			for (const table of ['transactions', 'recurring_transactions', 'budgets', 'transfers', 'accounts', 'retirement_goals', 'debts']) {
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
	getDebts,
	addDebt,
	updateDebt,
	deleteDebt,
	getMonthlyAccountActivity,
	getMonthlyTransferActivity,
	getMonthlyCategoryTotals,
	getTransactionsForAccounts,
	getRetirementGoal,
	setRetirementGoal,
	clearRetirementGoal,
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
	getAccounts,
	getAccount,
	findAccountBySource,
	findAccountByKey,
	addAccount,
	updateAccount,
	deleteAccount,
	getAccountActivity,
	getAccountBalances,
	getUnassignedNet,
	getUnassignedPeriodSummary,
	getCardPurchasesOriginated,
	assignUnassignedTransactions,
	setAccountBalanceToday,
	addTransfer,
	updateTransfer,
	getTransfer,
	deleteTransfer,
	findLiveTransfer,
	deleteTransactionsInGroup,
	assignTransactionAccount,
	getTransfers,
	getAccountTransactions,
	getAccountTransfers,
	normalizeAccountDraft,
	getTransfersByDateRange,
	countDirtyRows,
	markChangesClean,
	hasCategory,
	markCategoryDirty,
	reassignToUncategorized,
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
