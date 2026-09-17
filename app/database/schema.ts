export type CategoryType = 'expense' | 'income';

/**
 * Se a despesa é um custo de viver ou uma escolha.
 *
 * É a única informação que o livro-caixa não consegue derivar sozinho, e é o que separa
 * "gastei R$ 4.000" de "R$ 2.500 eu tinha que gastar e R$ 1.500 eu escolhi" — a base do
 * 50/30/20 (`needsWantsSavingsSplit` em `app/utils/metrics.ts`).
 *
 * Só faz sentido em categorias de despesa; nas de receita a coluna existe por uniformidade
 * e nunca é lida. O padrão é `discretionary` de propósito: classificar um gasto como
 * essencial é uma afirmação do usuário, e assumi-la por ele inflaria as "necessidades" de
 * quem nunca abriu a tela.
 */
export type CategoryNature = 'essential' | 'discretionary';

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
	/** Necessidade ou desejo. Lida apenas quando `type` é `expense`. */
	nature: CategoryNature;
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
	/** A conta ou cartão de onde saiu (ou entrou). Nulo em lançamentos antigos ou sem origem. */
	accountId: string | null;
	/**
	 * Parcela de uma compra parcelada: todas as parcelas compartilham `installmentGroup`,
	 * `installmentIndex` vai de 1 a `installmentCount`. Nulos numa compra à vista.
	 */
	installmentGroup: string | null;
	installmentIndex: number | null;
	installmentCount: number | null;
	/**
	 * Final do cartão que fez a compra (físico ou virtual, crédito ou débito). A fatura é da
	 * conta; o cartão é para saber quem gastou. Nulo quando não se sabe.
	 */
	cardLast4: string | null;
}

export type AccountKind = 'checking' | 'savings' | 'investment' | 'cash' | 'credit_card';

/**
 * O papel da conta na sua vida financeira — é o que decide como o mês é calculado.
 *
 * - `main`: onde a renda cai. Pix e débito saindo daqui são gastos do mês.
 * - `card`: compras contam no mês da compra, parcela a parcela; pagar a fatura é
 *   transferência, não gasto.
 * - `envelope`: conta de gastos com valor fixo por mês. O que se manda para ela é o
 *   gasto do mês; o que acontece lá dentro é detalhe e não soma de novo. A sobra fica
 *   na conta como recompensa.
 * - `reserve`: dinheiro guardado. O que entra é poupança, não gasto; rendimento é
 *   receita de investimento.
 * - `external`: uma conta que o app conhece mas não acompanha (a PJ, por exemplo):
 *   o que ela manda para a principal é receita.
 */
export type AccountRole = 'main' | 'card' | 'envelope' | 'reserve' | 'external';

/** O papel que uma conta nova recebe pelo tipo, até o usuário dizer o contrário. */
export const defaultRoleFor = (kind: AccountKind): AccountRole => {
	if (kind === 'credit_card') return 'card';
	if (kind === 'savings' || kind === 'investment') return 'reserve';
	return 'main';
};

/**
 * Uma conta ou cartão. É o que dá saldo por conta e fatura por cartão na tela inicial.
 *
 * O saldo é calculado, nunca guardado: `openingBalanceCents` é o saldo **no fim de**
 * `openingBalanceDate` (a âncora), e tudo datado depois soma ou subtrai. Ajustar o
 * saldo é mover a âncora, não reescrever lançamentos. Num cartão o saldo é negativo
 * quando há fatura em aberto — a mesma fórmula serve, só a leitura muda.
 *
 * `packageName` e `last4` ligam a conta às notificações (app do banco + final do
 * cartão); `accountKey` liga ao extrato OFX (`banco:conta`). Contas são criadas
 * sozinhas na primeira notificação ou import de cada origem.
 */
