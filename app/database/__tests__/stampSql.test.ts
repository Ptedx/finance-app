/**
 * Toda gravação numa linha que já existe carimba depois do carimbo dela (SPD-107), no SQL
 * **de verdade** de `database.ts` e `captures.ts`.
 *
 * O achado: uma transação gravada com o relógio adiantado ficou com `updatedAt` cinco
 * dias no futuro. A edição de hoje carimbava agora, mais velho que a cópia do servidor:
 * o push voltava `stale` e o pull desfazia a edição. A regra é `max(agora, anterior + 1 ms)`.
 *
 * O `expo-sqlite` vira um banco em memória do Node (`node:sqlite`), como em
 * `accountSql.test.ts`; sem `NODE_OPTIONS=--experimental-sqlite` a suíte é pulada.
 */

jest.mock('expo-sqlite', () => {
	const { createRequire } = jest.requireActual('module');
	let DatabaseSync: (new (path: string) => {
		exec: (sql: string) => void;
		prepare: (sql: string) => {
			run: (...params: unknown[]) => { changes: number | bigint; lastInsertRowid: number | bigint };
			get: (...params: unknown[]) => unknown;
			all: (...params: unknown[]) => unknown[];
		};
	}) | null = null;
	try {
		DatabaseSync = createRequire(__filename)('node:sqlite').DatabaseSync;
	} catch {
		DatabaseSync = null;
	}
	const normalise = (params: unknown[] = []) =>
		params.map((value) => (typeof value === 'boolean' ? (value ? 1 : 0) : value === undefined ? null : value));
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
					return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
				},
				getFirstAsync: async (sql: string, params: unknown[] = []) => raw.prepare(sql).get(...normalise(params)) ?? null,
				getAllAsync: async (sql: string, params: unknown[] = []) => raw.prepare(sql).all(...normalise(params)),
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

import { nextStampSql } from '../../utils/syncStamp';
import { deleteMerchantRule, insertCapture, saveMerchantRule, updateCapture } from '../captures';
import {
	addAccount,
	addBill,
	addCategory,
	addTransaction,
	addTransfer,
	clearBudget,
	db,
	deleteAccount,
	deleteCategory,
	deleteTransaction,
	initDatabase,
	mergeCardInto,
	moveAccountLedger,
	renameDefaultCategories,
	resetDatabase,
	restoreTransaction,
	setAccountBalanceToday,
	setBudget,
	setReserveGoal,
	updateAccount,
	updateTransaction,
} from '../database';
import type { AccountDraft, Capture, TransactionDraft } from '../schema';

const sqliteAvailable: boolean = jest.requireMock<{ mockSqliteAvailable: boolean }>('expo-sqlite').mockSqliteAvailable;
if (!sqliteAvailable) {
	console.warn('stampSql.test.ts pulado: rode com NODE_OPTIONS=--experimental-sqlite (Node 22.12).');
}
const describeSql = sqliteAvailable ? describe : describe.skip;

const DAY_MS = 24 * 60 * 60 * 1000;
/** O carimbo de uma linha gravada com o relógio cinco dias adiantado. */
const aheadBy = (days: number): string => new Date(Date.now() + days * DAY_MS).toISOString();
const msAfter = (stamp: string, ms: number): string => new Date(new Date(stamp).getTime() + ms).toISOString();

const account = (overrides: Partial<AccountDraft> = {}): AccountDraft => ({
	name: 'Conta',
	kind: 'checking',
	role: 'main',
	envelopeMonthlyCents: null,
	bankName: null,
	color: '#000000',
	last4: null,
	network: null,
	closingDay: null,
	dueDay: null,
	closingDaysBefore: null,
	creditLimitCents: null,
	cardNames: null,
	yieldCdiBp: null,
	reservePurpose: null,
	packageName: null,
	accountKey: null,
	openingBalanceCents: 0,
	openingBalanceDate: '2026-01-01',
	sortOrder: 0,
	archived: false,
	...overrides,
});

const purchase = (overrides: Partial<TransactionDraft> = {}): TransactionDraft => ({
	amountCents: 20_000,
	category: 'food',
	date: '2026-11-05',
	note: '',
	isIncome: false,
	...overrides,
});

const capture = (overrides: Partial<Capture> = {}): Omit<Capture, 'id' | 'createdAt' | 'updatedAt'> => ({
	fingerprint: `fp-${Math.random()}`,
	packageName: 'com.google.android.gm',
	appLabel: 'Gmail',
	title: 'Banco',
	text: 'Compra aprovada: R$ 45,00 em LOJA ABC.',
	postedAt: '2026-11-05T15:00:00.000Z',
	amountCents: 4500,
	direction: 'out',
	kind: 'purchase',
	counterparty: null,
	merchantKey: null,
	cardLast4: null,
	status: 'pending',
	question: null,
	relatedId: null,
	suggestedCategory: null,
	transactionId: null,
	autoConfirmed: false,
	reason: null,
	accountId: null,
	transferId: null,
	installments: null,
	...overrides,
});

type Stamped = { updatedAt: string; deletedAt: string | null; dirty: number };

/** Põe na linha o carimbo que o servidor também tem, e limpa: ela acabou de descer. */
const pulledWith = async (table: string, stamp: string, where = 'id = ?', key?: string): Promise<void> => {
	await db.runAsync(`UPDATE ${table} SET updatedAt = ?, dirty = 0 WHERE ${where}`, key === undefined ? [stamp] : [stamp, key]);
};

const stampOf = async (table: string, id: string, column = 'id'): Promise<Stamped> =>
	(await db.getFirstAsync<Stamped>(`SELECT updatedAt, deletedAt, dirty FROM ${table} WHERE ${column} = ?`, [id])) as Stamped;

/** O que a edição tem de ser para o servidor não a recusar: mais nova que a cópia de lá. */
const expectAfter = (row: Stamped, previous: string) => {
	expect(row.updatedAt > previous).toBe(true);
	expect(row.updatedAt).toBe(msAfter(previous, 1));
	expect(row.dirty).toBe(1);
};

describeSql('carimbo que sempre avança, SQL de verdade (SPD-107)', () => {
	beforeAll(async () => {
		jest.spyOn(console, 'log').mockImplementation(() => undefined);
		await initDatabase();
	});
	beforeEach(async () => {
		await db.execAsync(`
			DELETE FROM transactions; DELETE FROM transfers; DELETE FROM accounts; DELETE FROM bills;
			DELETE FROM debts; DELETE FROM budgets; DELETE FROM reserve_goals; DELETE FROM captures;
			DELETE FROM merchant_rules;
		`);
	});

	describe('a forma em SQL é a mesma conta da função pura', () => {
		const run = async (previous: string | null, now: string) =>
			(await db.getFirstAsync<{ v: string }>(`SELECT ${nextStampSql('?', '?')} AS v`, [now, previous]))?.v;

		it('anterior no futuro, no passado, nulo e sem milissegundos', async () => {
			const now = '2026-11-07T12:00:00.000Z';
			expect(await run('2026-11-12T03:20:05.123Z', now)).toBe('2026-11-12T03:20:05.124Z');
			expect(await run('2026-12-31T23:59:59.999Z', now)).toBe('2027-01-01T00:00:00.000Z');
			expect(await run('2026-11-01T08:00:00.000Z', now)).toBe(now);
			expect(await run(null, now)).toBe(now);
			expect(await run('', now)).toBe(now);
			expect(await run(now, now)).toBe('2026-11-07T12:00:00.001Z');
			expect(await run('2026-11-12T03:20:05Z', now)).toBe('2026-11-12T03:20:05.001Z');
		});
	});

	describe('o caso do aparelho: transação com carimbo cinco dias no futuro', () => {
		it('editar o valor de R$ 200 para R$ 250 carimba depois do anterior', async () => {
			const id = await addTransaction(purchase());
			const future = aheadBy(5);
			await pulledWith('transactions', future, 'id = ?', id);

			await updateTransaction({ ...purchase({ amountCents: 25_000 }), id });

			const row = await stampOf('transactions', id);
			expectAfter(row, future);
			const { amountCents } = (await db.getFirstAsync<{ amountCents: number }>('SELECT amountCents FROM transactions WHERE id = ?', [id])) as { amountCents: number };
			expect(amountCents).toBe(25_000);
		});

		it('apagar põe a lápide depois do anterior', async () => {
			const id = await addTransaction(purchase());
			const future = aheadBy(5);
			await pulledWith('transactions', future, 'id = ?', id);

			await deleteTransaction(id);

			const row = await stampOf('transactions', id);
			expectAfter(row, future);
			expect(row.deletedAt).not.toBeNull();
		});

		it('carimbo anterior no passado: a edição fica com o de agora', async () => {
			const id = await addTransaction(purchase());
			const past = aheadBy(-5);
			await pulledWith('transactions', past, 'id = ?', id);
			const before = new Date().toISOString();

			await updateTransaction({ ...purchase({ amountCents: 25_000 }), id });

			const row = await stampOf('transactions', id);
			expect(row.updatedAt >= before).toBe(true);
			expect(row.updatedAt <= new Date().toISOString()).toBe(true);
		});

		it('linha nova continua com o carimbo de agora', async () => {
			const before = new Date().toISOString();
			const id = await addTransaction(purchase());
			const row = await stampOf('transactions', id);
			expect(row.updatedAt >= before).toBe(true);
			expect(row.updatedAt <= new Date().toISOString()).toBe(true);
		});
	});

	describe('operações em lote', () => {
		it('juntar cartões: cada linha mexida passa o próprio carimbo, adiantado ou não', async () => {
			const from = await addAccount(account({ name: 'Cartão OFX', kind: 'credit_card', role: 'card', last4: '1111' }));
			const into = await addAccount(account({ name: 'Cartão', kind: 'credit_card', role: 'card', last4: '1111' }));
			const other = await addAccount(account({ name: 'Conta' }));
			const ahead = await addTransaction(purchase({ accountId: from }));
			const behind = await addTransaction(purchase({ accountId: from, amountCents: 5_000 }));
			const transfer = await addTransfer({ fromAccountId: other, toAccountId: from, amountCents: 9_000, date: '2026-11-04', note: '' });
			const future = aheadBy(5);
			const furtherAhead = aheadBy(9);
			await pulledWith('transactions', future, 'id = ?', ahead);
			await pulledWith('transactions', aheadBy(-3), 'id = ?', behind);
			await pulledWith('transfers', furtherAhead, 'id = ?', transfer);
			await pulledWith('accounts', future, 'id = ?', from);
			const before = new Date().toISOString();

			await mergeCardInto(from, into);

			expectAfter(await stampOf('transactions', ahead), future);
			expectAfter(await stampOf('transfers', transfer), furtherAhead);
			const merged = await stampOf('accounts', from);
			expectAfter(merged, future);
			expect(merged.deletedAt).not.toBeNull();
			const moved = await stampOf('transactions', behind);
			expect(moved.updatedAt >= before && moved.updatedAt <= new Date().toISOString()).toBe(true);
		});

		it('mover o livro de uma conta: lançamentos, capturas e contas a pagar', async () => {
			const from = await addAccount(account({ name: 'Débito' }));
			const to = await addAccount(account({ name: 'Conta' }));
			const tx = await addTransaction(purchase({ accountId: from }));
			const captured = await insertCapture(capture({ accountId: from }));
			const bill = await addBill({
				name: 'Luz',
				dueDay: 10,
				amountCents: 15_000,
				accountId: from,
				category: null,
				matchHint: null,
				debtId: null,
				paidThrough: null,
				paidByRef: null,
				active: true,
				sortOrder: 0,
			});
			const future = aheadBy(5);
			await pulledWith('transactions', future, 'id = ?', tx);
			await pulledWith('captures', future, 'id = ?', captured.id);
			await pulledWith('bills', future, 'id = ?', bill);

			await moveAccountLedger(from, to);

			expectAfter(await stampOf('transactions', tx), future);
			expectAfter(await stampOf('captures', captured.id), future);
			expectAfter(await stampOf('bills', bill), future);
		});

		it('apagar a categoria: os lançamentos dela vão para "sem categoria" depois do carimbo deles', async () => {
			await addCategory({ name: 'Viagem', color: '#000000', icon: 'airplane', type: 'expense', nature: 'discretionary' }, 'trip');
			const tx = await addTransaction(purchase({ category: 'trip' }));
			const future = aheadBy(5);
			await pulledWith('transactions', future, 'id = ?', tx);
			await pulledWith('categories', future, 'id = ?', 'trip');

			await deleteCategory('trip');

			expectAfter(await stampOf('transactions', tx), future);
			expectAfter(await stampOf('categories', 'trip'), future);
		});

		it('apagar a conta: a lápide dela e das transferências passa o carimbo de cada uma', async () => {
			const a = await addAccount(account({ name: 'Reserva' }));
			const b = await addAccount(account({ name: 'Conta' }));
			const transfer = await addTransfer({ fromAccountId: b, toAccountId: a, amountCents: 1_000, date: '2026-11-01', note: '' });
			const future = aheadBy(5);
			await pulledWith('accounts', future, 'id = ?', a);
			await pulledWith('transfers', future, 'id = ?', transfer);

			await deleteAccount(a);

			expectAfter(await stampOf('accounts', a), future);
			expectAfter(await stampOf('transfers', transfer), future);
		});

		it('a lápide de toda a importação (resetDatabase) e a restauração por cima dela', async () => {
			const id = await addTransaction(purchase());
			const future = aheadBy(5);
			await pulledWith('transactions', future, 'id = ?', id);

			await resetDatabase();
			const tombstone = await stampOf('transactions', id);
			expectAfter(tombstone, future);

			// O DELETE da lápide some com o carimbo dela; a linha regravada tem de passar dele.
			await restoreTransaction(purchase({ amountCents: 25_000 }), id);
			const restored = await stampOf('transactions', id);
			expectAfter(restored, tombstone.updatedAt);
			expect(restored.deletedAt).toBeNull();
		});
	});

	describe('as outras gravações em linha que já existe', () => {
		it('conta: editar e informar o saldo de hoje', async () => {
			const id = await addAccount(account());
			const future = aheadBy(5);
			await pulledWith('accounts', future, 'id = ?', id);
			await updateAccount({ ...account({ name: 'Conta renomeada' }), id });
			expectAfter(await stampOf('accounts', id), future);

			const later = aheadBy(6);
			await pulledWith('accounts', later, 'id = ?', id);
			await setAccountBalanceToday(id, 10_000);
			expectAfter(await stampOf('accounts', id), later);
		});

		it('categoria: regravar por id (restauração) e trocar o nome padrão', async () => {
			const future = aheadBy(5);
			await pulledWith('categories', future, 'id = ?', 'food');
			await addCategory({ name: 'Comida', color: '#000000', icon: 'food', type: 'expense', nature: 'essential' }, 'food');
			expectAfter(await stampOf('categories', 'food'), future);

			const later = aheadBy(6);
			await pulledWith('categories', later, 'id = ?', 'food');
			await renameDefaultCategories([{ id: 'food', from: 'Comida', name: 'Alimentação' }]);
			expectAfter(await stampOf('categories', 'food'), later);
		});

		it('orçamento: mudar o valor e limpar o mês', async () => {
			const id = await setBudget(2026, 11, 100_000);
			const future = aheadBy(5);
			await pulledWith('budgets', future, 'id = ?', id);
			await setBudget(2026, 11, 120_000);
			expectAfter(await stampOf('budgets', id), future);

			const later = aheadBy(6);
			await pulledWith('budgets', later, 'id = ?', id);
			await clearBudget(2026, 11);
			expectAfter(await stampOf('budgets', id), later);
		});

		it('meta da reserva: redefinir na mesma linha', async () => {
			await setReserveGoal({ targetMonths: 6, customMonthlyCostCents: null });
			const future = aheadBy(5);
			await pulledWith('reserve_goals', future, '1 = 1');
			await setReserveGoal({ targetMonths: 12, customMonthlyCostCents: null });
			const row = (await db.getFirstAsync<Stamped>('SELECT updatedAt, deletedAt, dirty FROM reserve_goals')) as Stamped;
			expectAfter(row, future);
		});

		it('captura e regra aprendida: decidir, aprender de novo e esquecer', async () => {
			const captured = await insertCapture(capture());
			const future = aheadBy(5);
			await pulledWith('captures', future, 'id = ?', captured.id);
			await updateCapture(captured.id, { status: 'dismissed', reason: 'manual' });
			expectAfter(await stampOf('captures', captured.id), future);

			await saveMerchantRule({ merchantKey: 'loja abc', categoryId: 'food', treatAs: 'transaction', confirmations: 1 });
			await pulledWith('merchant_rules', future, 'merchantKey = ?', 'loja abc');
			await saveMerchantRule({ merchantKey: 'loja abc', categoryId: 'food', treatAs: 'transaction', confirmations: 2 });
			expectAfter(await stampOf('merchant_rules', 'loja abc', 'merchantKey'), future);

			const later = aheadBy(6);
			await pulledWith('merchant_rules', later, 'merchantKey = ?', 'loja abc');
			await deleteMerchantRule('loja abc');
			expectAfter(await stampOf('merchant_rules', 'loja abc', 'merchantKey'), later);
		});
	});
});
