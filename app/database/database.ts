import { AccountInUseError, type AccountContents, isAccountEmpty } from '../utils/accountClosing';
import { brandFor } from '../utils/bankBrands';
import { CARD_ADJUSTMENT_NOTE, CARD_CHARGE_NOTE, CARD_CHARGE_NOTE_GLOB } from '../utils/cardMath';
import { parseCardNames, planDebitCardConversions, withCardName } from '../utils/cardNames';
import { planLedgerRepair } from '../utils/notificationTarget';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SQLite from 'expo-sqlite';
import { generateUniqueId } from '../utils/categoryEditUtils';
import { addDays, nowTimestamp, todayISO } from '../utils/dateUtils';
import { firstDueOnOrAfter, nextDueAfterEdit, type RecurrenceRule } from '../utils/recurrence';
import { STORAGE_KEYS, SYNCED_PREFERENCE_KEYS } from '../utils/storageUtils';
import { nextStamp, nextStampSql } from '../utils/syncStamp';
import { isMirroredPreference, type PreferenceRow, planPreferenceReconcile } from '../sync/preferences';
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
	CREATE_BILLS_TABLE,
	CREATE_PREFERENCES_TABLE,
	CREATE_RETIREMENT_GOALS_TABLE,
	CREATE_RESERVE_GOALS_TABLE,
	CREATE_SEEN_CAPTURE_FINGERPRINTS_TABLE,
	ACCOUNT_V17_COLUMNS,
	RESERVE_GOAL_ID,
	DEFAULT_RESERVE_MONTHS,
	type ReserveGoalRow,
	type ReservePurpose,
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
	type Bill,
	type BillDraft,
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
	ACCOUNT_V16_COLUMNS,
	DEBT_V16_COLUMNS,
	TRANSACTION_V13_COLUMNS,
	DEFAULT_CLOSING_DAYS_BEFORE,
	defaultRoleFor,
	CAPTURE_V7_COLUMNS,
	INBOX_V19_COLUMNS,
	identityColumnOf,
	type MerchantRule,
	CREATE_ACCOUNTS_TABLE,
	CREATE_TRANSFERS_TABLE,
	TRANSACTION_V7_COLUMNS,
} from './schema';
import { KNOWN_WIPE_AT_KEY, type SyncChanges } from '../sync/types';

/**
 * O único handle do banco. Exportado para módulos irmãos (`captures.ts`) que têm suas
 * próprias tabelas; telas e contexts continuam passando pelas funções deste arquivo.
 */
export const db = SQLite.openDatabaseSync(DATABASE_NAME);

/**
 * O `updatedAt` de toda gravação numa linha que já existe: agora, ou 1 ms depois do
 * carimbo que a linha tem, o que vier por último (SPD-107; a conta e o motivo estão em
 * `utils/syncStamp.ts`). Com um carimbo no futuro — relógio adiantado, aqui ou no aparelho
 * que gravou —, a edição carimbada com agora ficava mais velha que a cópia do servidor: o
 * push voltava `stale` e o pull desfazia a edição. Ocupa o lugar do `?` de agora, então os
 * parâmetros não mudam. Linha nova (INSERT) continua com agora.
 */
const NEXT_STAMP = nextStampSql();
/** O mesmo, no `DO UPDATE` de um upsert: o agora é o `excluded.updatedAt` que o INSERT trazia. */
const NEXT_STAMP_UPSERT = nextStampSql('excluded.updatedAt');

/**
 * A prova de que uma tarefa está dentro de uma transação aberta por `runInTransaction`.
 * Só vale enquanto aquela transação está aberta.
 */
export interface TransactionScope {
	readonly openedBy: 'runInTransaction';
}

/** O fim da última transação pedida: a próxima começa depois dele. */
let transactionTail: Promise<void> = Promise.resolve();
/** A transação aberta agora, se houver uma. */
let openTransaction: TransactionScope | null = null;

/**
 * Roda `task` numa transação, **uma de cada vez** no app inteiro (SPD-101, E2E-37). Toda
 * transação do app passa por aqui; `db.withTransactionAsync` direto, não.
 *
 * O `withTransactionAsync` do expo-sqlite não isola nada: é BEGIN, a tarefa e COMMIT na
 * conexão única, e enquanto a tarefa espera um `await` qualquer comando de outro lugar
 * entra no meio. Duas transações juntas — na abertura, o `renameDefaultCategories` do
 * TransactionsContext e o `ensureDebtBills` do DebtsContext; depois de juntar cartões, dois
 * `ensureDebtBills` — davam isto: o BEGIN da segunda falhava ("cannot start a transaction
 * within a transaction"), o ROLLBACK dela desfazia o que a primeira já tinha gravado, o
 * resto da primeira entrava solto, sem transação, e o COMMIT e o ROLLBACK dela falhavam
 * ("cannot rollback - no transaction is active"). Gravação pela metade. Aqui a segunda
 * espera o COMMIT (ou o ROLLBACK) da primeira, na ordem em que foram pedidas, e o erro de
 * uma desfaz só ela.
 *
 * O `withExclusiveTransactionAsync` não serve: ele abre outra conexão, todo comando da
 * tarefa teria de ir pelo `txn` dela (e o que a tarefa chama, como `captures.ts`, usa
 * `db`), e uma escrita pela conexão de sempre enquanto ela grava não espera — falha com
 * "database is locked".
 *
 * **Aninhar.** Uma tarefa que chamasse outra função que também abre transação travaria a
 * fila esperando a si mesma (hoje não há nenhuma: o BEGIN aninhado já falhava antes). Quem
 * precisar disso passa adiante o `scope` que recebeu: com o escopo da transação aberta,
 * `task` roda dentro dela, sem BEGIN próprio, e um erro desfaz a de fora inteira. O escopo
 * de uma transação que já terminou é recusado.
 *
 * O que a fila **não** cobre: um `db.runAsync` solto (fora de transação) de outra tarefa
 * ainda cai dentro da transação aberta, como antes — grava junto no COMMIT e só se perde
 * se ela terminar em ROLLBACK.
 */
export const runInTransaction = async (
	task: (scope: TransactionScope) => Promise<void>,
	within?: TransactionScope
): Promise<void> => {
	if (within) {
		if (within !== openTransaction) {
			throw new Error('runInTransaction: o escopo é de uma transação que já terminou');
		}
		await task(within);
		return;
	}

	const previous = transactionTail;
	let release: () => void = () => {};
	transactionTail = new Promise<void>((resolve) => {
		release = resolve;
	});
	try {
		await previous;
		const scope: TransactionScope = { openedBy: 'runInTransaction' };
		openTransaction = scope;
		try {
			await db.withTransactionAsync(() => task(scope));
		} finally {
			openTransaction = null;
		}
	} finally {
		release();
	}
};

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
	yieldCdiBp: number | null;
	reservePurpose: string | null;
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
	feeCents: number;
	adminFeeBp: number | null;
	accountId: string | null;
	category: string | null;
	archived: number;
	sortOrder: number;
}

interface BillDB extends SyncColumnsDB {
	id: string;
	name: string;
	dueDay: number;
	amountCents: number | null;
	accountId: string | null;
	category: string | null;
	matchHint: string | null;
	debtId: string | null;
	paidThrough: string | null;
	paidByRef: string | null;
	active: number;
	sortOrder: number;
}

/** Uma linha de `preferences` (v21): a chave do AsyncStorage e o texto guardado nela. */
interface PreferenceDB extends SyncColumnsDB {
	key: string;
	value: string;
}

interface ReserveGoalDB extends SyncColumnsDB {
	id: string;
	targetMonths: number;
	customMonthlyCostCents: number | null;
}

/**
 * Uma captura como a tabela a guarda: `autoConfirmed` é inteiro, e o `id` é **o id
 * local** — a identidade que viaja é o `fingerprint`.
 */
interface CaptureDB extends SyncColumnsDB, Omit<Capture, 'autoConfirmed' | 'updatedAt' | 'deletedAt'> {
	autoConfirmed: number;
}

interface MerchantRuleDB extends SyncColumnsDB, Omit<MerchantRule, 'updatedAt' | 'deletedAt'> {}

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
	yieldCdiBp: account.yieldCdiBp ?? null,
	reservePurpose: account.reservePurpose === 'investment' ? 'investment' : null,
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
 *
 * O `DROP TABLE IF EXISTS` da tabela temporária é o que torna o passo repetível: um
 * crash entre o CREATE e o RENAME deixava `transactions_migrated` para trás, e a
 * abertura seguinte morria com "table already exists" — o app não abria mais, em
 * nenhuma tela. Hoje a versão é gravada passo a passo (ver `applyMigrations`) e este
 * caso não deveria mais acontecer; a guarda fica porque o custo é zero e o estrago, total.
 */