export interface Account extends SyncMeta {
	id: string;
	name: string;
	kind: AccountKind;
	role: AccountRole;
	/** Quanto entra por mês num envelope, para a barra "gastou X de Y". Só `envelope`. */
	envelopeMonthlyCents: number | null;
	bankName: string | null;
	color: string;
	last4: string | null;
	/** Bandeira do cartão (`visa`, `mastercard`, `elo`, `amex`, `hipercard`). Só cartões. */
	network: string | null;
	/** Dia do mês em que a fatura fecha. Define o ciclo e o nome da fatura. Só cartões. */
	closingDay: number | null;
	/** Informativo: dia do mês em que costuma vencer (fechamento + N). O ciclo não usa. */
	dueDay: number | null;
	/**
	 * Dias entre o fechamento e o vencimento (Nubank: 7). O vencimento real é o fechamento
	 * mais isso, no próximo dia útil. Só cartões.
	 */
	closingDaysBefore: number | null;
	creditLimitCents: number | null;
	/**
	 * Nomes dos cartões desta conta, por final, em JSON (`{"6422": "iFood/99"}`). Numa conta
	 * de crédito são os cartões físico e virtuais que caem na mesma fatura; numa conta
	 * corrente, os cartões de débito. Ler e gravar por `utils/cardNames.ts`.
	 */
	cardNames: string | null;
	packageName: string | null;
	accountKey: string | null;
	openingBalanceCents: number;
	openingBalanceDate: string;
	sortOrder: number;
	archived: boolean;
}

/**
 * Dinheiro trocando de bolso: entre duas contas suas, ou entre uma conta sua e uma
 * que o app não acompanha (`null` de um dos lados). Nunca é receita nem despesa, por
 * isso vive fora de `transactions` — relatórios, exportação e listas não mudam.
 * Pagar a fatura do cartão é uma transferência da conta para o cartão.
 */
export interface Transfer extends SyncMeta {
	id: string;
	fromAccountId: string | null;
	toAccountId: string | null;
	amountCents: number;
	/** `YYYY-MM-DD`. */
	date: string;
	note: string;
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
 * 5 — categories gain `nature`, so expenses split into needs and wants.
 * 6 — `captures` and `merchant_rules` are created: the review inbox for bank
 *     notifications and what the app has learned about each merchant.
 * 7 — `accounts` and `transfers` are created; transactions gain `accountId` and the
 *     installment columns; captures gain `accountId` and `transferId`.
 * 8 — accounts gain `role` (how the month is computed) and `envelopeMonthlyCents`.
 * 9 — accounts gain `network` (card brand); cards are normalised so a card is always
 *     `kind = credit_card` and `role = card`, and nothing else is.
 * 10 — accounts gain `closingDaysBefore`: the card cycle comes from the due day (moved
 *     to the next business day) minus that many days, instead of a fixed closing day.
 * 11 — the cycle is anchored on the closing day again (the bank's invoice is named by
 *     the month it closes in); `closingDaysBefore` is the gap to the due date. Cards
 *     saved with only a due day get the closing day derived from it.
 * 12 — no column changes: card purchases filed by the old notification rules (one card
 *     per virtual card number, "Compra aprovada" on the checking account) are moved to
 *     the real card.
 * 13 — transactions gain `cardLast4` (which physical/virtual/debit card made the purchase,
 *     backfilled from captures); accounts gain `cardNames`. A "card" whose name says
 *     debit becomes a debit card of its bank's checking account.
 */
export const SCHEMA_VERSION = 13;

/** Tables that take part in the delta sync, in foreign-key-safe order. */
export const SYNCED_TABLES = [
	'categories',
	'accounts',
	'transactions',
	'recurring_transactions',
	'budgets',
	'transfers',
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
    nature TEXT NOT NULL DEFAULT 'discretionary',
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

/**
 * Which default expense categories start out as `essential`.
 *
 * These are the buckets nobody opts into — you eat, you get to work, you keep the lights
 * on, you treat what hurts, you pay the school. Everything else starts discretionary and
 * the user promotes it by hand. The list is read both when seeding a fresh install and by
 * the v4 -> v5 migration, so an existing database and a new one classify identically.
 */
export const ESSENTIAL_DEFAULT_CATEGORY_IDS = [
	'food',
	'transport',
	'utilities',
	'health',
	'education',
];

export const CREATE_TRANSACTIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY NOT NULL,
    amountCents INTEGER NOT NULL,
    category TEXT NOT NULL,
    date TEXT NOT NULL,
    note TEXT,
    isIncome INTEGER NOT NULL DEFAULT 0,
    accountId TEXT,
    installmentGroup TEXT,
    installmentIndex INTEGER,
    installmentCount INTEGER,
    cardLast4 TEXT,
${SYNC_COLUMNS_SQL},
    FOREIGN KEY (category) REFERENCES categories (id)
  );
`;

/** Colunas que o v7 acrescenta em `transactions`; a migração adiciona uma a uma. */
export const TRANSACTION_V7_COLUMNS: Array<[name: string, sql: string]> = [
	['accountId', 'TEXT'],
	['installmentGroup', 'TEXT'],
	['installmentIndex', 'INTEGER'],
	['installmentCount', 'INTEGER'],
];

export const CREATE_ACCOUNTS_TABLE = `
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'checking',
    role TEXT NOT NULL DEFAULT 'main',
    envelopeMonthlyCents INTEGER,
    network TEXT,
    bankName TEXT,
    color TEXT NOT NULL DEFAULT '#15E8FE',
    last4 TEXT,
    closingDay INTEGER,
    dueDay INTEGER,
    closingDaysBefore INTEGER,
    creditLimitCents INTEGER,
    cardNames TEXT,
    packageName TEXT,
    accountKey TEXT,
    openingBalanceCents INTEGER NOT NULL DEFAULT 0,
    openingBalanceDate TEXT NOT NULL,
    sortOrder INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
${SYNC_COLUMNS_SQL}
  );
