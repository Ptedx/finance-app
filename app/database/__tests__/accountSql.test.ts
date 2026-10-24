/**
 * Saldo pela âncora e conta de destino da captura, no SQL **de verdade** de `database.ts`.
 *
 * Os outros testes desta pasta anotam o comando que vai para o banco; aqui a pergunta é
 * o número que volta, e isso só um SQLite responde. O `expo-sqlite` vira um banco em
 * memória do próprio Node (`node:sqlite`). No Node 22.12 ele ainda pede
 * `NODE_OPTIONS=--experimental-sqlite`; sem a flag a suíte é pulada com um aviso, em vez
 * de quebrar a execução inteira.
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

import {
	addAccount,
	addTransaction,
	addTransfer,
	db,
	deleteTransaction,
	findAccountBySource,
	getAccount,
	getAccountBalances,
	initDatabase,
	setAccountBalanceToday,
} from '../database';
import type { AccountDraft } from '../schema';

const sqliteAvailable: boolean = jest.requireMock<{ mockSqliteAvailable: boolean }>('expo-sqlite').mockSqliteAvailable;
if (!sqliteAvailable) {
	console.warn('accountSql.test.ts pulado: rode com NODE_OPTIONS=--experimental-sqlite (Node 22.12).');
}
const describeSql = sqliteAvailable ? describe : describe.skip;

const INTER = 'br.com.intermedium';
const NU = 'com.nu.production';

const draft = (overrides: Partial<AccountDraft> = {}): AccountDraft => ({
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

const spend = (accountId: string, date: string, amountCents: number) =>
	addTransaction({ accountId, date, amountCents, isIncome: false, category: 'food', note: '' });
const earn = (accountId: string, date: string, amountCents: number) =>
	addTransaction({ accountId, date, amountCents, isIncome: true, category: 'salary', note: '' });
const balanceOn = async (accountId: string, date: string) => (await getAccountBalances(date)).get(accountId);

describeSql('SQL de verdade', () => {
	beforeAll(async () => {
		jest.spyOn(console, 'log').mockImplementation(() => undefined);
		await initDatabase();
	});
	beforeEach(async () => {
		await db.execAsync('DELETE FROM transactions; DELETE FROM transfers; DELETE FROM accounts;');
	});

	describe('a conta de uma captura pelo app do banco (findAccountBySource)', () => {
		it('conta arquivada ainda ligada ao app não é destino: vence a ativa ligada ao mesmo app', async () => {
			// A arquivada nasce antes: sem o filtro, é a primeira linha que o SELECT devolve.
			await addAccount(draft({ name: 'Inter', bankName: 'Inter', packageName: INTER, archived: true }));
			const live = await addAccount(draft({ name: 'Inter PF', bankName: 'Inter', packageName: INTER }));
			expect((await findAccountBySource(INTER, null))?.id).toBe(live);
		});

		it('só a arquivada ligada ao app: não há conta, e ela continua arquivada', async () => {
			const archived = await addAccount(draft({ name: 'Inter', bankName: 'Inter', packageName: INTER, archived: true }));
			expect(await findAccountBySource(INTER, null)).toBeNull();
			expect((await getAccount(archived))?.archived).toBe(true);
		});

		it('cartão arquivado com o mesmo final: não é destino', async () => {
			const card = await addAccount(
				draft({ name: 'Cartão antigo', kind: 'credit_card', role: 'card', bankName: 'Nubank', packageName: NU, last4: '1534', archived: true })
			);
			expect(await findAccountBySource(NU, '1534')).toBeNull();
			expect((await getAccount(card))?.archived).toBe(true);
		});

		it('conta e cartão ativos seguem achados como antes', async () => {
			const checking = await addAccount(draft({ name: 'Nubank PF', bankName: 'Nubank', packageName: NU }));
			const card = await addAccount(
				draft({ name: 'Cartão', kind: 'credit_card', role: 'card', bankName: 'Nubank', packageName: NU, last4: '1534' })
			);
			expect((await findAccountBySource(NU, null))?.id).toBe(checking);
			expect((await findAccountBySource(NU, '1534'))?.id).toBe(card);
		});
	});

	describe('saldo numa data anterior à âncora (getAccountBalances)', () => {
		/*
		 * Envelope de R$ 1.000/mês. Em 01/10 entram R$ 1.000 da principal; em 05/10 saem
		 * R$ 300. O banco mostra R$ 850, porque sobraram R$ 150 de setembro que o app não
		 * sabia. O acerto de 16/10 põe a âncora em 15/10 = R$ 850. Na véspera do mês, o
		 * saldo de verdade é R$ 150 — e não os R$ 850 da âncora.
		 */
		it('envelope acertado no meio do mês: a véspera do mês desfaz o que houve até a âncora', async () => {
			jest.useFakeTimers({ now: new Date(2026, 9, 16, 12, 0, 0), doNotFake: ['nextTick', 'setImmediate'] });
			try {
				const main = await addAccount(draft({ name: 'Principal', openingBalanceCents: 1_000_000, openingBalanceDate: '2026-09-30' }));
				const env = await addAccount(
					draft({ name: 'Envelope', role: 'envelope', envelopeMonthlyCents: 100_000, openingBalanceDate: '2026-09-30' })
				);
				await addTransfer({ fromAccountId: main, toAccountId: env, amountCents: 100_000, date: '2026-10-01', note: '' });
				await spend(env, '2026-10-05', 30_000);
				await setAccountBalanceToday(env, 85_000);
				expect((await getAccount(env))?.openingBalanceDate).toBe('2026-10-15');

				expect(await balanceOn(env, '2026-09-30')).toBe(15_000);
				expect(await balanceOn(env, '2026-10-01')).toBe(115_000);
				expect(await balanceOn(env, '2026-10-05')).toBe(85_000);
				expect(await balanceOn(env, '2026-10-15')).toBe(85_000);
				expect(await balanceOn(env, '2026-10-16')).toBe(85_000);
			} finally {
				jest.useRealTimers();
			}
		});

		it('conta corrente: a mesma regra, com receita, despesa e transferência nos dois sentidos', async () => {
			const other = await addAccount(draft({ name: 'Outra', openingBalanceDate: '2026-01-01' }));
			const a = await addAccount(draft({ name: 'A', openingBalanceCents: 200_000, openingBalanceDate: '2026-10-20' }));
			await earn(a, '2026-10-05', 500_000);
			await spend(a, '2026-10-10', 12_345);
			await addTransfer({ fromAccountId: a, toAccountId: other, amountCents: 100_000, date: '2026-10-12', note: '' });
			await addTransfer({ fromAccountId: other, toAccountId: a, amountCents: 20_000, date: '2026-10-15', note: '' });
			// O dia da âncora já está dentro dela: na véspera, o gasto de 20/10 é desfeito.
			await spend(a, '2026-10-20', 1_000);
			// Depois da âncora, soma como sempre.
			await spend(a, '2026-10-25', 5_000);

			expect(await balanceOn(a, '2026-10-20')).toBe(200_000);
			expect(await balanceOn(a, '2026-10-19')).toBe(200_000 + 1_000);
			expect(await balanceOn(a, '2026-10-14')).toBe(200_000 + 1_000 - 20_000);
			expect(await balanceOn(a, '2026-09-30')).toBe(200_000 + 1_000 - 20_000 + 100_000 + 12_345 - 500_000);
			expect(await balanceOn(a, '2026-10-31')).toBe(200_000 - 5_000);
			// A outra ponta das transferências, com âncora antiga, soma do jeito de sempre.
			expect(await balanceOn(other, '2026-10-31')).toBe(100_000 - 20_000);
		});

		it('lançamento apagado não entra na reconstrução', async () => {
			const a = await addAccount(draft({ openingBalanceCents: 50_000, openingBalanceDate: '2026-10-15' }));
			const gone = await spend(a, '2026-10-10', 9_000);
			await spend(a, '2026-10-11', 1_000);
			await deleteTransaction(gone);
			expect(await balanceOn(a, '2026-10-01')).toBe(51_000);
		});
	});
});