const migrateMoneyToCents = async (): Promise<void> => {
	for (const table of ['transactions', 'recurring_transactions']) {
		if (!(await tableExists(table))) continue;
		if (!(await tableHasColumn(table, 'amount'))) continue;

		if (table === 'transactions') {
			await db.execAsync(`
        DROP TABLE IF EXISTS transactions_migrated;
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
        DROP TABLE IF EXISTS recurring_migrated;
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

	await runInTransaction(async () => {
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
/** O carimbo das categorias padrão semeadas: perde para qualquer versão vinda da conta. */
const SEED_TIMESTAMP = '1970-01-01T00:00:00.000Z';

const seedMissingDefaultCategories = async (): Promise<void> => {
	// Includes tombstoned rows on purpose: a category the user deleted must not be
	// resurrected by the next launch.
	const existing = await db.getAllAsync<{ id: string }>('SELECT id FROM categories');
	const existingIds = new Set(existing.map((c) => c.id));
	const missing = DEFAULT_CATEGORIES.filter((c) => !existingIds.has(c.id));

	if (missing.length === 0) return;

	// As padrão nascem com a data mais antiga possível e limpas. Com a data da instalação e
	// sujas, o primeiro login de um app novo subia as padrão como mais novas que as da
	// conta e desfazia os nomes e as naturezas que o usuário tinha ajustado. Assim a versão
	// da conta sempre vence; uma conta nova recebe as padrão pelo `markEverythingDirty`.
	const timestamp = SEED_TIMESTAMP;

	await runInTransaction(async () => {
		for (const category of missing) {
			await db.runAsync(
				`INSERT INTO categories (id, name, color, icon, type, nature, updatedAt, deletedAt, dirty)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0)`,
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

/**
 * Troca o nome de categorias padrão para o idioma do app (SPD-088); quem decide quais é
 * `utils/defaultCategoryNames.ts`. Devolve quantas trocaram.
 *
 * O carimbo depende de onde a linha veio. A recém-semeada (1970) troca só o nome e continua
 * perdendo para a conta: com carimbo novo e suja, o primeiro login de um aparelho novo
 * desfaria os nomes que o usuário deu na conta (o motivo do `SEED_TIMESTAMP`). A que já veio
 * da conta ou foi editada troca como uma edição — carimbo novo (`NEXT_STAMP`) e suja, para subir.
 *
 * `from` protege uma edição do usuário que tenha chegado entre a leitura e a escrita: a
 * troca só vale se a linha ainda tiver aquele nome.
 */
export const renameDefaultCategories = async (
	renames: readonly { id: string; from: string; name: string }[]
): Promise<number> => {
	if (renames.length === 0) return 0;
	const timestamp = nowTimestamp();
	let changed = 0;

	await runInTransaction(async () => {
		for (const rename of renames) {
			const result = await db.runAsync(
				`UPDATE categories
         SET name = ?,
             updatedAt = CASE WHEN updatedAt = ? THEN updatedAt ELSE ${NEXT_STAMP} END,
             dirty = CASE WHEN updatedAt = ? THEN dirty ELSE 1 END
         WHERE id = ? AND name = ? AND deletedAt IS NULL`,
				[rename.name, SEED_TIMESTAMP, timestamp, SEED_TIMESTAMP, rename.id, rename.from]
			);
			changed += result.changes;
		}
	});

	return changed;
};

/** Um passo da escada: a versão que ele conclui e o que ele faz. */
export type MigrationStep = [version: number, run: () => Promise<void>];

/**
 * A escada de migrações, em ordem. A ordem e o conteúdo de cada passo são história
 * gravada em bancos de verdade: nada aqui se reordena nem se reescreve, só se acrescenta
 * no fim (e `SCHEMA_VERSION` sobe junto).
 *
 * É uma função, e não uma constante, porque metade dos passos é declarada abaixo deste
 * ponto do arquivo: uma constante os leria antes da hora e o módulo nem carregaria.
 * Exportada para o teste conferir que a escada cobre 1..`SCHEMA_VERSION` sem buraco.
 */
export const migrationLadder = (): MigrationStep[] => [
	[1, migrateMoneyToCents],
	[2, migrateCategoryTypes],
	[3, migrateSyncColumns],
	[4, migrateBudgetsFromStorage],
	[5, migrateCategoryNature],
	[6, migrateCaptureTables],
	[7, migrateAccounts],
	[8, migrateAccountRoles],
	[9, migrateCardsApart],
	[10, migrateCardCycleFromDueDay],
	[11, migrateCardCycleToClosingDay],
	[12, migrateCardPurchasesToRealCard],
	[13, migrateCardsPerPurchase],
	[14, migrateRetirementGoals],
	[15, migrateDebts],
	[16, migrateYieldAndFees],
	[17, migrateReserve],
	[18, migratePhantomAppAccounts],
	[19, migrateSyncedInbox],
	[20, migrateBills],
	[21, migratePreferences],
	[22, migrateSeenCaptureFingerprints],
];

/**
 * Roda os passos que faltam, **gravando a versão a cada passo concluído**.
 *
 * Antes a versão era gravada uma única vez, depois dos dezoito passos: um crash no meio
 * (ou o Android matando o processo na abertura) fazia a abertura seguinte refazer tudo do
 * zero, e o passo mais antigo — dinheiro em centavos, que reconstrói a tabela — morria
 * com "table already exists". O app parava de abrir, em todas as telas, com os dados
 * intactos no disco. Gravando passo a passo, uma interrupção custa no máximo a repetição
 * do passo que estava em curso.
 *
 * Separado de `runMigrations` por ser a parte que dá para testar: o `setVersion` entra
 * por parâmetro, sem precisar de um SQLite de verdade.
 */
export const applyMigrations = async (
	fromVersion: number,
	steps: MigrationStep[],
	setVersion: (version: number) => Promise<void>
): Promise<number> => {
	let version = fromVersion;

	for (const [target, run] of steps) {
		if (version >= target) continue;
		await run();
		await setVersion(target);
		version = target;
	}

	return version;
};

const runMigrations = async (): Promise<void> => {
	const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
	const version = row?.user_version ?? 0;

	if (version >= SCHEMA_VERSION) return;

	// `target` vem da escada acima, nunca de fora: PRAGMA não aceita parâmetro ligado.
	const reached = await applyMigrations(version, migrationLadder(), async (target) => {
		await db.execAsync(`PRAGMA user_version = ${target}`);
	});

	// A escada pode terminar antes da versão atual quando a última subida não precisou de
	// passo nenhum (só tabelas novas, criadas pelo CREATE TABLE IF NOT EXISTS da abertura).
	if (reached < SCHEMA_VERSION) await db.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION}`);
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
/**
 * v15 -> v16: contas ganham quanto do CDI rendem; dívidas ganham os encargos da parcela.
 *
 * E todas as dívidas voltam a ficar sujas: um servidor sem a coleção `debts` descartava as
 * dívidas em silêncio enquanto o app as marcava como enviadas. Reenviar é inofensivo — o
 * upsert do servidor é idempotente — e o motor agora só envia o que o servidor conhece.
 */
const migrateYieldAndFees = async (): Promise<void> => {
	if (await tableExists('accounts')) {
		for (const [name, sql] of ACCOUNT_V16_COLUMNS) {
			if (await tableHasColumn('accounts', name)) continue;
			await db.execAsync(`ALTER TABLE accounts ADD COLUMN ${name} ${sql}`);
		}
	}
	if (await tableExists('debts')) {
		for (const [name, sql] of DEBT_V16_COLUMNS) {
			if (await tableHasColumn('debts', name)) continue;
			await db.execAsync(`ALTER TABLE debts ADD COLUMN ${name} ${sql}`);
		}
		await db.runAsync('UPDATE debts SET dirty = 1');
	}
};

/**
 * v16 -> v17: a meta da reserva de emergência ganha sua tabela sincronizada, e as contas,
 * `reservePurpose`. Só acréscimos: um app 1.1 abre um banco v17 e ignora os dois.
 */
/**
 * v17 -> v18: fora as contas que nasceram de um app que não é banco.
 *
 * Até aqui, qualquer notificação com um valor criava uma conta com o nome do app que
 * avisou. O mensageiro que repassa o SMS do banco, o e-mail com a fatura, o app de
 * corrida: nasceram contas "WhatsApp", "Gmail" e "99" do lado das de verdade, e a
 * compra podia cair numa delas. `bankLabelOf` não as cria mais; aqui saem as que
 * ficaram.
 *
 * Só as vazias. Com lançamento, transferência ou captura apontando para ela, a conta
 * fica — pode ser um banco que a lista de marcas não conhece, e nesse caso o dinheiro é
 * real. Marca a lápide como suja, para a limpeza subir no próximo sync.
 */
const migratePhantomAppAccounts = async (): Promise<void> => {
	const removed = await repairPhantomAppAccounts();
	console.log(`Migrated phantom app accounts (${removed})`);
};

/**
 * O reparo das contas fantasma, idempotente, rodável a qualquer momento.
 *
 * Era só a migração v18, e migração roda **uma vez**, antes de qualquer login: numa
 * instalação nova ela não acha nada (as tabelas acabaram de nascer vazias) e o login em
 * seguida baixa as contas inventadas de volta do servidor. Foi o que aconteceu com o
 * dono: ele está na 1.2.7 e tem de volta as seis contas "WhatsApp", "Gmail", "Messages",
 * "Google", "99" e "OnlineBanking". Por isso o reparo também roda depois de cada pull
 * (ver `pullAll` em `sync/engine.ts`) — ele põe a lápide suja, e a remoção sobe.
 *
 * As condições são as mesmas, apertadas, da migração: só conta **vazia** — sem
 * lançamento, sem transferência e sem captura apontando para ela —, âncora zerada, sem
 * chave de extrato, nome igual ao do banco e marca desconhecida. Com qualquer dado
 * atrelado, a conta fica: pode ser um banco que a lista de marcas não conhece, e nesse
 * caso o dinheiro é real.
 *
 * Devolve quantas lápides pôs, para quem chama registrar.
 */
export const repairPhantomAppAccounts = async (): Promise<number> => {
	if (!(await tableExists('accounts'))) return 0;

	const bound = (
		await db.getAllAsync<AccountDB>('SELECT * FROM accounts WHERE deletedAt IS NULL AND packageName IS NOT NULL')
	).map(convertAccount);
	// Nome igual ao do banco e âncora zerada é a assinatura da conta criada sozinha; marca
	// conhecida (Nubank, Inter…) nunca é fantasma, mesmo que o resto bata.
	const phantoms = bound.filter(
		(account) =>
			account.accountKey === null &&
			account.openingBalanceCents === 0 &&
			account.bankName !== null &&
			account.name === account.bankName &&
			brandFor(account.bankName) === null
	);
	if (phantoms.length === 0) return 0;

	const hasCaptures = await tableExists('captures');
	const timestamp = nowTimestamp();
	let removed = 0;
	for (const account of phantoms) {
		// As capturas contam **com lápide e tudo**: uma captura apagada que apontava para a
		// conta ainda é sinal de que ali passou dinheiro de verdade, e na dúvida a conta
		// fica. Contar só as vivas dependeria da coluna `deletedAt`, que no v18 — quando
		// este reparo nasceu como migração — ainda não existia em `captures`.
		const inUse = await db.getFirstAsync<{ total: number }>(
			`SELECT (SELECT COUNT(*) FROM transactions WHERE accountId = ? AND deletedAt IS NULL)
						+ (SELECT COUNT(*) FROM transfers WHERE (fromAccountId = ? OR toAccountId = ?) AND deletedAt IS NULL)
						+ ${hasCaptures ? '(SELECT COUNT(*) FROM captures WHERE accountId = ?)' : '0'} AS total`,
			hasCaptures
				? [account.id, account.id, account.id, account.id]
				: [account.id, account.id, account.id]
		);
		// Na dúvida (consulta sem resposta), a conta fica.
		if ((inUse?.total ?? 1) > 0) continue;
		await db.runAsync(`UPDATE accounts SET deletedAt = ?, updatedAt = ${NEXT_STAMP}, dirty = 1 WHERE id = ?`, [
			timestamp,
			timestamp,
			account.id,
		]);
		removed += 1;
	}

	return removed;
};

/**
 * v18 -> v19: a caixa de entrada e as regras aprendidas entram no sync.
 *
 * Só acréscimo de coluna (`deletedAt` e `dirty`), no padrão dos outros passos. As linhas
 * que já estão no aparelho nascem **sujas**, pelo `DEFAULT 1` da coluna: é o que faz as
 * compras que estavam esperando revisão — e tudo o que o app já aprendeu sobre cada
 * estabelecimento — subirem para a conta no primeiro sync depois da atualização, em vez
 * de continuarem a um desinstalar de distância do esquecimento.
 */
const migrateSyncedInbox = async (): Promise<void> => {
	for (const table of ['captures', 'merchant_rules']) {
		if (!(await tableExists(table))) continue;
		for (const [name, sql] of INBOX_V19_COLUMNS) {
			if (await tableHasColumn(table, name)) continue;
			await db.execAsync(`ALTER TABLE ${table} ADD COLUMN ${name} ${sql}`);
		}
	}

	console.log('Migrated capture inbox and merchant rules to synchronisable rows');
};

const migrateReserve = async (): Promise<void> => {
	await db.execAsync(CREATE_RESERVE_GOALS_TABLE);
	if (await tableExists('accounts')) {
		for (const [name, sql] of ACCOUNT_V17_COLUMNS) {
			if (await tableHasColumn('accounts', name)) continue;
			await db.execAsync(`ALTER TABLE accounts ADD COLUMN ${name} ${sql}`);
		}
	}
};

/**
 * v19 -> v20: contas a pagar, numa tabela sincronizada nova. Só tabela nova, nada de
 * ALTER: o passo existe para a versão contar a história, e o `CREATE TABLE IF NOT
 * EXISTS` da abertura faria o mesmo. As contas a pagar das dívidas não nascem aqui —
 * `ensureDebtBills` as cria, porque a migração roda antes de as dívidas do pull chegarem.
 */
const migrateBills = async (): Promise<void> => {
	await db.execAsync(CREATE_BILLS_TABLE);
};

/**
 * v20 -> v21: as preferências ganham uma tabela sincronizada. Só tabela nova, como o v20.
 *
 * Nada é copiado do AsyncStorage aqui: a reconciliação que roda antes de cada push
 * (`reconcilePreferences`) descobre os valores que já existem e os grava com o carimbo de
 * semente. Copiar aqui daria no mesmo, só que num momento em que a sessão nem existe.
 */
const migratePreferences = async (): Promise<void> => {
	await db.execAsync(CREATE_PREFERENCES_TABLE);
};

/**
 * v21 -> v22: as impressões digitais que sobrevivem ao "Apagar todos os dados" (SPD-082).
 * Só tabela nova, local, como o v20 e o v21.
 */
const migrateSeenCaptureFingerprints = async (): Promise<void> => {
	await db.execAsync(CREATE_SEEN_CAPTURE_FINGERPRINTS_TABLE);
};

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
		await runInTransaction(async () => {
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
	await runInTransaction(async () => {
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
      ${CREATE_RESERVE_GOALS_TABLE}
      ${CREATE_BILLS_TABLE}
      ${CREATE_PREFERENCES_TABLE}
      ${CREATE_SEEN_CAPTURE_FINGERPRINTS_TABLE}
      ${CREATE_INDEXES}
    `);

		await seedMissingDefaultCategories();

		// O que a exclusão antiga deixou apontando para conta apagada (SPD-144). Falhar aqui
		// não impede o app de abrir: o reparo roda de novo na próxima carga.
		try {
			const repaired = await repairDeadAccountLinks();
			if (repaired.unlinked > 0 || repaired.orphaned > 0) {
				console.log(`Dead account links: ${repaired.unlinked} cleared, ${repaired.orphaned} entry(ies) left on deleted accounts`);
			}
		} catch (error) {
			console.error('Error repairing links to deleted accounts:', error);
		}

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

/**
 * **Todas** as categorias, para o backup: as apagadas (lápide) e a `uncategorized`.
 *
 * `getCategories` é a lista da tela e esconde a `uncategorized` enquanto nada cai nela;
 * foi por isso que o backup de 12/10/2026 saiu com 15 categorias enquanto o servidor
 * tinha 16. Um arquivo que não leva a lápide também ressuscita, na restauração, a
 * categoria padrão que o usuário tinha apagado.
 *
 * `dirty` fica fora: é de cada aparelho, e vazava no arquivo porque a leitura da tela
 * é um `SELECT *` cru.
 */
export const getCategoriesForBackup = async (): Promise<Category[]> => {
	const rows = await db.getAllAsync<Category & { dirty?: number }>(
		'SELECT * FROM categories ORDER BY name'
	);
	return rows.map(({ dirty: _dirty, ...category }) => ({
		...category,
		deletedAt: category.deletedAt ?? undefined,
	}));
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
       type = excluded.type, nature = excluded.nature, updatedAt = ${NEXT_STAMP_UPSERT},
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

/**
 * Grava uma categoria do backup com o id original, **mantendo a lápide** que o arquivo
 * traz.
 *
 * `addCategory` ressuscita o que encontra apagado, e é o que a restauração quer para
 * uma categoria viva. Para uma categoria que o usuário apagou é o contrário: sem isto,
 * restaurar o backup trazia de volta todas as categorias padrão que ele tinha removido,
 * e elas reapareciam nos seletores do app.
 */
export const restoreCategory = async (
	category: CategoryDraft & { deletedAt?: string },
	id: string
): Promise<void> => {
	await addCategory(category, id);
	if (category.deletedAt) {
		await db.runAsync('UPDATE categories SET deletedAt = ?, dirty = 1 WHERE id = ?', [
			category.deletedAt,
			id,
		]);
	}
};

export const updateCategory = async (category: CategoryEdit): Promise<void> => {
	await db.runAsync(
		`UPDATE categories
     SET name = ?, color = ?, icon = ?, type = ?, nature = ?, updatedAt = ${NEXT_STAMP}, dirty = 1
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

	await runInTransaction(async () => {
		// Reassign in one statement instead of a round trip per transaction. The moved
		// rows are dirtied too: without that, another device would keep showing them
		// under a category this one has already deleted.
		await db.runAsync(
			`UPDATE transactions SET category = 'uncategorized', updatedAt = ${NEXT_STAMP}, dirty = 1
       WHERE category = ? AND deletedAt IS NULL`,
			[timestamp, categoryId]
		);
		await db.runAsync(
			`UPDATE recurring_transactions SET category = 'uncategorized', updatedAt = ${NEXT_STAMP}, dirty = 1
       WHERE category = ? AND deletedAt IS NULL`,
			[timestamp, categoryId]
		);
		// Tombstone rather than DELETE, so the removal itself can be synced.
		await db.runAsync(
			`UPDATE categories SET deletedAt = ?, updatedAt = ${NEXT_STAMP}, dirty = 1 WHERE id = ?`,
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
           cardLast4 = CASE WHEN ? THEN ? ELSE cardLast4 END,
           updatedAt = ${NEXT_STAMP}, dirty = 1
       WHERE id = ?`,
			[
				transaction.amountCents,
				transaction.category,
				transaction.date,
				transaction.note,
				transaction.isIncome ? 1 : 0,
				transaction.accountId === undefined ? 0 : 1,
				transaction.accountId ?? null,
				// Como a conta: `undefined` preserva o cartão que a captura anotou.
				transaction.cardLast4 === undefined ? 0 : 1,
				transaction.cardLast4 ?? null,
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
			`UPDATE transactions SET deletedAt = ?, updatedAt = ${NEXT_STAMP}, dirty = 1 WHERE id = ?`,
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

/**
 * A conta ligada a um app do banco e, para cartões, ao final do cartão.
 *
 * Arquivada nunca é destino de captura: arquivar a duplicata "Inter" que ainda estava
 * ligada ao app fazia toda compra do Inter cair nela, longe da tela, em vez da "Inter
 * PF" ativa. Arquivada continua arquivada e ligada; a captura segue sem ela.
 */
export const findAccountBySource = async (
	packageName: string,
	last4: string | null
): Promise<Account | null> => {
	const row = last4
		? await db.getFirstAsync<AccountDB>(
				'SELECT * FROM accounts WHERE packageName = ? AND last4 = ? AND archived = 0 AND deletedAt IS NULL',
				[packageName, last4]
			)
		: await db.getFirstAsync<AccountDB>(
				"SELECT * FROM accounts WHERE packageName = ? AND last4 IS NULL AND kind <> 'credit_card' AND archived = 0 AND deletedAt IS NULL",
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
		yieldCdiBp: isCard ? null : (account.yieldCdiBp ?? null),
		reservePurpose: account.role === 'reserve' && account.reservePurpose === 'investment' ? 'investment' : null,
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
	account.yieldCdiBp ?? null,
	account.reservePurpose ?? null,
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
        closingDaysBefore, creditLimitCents, cardNames, yieldCdiBp, reservePurpose, packageName, accountKey, openingBalanceCents, openingBalanceDate,
        sortOrder, archived, id, updatedAt, deletedAt, dirty)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)
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
         last4 = ?, closingDay = ?, dueDay = ?, closingDaysBefore = ?, creditLimitCents = ?, cardNames = ?, yieldCdiBp = ?, reservePurpose = ?, packageName = ?, accountKey = ?,
         openingBalanceCents = ?, openingBalanceDate = ?, sortOrder = ?, archived = ?,
         updatedAt = ${NEXT_STAMP}, dirty = 1
     WHERE id = ?`,
		[...accountValues(account), nowTimestamp(), id]
	);
};

/**
 * Lápide em todas as transferências que entram ou saem de uma conta (`deleteTransfersOf`).
 * Nenhum fluxo do app usa mais: apagar conta não apaga transferência (SPD-144), e levar o
 * cartão para o débito as leva para a conta (SPD-152).
 */
const TOMBSTONE_TRANSFERS_OF_ACCOUNT =
	`UPDATE transfers SET deletedAt = ?, updatedAt = ${NEXT_STAMP}, dirty = 1 WHERE (fromAccountId = ? OR toAccountId = ?) AND deletedAt IS NULL`;

export { AccountInUseError };

/**
 * O que está ligado a uma conta, para decidir se ela é vazia (`isAccountEmpty`) e para a
 * confirmação dizer por quê. Só linhas vivas; capturas em qualquer status (confirmada,
 * descartada ou pendente: todas são aviso do banco que passou por esta conta).
 */
export const getAccountContents = async (id: string): Promise<AccountContents> => {
	const row = await db.getFirstAsync<{
		transactions: number;
		transfers: number;
		captures: number;
		bills: number;
		debts: number;
		openingBalanceCents: number | null;
	}>(
		`SELECT
       (SELECT COUNT(*) FROM transactions WHERE accountId = ? AND deletedAt IS NULL) AS transactions,
       (SELECT COUNT(*) FROM transfers WHERE (fromAccountId = ? OR toAccountId = ?) AND deletedAt IS NULL) AS transfers,
       (SELECT COUNT(*) FROM captures WHERE accountId = ? AND deletedAt IS NULL) AS captures,
       (SELECT COUNT(*) FROM bills WHERE accountId = ? AND deletedAt IS NULL) AS bills,
       (SELECT COUNT(*) FROM debts WHERE accountId = ? AND deletedAt IS NULL) AS debts,
       (SELECT openingBalanceCents FROM accounts WHERE id = ?) AS openingBalanceCents`,
		[id, id, id, id, id, id, id]
	);
	return {
		transactions: row?.transactions ?? 0,
		transfers: row?.transfers ?? 0,
		captures: row?.captures ?? 0,
		bills: row?.bills ?? 0,
		debts: row?.debts ?? 0,
		openingBalanceCents: row?.openingBalanceCents ?? 0,
	};
};

/**
 * A lápide da conta, e as contas a pagar e dívidas ligadas a ela ficam sem conta (carimbo
 * novo e sujas, para o sync levar): nunca um id morto. Chamar dentro de uma transação.
 */
const tombstoneAccountRow = async (id: string, timestamp: string): Promise<void> => {
	await db.runAsync(`UPDATE accounts SET deletedAt = ?, updatedAt = ${NEXT_STAMP}, dirty = 1 WHERE id = ?`, [timestamp, timestamp, id]);
	await db.runAsync(`UPDATE bills SET accountId = NULL, updatedAt = ${NEXT_STAMP}, dirty = 1 WHERE accountId = ? AND deletedAt IS NULL`, [
		timestamp,
		id,
	]);
	await db.runAsync(`UPDATE debts SET accountId = NULL, updatedAt = ${NEXT_STAMP}, dirty = 1 WHERE accountId = ? AND deletedAt IS NULL`, [
		timestamp,
		id,
	]);
};

/**
 * Apaga (lápide) uma conta **vazia** (SPD-144): sem lançamento, transferência, captura nem
 * saldo de partida. Com conteúdo, recusa com `AccountInUseError` e não muda nada.
 *
 * O app recalcula saldo, patrimônio e histórico das linhas de hoje: apagar uma conta com
 * conteúdo reescrevia o passado — apagar a PJ que mandou 2 × R$ 12.000 derrubava o
 * patrimônio em R$ 24.000, apagar o cartão com fatura paga de R$ 800 o fazia subir. Conta
 * com conteúdo é encerrada (`archived`) ou juntada com outra. A contagem e a lápide vão na
 * mesma transação: o que entrar entre a pergunta e o toque também conta.
 */
export const deleteAccount = async (id: string): Promise<void> => {
	const timestamp = nowTimestamp();
	await runInTransaction(async () => {
		if (!isAccountEmpty(await getAccountContents(id))) throw new AccountInUseError();
		await tombstoneAccountRow(id, timestamp);
	});
};

/**
 * A lápide de uma conta que já entregou tudo a outra — juntar contas, ou o cartão de débito
 * que vira conta. Sem a verificação de vazia: o saldo de partida dela já foi somado na que
 * fica (`foldAccountBalance`) ou não conta. Contas a pagar e dívidas que sobrassem ficam sem
 * conta, como no `deleteAccount`.
 */
export const retireMergedAccount = async (id: string): Promise<void> => {
	const timestamp = nowTimestamp();
	await runInTransaction(async () => {
		await tombstoneAccountRow(id, timestamp);
	});
};

/**
 * A conta apagada que ainda tem lançamento ou transferência viva volta **encerrada** (sem
 * lápide, `archived = 1`, carimbo depois da lápide e suja, para o sync levar): o dinheiro
 * não some. Fica fora dos totais de hoje, como estava, e o histórico a vê de novo.
 * Devolve quantas voltaram.
 */
const reviveAccountsWithMoney = async (ids: Iterable<string>, timestamp: string): Promise<number> => {
	let revived = 0;
	for (const id of new Set(ids)) {
		const result = await db.runAsync(
			`UPDATE accounts SET deletedAt = NULL, archived = 1, updatedAt = ${NEXT_STAMP}, dirty = 1
       WHERE id = ? AND deletedAt IS NOT NULL
         AND (EXISTS (SELECT 1 FROM transactions WHERE accountId = ? AND deletedAt IS NULL)
           OR EXISTS (SELECT 1 FROM transfers WHERE (fromAccountId = ? OR toAccountId = ?) AND deletedAt IS NULL))`,
			[timestamp, id, id, id, id]
		);
		revived += result?.changes ?? 0;
	}
	return revived;
};

/**
 * Contas a pagar, dívidas e capturas **pendentes** vivas que apontam para uma conta apagada
 * ficam sem conta (carimbo novo, sujas). Com `ids`, só as que apontam para essas contas.
 * A captura já confirmada ou descartada não muda: ela é registro do que aconteceu, e o
 * lançamento dela é que conta. Devolve quantas linhas mudaram.
 */
const unlinkDeadAccounts = async (timestamp: string, ids?: Iterable<string>): Promise<number> => {
	const targets = ids ? [...new Set(ids)] : null;
	if (targets && targets.length === 0) return 0;
	const scope = targets ? `AND accountId IN (${targets.map(() => '?').join(', ')})` : '';
	const dead = `accountId IN (SELECT id FROM accounts WHERE deletedAt IS NOT NULL) ${scope}`;
	let changed = 0;
	for (const sql of [
		`UPDATE bills SET accountId = NULL, updatedAt = ${NEXT_STAMP}, dirty = 1 WHERE deletedAt IS NULL AND ${dead}`,
		`UPDATE debts SET accountId = NULL, updatedAt = ${NEXT_STAMP}, dirty = 1 WHERE deletedAt IS NULL AND ${dead}`,
		`UPDATE captures SET accountId = NULL, updatedAt = ${NEXT_STAMP}, dirty = 1 WHERE deletedAt IS NULL AND status = 'pending' AND ${dead}`,
	]) {
		const result = await db.runAsync(sql, [timestamp, ...(targets ?? [])]);
		changed += result?.changes ?? 0;
	}
	return changed;
};

/**
 * O reparo, na carga, do que a exclusão antiga deixou apontando para conta apagada
 * (SPD-144): conta a pagar, dívida e captura pendente ficam sem conta. Idempotente.
 *
 * Nenhum número muda: a conta a pagar e a dívida não entram em saldo, e a captura pendente
 * de conta apagada já não contava como provisória (não há conta onde contar).
 *
 * O lançamento ou a transferência viva numa conta apagada (o "Já paguei" e a captura
 * confirmada gravavam o id morto) **não** é tocado: hoje ele não aparece em número nenhum,
 * e trazê-lo de volta mudaria o gasto do mês dele. Só é contado (`orphaned`), para o log.
 */
export const repairDeadAccountLinks = async (): Promise<{ unlinked: number; orphaned: number }> => {
	const timestamp = nowTimestamp();
	let outcome = { unlinked: 0, orphaned: 0 };
	await runInTransaction(async () => {
		const unlinked = await unlinkDeadAccounts(timestamp);
		const orphans = await db.getFirstAsync<{ n: number }>(
			`SELECT (SELECT COUNT(*) FROM transactions WHERE deletedAt IS NULL AND accountId IN (SELECT id FROM accounts WHERE deletedAt IS NOT NULL))
            + (SELECT COUNT(*) FROM transfers WHERE deletedAt IS NULL AND (fromAccountId IN (SELECT id FROM accounts WHERE deletedAt IS NOT NULL)
                OR toAccountId IN (SELECT id FROM accounts WHERE deletedAt IS NOT NULL))) AS n`
		);
		outcome = { unlinked, orphaned: orphans?.n ?? 0 };
	});
	return outcome;
};

/**
 * Leva os lançamentos, capturas, contas a pagar e dívidas de uma conta para outra. Serve
 * para desfazer um cartão de débito cadastrado como cartão: débito sai direto da conta,
 * então o que foi lançado nele pertence à conta. E para juntar duas contas.
 *
 * Os dois chamadores apagam a origem logo depois: a conta a pagar e a dívida que ficassem
 * nela apontariam para uma lápide (SPD-099).
 */
export const moveAccountLedger = async (fromId: string, toId: string, cardLast4: string | null = null): Promise<void> => {
	const timestamp = nowTimestamp();
	await runInTransaction(async () => {
		// Lançamento sem final de cartão ganha o do cartão que está saindo: o histórico
		// continua sabendo que foi aquele cartão.
		await db.runAsync(
			`UPDATE transactions SET accountId = ?, cardLast4 = COALESCE(cardLast4, ?), updatedAt = ${NEXT_STAMP}, dirty = 1 WHERE accountId = ? AND deletedAt IS NULL`,
			[toId, cardLast4, timestamp, fromId]
		);
		// A captura também sincroniza desde o v19: mover a conta dela é uma edição, e sem
		// `dirty` o outro aparelho continuaria mostrando a compra no cartão que não existe.
		await db.runAsync(`UPDATE captures SET accountId = ?, updatedAt = ${NEXT_STAMP}, dirty = 1 WHERE accountId = ?`, [
			toId,
			timestamp,
			fromId,
		]);
		// Como em `mergeCardInto`. A da dívida e a dívida vão juntas: `ensureDebtBills` põe na
		// conta a pagar a conta da dívida, e uma sem a outra seria desfeita na próxima carga.
		await db.runAsync(`UPDATE bills SET accountId = ?, updatedAt = ${NEXT_STAMP}, dirty = 1 WHERE accountId = ? AND deletedAt IS NULL`, [
			toId,
			timestamp,
			fromId,
		]);
		await db.runAsync(`UPDATE debts SET accountId = ?, updatedAt = ${NEXT_STAMP}, dirty = 1 WHERE accountId = ? AND deletedAt IS NULL`, [
			toId,
			timestamp,
			fromId,
		]);
	});
};

/**
 * Põe na âncora de uma conta o saldo de outra que vai ser juntada a ela (SPD-073).
 *
 * Juntar é arrumação, não dinheiro entrando ou saindo: o total de antes tem que ser o de
 * depois. Os lançamentos que vêm junto já somam sozinhos o que acontece **depois** da
 * âncora da conta que fica; o que a outra tinha até aquele dia (a âncora dela e o que
 * veio antes) sumia com ela. Esse pedaço é o saldo da outra no dia da âncora, e entra na
 * âncora no mesmo dia — assim o saldo bate em qualquer data, não só hoje. A
 * transferência entre as duas se anula na soma, então pode sumir depois.
 *
 * Chamar **antes** de mover os lançamentos: depois a outra não tem mais saldo para ler.
 */
export const foldAccountBalance = async (fromId: string, intoId: string): Promise<void> => {
	const into = await getAccount(intoId);
	if (!into || fromId === intoId) return;
	const carried = (await getAccountBalances(into.openingBalanceDate)).get(fromId) ?? 0;
	if (carried === 0) return;
	await setAccountAnchor(intoId, into.openingBalanceCents + carried, into.openingBalanceDate);
};

/**
 * Repõe em outra conta as transferências de uma. A que ligava as duas vira uma
 * transferência para si mesma e some: ela só existia porque o mesmo dinheiro tinha duas
 * fichas no app.
 */
export const repointTransfers = async (fromId: string, toId: string): Promise<void> => {
	const timestamp = nowTimestamp();
	await runInTransaction(async () => {
		await db.runAsync(
			`UPDATE transfers SET deletedAt = ?, updatedAt = ${NEXT_STAMP}, dirty = 1
       WHERE deletedAt IS NULL AND ((fromAccountId = ? AND toAccountId = ?) OR (fromAccountId = ? AND toAccountId = ?))`,
			[timestamp, timestamp, fromId, toId, toId, fromId]
		);
		await db.runAsync(`UPDATE transfers SET fromAccountId = ?, updatedAt = ${NEXT_STAMP}, dirty = 1 WHERE fromAccountId = ? AND deletedAt IS NULL`, [
			toId,
			timestamp,
			fromId,
		]);
		await db.runAsync(`UPDATE transfers SET toAccountId = ?, updatedAt = ${NEXT_STAMP}, dirty = 1 WHERE toAccountId = ? AND deletedAt IS NULL`, [
			toId,
			timestamp,
			fromId,
		]);
	});
};

/**
 * Junta um cartão de crédito em outro (SPD-097): o extrato OFX criou "NU PAGAMENTOS S.A. ·
 * cartão final 1111" ao lado do "Nubank Teste" final 1111 que já existia (E2E-34).
 *
 * O que fica mantém fechamento, vencimento e limite. Do que sai vêm as compras, parcelas,
 * estornos, encargos, o ajuste com a fatura do banco, pagamentos de fatura, capturas
 * (inclusive as da caixa de entrada), contas a pagar e dívidas ligadas, e os finais e a
 * chave de extrato, para o próximo aviso ou OFX cair no que fica.
 *
 * A dívida dos dois soma, como o saldo em `mergeAccounts` (SPD-152): juntar é arrumação, e o
 * patrimônio de antes tem que ser o de depois. Antes, a fatura informada (âncora) e o ajuste
 * do que sai sumiam com ele — R$ 500 + R$ 370 viravam R$ 520, e o patrimônio subia R$ 350 em
 * silêncio. Agora a âncora do que fica é a soma dos dois saldos na data da âncora mais antiga
 * (o cálculo de `foldAccountBalance`), e o resto vem como lançamento: a dívida bate em
 * qualquer data e, com o mesmo fechamento, cada fatura é a soma das duas (com fechamentos
 * diferentes, as compras do que sai caem no ciclo do que fica). Se os dois eram leituras da
 * mesma fatura, ela já estava contada duas vezes antes de juntar; a confirmação mostra a soma
 * em R$, e o "Acertar valor" com a fatura do banco corrige.
 *
 * Uma transação só, toda linha mudada suja para o sync levar; o cartão que sai sai como
 * `deleteAccount` apaga (lápide). Fora de cartão para cartão, ou para ele mesmo, não faz nada.
 */
export const mergeCardInto = async (fromId: string, intoId: string): Promise<void> => {
	if (fromId === intoId) return;
	const [from, into] = await Promise.all([getAccount(fromId), getAccount(intoId)]);
	if (!from || !into || from.deletedAt || into.deletedAt) return;
	if (from.kind !== 'credit_card' || into.kind !== 'credit_card') return;

	// Os finais do que sai entram sem trocar o nome que o que fica já dava a um final; o
	// plástico dele, com o nome dele, só quando é outro final que não o do que fica.
	const keptNames = parseCardNames(into.cardNames);
	let cardNames = into.cardNames;
	for (const [last4, name] of Object.entries(parseCardNames(from.cardNames))) {
		if (last4 !== into.last4 && keptNames[last4] === undefined) cardNames = withCardName(cardNames, last4, name);
	}
	if (from.last4 && into.last4 && from.last4 !== into.last4 && keptNames[from.last4] === undefined) {
		cardNames = withCardName(cardNames, from.last4, from.name);
	}
	const identity = {
		cardNames,
		last4: into.last4 ?? from.last4,
		packageName: into.packageName ?? from.packageName,
		accountKey: into.accountKey ?? from.accountKey,
	};
	const identityChanged =
		identity.cardNames !== into.cardNames ||
		identity.last4 !== into.last4 ||
		identity.packageName !== into.packageName ||
		identity.accountKey !== into.accountKey;

	const timestamp = nowTimestamp();
	await runInTransaction(async () => {
		// A âncora nova é a soma dos dois saldos na data da âncora **mais antiga** — lidos antes
		// de mover os lançamentos, como em `foldAccountBalance`. Na mais antiga, e não sempre na
		// do que fica: com a do que fica mais nova, o que o outro tinha entre as duas datas (a
		// fatura de outubro, paga) sumia dentro da fatura informada, e o gasto de outubro com ela.
		// Assim o resultado é o mesmo em qualquer direção, e a fatura informada mais nova passa a
		// contar a partir da data da outra (a confirmação avisa, `cardMergeConfirmMessage`).
		const anchorDate = from.openingBalanceDate < into.openingBalanceDate ? from.openingBalanceDate : into.openingBalanceDate;
		const atAnchor = await getAccountBalances(anchorDate);
		const anchorCents = (atAnchor.get(intoId) ?? 0) + (atAnchor.get(fromId) ?? 0);
		if (anchorCents !== into.openingBalanceCents || anchorDate !== into.openingBalanceDate) {
			await db.runAsync(
				`UPDATE accounts SET openingBalanceCents = ?, openingBalanceDate = ?, updatedAt = ${NEXT_STAMP}, dirty = 1 WHERE id = ?`,
				[anchorCents, anchorDate, timestamp, intoId]
			);
		}
		// Como em `moveAccountLedger`: lançamento sem final ganha o do cartão que sai.
		await db.runAsync(
			`UPDATE transactions SET accountId = ?, cardLast4 = COALESCE(cardLast4, ?), updatedAt = ${NEXT_STAMP}, dirty = 1 WHERE accountId = ? AND deletedAt IS NULL`,
			[intoId, from.last4, timestamp, fromId]
		);
		await db.runAsync(`UPDATE captures SET accountId = ?, updatedAt = ${NEXT_STAMP}, dirty = 1 WHERE accountId = ?`, [intoId, timestamp, fromId]);
		// Como em `repointTransfers`: o pagamento entre os dois era o mesmo dinheiro com duas fichas.
		await db.runAsync(
			`UPDATE transfers SET deletedAt = ?, updatedAt = ${NEXT_STAMP}, dirty = 1
       WHERE deletedAt IS NULL AND ((fromAccountId = ? AND toAccountId = ?) OR (fromAccountId = ? AND toAccountId = ?))`,
			[timestamp, timestamp, fromId, intoId, intoId, fromId]
		);
		await db.runAsync(`UPDATE transfers SET fromAccountId = ?, updatedAt = ${NEXT_STAMP}, dirty = 1 WHERE fromAccountId = ? AND deletedAt IS NULL`, [
			intoId,
			timestamp,
			fromId,
		]);
		await db.runAsync(`UPDATE transfers SET toAccountId = ?, updatedAt = ${NEXT_STAMP}, dirty = 1 WHERE toAccountId = ? AND deletedAt IS NULL`, [
			intoId,
			timestamp,
			fromId,
		]);
		await db.runAsync(`UPDATE bills SET accountId = ?, updatedAt = ${NEXT_STAMP}, dirty = 1 WHERE accountId = ? AND deletedAt IS NULL`, [
			intoId,
			timestamp,
			fromId,
		]);
		await db.runAsync(`UPDATE debts SET accountId = ?, updatedAt = ${NEXT_STAMP}, dirty = 1 WHERE accountId = ? AND deletedAt IS NULL`, [
			intoId,
			timestamp,
			fromId,
		]);
		if (identityChanged) {
			await db.runAsync(
				`UPDATE accounts SET cardNames = ?, last4 = ?, packageName = ?, accountKey = ?, updatedAt = ${NEXT_STAMP}, dirty = 1 WHERE id = ?`,
				[identity.cardNames, identity.last4, identity.packageName, identity.accountKey, timestamp, intoId]
			);
		}
		// A lápide do `deleteAccount`. Já não sobra lançamento, transferência nem saldo nele.
		await db.runAsync(`UPDATE accounts SET deletedAt = ?, updatedAt = ${NEXT_STAMP}, dirty = 1 WHERE id = ?`, [timestamp, timestamp, fromId]);
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
		`UPDATE transactions SET accountId = ?, updatedAt = ${NEXT_STAMP}, dirty = 1 WHERE (id = ? OR installmentGroup = ?) AND deletedAt IS NULL`,
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
 * Saldo de cada conta no fim de `asOfDate`, a partir da âncora (o saldo no fim de
 * `openingBalanceDate`, com tudo até aquele dia já dentro dele).
 *
 * Depois da âncora: a âncora mais o que veio depois dela, até a data. **Antes** da
 * âncora: a âncora menos o que houve entre a data e ela — desfazer os movimentos é o
 * único jeito de chegar no saldo de um dia que a âncora já engoliu. Devolver a própria
 * âncora ali fazia o envelope acertado no dia 16 "ter sobrado" R$ 850 do mês anterior,
 * quando a sobra de verdade era R$ 150, e o teto do mês inchava.
 *
 * As duas metades são a mesma janela, entre a menor e a maior das duas datas, com o
 * sinal trocado. Uma só consulta para todas as contas; a tela inicial chama isto a cada
 * recarga.
 */
export const getAccountBalances = async (asOfDate: string): Promise<Map<string, number>> => {
	const rows = await db.getAllAsync<{ accountId: string; balanceCents: number }>(
		`SELECT a.id AS accountId,
            a.openingBalanceCents
            + (CASE WHEN p.asOf >= a.openingBalanceDate THEN 1 ELSE -1 END) * (
                COALESCE((SELECT SUM(CASE WHEN t.isIncome = 1 THEN t.amountCents ELSE -t.amountCents END)
                          FROM transactions t
                          WHERE t.accountId = a.id AND t.deletedAt IS NULL
                            AND t.date > MIN(a.openingBalanceDate, p.asOf)
                            AND t.date <= MAX(a.openingBalanceDate, p.asOf)), 0)
              - COALESCE((SELECT SUM(x.amountCents) FROM transfers x
                          WHERE x.fromAccountId = a.id AND x.deletedAt IS NULL
                            AND x.date > MIN(a.openingBalanceDate, p.asOf)
                            AND x.date <= MAX(a.openingBalanceDate, p.asOf)), 0)
              + COALESCE((SELECT SUM(x.amountCents) FROM transfers x
                          WHERE x.toAccountId = a.id AND x.deletedAt IS NULL
                            AND x.date > MIN(a.openingBalanceDate, p.asOf)
                            AND x.date <= MAX(a.openingBalanceDate, p.asOf)), 0)
              ) AS balanceCents
     FROM accounts a, (SELECT ? AS asOf) p
     WHERE a.deletedAt IS NULL`,
		[asOfDate]
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
 *
 * O ajuste com a fatura do banco (`isCardAdjustment`: a nota-marcador, sem parcela) fica
 * de fora: está na fatura, mas não é compra feita no mês — a fatura informada no cadastro
 * aparecia como "R$ 1.234,56 comprados neste mês". O encargo do cartão (`isCardCharge`:
 * juros, IOF, anuidade) também: a nota pura ou com o tipo entre parênteses — `GLOB`, e não
 * `LIKE`, porque diferencia maiúsculas como a função.
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
         AND TRIM(COALESCE(note, '')) <> ?
         AND TRIM(COALESCE(note, '')) <> ? AND TRIM(COALESCE(note, '')) NOT GLOB ?
         AND date BETWEEN ? AND ? AND deletedAt IS NULL`,
			[accountId, CARD_ADJUSTMENT_NOTE, CARD_CHARGE_NOTE, CARD_CHARGE_NOTE_GLOB, startDate, endDate]
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

/**
 * Quantos lançamentos sem conta são datados **antes ou no dia** da âncora de uma conta.
 *
 * "Em caixa" soma os lançamentos sem conta até hoje, enquanto o saldo de uma conta só
 * conta o que vem **depois** da âncora (`openingBalanceCents` é o saldo no fim de
 * `openingBalanceDate`). Mover para uma conta criada hoje 40 lançamentos antigos faz o
 * total pular no instante do toque: cada um deles sai do caixa e não entra em lugar
 * nenhum. Este número é o aviso que a tela precisa dar antes de mover.
 */
export const countUnassignedOnOrBeforeAnchor = async (accountId: string): Promise<number> => {
	const row = await db.getFirstAsync<{ count: number }>(
		`SELECT COUNT(*) AS count
     FROM transactions t
     JOIN accounts a ON a.id = ?
     WHERE t.accountId IS NULL AND t.deletedAt IS NULL AND t.date <= a.openingBalanceDate`,
		[accountId]
	);
	return row?.count ?? 0;
};

/** O que o movimento em massa fez. */
export interface UnassignedAssignment {
	/** Quantos lançamentos ganharam a conta. */
	moved: number;
	/**
	 * Quantos deles são datados antes ou na âncora do destino, e portanto somem do total
	 * sem reaparecer no saldo da conta. Zero é a resposta boa.
	 */
	beforeAnchor: number;
}

/**
 * Dá uma conta a todos os lançamentos que não têm nenhuma.
 *
 * Nada de âncora nem de saldo é mexido aqui de propósito: mover um lançamento não é
 * motivo para reescrever o saldo que o usuário informou. O que esta função faz é
 * **contar** os que vão ficar invisíveis, antes do UPDATE, para a tela poder avisar.
 */
export const assignUnassignedToAccount = async (accountId: string): Promise<UnassignedAssignment> => {
	const beforeAnchor = await countUnassignedOnOrBeforeAnchor(accountId);
	const result = await db.runAsync(
		`UPDATE transactions SET accountId = ?, updatedAt = ${NEXT_STAMP}, dirty = 1 WHERE accountId IS NULL AND deletedAt IS NULL`,
		[accountId, nowTimestamp()]
	);
	return { moved: result.changes, beforeAnchor };
};

/**
 * Só a contagem do que mudou.
 *
 * `AccountsContext` ainda expõe `assignUnassigned` como `Promise<number>` e a tela de
 * "sem conta" só anuncia esse número; enquanto as duas não passarem o aviso adiante,
 * este embrulho mantém o caminho antigo funcionando com uma única implementação.
 */
export const assignUnassignedTransactions = async (accountId: string): Promise<number> =>
	(await assignUnassignedToAccount(accountId)).moved;

/** Receita menos despesa dos lançamentos sem conta, até `asOfDate`. */
export const getUnassignedNet = async (asOfDate: string): Promise<number> => {
	const row = await db.getFirstAsync<{ net: number }>(
		`SELECT COALESCE(SUM(CASE WHEN isIncome = 1 THEN amountCents ELSE -amountCents END), 0) AS net
     FROM transactions WHERE accountId IS NULL AND date <= ? AND deletedAt IS NULL`,
		[asOfDate]
	);
	return row?.net ?? 0;
};

/** Âncora explícita: o saldo (num cartão, negativo = deve) no fim de `date`. */
export const setAccountAnchor = async (accountId: string, balanceCents: number, date: string): Promise<void> => {
	await db.runAsync(
		`UPDATE accounts SET openingBalanceCents = ?, openingBalanceDate = ?, updatedAt = ${NEXT_STAMP}, dirty = 1
     WHERE id = ?`,
		[balanceCents, date, nowTimestamp(), accountId]
	);
};

/**
 * "Meu saldo agora é X": move a âncora para ontem, com o valor que faz o saldo de hoje
 * bater com X depois de somar o que já aconteceu hoje. Lançamentos que entrarem mais
 * tarde hoje continuam somando por cima, porque são datados depois da âncora.
 */
export const setAccountBalanceToday = async (accountId: string, balanceCents: number): Promise<void> => {
	const today = todayISO();
	const activity = await getAccountActivity(accountId, today, today);
	const todayNet =
		activity.incomeCents - activity.expenseCents + activity.transfersInCents - activity.transfersOutCents;

	await db.runAsync(
		`UPDATE accounts SET openingBalanceCents = ?, openingBalanceDate = ?, updatedAt = ${NEXT_STAMP}, dirty = 1
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

/** As tabelas que a restauração regrava por cima da lápide, todas com a identidade em `id`. */
type RestoredTable = 'accounts' | 'transfers' | 'transactions' | 'recurring_transactions' | 'debts' | 'bills' | 'budgets';

/**
 * Tira a lápide de `id` para a restauração regravar a linha, e devolve o carimbo dela (nulo
 * sem lápide). O carimbo tem de sair daqui antes do DELETE: a linha regravada precisa
 * passar dele (`stampPastTombstone`), senão a lápide guardada no servidor — de um relógio
 * adiantado, ou carimbada pelo `resetDatabase` depois de um carimbo no futuro — venceria a
 * restauração por `stale` (SPD-107).
 */
const liftTombstone = async (table: RestoredTable, id: string): Promise<string | null> => {
	const tombstone = await db.getFirstAsync<{ updatedAt: string | null }>(
		`SELECT updatedAt FROM ${table} WHERE id = ? AND deletedAt IS NOT NULL`,
		[id]
	);
	await db.runAsync(`DELETE FROM ${table} WHERE id = ? AND deletedAt IS NOT NULL`, [id]);
	return tombstone ? (tombstone.updatedAt ?? '') : null;
};

/** Leva o carimbo da linha regravada para depois do da lápide que ela substituiu. */
const stampPastTombstone = async (table: RestoredTable, id: string, tombstone: string | null): Promise<void> => {
	if (tombstone === null) return;
	await db.runAsync(`UPDATE ${table} SET updatedAt = ? WHERE id = ?`, [nextStamp(tombstone, nowTimestamp()), id]);
};

/**
 * Grava uma conta ou transferência de um backup com o id original, **ressuscitando** a
 * linha se ela estiver apagada. A importação apaga tudo (lápides) antes de regravar, e o
 * `ON CONFLICT DO NOTHING` de `addAccount`/`addTransfer` deixava as contas apagadas: o
 * app ficava sem contas, e os lançamentos importados, presos a contas invisíveis.
 *
 * A lápide sai e a linha entra de novo, suja e com carimbo depois do da lápide — mais nova
 * que ela em qualquer aparelho ou no servidor, então é ela que vale no sync.
 */
export const restoreAccount = async (draft: AccountDraft, id: string): Promise<void> => {
	const tombstone = await liftTombstone('accounts', id);
	await addAccount(draft, id);
	await stampPastTombstone('accounts', id, tombstone);
};

export const restoreTransfer = async (draft: TransferDraft, id: string): Promise<void> => {
	const tombstone = await liftTombstone('transfers', id);
	await addTransfer(draft, id);
	await stampPastTombstone('transfers', id, tombstone);
};

/**
 * Grava um lançamento do backup com o id original, ressuscitando a lápide que o
 * `resetDatabase` da importação acabou de pôr.
 *
 * O id tem de ser o do arquivo. Enquanto a importação gerava id novo, importar o mesmo
 * backup em dois aparelhos deixava **duas gerações do mesmo lançamento** vivas na conta:
 * o sync não tem como saber que são a mesma compra, e o livro-caixa dobrava. Com o id
 * preservado, o segundo aparelho reconhece a linha e o last-write-wins resolve.
 *
 * Sem id — arquivo editado à mão, ou truncado —, a linha entra com um id novo: perder o
 * lançamento inteiro por causa de um campo faltando seria o pior dos dois erros.
 */
export const restoreTransaction = async (draft: TransactionDraft, id?: string): Promise<void> => {
	const rowId = id ?? generateUniqueId();
	const tombstone = await liftTombstone('transactions', rowId);
	await addTransaction(draft, rowId);
	await stampPastTombstone('transactions', rowId, tombstone);
};

/**
 * Grava uma recorrência do backup com o id original e com o relógio dela intacto.
 *
 * `lastProcessed` e `nextDue` vêm do arquivo: `addRecurringTransaction` recalcula o
 * próximo vencimento como se a regra nascesse hoje, e a importação perdia com isso o
 * histórico de quais ocorrências já foram lançadas — a assinatura do mês vinha outra vez.
 */
export const restoreRecurringTransaction = async (
	rule: RecurringTransaction,
	id?: string
): Promise<void> => {
	const rowId = id ?? generateUniqueId();
	const tombstone = await liftTombstone('recurring_transactions', rowId);
	await db.runAsync(
		`INSERT INTO recurring_transactions
       (id, amountCents, isIncome, note, category, recurrenceType, day, month, weekday,
        lastProcessed, nextDue, active, updatedAt, deletedAt, dirty)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)
     ON CONFLICT (id) DO NOTHING`,
		[
			rowId,
			rule.amountCents,
			rule.isIncome ? 1 : 0,
			rule.note,
			rule.category,
			rule.recurrenceType,
			rule.day ?? null,
			rule.month ?? null,
			rule.weekday ?? null,
			rule.lastProcessed ?? null,
			// Sem `nextDue` no arquivo (backup antigo), a regra recomeça do primeiro
			// vencimento a partir de hoje, como uma regra nova.
			rule.nextDue ?? firstDueOnOrAfter(toRule(rule), todayISO()),
			rule.active ? 1 : 0,
			nowTimestamp(),
		]
	);
	await stampPastTombstone('recurring_transactions', rowId, tombstone);
};

/** Grava uma dívida do backup com o id original, pelo mesmo motivo dos lançamentos. */
export const restoreDebt = async (draft: DebtDraft, id?: string): Promise<void> => {
	const rowId = id ?? generateUniqueId();
	const tombstone = await liftTombstone('debts', rowId);
	await db.runAsync(
		`INSERT INTO debts (id, ${DEBT_COLUMNS.join(', ')}, updatedAt, deletedAt, dirty)
     VALUES (?, ${DEBT_COLUMNS.map(() => '?').join(', ')}, ?, NULL, 1)
     ON CONFLICT (id) DO NOTHING`,
		[rowId, ...debtValues(draft), nowTimestamp()]
	);
	await stampPastTombstone('debts', rowId, tombstone);
};

/** Grava uma conta a pagar do backup com o id original, pelo mesmo motivo das dívidas. */
export const restoreBill = async (draft: BillDraft, id?: string): Promise<void> => {
	const rowId = id ?? generateUniqueId();
	const tombstone = await liftTombstone('bills', rowId);
	await db.runAsync(
		`INSERT INTO bills (id, ${BILL_COLUMNS.join(', ')}, updatedAt, deletedAt, dirty)
     VALUES (?, ${BILL_COLUMNS.map(() => '?').join(', ')}, ?, NULL, 1)
     ON CONFLICT (id) DO NOTHING`,
		[rowId, ...billValues(draft), nowTimestamp()]
	);
	await stampPastTombstone('bills', rowId, tombstone);
};

export const updateTransfer = async (transfer: TransferEdit): Promise<void> => {
	await db.runAsync(
		`UPDATE transfers SET fromAccountId = ?, toAccountId = ?, amountCents = ?, date = ?, note = ?,
       updatedAt = ${NEXT_STAMP}, dirty = 1
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
	await db.runAsync(`UPDATE transfers SET deletedAt = ?, updatedAt = ${NEXT_STAMP}, dirty = 1 WHERE id = ?`, [
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
	await db.runAsync(`UPDATE accounts SET cardNames = ?, updatedAt = ${NEXT_STAMP}, dirty = 1 WHERE id = ?`, [
		cardNames,
		nowTimestamp(),
		accountId,
	]);
};

/**
 * Lápide em todas as transferências que entram ou saem de uma conta. Levar o cartão para o
 * débito não usa mais (SPD-152): apagar os pagamentos de fatura devolvia o dinheiro à conta
 * que pagou e mudava o patrimônio.
 */
export const deleteTransfersOf = async (accountId: string): Promise<void> => {
	const timestamp = nowTimestamp();
	await db.runAsync(TOMBSTONE_TRANSFERS_OF_ACCOUNT, [timestamp, timestamp, accountId, accountId]);
};

/**
 * Uma transferência viva que case com estes lados e esta janela de datas. Um lado nulo
 * casa com qualquer conta: o aviso do banco muitas vezes só identifica uma das pernas.
 */
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
		`UPDATE transactions SET deletedAt = ?, updatedAt = ${NEXT_STAMP}, dirty = 1 WHERE installmentGroup = ? AND deletedAt IS NULL`,
		[timestamp, timestamp, installmentGroup]
	);
};

/** Dá conta a um lançamento que ainda não tem: o extrato sabe de onde ele saiu. */
export const assignTransactionAccount = async (id: string, accountId: string): Promise<void> => {
	await db.runAsync(
		`UPDATE transactions SET accountId = ?, updatedAt = ${NEXT_STAMP}, dirty = 1 WHERE id = ? AND accountId IS NULL`,
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
           lastProcessed = ?, nextDue = ?, active = ?, updatedAt = ${NEXT_STAMP}, dirty = 1
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
			`UPDATE recurring_transactions SET deletedAt = ?, updatedAt = ${NEXT_STAMP}, dirty = 1 WHERE id = ?`,
			[timestamp, timestamp, id]
		);
	} catch (error) {
		console.error('Error deleting recurring transaction:', error);
		throw error;
	}
};

/*
 * As regras não lançam mais nada (SPD-113). Até aqui havia `processRecurringTransactions`,
 * que a Início chamava ao abrir e lançava um `[Auto]` a cada vencimento. A tela das
 * recorrências saiu no SPD-079, mas as regras antigas ficaram no banco e seguiam lançando:
 * quando a cobrança de verdade chegava (pela captura ou à mão), o mês ficava com o gasto
 * dobrado. As regras e os `[Auto]` já lançados são dados do usuário e continuam aqui e no
 * sync; o par que sobrou aparece em Relatórios com o botão de apagar o `[Auto]`.
 */

// ---------------------------------------------------------------------------
// Currency conversion
// ---------------------------------------------------------------------------

/**
 * Cada valor em dinheiro guardado, por tabela (SPD-140). É a lista que a troca de moeda com
 * taxa converte e que decide se a troca precisa perguntar a taxa — uma lista só, para as
 * duas não divergirem.
 *
 * Fica de fora o que não é dinheiro: percentuais e pontos-base (`yieldCdiBp`, `rateBp`,
 * `adminFeeBp`, `reinvestBp`, `expectedYieldBp`), contadores (parcelas, meses da reserva),
 * dias e datas. O que é calculado — saldo, fatura, rendimento estimado, quanto a reserva já
 * guardou — não é gravado: sai convertido das colunas daqui.
 *
 * `captures` entra inteira, e não só o que está pendente: o aviso a revisar já conta no
 * saldo e na fatura (`provisionalEntries`) e vira lançamento com este valor; o resolvido
 * guarda o mesmo valor do lançamento ou da transferência que gerou, e as duas pontas têm de
 * continuar iguais. O texto do aviso (`text`) fica como o banco mandou.
 */
const MONEY_COLUMNS: ReadonlyArray<{ table: string; columns: readonly string[] }> = [
	{ table: 'transactions', columns: ['amountCents'] },
	{ table: 'recurring_transactions', columns: ['amountCents'] },
	{ table: 'transfers', columns: ['amountCents'] },
	{ table: 'accounts', columns: ['openingBalanceCents', 'creditLimitCents', 'envelopeMonthlyCents'] },
	{ table: 'budgets', columns: ['amountCents'] },
	{ table: 'retirement_goals', columns: ['targetMonthlyCents', 'outsideCapitalCents'] },
	{ table: 'reserve_goals', columns: ['customMonthlyCostCents'] },
	{ table: 'debts', columns: ['openingBalanceCents', 'installmentCents', 'feeCents'] },
	{ table: 'bills', columns: ['amountCents'] },
	{ table: 'captures', columns: ['amountCents'] },
];

/**
 * Se há algum valor em dinheiro guardado, para a troca de moeda decidir se pergunta a taxa.
 * Conta a linha viva com algum valor diferente de zero: uma conta zerada, uma conta a pagar
 * que varia ou a meta da reserva só com os meses não têm o que converter.
 *
 * Antes só lançamentos e recorrentes contavam, e quem tinha só o saldo de partida das contas
 * trocava de moeda sem ser perguntado: R$ 1.000 viravam US$ 1.000.
 */
export const hasFinancialData = async (): Promise<boolean> => {
	const exists = MONEY_COLUMNS.map(
		({ table, columns }) =>
			`EXISTS (SELECT 1 FROM ${table} WHERE deletedAt IS NULL AND (${columns.map((column) => `COALESCE(${column}, 0) <> 0`).join(' OR ')}))`
	);
	const row = await db.getFirstAsync<{ found: number }>(`SELECT (${exists.join(' OR ')}) AS found`);
	return Boolean(row?.found);
};

/**
 * Rescales every stored amount by an exchange rate — todas as colunas de `MONEY_COLUMNS`.
 *
 * Rounding happens once per row, in SQLite, so the result is the same integer cents
 * the app would have computed itself. Coluna nula (o limite de quem não informou, a conta a
 * pagar que varia) continua nula. Wrapped in a transaction: a half-converted ledger would
 * be worse than either currency.
 *
 * Só as linhas vivas: a lápide não volta a valer, e reconvertê-la só a faria subir de novo.
 */
export const convertAllAmounts = async (rate: number): Promise<void> => {
	if (!Number.isFinite(rate) || rate <= 0) {
		throw new Error(`Refusing to convert amounts by a non-positive rate: ${rate}`);
	}

	const timestamp = nowTimestamp();

	await runInTransaction(async () => {
		// Every rescaled row is a genuine change and has to reach the other devices,
		// otherwise they would keep the old currency's numbers under the new symbol. O
		// carimbo é o de toda edição (`NEXT_STAMP`): agora, ou 1 ms depois do da linha. A linha
		// sem valor nenhum (a conta a pagar que varia) não muda e não é carimbada.
		for (const { table, columns } of MONEY_COLUMNS) {
			const scaled = columns.map((column) => `${column} = CAST(ROUND(${column} * ?) AS INTEGER)`).join(', ');
			const hasValue = columns.map((column) => `${column} IS NOT NULL`).join(' OR ');
			await db.runAsync(
				`UPDATE ${table} SET ${scaled}, updatedAt = ${NEXT_STAMP}, dirty = 1 WHERE deletedAt IS NULL AND (${hasValue})`,
				[...columns.map(() => rate), timestamp]
			);
		}
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
	feeCents: row.feeCents ?? 0,
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
	'feeCents',
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
		`UPDATE debts SET ${DEBT_COLUMNS.map((column) => `${column} = ?`).join(', ')}, updatedAt = ${NEXT_STAMP}, dirty = 1 WHERE id = ?`,
		[...debtValues(draft), nowTimestamp(), id]
	);
};

/** Lápide: some aqui e, no próximo sync, dos outros aparelhos. */
export const deleteDebt = async (id: string): Promise<void> => {
	const timestamp = nowTimestamp();
	await db.runAsync(`UPDATE debts SET deletedAt = ?, updatedAt = ${NEXT_STAMP}, dirty = 1 WHERE id = ? AND deletedAt IS NULL`, [timestamp, timestamp, id]);
};

// ---------------------------------------------------------------------------
// Bills (contas a pagar)
// ---------------------------------------------------------------------------

const convertBill = (row: BillDB): Bill => ({
	id: row.id,
	name: row.name,
	dueDay: row.dueDay,
	amountCents: row.amountCents ?? null,
	accountId: row.accountId ?? null,
	category: row.category ?? null,
	matchHint: row.matchHint ?? null,
	debtId: row.debtId ?? null,
	paidThrough: row.paidThrough ?? null,
	paidByRef: row.paidByRef ?? null,
	active: Boolean(row.active),
	sortOrder: row.sortOrder,
	updatedAt: row.updatedAt,
	deletedAt: row.deletedAt ?? undefined,
});

/** As contas a pagar vivas, desativadas inclusive (a tela separa). */
export const getBills = async (): Promise<Bill[]> => {
	const rows = await db.getAllAsync<BillDB>('SELECT * FROM bills WHERE deletedAt IS NULL ORDER BY sortOrder ASC, name ASC');
	return rows.map(convertBill);
};

const BILL_COLUMNS = [
	'name',
	'dueDay',
	'amountCents',
	'accountId',
	'category',
	'matchHint',
	'debtId',
	'paidThrough',
	'paidByRef',
	'active',
	'sortOrder',
] as const;

const billValues = (draft: BillDraft) =>
	BILL_COLUMNS.map((column) => {
		const value = draft[column];
		return typeof value === 'boolean' ? (value ? 1 : 0) : (value ?? null);
	});

export const addBill = async (draft: BillDraft): Promise<string> => {
	const id = generateUniqueId();
	await db.runAsync(
		`INSERT INTO bills (id, ${BILL_COLUMNS.join(', ')}, updatedAt, deletedAt, dirty)
     VALUES (?, ${BILL_COLUMNS.map(() => '?').join(', ')}, ?, NULL, 1)`,
		[id, ...billValues(draft), nowTimestamp()]
	);
	return id;
};

export const updateBill = async (id: string, draft: BillDraft): Promise<void> => {
	await db.runAsync(
		`UPDATE bills SET ${BILL_COLUMNS.map((column) => `${column} = ?`).join(', ')}, updatedAt = ${NEXT_STAMP}, dirty = 1 WHERE id = ?`,
		[...billValues(draft), nowTimestamp(), id]
	);
};

/** Lápide: some aqui e, no próximo sync, dos outros aparelhos. */
export const deleteBill = async (id: string): Promise<void> => {
	const timestamp = nowTimestamp();
	await db.runAsync(`UPDATE bills SET deletedAt = ?, updatedAt = ${NEXT_STAMP}, dirty = 1 WHERE id = ? AND deletedAt IS NULL`, [timestamp, timestamp, id]);
};

/**
 * Uma conta a pagar por dívida ativa (financiamento, consórcio, empréstimo), ligada pela
 * `debtId`. Devolve quantas linhas gravou.
 *
 * - Dívida ativa sem conta a pagar viva ligada: cria uma com o nome, o dia, a parcela
 *   (`installmentCents`), a conta e a categoria da dívida. O **id é o da dívida**: dois
 *   aparelhos que rodam isto offline para a mesma dívida criam a mesma linha, e o sync a
 *   junta por last-write-wins em vez de deixar duas. Se esse id tiver uma lápide (a conta
 *   a pagar foi apagada), ela volta à vida.
 * - Ligada a dívida ativa: segue o nome, o dia, o valor e a conta da dívida quando eles
 *   mudaram, e volta a ficar ativa (dívida desarquivada).
 * - Ligada a dívida arquivada, apagada ou que não está em `debts`: fica `active = false`.
 *
 * O que a conta a pagar acrescenta — `paidThrough`, `paidByRef`, `matchHint`, a categoria
 * depois de criada, a ordem — nunca é tocado aqui. Idempotente: nada mudou, nada é
 * gravado, e nenhuma linha fica suja à toa.
 *
 * `debts` é a lista inteira de dívidas (a de `getDebts`): uma dívida fora dela conta
 * como apagada.
 */
export const ensureDebtBills = async (debts: Debt[]): Promise<number> => {
	const timestamp = nowTimestamp();
	let written = 0;

	const follow = async (bill: BillDB, target: { name: string; dueDay: number; amountCents: number | null; accountId: string | null; active: boolean }) => {
		const unchanged =
			bill.name === target.name &&
			bill.dueDay === target.dueDay &&
			(bill.amountCents ?? null) === target.amountCents &&
			(bill.accountId ?? null) === target.accountId &&
			Boolean(bill.active) === target.active;
		if (unchanged) return;
		await db.runAsync(
			`UPDATE bills SET name = ?, dueDay = ?, amountCents = ?, accountId = ?, active = ?, updatedAt = ${NEXT_STAMP}, dirty = 1 WHERE id = ?`,
			[target.name, target.dueDay, target.amountCents, target.accountId, target.active ? 1 : 0, timestamp, bill.id]
		);
		written += 1;
	};

	await runInTransaction(async () => {
		// Lidas já dentro da transação: duas cargas do DebtsContext juntas (o aviso de contas a
		// pagar e o fim do sync, depois de juntar cartões) esperam uma à outra, e a segunda
		// precisa ver o que a primeira gravou, senão regravava tudo de novo à toa.
		const linked = await db.getAllAsync<BillDB>('SELECT * FROM bills WHERE debtId IS NOT NULL AND deletedAt IS NULL');
		const billsOf = new Map<string, BillDB[]>();
		for (const bill of linked) {
			if (!bill.debtId) continue;
			billsOf.set(bill.debtId, [...(billsOf.get(bill.debtId) ?? []), bill]);
		}

		const known = new Set<string>();
		for (const debt of debts) {
			known.add(debt.id);
			const alive = !debt.archived && !debt.deletedAt;
			const bills = billsOf.get(debt.id) ?? [];

			if (bills.length === 0) {
				if (!alive) continue;
				const draft: BillDraft = {
					name: debt.name,
					dueDay: debt.dueDay,
					amountCents: debt.installmentCents,
					accountId: debt.accountId ?? null,
					category: debt.category ?? null,
					matchHint: null,
					debtId: debt.id,
					paidThrough: null,
					paidByRef: null,
					active: true,
					sortOrder: 0,
				};
				// A ressurreição da lápide não mexe no mês pago nem na pista de casamento:
				// só no que vem da dívida.
				await db.runAsync(
					`INSERT INTO bills (id, ${BILL_COLUMNS.join(', ')}, updatedAt, deletedAt, dirty)
           VALUES (?, ${BILL_COLUMNS.map(() => '?').join(', ')}, ?, NULL, 1)
           ON CONFLICT (id) DO UPDATE SET
             name = excluded.name, dueDay = excluded.dueDay, amountCents = excluded.amountCents,
             accountId = excluded.accountId, category = excluded.category, debtId = excluded.debtId,
             active = 1, updatedAt = ${NEXT_STAMP_UPSERT}, deletedAt = NULL, dirty = 1`,
					[debt.id, ...billValues(draft), timestamp]
				);
				written += 1;
				continue;
			}

			for (const bill of bills) {
				await follow(
					bill,
					alive
						? { name: debt.name, dueDay: debt.dueDay, amountCents: debt.installmentCents, accountId: debt.accountId ?? null, active: true }
						: { name: bill.name, dueDay: bill.dueDay, amountCents: bill.amountCents ?? null, accountId: bill.accountId ?? null, active: false }
				);
			}
		}

		// Ligadas a uma dívida que não existe mais (fora da lista): a dívida foi apagada.
		for (const [debtId, bills] of billsOf) {
			if (known.has(debtId)) continue;
			for (const bill of bills) {
				await follow(bill, { name: bill.name, dueDay: bill.dueDay, amountCents: bill.amountCents ?? null, accountId: bill.accountId ?? null, active: false });
			}
		}
	});

	return written;
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
       updatedAt = ${NEXT_STAMP_UPSERT}, deletedAt = NULL, dirty = 1`,
		[RETIREMENT_GOAL_ID, draft.targetMonthlyCents, draft.reinvestBp, draft.expectedYieldBp, draft.outsideCapitalCents, nowTimestamp()]
	);
};

export const clearRetirementGoal = async (): Promise<void> => {
	const timestamp = nowTimestamp();
	await db.runAsync(`UPDATE retirement_goals SET deletedAt = ?, updatedAt = ${NEXT_STAMP}, dirty = 1 WHERE id = ? AND deletedAt IS NULL`, [
		timestamp,
		timestamp,
		RETIREMENT_GOAL_ID,
	]);
};

// ---------------------------------------------------------------------------
// Reserve goal
// ---------------------------------------------------------------------------

export type ReserveGoalDraft = Omit<ReserveGoalRow, 'id' | 'updatedAt' | 'deletedAt'>;

const convertReserveGoal = (row: ReserveGoalDB): ReserveGoalRow => ({
	id: row.id,
	targetMonths: row.targetMonths ?? DEFAULT_RESERVE_MONTHS,
	customMonthlyCostCents: row.customMonthlyCostCents ?? null,
	updatedAt: row.updatedAt,
	deletedAt: row.deletedAt ?? undefined,
});

/** A meta da reserva, ou nula enquanto o usuário não mexeu nela (vale o padrão de 12 meses). */
export const getReserveGoal = async (): Promise<ReserveGoalRow | null> => {
	const row = await db.getFirstAsync<ReserveGoalDB>('SELECT * FROM reserve_goals WHERE id = ? AND deletedAt IS NULL', [
		RESERVE_GOAL_ID,
	]);
	return row ? convertReserveGoal(row) : null;
};

/** Define (ou redefine) a meta da reserva, na mesma linha de id fixo. */
export const setReserveGoal = async (draft: ReserveGoalDraft): Promise<void> => {
	await db.runAsync(
		`INSERT INTO reserve_goals (id, targetMonths, customMonthlyCostCents, updatedAt, deletedAt, dirty)
     VALUES (?, ?, ?, ?, NULL, 1)
     ON CONFLICT (id) DO UPDATE SET
       targetMonths = excluded.targetMonths, customMonthlyCostCents = excluded.customMonthlyCostCents,
       updatedAt = ${NEXT_STAMP_UPSERT}, deletedAt = NULL, dirty = 1`,
		[RESERVE_GOAL_ID, draft.targetMonths, draft.customMonthlyCostCents, nowTimestamp()]
	);
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
		await db.runAsync(`UPDATE budgets SET amountCents = ?, updatedAt = ${NEXT_STAMP}, dirty = 1 WHERE id = ?`, [
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

/**
 * Grava o orçamento de um mês com o id do backup, ressuscitando a lápide da importação.
 *
 * O id importa aqui tanto quanto nos lançamentos, e por um motivo pior: o servidor exige
 * **um só orçamento vivo** por mês. Dois aparelhos que importassem o mesmo arquivo com
 * ids diferentes criariam dois orçamentos do mesmo mês e derrubariam o push — o achado
 * 6.1. Com o id do arquivo, os dois aparelhos convergem na mesma linha.
 *
 * **Sem transação própria**, como os outros `restore*`. Ela abria uma, e a importação do
 * E2E-35 corria junto de outra — a da rodada de sync que a volta do seletor de arquivo
 * dispara —: o `BEGIN` dentro da transação aberta falhava ("cannot start a transaction
 * within a transaction") e só o orçamento ficava de fora. A importação agora roda com a
 * fila parada (`importDatabaseData`), mas um contexto que grava ao voltar ao primeiro
 * plano ainda pode estar com a dele aberta. Cada comando abaixo deixa o banco coerente
 * sozinho: interrompido no meio, o mês fica sem orçamento até a próxima importação — o
 * mesmo que os outros `restore*` arriscam.
 */
export const restoreBudget = async (
	year: number,
	month: number,
	amountCents: number,
	id: string
): Promise<void> => {
	const tombstone = await liftTombstone('budgets', id);
	// O índice único cobre só as linhas vivas: se o mês já tem outra linha viva (uma
	// que a importação não apagou), ela perde a vez para a do arquivo.
	await db.runAsync(
		`UPDATE budgets SET deletedAt = ?, updatedAt = ${NEXT_STAMP}, dirty = 1
     WHERE year = ? AND month = ? AND id != ? AND deletedAt IS NULL`,
		[nowTimestamp(), nowTimestamp(), year, month, id]
	);
	await db.runAsync(
		`INSERT INTO budgets (id, year, month, amountCents, updatedAt, deletedAt, dirty)
     VALUES (?, ?, ?, ?, ?, NULL, 1)
     ON CONFLICT (id) DO UPDATE SET
       year = excluded.year, month = excluded.month, amountCents = excluded.amountCents,
       updatedAt = ${NEXT_STAMP_UPSERT}, deletedAt = NULL, dirty = 1`,
		[id, year, month, amountCents, nowTimestamp()]
	);
	await stampPastTombstone('budgets', id, tombstone);
};

export const clearBudget = async (year: number, month: number): Promise<void> => {
	const timestamp = nowTimestamp();
	await db.runAsync(
		`UPDATE budgets SET deletedAt = ?, updatedAt = ${NEXT_STAMP}, dirty = 1
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
	const [categories, accounts, transactions, recurring, budgets, transfers, retirementGoals, debts, reserveGoals, captures, merchantRules, bills, preferences] = await Promise.all([
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
		db.getAllAsync<ReserveGoalDB>('SELECT * FROM reserve_goals WHERE dirty = 1 ORDER BY updatedAt ASC LIMIT ?', [limit]),
		db.getAllAsync<CaptureDB>('SELECT * FROM captures WHERE dirty = 1 ORDER BY updatedAt ASC LIMIT ?', [limit]),
		db.getAllAsync<MerchantRuleDB>('SELECT * FROM merchant_rules WHERE dirty = 1 ORDER BY updatedAt ASC LIMIT ?', [limit]),
		db.getAllAsync<BillDB>('SELECT * FROM bills WHERE dirty = 1 ORDER BY updatedAt ASC LIMIT ?', [limit]),
		db.getAllAsync<PreferenceDB>('SELECT * FROM preferences WHERE dirty = 1 ORDER BY updatedAt ASC LIMIT ?', [limit]),
	]);

	// O `relatedId` ("é duplicata daquela?") é um id local, que não significa nada do
	// outro lado: ele sobe como o **fingerprint** do item relacionado. Uma consulta só
	// para todos os relacionados desta remessa, inclusive os que não estão subindo agora.
	const relatedIds = [...new Set(captures.map((row) => row.relatedId).filter((id): id is string => Boolean(id)))];
	const fingerprintOfLocalId = new Map<string, string>();
	if (relatedIds.length > 0) {
		const related = await db.getAllAsync<{ id: string; fingerprint: string }>(
			`SELECT id, fingerprint FROM captures WHERE id IN (${relatedIds.map(() => '?').join(', ')})`,
			relatedIds
		);
		for (const row of related) fingerprintOfLocalId.set(row.id, row.fingerprint);
	}

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
			yieldCdiBp: row.yieldCdiBp ?? null,
			reservePurpose: row.reservePurpose === 'investment' ? ('investment' as ReservePurpose) : null,
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
		reserveGoals: reserveGoals.map((row) => ({
			id: row.id,
			targetMonths: row.targetMonths,
			customMonthlyCostCents: row.customMonthlyCostCents ?? null,
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
		captures: captures.map((row) => ({
			// A identidade da linha no servidor é o fingerprint; o id local fica aqui.
			id: row.fingerprint,
			packageName: row.packageName,
			appLabel: row.appLabel,
			title: row.title,
			text: row.text,
			postedAt: row.postedAt,
			amountCents: row.amountCents,
			direction: row.direction,
			kind: row.kind,
			counterparty: row.counterparty ?? null,
			merchantKey: row.merchantKey ?? null,
			cardLast4: row.cardLast4 ?? null,
			status: row.status,
			question: row.question ?? null,
			// Um relacionado que já saiu deste aparelho (podado, por exemplo) sobe como
			// nulo: melhor a pergunta sem o ponteiro do que um ponteiro para o nada.
			relatedFingerprint: row.relatedId ? (fingerprintOfLocalId.get(row.relatedId) ?? null) : null,
			suggestedCategory: row.suggestedCategory ?? null,
			transactionId: row.transactionId ?? null,
			autoConfirmed: Boolean(row.autoConfirmed),
			reason: row.reason ?? null,
			accountId: row.accountId ?? null,
			transferId: row.transferId ?? null,
			installments: row.installments ?? null,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
			deletedAt: row.deletedAt,
		})),
		merchantRules: merchantRules.map((row) => ({
			// A identidade é a própria chave do estabelecimento.
			id: row.merchantKey,
			categoryId: row.categoryId ?? null,
			treatAs: row.treatAs,
			confirmations: row.confirmations,
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
			feeCents: row.feeCents ?? 0,
			adminFeeBp: row.adminFeeBp ?? null,
			accountId: row.accountId ?? null,
			category: row.category ?? null,
			archived: Boolean(row.archived),
			sortOrder: row.sortOrder,
			updatedAt: row.updatedAt,
			deletedAt: row.deletedAt,
		})),
		bills: bills.map((row) => ({
			id: row.id,
			name: row.name,
			dueDay: row.dueDay,
			amountCents: row.amountCents ?? null,
			accountId: row.accountId ?? null,
			category: row.category ?? null,
			matchHint: row.matchHint ?? null,
			debtId: row.debtId ?? null,
			paidThrough: row.paidThrough ?? null,
			paidByRef: row.paidByRef ?? null,
			active: Boolean(row.active),
			sortOrder: row.sortOrder,
			updatedAt: row.updatedAt,
			deletedAt: row.deletedAt,
		})),
		// A chave do AsyncStorage viaja como o `id` da linha; `dirty` não sai daqui.
		preferences: preferences.map((row) => ({
			id: row.key,
			value: row.value,
			updatedAt: row.updatedAt,
			deletedAt: row.deletedAt ?? null,
		})),
	};
};

/** O que este aparelho tem, para comparar com a conta antes de decidir o que sobe. */
export interface LocalDataCounts {
	transactions: number;
	recurringTransactions: number;
	budgets: number;
	accounts: number;
	transfers: number;
	debts: number;
	customCategories: number;
	/** Desde que a contagem passou a cobrir todas as coleções do sync. */
	captures: number;
	merchantRules: number;
	retirementGoals: number;
	reserveGoals: number;
	bills: number;
	total: number;
}

/**
 * As linhas vivas deste aparelho que são dados do usuário, em **todas** as coleções do sync.
 *
 * Contava sete tabelas. Um aparelho que só tinha a caixa de entrada, as regras aprendidas,
 * as metas ou as contas a pagar era "vazio", e o login numa conta com histórico seguia sem
 * perguntar — e depois o push mesclava os dois lados em silêncio.
 *
 * Fica de fora o que todo aparelho tem sem o usuário ter feito nada, porque contar isso
 * faria todo login perguntar:
 *  - as categorias padrão, semeadas na abertura (`seedMissingDefaultCategories`);
 *  - as preferências: o CDI chega sozinho do Banco Central, e moeda e idioma juntam chave
 *    a chave pelo carimbo, sem nada a escolher entre os dois lados.
 * A instalação nova não cria conta, meta, regra nem conta a pagar sozinha: contas nascem
 * do usuário ou da primeira notificação de banco (que exige o acesso que ele concedeu), e
 * as contas a pagar de dívida (`ensureDebtBills`) só existem com uma dívida, que já conta.
 */
export const countLocalData = async (): Promise<LocalDataCounts> => {
	const defaultIds = DEFAULT_CATEGORIES.map((category) => category.id);
	const placeholders = defaultIds.map(() => '?').join(', ');
	const row = await db.getFirstAsync<Partial<Omit<LocalDataCounts, 'total'>>>(
		`SELECT
       (SELECT COUNT(*) FROM transactions WHERE deletedAt IS NULL) AS transactions,
       (SELECT COUNT(*) FROM recurring_transactions WHERE deletedAt IS NULL) AS recurringTransactions,
       (SELECT COUNT(*) FROM budgets WHERE deletedAt IS NULL) AS budgets,
       (SELECT COUNT(*) FROM accounts WHERE deletedAt IS NULL) AS accounts,
       (SELECT COUNT(*) FROM transfers WHERE deletedAt IS NULL) AS transfers,
       (SELECT COUNT(*) FROM debts WHERE deletedAt IS NULL) AS debts,
       (SELECT COUNT(*) FROM categories WHERE deletedAt IS NULL AND id NOT IN (${placeholders})) AS customCategories,
       (SELECT COUNT(*) FROM captures WHERE deletedAt IS NULL) AS captures,
       (SELECT COUNT(*) FROM merchant_rules WHERE deletedAt IS NULL) AS merchantRules,
       (SELECT COUNT(*) FROM retirement_goals WHERE deletedAt IS NULL) AS retirementGoals,
       (SELECT COUNT(*) FROM reserve_goals WHERE deletedAt IS NULL) AS reserveGoals,
       (SELECT COUNT(*) FROM bills WHERE deletedAt IS NULL) AS bills`,
		defaultIds
	);
	const counts = {
		transactions: row?.transactions ?? 0,
		recurringTransactions: row?.recurringTransactions ?? 0,
		budgets: row?.budgets ?? 0,
		accounts: row?.accounts ?? 0,
		transfers: row?.transfers ?? 0,
		debts: row?.debts ?? 0,
		customCategories: row?.customCategories ?? 0,
		captures: row?.captures ?? 0,
		merchantRules: row?.merchantRules ?? 0,
		retirementGoals: row?.retirementGoals ?? 0,
		reserveGoals: row?.reserveGoals ?? 0,
		bills: row?.bills ?? 0,
	};
	return { ...counts, total: Object.values(counts).reduce((sum, value) => sum + value, 0) };
};

/**
 * Todas as identidades de uma tabela sincronizada, apagadas inclusive.
 *
 * "Identidade" é a do protocolo, não a chave local: em `captures` é o `fingerprint` e em
 * `merchant_rules` é o `merchantKey` (ver `identityColumnOf`). É o que a substituição
 * compara com os ids que vêm do servidor — comparar o id local das capturas faria a
 * substituição apagar da conta exatamente as capturas que este aparelho também tem.
 */
export const getSyncedIds = async (table: SyncedTable): Promise<Set<string>> => {
	const rows = await db.getAllAsync<{ id: string }>(
		`SELECT ${identityColumnOf(table)} AS id FROM ${table}`
	);
	return new Set(rows.map((row) => row.id));
};

/**
 * Regrava todas as linhas sincronizadas com um carimbo e as marca para subir. É o passo
 * de "este aparelho é a verdade": com o carimbo depois de tudo o que a conta tem, cada
 * linha daqui vence a da conta no último-escreve-vence.
 *
 * Inclui a caixa de entrada e as regras desde o v19: "subir deste aparelho" tem de
 * valer para tudo o que o aparelho tem, senão a caixa da conta sobreviveria à
 * substituição e voltaria no pull seguinte.
 */
export const stampEverything = async (timestamp: string): Promise<void> => {
	await runInTransaction(async () => {
		for (const table of SYNCED_TABLES) {
			await db.runAsync(`UPDATE ${table} SET updatedAt = ?, dirty = 1`, [timestamp]);
		}
	});
};

/**
 * Quantas linhas ainda faltam subir, lápides incluídas. Alimenta o indicador de status
 * do sync. Desde o v19 conta também a caixa de entrada e as regras aprendidas.
 */
export const countDirtyRows = async (): Promise<number> => {
	const subqueries = SYNCED_TABLES.map(
		(table) => `(SELECT COUNT(*) FROM ${table} WHERE dirty = 1)`
	).join(' + ');

	const row = await db.getFirstAsync<{ count: number }>(`SELECT ${subqueries} AS count`);
	return row?.count ?? 0;
};

/**
 * Quantas linhas **vivas** ainda não subiram, somando as tabelas sincronizadas.
 *
 * É o número para dizer ao dono o que ainda não está na conta — "32 coisas suas só
 * existem neste aparelho". Difere de `countDirtyRows` de propósito: as lápides sujas
 * também faltam subir, mas anunciá-las como dado em risco seria mentira, porque o que
 * elas carregam é uma remoção, e perdê-las não perde nada que o usuário tenha.
 */
export const countUnsyncedRows = async (): Promise<number> => {
	const subqueries = SYNCED_TABLES.map(
		(table) => `(SELECT COUNT(*) FROM ${table} WHERE dirty = 1 AND deletedAt IS NULL)`
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
 *
 * O `id` de cada linha é o do protocolo, então a comparação é pela coluna de identidade
 * da tabela: `fingerprint` nas capturas, `merchantKey` nas regras.
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
		['reserve_goals', changes.reserveGoals ?? []],
		['captures', changes.captures ?? []],
		['merchant_rules', changes.merchantRules ?? []],
		['bills', changes.bills ?? []],
		['preferences', changes.preferences ?? []],
	];

	await runInTransaction(async () => {
		for (const [table, rows] of byTable) {
			const identity = identityColumnOf(table);
			for (const row of rows) {
				await db.runAsync(
					`UPDATE ${table} SET dirty = 0 WHERE ${identity} = ? AND updatedAt = ?`,
					[row.id, row.updatedAt]
				);
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
		`UPDATE ${table} SET category = 'uncategorized', updatedAt = ${NEXT_STAMP}, dirty = 1 WHERE id = ?`,
		[nowTimestamp(), id]
	);
};

/**
 * As colunas de uma captura que vêm do protocolo, na ordem. Fora da lista ficam as três
 * que não viajam como vêm: `id` (local, nunca sai do aparelho), `fingerprint` (a
 * identidade, que chega como o `id` da linha) e `relatedId` (traduzido do fingerprint do
 * item relacionado, numa segunda passada).
 */
const CAPTURE_SYNC_COLUMNS = [
	'packageName',
	'appLabel',
	'title',
	'text',
	'postedAt',
	'amountCents',
	'direction',
	'kind',
	'counterparty',
	'merchantKey',
	'cardLast4',
	'status',
	'question',
	'suggestedCategory',
	'transactionId',
	'autoConfirmed',
	'reason',
	'accountId',
	'transferId',
	'installments',
	'createdAt',
];

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
			`SELECT updatedAt FROM ${table} WHERE ${identityColumnOf(table)} = ?`,
			[id]
		);
		// Sem linha local a resposta é não: é uma criação, e ela tem que entrar.
		// Timestamps ISO 8601 UTC comparam corretamente como texto.
		return local !== null && local.updatedAt >= updatedAt;
	};

	// Para a regra da conta apagada (SPD-144, no fim da transação): só o que esta leva gravou.
	/** Contas que chegaram com lápide. */
	const accountTombstones = new Set<string>();
	/** Contas de lançamentos e transferências vivos que chegaram. */
	const moneyRefs = new Set<string>();
	/** Contas de contas a pagar, dívidas e capturas pendentes vivas que chegaram. */
	const linkRefs = new Set<string>();

	await runInTransaction(async () => {
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
			if (row.deletedAt) accountTombstones.add(row.id);

			await db.runAsync(
				`INSERT INTO accounts
           (id, name, kind, role, envelopeMonthlyCents, network, bankName, color, last4, closingDay, dueDay,
            closingDaysBefore, creditLimitCents, cardNames, yieldCdiBp, reservePurpose, packageName, accountKey, openingBalanceCents, openingBalanceDate,
            sortOrder, archived, updatedAt, deletedAt, dirty)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT (id) DO UPDATE SET
           name = excluded.name, kind = excluded.kind, role = excluded.role,
           envelopeMonthlyCents = excluded.envelopeMonthlyCents, network = excluded.network,
           bankName = excluded.bankName,
           color = excluded.color, last4 = excluded.last4, closingDay = excluded.closingDay,
           dueDay = excluded.dueDay, closingDaysBefore = excluded.closingDaysBefore,
           creditLimitCents = excluded.creditLimitCents, cardNames = excluded.cardNames, yieldCdiBp = excluded.yieldCdiBp,
           reservePurpose = excluded.reservePurpose, packageName = excluded.packageName, accountKey = excluded.accountKey,
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
					row.yieldCdiBp ?? null,
					row.reservePurpose === 'investment' ? 'investment' : null,
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
			if (!row.deletedAt && row.accountId) moneyRefs.add(row.accountId);

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
			if (!row.deletedAt) {
				if (row.fromAccountId) moneyRefs.add(row.fromAccountId);
				if (row.toAccountId) moneyRefs.add(row.toAccountId);
			}

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

		// A meta da reserva também tem id fixo.
		for (const row of changes.reserveGoals ?? []) {
			if (await isStale('reserve_goals', row.id, row.updatedAt)) continue;

			await db.runAsync(
				`INSERT INTO reserve_goals (id, targetMonths, customMonthlyCostCents, updatedAt, deletedAt, dirty)
         VALUES (?, ?, ?, ?, ?, 0)
         ON CONFLICT (id) DO UPDATE SET
           targetMonths = excluded.targetMonths, customMonthlyCostCents = excluded.customMonthlyCostCents,
           updatedAt = excluded.updatedAt, deletedAt = excluded.deletedAt, dirty = 0`,
				[row.id, row.targetMonths, row.customMonthlyCostCents ?? null, row.updatedAt, row.deletedAt]
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
			if (!row.deletedAt && row.accountId) linkRefs.add(row.accountId);

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
				row.feeCents ?? 0,
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

		// Contas a pagar (v20), depois das dívidas a que elas se ligam pela `debtId`.
		for (const row of changes.bills ?? []) {
			if (await isStale('bills', row.id, row.updatedAt)) continue;
			if (!row.deletedAt && row.accountId) linkRefs.add(row.accountId);

			const values = [
				row.name,
				row.dueDay,
				row.amountCents ?? null,
				row.accountId ?? null,
				row.category ?? null,
				row.matchHint ?? null,
				row.debtId ?? null,
				row.paidThrough ?? null,
				row.paidByRef ?? null,
				row.active ? 1 : 0,
				row.sortOrder ?? 0,
			];
			await db.runAsync(
				`INSERT INTO bills (id, ${BILL_COLUMNS.join(', ')}, updatedAt, deletedAt, dirty)
         VALUES (?, ${BILL_COLUMNS.map(() => '?').join(', ')}, ?, ?, 0)
         ON CONFLICT (id) DO UPDATE SET
           ${BILL_COLUMNS.map((column) => `${column} = excluded.${column}`).join(', ')},
           updatedAt = excluded.updatedAt, deletedAt = excluded.deletedAt, dirty = 0`,
				[row.id, ...values, row.updatedAt, row.deletedAt ?? null]
			);
		}

		/**
		 * As preferências (v21). Duas diferenças das outras coleções:
		 *
		 * - **o empate**: com a linha daqui já enviada (`dirty = 0`), o empate fica com o
		 *   servidor. Dois aparelhos que descobriram a mesma chave com o carimbo de semente
		 *   sobem carimbos iguais, e o servidor guarda o último a chegar (o empate dele é de
		 *   quem envia); sem esta regra o primeiro ficaria com o valor dele para sempre. Com
		 *   a linha daqui ainda por subir, o empate continua sendo daqui, como no resto;
		 * - **o espelho**: quem lê a moeda e o idioma lê do AsyncStorage, então a versão
		 *   vencedora vai para lá **antes** da tabela. Na ordem inversa, morrer entre as duas
		 *   gravações deixaria a tabela nova e o AsyncStorage velho — e a reconciliação
		 *   seguinte tomaria o valor velho por uma escolha nova e o subiria por cima da
		 *   conta. Nesta ordem, o pior caso é ela subir de volta o mesmo valor que chegou.
		 *
		 * Só as chaves de `SYNCED_PREFERENCE_KEYS` chegam ao AsyncStorage: a linha vem da
		 * rede, e escrever qualquer chave seria deixar o servidor mandar no estado do app —
		 * a biometria mora ali. As outras ficam só na tabela, para "subir deste aparelho" não
		 * apagar da conta o que uma versão mais nova do app gravou lá.
		 */
		for (const row of changes.preferences ?? []) {
			const local = await db.getFirstAsync<{ updatedAt: string; dirty: number }>(
				'SELECT updatedAt, dirty FROM preferences WHERE key = ?',
				[row.id]
			);
			if (local && (local.updatedAt > row.updatedAt || (local.updatedAt === row.updatedAt && local.dirty === 1))) continue;

			if (isMirroredPreference(row.id)) {
				if (row.deletedAt) await AsyncStorage.removeItem(row.id);
				else await AsyncStorage.setItem(row.id, row.value);
			}

			await db.runAsync(
				`INSERT INTO preferences (key, value, updatedAt, deletedAt, dirty)
         VALUES (?, ?, ?, ?, 0)
         ON CONFLICT (key) DO UPDATE SET
           value = excluded.value, updatedAt = excluded.updatedAt,
           deletedAt = excluded.deletedAt, dirty = 0`,
				[row.id, row.value, row.updatedAt, row.deletedAt ?? null]
			);
		}

		// As regras aprendidas: a identidade é a própria `merchantKey`, então o upsert é o
		// merge inteiro — duas aprendizagens do mesmo estabelecimento convergem por
		// `updatedAt`, sem conflito de id.
		for (const row of changes.merchantRules ?? []) {
			if (await isStale('merchant_rules', row.id, row.updatedAt)) continue;

			await db.runAsync(
				`INSERT INTO merchant_rules (merchantKey, categoryId, treatAs, confirmations, updatedAt, deletedAt, dirty)
         VALUES (?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT (merchantKey) DO UPDATE SET
           categoryId = excluded.categoryId, treatAs = excluded.treatAs,
           confirmations = excluded.confirmations, updatedAt = excluded.updatedAt,
           deletedAt = excluded.deletedAt, dirty = 0`,
				[row.id, row.categoryId ?? null, row.treatAs, row.confirmations, row.updatedAt, row.deletedAt ?? null]
			);
		}

		/**
		 * A caixa de entrada, em **duas passadas**.
		 *
		 * O `id` que chega é o fingerprint, e a linha local pode já existir com outro id
		 * local (o mesmo aviso capturado nos dois aparelhos): casa-se pelo fingerprint e
		 * mantém-se o id daqui, porque é ele que o histórico, o "reverter" e o `relatedId`
		 * de outras capturas apontam. A segunda passada traduz os ponteiros entre itens,
		 * depois de todas as linhas existirem: um item e a duplicata dele podem vir na
		 * mesma página em qualquer ordem, e resolver na mesma passada daria resultado
		 * diferente conforme a ordem em que o servidor mandou.
		 */
		const localIdOf = new Map<string, string>();
		/** Só os fingerprints que esta leva realmente gravou: ver a segunda passada. */
		const written = new Set<string>();
		for (const row of changes.captures ?? []) {
			const local = await db.getFirstAsync<{ id: string; updatedAt: string }>(
				'SELECT id, updatedAt FROM captures WHERE fingerprint = ?',
				[row.id]
			);
			const localId = local?.id ?? generateUniqueId();
			// O mapa guarda a tradução mesmo da linha que não foi gravada: ela pode ser o
			// **relacionado** de outra, e nesse caso a tradução continua valendo.
			localIdOf.set(row.id, localId);
			// Sem linha local é criação, e ela entra. Com linha local, o empate fica com o
			// daqui, que pode ter decisão ainda não enviada.
			if (local && local.updatedAt >= row.updatedAt) continue;
			written.add(row.id);
			if (!row.deletedAt && row.status === 'pending' && row.accountId) linkRefs.add(row.accountId);

			const values = [
				row.packageName,
				row.appLabel,
				row.title,
				row.text,
				row.postedAt,
				row.amountCents,
				row.direction,
				row.kind,
				row.counterparty ?? null,
				row.merchantKey ?? null,
				row.cardLast4 ?? null,
				row.status,
				row.question ?? null,
				row.suggestedCategory ?? null,
				row.transactionId ?? null,
				row.autoConfirmed ? 1 : 0,
				row.reason ?? null,
				row.accountId ?? null,
				row.transferId ?? null,
				row.installments ?? null,
				row.createdAt,
			];
			// `relatedId` entra nulo e é resolvido na passada seguinte.
			await db.runAsync(
				`INSERT INTO captures (id, fingerprint, ${CAPTURE_SYNC_COLUMNS.join(', ')}, relatedId, updatedAt, deletedAt, dirty)
         VALUES (?, ?, ${CAPTURE_SYNC_COLUMNS.map(() => '?').join(', ')}, NULL, ?, ?, 0)
         ON CONFLICT (fingerprint) DO UPDATE SET
           ${CAPTURE_SYNC_COLUMNS.map((column) => `${column} = excluded.${column}`).join(', ')},
           relatedId = NULL, updatedAt = excluded.updatedAt, deletedAt = excluded.deletedAt, dirty = 0`,
				[localId, row.id, ...values, row.updatedAt, row.deletedAt ?? null]
			);
		}

		for (const row of changes.captures ?? []) {
			if (!row.relatedFingerprint) continue;
			// A linha que perdeu no último-escreve-vence não é tocada aqui tampouco: o
			// ponteiro que vale é o da versão local, que é a mais nova.
			if (!written.has(row.id)) continue;
			const localId = localIdOf.get(row.id);
			if (!localId) continue;

			let relatedLocalId = localIdOf.get(row.relatedFingerprint) ?? null;
			if (!relatedLocalId) {
				const related = await db.getFirstAsync<{ id: string }>(
					'SELECT id FROM captures WHERE fingerprint = ?',
					[row.relatedFingerprint]
				);
				relatedLocalId = related?.id ?? null;
			}

			// O relacionado não existe deste lado: o aviso que ele compara nunca passou por
			// aqui (o outro aparelho capturou de um app que este não tem, ou a captura já foi
			// podada). O ponteiro fica nulo e **a pergunta cai** — "é duplicata daquela?" sem
			// a "daquela" é uma pergunta impossível de responder, e a tela mostraria um item
			// a comparar com nada. O item continua no status que o servidor mandou: pendente
			// segue pendente, para o usuário decidir sozinho.
			await db.runAsync(
				`UPDATE captures SET relatedId = ?, question = CASE WHEN ? IS NULL THEN NULL ELSE question END
         WHERE id = ?`,
				[relatedLocalId, relatedLocalId, localId]
			);
		}

		await settleDeadAccountRefs(accountTombstones, moneyRefs, linkRefs);
	});
};

/**
 * A conta apagada num aparelho e usada em outro (SPD-144), resolvida no pull.
 *
 * - Lançamento ou transferência viva que chegou apontando para uma conta apagada: a conta
 *   volta **encerrada** (sem lápide, `archived = 1`, carimbo depois da lápide, suja). O
 *   dinheiro não some — fica fora dos totais de hoje, como a conta encerrada fica, e o
 *   histórico o vê. O outro aparelho recebe a conta de volta no próximo pull.
 * - Lápide de conta que chegou enquanto aqui há lançamento ou transferência **ainda não
 *   enviado** (`dirty`) nela: a mesma coisa. Só o sujo conta: o app antigo, ao apagar uma
 *   conta, deixava os lançamentos "sem conta" no servidor, e essa mudança pode vir numa
 *   página depois da lápide — o lançamento já enviado que ainda aponta para ela aqui vai
 *   chegar sem conta e não deve ressuscitar nada.
 * - Conta a pagar, dívida ou captura pendente que chegou apontando para conta apagada, e o
 *   que aqui aponta para uma conta cuja lápide chegou: ficam sem conta (sujas), nunca com
 *   um id morto.
 *
 * Captura não ressuscita conta: as confirmadas antigas apontam para contas que o app antigo
 * apagou, e um pull completo traria todas de volta.
 */
const settleDeadAccountRefs = async (accountTombstones: Set<string>, moneyRefs: Set<string>, linkRefs: Set<string>): Promise<void> => {
	if (accountTombstones.size === 0 && moneyRefs.size === 0 && linkRefs.size === 0) return;
	const timestamp = nowTimestamp();
	const revive = new Set(moneyRefs);
	for (const id of accountTombstones) {
		const pending = await db.getFirstAsync<{ n: number }>(
			`SELECT (SELECT COUNT(*) FROM transactions WHERE accountId = ? AND deletedAt IS NULL AND dirty = 1)
            + (SELECT COUNT(*) FROM transfers WHERE (fromAccountId = ? OR toAccountId = ?) AND deletedAt IS NULL AND dirty = 1) AS n`,
			[id, id, id]
		);
		if ((pending?.n ?? 0) > 0) revive.add(id);
	}
	await reviveAccountsWithMoney(revive, timestamp);
	await unlinkDeadAccounts(timestamp, [...linkRefs, ...accountTombstones]);
};

// ---------------------------------------------------------------------------
// Preferências (v21)
// ---------------------------------------------------------------------------

const UPSERT_DIRTY_PREFERENCE = `INSERT INTO preferences (key, value, updatedAt, deletedAt, dirty)
     VALUES (?, ?, ?, ?, 1)
     ON CONFLICT (key) DO UPDATE SET
       value = excluded.value, updatedAt = excluded.updatedAt,
       deletedAt = excluded.deletedAt, dirty = 1`;

/**
 * Grava uma preferência escolhida agora: no AsyncStorage, que é de onde as telas leem, e
 * na tabela, suja e carimbada, para subir. `null` apaga — sai do AsyncStorage e vira
 * lápide com o último valor.
 *
 * O AsyncStorage vem primeiro e é o que pode falhar para quem chama: a escolha tem de valer
 * aqui mesmo sem banco. A tabela é o sync, e falhar nela só atrasa a subida — a
 * reconciliação do próximo push encontra a diferença e marca a linha.
 *
 * Chave que não viaja (`SYNCED_PREFERENCE_KEYS`) vai só para o AsyncStorage.
 */
export const setPreference = async (key: string, value: string | null): Promise<void> => {
	if (value === null) await AsyncStorage.removeItem(key);
	else await AsyncStorage.setItem(key, value);

	if (!SYNCED_PREFERENCE_KEYS.includes(key)) return;

	try {
		const current = await db.getFirstAsync<{ value: string; updatedAt: string }>(
			'SELECT value, updatedAt FROM preferences WHERE key = ?',
			[key]
		);
		if (value === null && !current) return;

		const stamp = nextStamp(current?.updatedAt, nowTimestamp());
		await db.runAsync(UPSERT_DIRTY_PREFERENCE, [
			key,
			value ?? (current as { value: string }).value,
			stamp,
			value === null ? stamp : null,
		]);
	} catch (error) {
		console.warn(`Preferências: ${key} gravada, mas não marcada para subir:`, error);
	}
};

/**
 * Passa para a tabela o que mudou no AsyncStorage sem passar por `setPreference` — o CDI
 * que o app buscou, um aviso dispensado, o liga/desliga dos lembretes, um backup
 * importado — e o que já estava lá antes do v21. Roda antes de cada push e antes de
 * "subir deste aparelho". O que gravar é decidido em `planPreferenceReconcile`.
 *
 * Devolve quantas linhas ficaram sujas.
 */
export const reconcilePreferences = async (): Promise<number> => {
	const [rows, pairs] = await Promise.all([
		db.getAllAsync<PreferenceDB>('SELECT key, value, updatedAt, deletedAt FROM preferences'),
		AsyncStorage.multiGet([...SYNCED_PREFERENCE_KEYS]),
	]);

	const stored: Record<string, string | null> = {};
	for (const [key, value] of pairs) stored[key] = value;

	const current: PreferenceRow[] = rows.map((row) => ({
		key: row.key,
		value: row.value,
		updatedAt: row.updatedAt,
		deletedAt: row.deletedAt ?? null,
	}));
	const writes = planPreferenceReconcile(current, stored, nowTimestamp());
	if (writes.length === 0) return 0;

	await runInTransaction(async () => {
		for (const write of writes) {
			await db.runAsync(UPSERT_DIRTY_PREFERENCE, [write.key, write.value, write.updatedAt, write.deletedAt]);
		}
	});

	return writes.length;
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
 *
 * Desde o v19 isto inclui `captures` e `merchant_rules` — vem de `SYNCED_TABLES`, de
 * propósito. Sem elas, "juntar" no login subia o livro-caixa e deixava a caixa de entrada
 * para trás: exatamente as compras que esperavam revisão, que são as que não existem em
 * nenhum outro lugar.
 */
export const markEverythingDirty = async (): Promise<void> => {
	await runInTransaction(async () => {
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
 *
 * A caixa de entrada e as regras aprendidas vão com o resto (vêm de `SYNCED_TABLES`):
 * quem escolhe "usar os dados da conta" está dizendo que o rascunho deste aparelho não
 * vale, e deixá-lo aqui o faria subir depois como se fosse da conta. O pull seguinte
 * traz a caixa de entrada da conta. A fila nativa já foi esvaziada, então apagar os
 * fingerprints não faz nenhum aviso ser interpretado duas vezes.
 */
export const clearSyncedData = async (): Promise<void> => {
	await runInTransaction(async () => {
		for (const table of SYNCED_TABLES) {
			await db.runAsync(`DELETE FROM ${table}`);
		}
	});
};

/**
 * Apaga o livro inteiro com lápides: o primeiro passo da importação de um backup. O
 * "Apagar todos os dados" das Configurações usava esta mesma função até o SPD-082 e hoje
 * tem a sua (`wipeLocalData`), que apaga de verdade; a importação ficou como estava.
 *
 * As **categorias ficam**, de propósito. Elas não são dinheiro, e a importação regrava
 * em cima das que já existem (mesmo id) — apagá-las antes deixaria todo lançamento do
 * próprio backup apontando para id inexistente. O preço conhecido é o do achado 6.6: as
 * categorias que só o aparelho tinha continuam na lista depois de importar.
 *
 * As **regras aprendidas também ficam**, pelo mesmo motivo: não são dinheiro, são hábito
 * ("o iFood é alimentação"), e a importação as regrava por `merchantKey`. Apagar o
 * aprendizado faria o app voltar a perguntar o que já estava respondido, sem que ninguém
 * tenha pedido isso ao mandar apagar os lançamentos.
 *
 * A **caixa de entrada ganha lápide**, e isto é novo no v19. Antes as capturas eram
 * locais e sobreviviam ao reset com os ponteiros consertados; agora elas sincronizam, e
 * uma caixa de entrada viva depois de "apagar meus dados" significaria que a compra
 * pendente continua na conta e volta no próximo pull — ou pior, reaparece em outro
 * aparelho. A lápide é suja, para a remoção subir.
 */
export const resetDatabase = async (): Promise<void> => {
	const timestamp = nowTimestamp();

	try {
		// Tombstones rather than DELETE: if the device is signed in, "erase my data" has
		// to reach the profile too, and a plain delete would be undone by the next pull.
		await runInTransaction(async () => {
			for (const table of ['transactions', 'recurring_transactions', 'budgets', 'transfers', 'accounts', 'retirement_goals', 'debts', 'reserve_goals', 'bills']) {
				await db.runAsync(
					`UPDATE ${table} SET deletedAt = ?, updatedAt = ${NEXT_STAMP}, dirty = 1 WHERE deletedAt IS NULL`,
					[timestamp, timestamp]
				);
			}

			// As capturas apontam para o livro: uma captura confirmada guarda o
			// `transactionId` que ela criou, e a de troca de bolso, o `transferId`. Depois
			// das lápides acima, esses ponteiros apontam todos para linha apagada — o
			// histórico anunciava compras que o app não tinha mais, e o "reverter" tentava
			// apagar o que já não existia. Elas saem do jogo com o motivo registrado antes
			// de receberem a própria lápide: a linha continua no disco, e o texto cru e o
			// `fingerprint` com ela — é o que impede a mesma notificação de virar dinheiro
			// duas vezes se ela voltar a ser capturada.
			await db.runAsync(
				`UPDATE captures
         SET status = 'ignored', reason = 'data_reset', transactionId = NULL, transferId = NULL,
             question = NULL, updatedAt = ${NEXT_STAMP}, dirty = 1
         WHERE deletedAt IS NULL AND (transactionId IS NOT NULL OR transferId IS NOT NULL)`,
				[timestamp]
			);

			// Capturas pendentes não apontam para o livro, mas a pergunta que elas fazem
			// ("é duplicata daquela?") compara com itens que acabaram de perder o
			// lançamento. A pergunta cai; o item continua pendente, para o usuário decidir.
			await db.runAsync(
				`UPDATE captures SET question = NULL, relatedId = NULL, updatedAt = ${NEXT_STAMP}, dirty = 1
         WHERE deletedAt IS NULL AND status = 'pending' AND question IS NOT NULL`,
				[timestamp]
			);

			// E a caixa de entrada inteira ganha lápide: "apagar meus dados" tem de valer
			// para a compra que estava esperando revisão também, e a lápide é o que faz a
			// remoção chegar à conta e aos outros aparelhos em vez de voltar no pull.
			await db.runAsync(
				`UPDATE captures SET deletedAt = ?, updatedAt = ${NEXT_STAMP}, dirty = 1 WHERE deletedAt IS NULL`,
				[timestamp, timestamp]
			);
		});

		console.log('Database reset successfully');
	} catch (error) {
		console.error('Error resetting database:', error);
		throw error;
	}
};

/**
 * O que o "Apagar todos os dados" apaga, linha por linha, lápides inclusive (SPD-082,
 * DEC-35): o dinheiro e tudo o que aponta para ele — lançamentos, recorrências,
 * orçamentos, transferências, contas e cartões, metas, dívidas, contas a pagar e a caixa
 * de entrada.
 */
export const WIPE_DELETED_TABLES = [
	'transactions',
	'recurring_transactions',
	'budgets',
	'transfers',
	'accounts',
	'retirement_goals',
	'debts',
	'reserve_goals',
	'bills',
	'captures',
] as const satisfies readonly SyncedTable[];

/**
 * O que ele mantém:
 *
 * - `categories`: as regras aprendidas apontam para elas, e não são dinheiro.
 * - `merchant_rules`: o que o app aprendeu por estabelecimento ("o iFood é alimentação",
 *   "ignorar o WhatsApp"). O DEC-35 manda guardar.
 * - `preferences`: a configuração (moeda, idioma, CDI, lembretes, avisos dispensados).
 *   Só saem as chaves presas a contas, ver `ACCOUNT_TIED_PREFERENCE_KEYS`.
 *
 * Toda tabela de `SYNCED_TABLES` está numa das duas listas — o teste confere, para uma
 * tabela nova não ficar de fora calada. Fora delas: `sync_state` (o cursor e a marca do
 * apagar, que este apagar grava) e `seen_capture_fingerprints` (que ele alimenta).
 */
export const WIPE_KEPT_TABLES = [
	'categories',
	'merchant_rules',
	'preferences',
] as const satisfies readonly SyncedTable[];

/**
 * As preferências que apontam para contas que deixam de existir: os pares "são contas
 * diferentes", qual conta recebe os avisos da PJ de cada banco e as escolhas aprendidas nos
 * avisos ambíguos (SPD-123), que guardam o id da conta ou do cartão escolhido (SPD-132). Com
 * conta, o servidor já apagou as duas primeiras junto (SPD-080); sem conta, não há para onde
 * propagar.
 */
const ACCOUNT_TIED_PREFERENCE_KEYS = [
	STORAGE_KEYS.distinctAccountPairs,
	STORAGE_KEYS.businessFeeds,
	STORAGE_KEYS.captureChoices,
];

export interface LocalWipeOptions {
	/**
	 * Impressões digitais de avisos que nunca viraram captura — os que estavam na fila
	 * nativa e foram descartados. Ficam conhecidas como as das capturas apagadas.
	 */
	seenFingerprints?: readonly string[];
	/**
	 * O `dataWipedAt` que o servidor devolveu, gravado como o apagar que este aparelho
	 * conhece (`KNOWN_WIPE_AT_KEY`). Ausente sem conta: não há apagar da conta a conhecer.
	 */
	knownWipeAt?: string;
}

/**
 * "Apagar todos os dados" neste aparelho (SPD-082, DEC-35): DELETE de verdade, numa
 * transação só.
 *
 * Nada de lápide. O "apagar" antigo (`resetDatabase`) punha lápide suja em tudo para a
 * remoção subir — e o conteúdo ficava para sempre, aqui e no servidor; com o relógio do
 * aparelho atrasado o servidor recusava as lápides e o pull seguinte ressuscitava tudo.
 * Agora, com conta, quem apaga na conta é o servidor (`/me/wipe`), antes daqui; sem
 * conta, não há para onde propagar. Em nenhum dos casos sobra linha suja para subir.
 *
 * Da caixa de entrada sobra só a impressão digital de cada aviso
 * (`seen_capture_fingerprints`), sem texto nem valor: é o que impede o mesmo aviso de virar
 * dinheiro de novo quando o Android o reentrega. As linhas de extrato (`ofx:`) não ficam:
 * a impressão delas leva o id da conta, que foi apagada junto, e reimportar o extrato é o
 * caminho de quem quer o mês de volta.
 *
 * A marca do apagar (`knownWipeAt`) entra na mesma transação: apagar sem a marca faria o
 * próximo push ser recusado, e a marca sem apagar subiria o que devia ter sumido.
 *
 * O AsyncStorage vem depois da transação (ele não participa dela): saem as chaves
 * presas a contas e a cópia antiga dos orçamentos que a migração v4 deixou para trás.
 *
 * Usada pelo fluxo das Configurações (`utils/dataWipe.ts`) e, no SPD-083, quando outro
 * aparelho apagou a conta.
 */
export const wipeLocalData = async (options: LocalWipeOptions = {}): Promise<void> => {
	const timestamp = nowTimestamp();

	await runInTransaction(async () => {
		await db.runAsync(
			`INSERT OR IGNORE INTO seen_capture_fingerprints (fingerprint, seenAt)
       SELECT fingerprint, ? FROM captures WHERE fingerprint NOT LIKE 'ofx:%'`,
			[timestamp]
		);
		for (const fingerprint of options.seenFingerprints ?? []) {
			await db.runAsync(
				'INSERT OR IGNORE INTO seen_capture_fingerprints (fingerprint, seenAt) VALUES (?, ?)',
				[fingerprint, timestamp]
			);
		}

		for (const table of WIPE_DELETED_TABLES) {
			await db.runAsync(`DELETE FROM ${table}`);
		}

		// DELETE, não lápide: com conta o servidor já as apagou, sem conta não há para onde
		// a lápide ir. Uma lápide aqui subiria no próximo push à toa.
		await db.runAsync(
			`DELETE FROM preferences WHERE key IN (${ACCOUNT_TIED_PREFERENCE_KEYS.map(() => '?').join(', ')})`,
			ACCOUNT_TIED_PREFERENCE_KEYS
		);

		if (options.knownWipeAt !== undefined) {
			await db.runAsync(
				'INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
				[KNOWN_WIPE_AT_KEY, options.knownWipeAt]
			);
		}
	});

	// Sem as linhas na tabela e sem a chave aqui, a reconciliação das preferências não tem
	// diferença a anotar: nada vira lápide no próximo push.
	await AsyncStorage.multiRemove([...ACCOUNT_TIED_PREFERENCE_KEYS, STORAGE_KEYS.budgets]);

	console.log('Local data wiped');
};

export default {
	initDatabase,
	runInTransaction,
	getDebts,
	addDebt,
	updateDebt,
	deleteDebt,
	getBills,
	addBill,
	updateBill,
	deleteBill,
	restoreBill,
	ensureDebtBills,
	countLocalData,
	getSyncedIds,
	stampEverything,
	getMonthlyAccountActivity,
	getMonthlyTransferActivity,
	getMonthlyCategoryTotals,
	getTransactionsForAccounts,
	getRetirementGoal,
	setRetirementGoal,
	clearRetirementGoal,
	getReserveGoal,
	setReserveGoal,
	getCategories,
	getCategoriesForBackup,
	getCategoriesByType,
	addCategory,
	restoreCategory,
	updateCategory,
	renameDefaultCategories,
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
	getAccountContents,
	retireMergedAccount,
	repairDeadAccountLinks,
	getAccountActivity,
	getAccountBalances,
	getUnassignedNet,
	getUnassignedPeriodSummary,
	getCardPurchasesOriginated,
	assignUnassignedTransactions,
	assignUnassignedToAccount,
	countUnassignedOnOrBeforeAnchor,
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
	countUnsyncedRows,
	repairPhantomAppAccounts,
	markChangesClean,
	hasCategory,
	markCategoryDirty,
	reassignToUncategorized,
	applyPulledChanges,
	setPreference,
	reconcilePreferences,
	getSyncState,
	setSyncState,
	clearSyncState,
	markEverythingDirty,
	clearSyncedData,
	hasFinancialData,
	convertAllAmounts,
	resetDatabase,
	wipeLocalData,
};