`;

/** Colunas que o v8 acrescenta em `accounts`. */
export const ACCOUNT_V8_COLUMNS: Array<[name: string, sql: string]> = [
	['role', "TEXT NOT NULL DEFAULT 'main'"],
	['envelopeMonthlyCents', 'INTEGER'],
];

/** Colunas que o v9 acrescenta em `accounts`. */
export const ACCOUNT_V9_COLUMNS: Array<[name: string, sql: string]> = [['network', 'TEXT']];

/** Colunas que o v10 acrescenta em `accounts`. */
export const ACCOUNT_V10_COLUMNS: Array<[name: string, sql: string]> = [['closingDaysBefore', 'INTEGER']];

/** Colunas que o v13 acrescenta. */
export const TRANSACTION_V13_COLUMNS: Array<[name: string, sql: string]> = [['cardLast4', 'TEXT']];
export const ACCOUNT_V13_COLUMNS: Array<[name: string, sql: string]> = [['cardNames', 'TEXT']];

/** O Nubank e a maioria dos bancos fecham a fatura 7 dias antes do vencimento. */
export const DEFAULT_CLOSING_DAYS_BEFORE = 7;

export const CREATE_TRANSFERS_TABLE = `
  CREATE TABLE IF NOT EXISTS transfers (
    id TEXT PRIMARY KEY NOT NULL,
    fromAccountId TEXT,
    toAccountId TEXT,
    amountCents INTEGER NOT NULL,
    date TEXT NOT NULL,
    note TEXT,
${SYNC_COLUMNS_SQL}
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
 * A notificação de banco capturada e o que o app decidiu sobre ela.
 *
 * **Local, nunca sincronizada.** O que sobe para o servidor é a transação que o
 * usuário confirma; a caixa de entrada é o rascunho de cada aparelho. O texto bruto
 * (`title`, `text`) fica guardado de propósito: se o parser errar, dá para corrigir a
 * regra e reprocessar sem ter perdido nada.
 *
 * `status`: pending (a revisar), confirmed (virou transação), dismissed (o usuário
 * descartou), duplicate (era o mesmo aviso de outro app), transfer (troca de bolso
 * entre contas próprias), ignored (fatura paga, aplicação, regra de ignorar).
 * `question`: quando pendente, a pergunta que o item faz — duplicate ou transfer —
 * sempre apontando para `relatedId`.
 */
export interface Capture {
	id: string;
	fingerprint: string;
	packageName: string;
	appLabel: string;
	title: string;
	text: string;
	/** Instante ISO 8601 em que a notificação foi publicada. */
	postedAt: string;
	amountCents: number;
	direction: 'in' | 'out';
	kind: string;
	counterparty: string | null;
	merchantKey: string | null;
	cardLast4: string | null;
	status: 'pending' | 'confirmed' | 'dismissed' | 'duplicate' | 'transfer' | 'ignored';
	question: 'duplicate' | 'transfer' | null;
	relatedId: string | null;
	suggestedCategory: string | null;
	transactionId: string | null;
	autoConfirmed: boolean;
	/** Por que saiu do jogo (own_name, rule, invoice_payment, investment…), para o histórico. */
	reason: string | null;
	/** A conta ou cartão de origem, resolvida pela fonte (app + final do cartão, ou conta do OFX). */
	accountId: string | null;
	/** A transferência criada quando o item é troca de bolso ou pagamento de fatura. */
	transferId: string | null;
	/** Quantas parcelas, quando a compra é parcelada. Nulo à vista. */
	installments: number | null;
	createdAt: string;
	updatedAt: string;
}

/** Colunas que o v7 acrescenta em `captures`. */
export const CAPTURE_V7_COLUMNS: Array<[name: string, sql: string]> = [
	['accountId', 'TEXT'],
	['transferId', 'TEXT'],
	['installments', 'INTEGER'],
];

/**
 * O que o app aprendeu sobre um estabelecimento ou pessoa (`merchantKey`, ver
 * `merchantKeyOf`). Também local: é um hábito deste usuário neste aparelho.
 */
export interface MerchantRule {
	merchantKey: string;
	categoryId: string | null;
	treatAs: 'transaction' | 'transfer' | 'ignore';
	confirmations: number;
	updatedAt: string;
}

export const CREATE_CAPTURES_TABLE = `
  CREATE TABLE IF NOT EXISTS captures (
    id TEXT PRIMARY KEY NOT NULL,
    fingerprint TEXT NOT NULL UNIQUE,
    packageName TEXT NOT NULL,
    appLabel TEXT NOT NULL,
    title TEXT NOT NULL,
    text TEXT NOT NULL,
    postedAt TEXT NOT NULL,
    amountCents INTEGER NOT NULL,
    direction TEXT NOT NULL,
    kind TEXT NOT NULL,
    counterparty TEXT,
    merchantKey TEXT,
    cardLast4 TEXT,
    status TEXT NOT NULL,
    question TEXT,
    relatedId TEXT,
    suggestedCategory TEXT,
    transactionId TEXT,
    autoConfirmed INTEGER NOT NULL DEFAULT 0,
    reason TEXT,
    accountId TEXT,
    transferId TEXT,
    installments INTEGER,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
`;

export const CREATE_MERCHANT_RULES_TABLE = `
  CREATE TABLE IF NOT EXISTS merchant_rules (
    merchantKey TEXT PRIMARY KEY NOT NULL,
    categoryId TEXT,
    treatAs TEXT NOT NULL DEFAULT 'transaction',
    confirmations INTEGER NOT NULL DEFAULT 0,
    updatedAt TEXT NOT NULL
  );
`;

/**
 * Queries filter by date range constantly; without these they are full scans.
 * The `dirty` indexes keep the push's "what changed?" scan off the full table.
 */
export const CREATE_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_captures_status ON captures (status, postedAt);
  CREATE INDEX IF NOT EXISTS idx_captures_posted ON captures (postedAt);
  CREATE INDEX IF NOT EXISTS idx_transactions_account ON transactions (accountId, date);
  CREATE INDEX IF NOT EXISTS idx_transfers_date ON transfers (date);
  CREATE INDEX IF NOT EXISTS idx_accounts_dirty ON accounts (dirty);
  CREATE INDEX IF NOT EXISTS idx_transfers_dirty ON transfers (dirty);
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

/** Campos do v7 que um lançamento pode não ter: à vista, sem conta conhecida. */
type OptionalTransactionFields = 'accountId' | 'installmentGroup' | 'installmentIndex' | 'installmentCount' | 'cardLast4';
export type TransactionDraft = Omit<Transaction, 'id' | keyof SyncMeta | OptionalTransactionFields> &
	Partial<Pick<Transaction, OptionalTransactionFields>>;

export type AccountDraft = Omit<Account, 'id' | keyof SyncMeta>;
export type AccountEdit = AccountDraft & { id: string };
export type TransferDraft = Omit<Transfer, 'id' | keyof SyncMeta>;
export type TransferEdit = TransferDraft & { id: string };
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
	// Expense categories. `nature` follows ESSENTIAL_DEFAULT_CATEGORY_IDS above.
	{
		id: 'food',
		name: 'Food',
		color: '#50E3C2',
		icon: 'fast-food',
		type: 'expense',
		nature: 'essential',
	},
	{
		id: 'transport',
		name: 'Transportation',
		color: '#5E5CE6',
		icon: 'car',
		type: 'expense',
		nature: 'essential',
	},
	{
		id: 'entertainment',
		name: 'Entertainment',
		color: '#FF6B6B',
		icon: 'film',
		type: 'expense',
		nature: 'discretionary',
	},
	{
		id: 'shopping',
		name: 'Shopping',
		color: '#FFCC5C',
		icon: 'cart',
		type: 'expense',
		nature: 'discretionary',
	},
	{
		id: 'utilities',
		name: 'Utilities',
		color: '#4DACF7',
		icon: 'flash',
		type: 'expense',
		nature: 'essential',
	},
	{
		id: 'health',
		name: 'Health',
		color: '#FF9FB1',
		icon: 'medical',
		type: 'expense',
		nature: 'essential',
	},
	{
		id: 'education',
		name: 'Education',
		color: '#A78BFA',
		icon: 'school',
		type: 'expense',
		nature: 'essential',
	},
	{
		id: 'other_expense',
		name: 'Other Expense',
		color: '#9CA3AF',
		icon: 'ellipsis-horizontal',
		type: 'expense',
		nature: 'discretionary',
	},

	// Income categories. These ids were referenced throughout the app but had never
	// actually been seeded, so the income category list was always empty. `nature` is
	// carried for uniformity and never read on this side of the ledger.
	{
		id: 'salary',
		name: 'Salary',
		color: '#4CAF50',
		icon: 'wallet',
		type: 'income',
		nature: 'discretionary',
	},
	{
		id: 'freelance',
		name: 'Freelance',
		color: '#15E8FE',
		icon: 'briefcase',
		type: 'income',
		nature: 'discretionary',
	},
	{
		id: 'investment',
		name: 'Investment',
		color: '#FFD166',
		icon: 'trending-up',
		type: 'income',
		nature: 'discretionary',
	},
	{
		id: 'gift',
		name: 'Gift',
		color: '#F78FB3',
		icon: 'gift',
		type: 'income',
		nature: 'discretionary',
	},
	{
		id: 'refund',
		name: 'Refund',
		color: '#7BDFF2',
		icon: 'return-down-back',
		type: 'income',
		nature: 'discretionary',
	},
	{
		id: 'other_income',
		name: 'Other Income',
		color: '#A0E7A0',
		icon: 'ellipsis-horizontal',
		type: 'income',
		nature: 'discretionary',
	},

	// Fallback bucket for transactions whose category was deleted. Discretionary because
	// an unclassified expense must not quietly count as a need.
	{
		id: 'uncategorized',
		name: 'Uncategorized',
		color: '#9CA3AF',
		icon: 'help-circle',
		type: 'expense',
		nature: 'discretionary',
	},
];

export default {
	DATABASE_NAME,
	SCHEMA_VERSION,
	SYNCED_TABLES,
	LEGACY_INCOME_CATEGORY_IDS,
	ESSENTIAL_DEFAULT_CATEGORY_IDS,
	CREATE_CATEGORIES_TABLE,
	CREATE_TRANSACTIONS_TABLE,
	CREATE_RECURRING_TRANSACTIONS_TABLE,
	CREATE_BUDGETS_TABLE,
	CREATE_SYNC_STATE_TABLE,
	CREATE_CAPTURES_TABLE,
	CREATE_MERCHANT_RULES_TABLE,
	CREATE_ACCOUNTS_TABLE,
	CREATE_TRANSFERS_TABLE,
	CREATE_INDEXES,
	DEFAULT_CATEGORIES,
};
