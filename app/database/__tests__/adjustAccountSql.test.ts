/**
 * O que fica gravado depois do "Acertar conta" numa conta nova (E2E-01, SPD-087), no SQL
 * **de verdade** de `database.ts`.
 *
 * Quem tem R$ 5.000 hoje e já gastou R$ 1.200 em novembro: o gasto entra no mês como
 * lançamento (`spendingAdjustment`), e o resto do que não fecha é dinheiro de antes — move
 * a âncora (`setAccountBalanceToday`), sem virar receita. Os passos são os de
 * `adjustAccountMonth`, sem o provider em volta. Como em `accountSql.test.ts`, precisa de
 * `NODE_OPTIONS=--experimental-sqlite`; sem a flag a suíte é pulada.
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

import { spendingAdjustment } from '../../utils/accountMath';
import { addAccount, addTransaction, db, getAccountActivity, getAccountBalances, initDatabase, setAccountBalanceToday } from '../database';
import type { AccountDraft } from '../schema';

const sqliteAvailable: boolean = jest.requireMock<{ mockSqliteAvailable: boolean }>('expo-sqlite').mockSqliteAvailable;
if (!sqliteAvailable) {
	console.warn('adjustAccountSql.test.ts pulado: rode com NODE_OPTIONS=--experimental-sqlite (Node 22.12).');
}
const describeSql = sqliteAvailable ? describe : describe.skip;

const TODAY = '2026-11-07';

/** A conta como o cadastro grava hoje: âncora no fim de ontem. */
const draft = (openingBalanceCents = 0): AccountDraft => ({
	name: 'Corrente Teste',
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
	openingBalanceCents,
	openingBalanceDate: '2026-11-06',
	sortOrder: 0,
	archived: false,
});

/** Os passos de `adjustAccountMonth` para uma conta sem provisórias. */
const adjust = async (id: string, spentNow: number, input: { spentCents: number; balanceCents: number }) => {
	const spend = spendingAdjustment(spentNow, input.spentCents);
	if (spend) {
		await addTransaction({
			accountId: id,
			date: TODAY,
			amountCents: spend.amountCents,
			isIncome: spend.isIncome,
			category: spend.isIncome ? 'other_income' : 'other_expense',
			note: 'ajuste',
		});
	}
	if ((await getAccountBalances(TODAY)).get(id) !== input.balanceCents) await setAccountBalanceToday(id, input.balanceCents);
};

const month = (id: string) => getAccountActivity(id, '2026-11-01', '2026-11-30');

describeSql('SQL de verdade — acertar uma conta nova', () => {
	beforeAll(async () => {
		jest.spyOn(console, 'log').mockImplementation(() => undefined);
		await initDatabase();
	});
	beforeEach(async () => {
		jest.useFakeTimers({ now: new Date(2026, 10, 7, 12, 0, 0), doNotFake: ['nextTick', 'setImmediate'] });
		await db.execAsync('DELETE FROM transactions; DELETE FROM transfers; DELETE FROM accounts;');
	});
	afterEach(() => jest.useRealTimers());

	it('gastei R$ 1.200 e tenho R$ 5.000: saldo R$ 5.000, gasto R$ 1.200, nenhuma receita', async () => {
		const id = await addAccount(draft());
		await adjust(id, 0, { spentCents: 120_000, balanceCents: 500_000 });

		expect((await getAccountBalances(TODAY)).get(id)).toBe(500_000);
		const activity = await month(id);
		expect(activity.expenseCents).toBe(120_000);
		expect(activity.incomeCents).toBe(0);
		// Os R$ 6.200 de antes ficam na âncora, no fim de ontem.
		expect((await getAccountBalances('2026-11-06')).get(id)).toBe(620_000);
	});

	it('saldo do cadastro (R$ 5.000) e um gasto de hoje: o gasto conta por cima da âncora', async () => {
		const id = await addAccount(draft(500_000));
		await addTransaction({ accountId: id, date: TODAY, amountCents: 120_000, isIncome: false, category: 'food', note: '' });

		expect((await getAccountBalances(TODAY)).get(id)).toBe(380_000);
		expect((await month(id)).incomeCents).toBe(0);
	});
});
