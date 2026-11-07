/**
 * Duas transações do banco ao mesmo tempo (SPD-101, E2E-37), no SQL **de verdade** de
 * `database.ts`: o `expo-sqlite` vira um banco em memória do próprio Node (`node:sqlite`),
 * como em `categoryNamesSql.test.ts`. Sem `NODE_OPTIONS=--experimental-sqlite` a suíte é
 * pulada com um aviso.
 *
 * A diferença para os outros `*Sql.test.ts`: aqui a transação é a do `expo-sqlite` linha a
 * linha (`SQLiteDatabase.withTransactionAsync` — o BEGIN dentro do `try`, o ROLLBACK no
 * `catch`), numa conexão só. É ela que o aparelho tem, e é com ela que o BEGIN de uma
 * segunda tarefa falha e o ROLLBACK dessa segunda desfaz a primeira.
 *
 * Os dois pares que o Metro mostrou:
 * - a abertura: `renameDefaultCategories` (SPD-088, pelo `localizeDefaultCategories` do
 *   TransactionsContext) e `ensureDebtBills` (o `syncDebtBills` do DebtsContext);
 * - depois de juntar dois cartões: o aviso de contas a pagar e o fim da rodada de sync
 *   recarregam o DebtsContext mais de uma vez, e dois `ensureDebtBills` correm juntos.
 */

jest.mock('expo-sqlite', () => {
	const { createRequire } = jest.requireActual('module');
	let DatabaseSync:
		| (new (
				path: string
		  ) => {
				exec: (sql: string) => void;
				prepare: (sql: string) => {
					run: (...params: unknown[]) => {
						changes: number | bigint;
						lastInsertRowid: number | bigint;
					};
					get: (...params: unknown[]) => unknown;
					all: (...params: unknown[]) => unknown[];
				};
		  })
		| null = null;
	try {
		DatabaseSync = createRequire(__filename)('node:sqlite').DatabaseSync;
	} catch {
		DatabaseSync = null;
	}
	const normalise = (params: unknown[] = []) =>
		params.map((value) =>
			typeof value === 'boolean' ? (value ? 1 : 0) : value === undefined ? null : value
		);
	return {
		mockSqliteAvailable: DatabaseSync !== null,
		openDatabaseSync: () => {
			if (!DatabaseSync) return {};
			const raw = new DatabaseSync(':memory:');
			const execAsync = async (sql: string) => {
				raw.exec(sql);
			};
			return {
				execAsync,
				runAsync: async (sql: string, params: unknown[] = []) => {
					const result = raw.prepare(sql).run(...normalise(params));
					return {
						changes: Number(result.changes),
						lastInsertRowId: Number(result.lastInsertRowid),
					};
				},
				getFirstAsync: async (sql: string, params: unknown[] = []) =>
					raw.prepare(sql).get(...normalise(params)) ?? null,
				getAllAsync: async (sql: string, params: unknown[] = []) =>
					raw.prepare(sql).all(...normalise(params)),
				// Cópia de `SQLiteDatabase.withTransactionAsync` (expo-sqlite 55).
				withTransactionAsync: async (task: () => Promise<void>) => {
					try {
						await execAsync('BEGIN');
						await task();
						await execAsync('COMMIT');
					} catch (error) {
						await execAsync('ROLLBACK');
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
	multiGet: jest.fn(async (keys: string[]) => keys.map((key) => [key, null])),
}));

jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'pt' }] }));

import { planDefaultCategoryRenames } from '../../utils/defaultCategoryNames';
import {
	addAccount,
	addDebt,
	db,
	ensureDebtBills,
	getCategoriesForBackup,
	getDebts,
	initDatabase,
	mergeCardInto,
	renameDefaultCategories,
} from '../database';
import { type AccountDraft, DEFAULT_CATEGORIES, type DebtDraft } from '../schema';

const sqliteAvailable: boolean = jest.requireMock<{ mockSqliteAvailable: boolean }>(
	'expo-sqlite'
).mockSqliteAvailable;
if (!sqliteAvailable) {
	console.warn(
		'transactionOverlapSql.test.ts pulado: rode com NODE_OPTIONS=--experimental-sqlite (Node 22.12).'
	);
}
const describeSql = sqliteAvailable ? describe : describe.skip;

const SEED = '1970-01-01T00:00:00.000Z';

const card = (overrides: Partial<AccountDraft> = {}): AccountDraft => ({
	name: 'Cartão',
	kind: 'credit_card',
	role: 'card',
	envelopeMonthlyCents: null,
	bankName: 'Nubank',
	color: '#820AD1',
	last4: '1111',
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
	openingBalanceDate: '2026-10-31',
	sortOrder: 0,
	archived: false,
	...overrides,
});

// Empréstimo de 5 parcelas de R$ 300, uma já paga: a próxima é a 2/5.
const loan = (accountId: string | null): DebtDraft => ({
	name: 'Empréstimo',
	kind: 'loan',
	system: 'price',
	openingBalanceCents: 120_000,
	openingBalanceDate: '2026-10-31',
	installmentCents: 30_000,
	remainingAtOpening: 4,
	installmentsTotal: 5,
	dueDay: 5,
	rateBp: 0,
	feeCents: 0,
	adminFeeBp: null,
	accountId,
	category: null,
	archived: false,
	sortOrder: 0,
});

interface BillRow {
	id: string;
	name: string;
	amountCents: number | null;
	accountId: string | null;
	debtId: string | null;
	active: number;
}

const liveBills = () =>
	db.getAllAsync<BillRow>(
		'SELECT id, name, amountCents, accountId, debtId, active FROM bills WHERE deletedAt IS NULL ORDER BY id'
	);

describeSql('duas transações ao mesmo tempo na mesma conexão (SPD-101, E2E-37)', () => {
	beforeAll(async () => {
		jest.spyOn(console, 'log').mockImplementation(() => undefined);
		await initDatabase();
	});

	beforeEach(async () => {
		await db.execAsync('DELETE FROM categories; DELETE FROM bills; DELETE FROM debts; DELETE FROM accounts;');
		// As 16 padrão como o app e o servidor semeiam: em inglês, carimbo de 1970.
		for (const category of DEFAULT_CATEGORIES) {
			await db.runAsync(
				`INSERT INTO categories (id, name, color, icon, type, nature, updatedAt, deletedAt, dirty)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0)`,
				[category.id, category.name, category.color, category.icon, category.type, category.nature, SEED]
			);
		}
	});

	it('na abertura: as categorias vão para o português e a conta a pagar do empréstimo nasce, as duas inteiras', async () => {
		const debtId = await addDebt(loan(null));
		const plan = planDefaultCategoryRenames(await getCategoriesForBackup(), { code: 'pt', chosen: true });
		// Todas menos a `uncategorized`, que não tem nome por idioma.
		expect(plan).toHaveLength(DEFAULT_CATEGORIES.length - 1);

		// Como na abertura: o TransactionsContext e o DebtsContext, cada um depois do seu
		// `initDatabase`, sem um esperar o outro.
		const [renamed, ensured] = await Promise.allSettled([
			renameDefaultCategories(plan),
			getDebts().then(ensureDebtBills),
		]);

		expect(renamed).toEqual({ status: 'fulfilled', value: plan.length });
		expect(ensured).toEqual({ status: 'fulfilled', value: 1 });
		const names = await db.getAllAsync<{ id: string; name: string }>('SELECT id, name FROM categories');
		// Nenhuma ficou pela metade: cada uma do plano está com o nome novo.
		for (const rename of plan) expect(names.find((row) => row.id === rename.id)?.name).toBe(rename.name);
		expect(names.find((row) => row.id === 'other_expense')?.name).toBe('Outras despesas');
		expect(await liveBills()).toEqual([
			{ id: debtId, name: 'Empréstimo', amountCents: 30_000, accountId: null, debtId, active: 1 },
		]);
	});

	it('depois de juntar cartões: dois ensureDebtBills juntos deixam uma conta a pagar só, no cartão que fica', async () => {
		const nubank = await addAccount(card({ name: 'Nubank Teste' }));
		const duplicado = await addAccount(card({ name: 'NU PAGAMENTOS S.A. · cartão final 1111', sortOrder: 1 }));
		const debtId = await addDebt(loan(duplicado));
		await mergeCardInto(duplicado, nubank);

		// O aviso de contas a pagar e o fim da rodada de sync recarregam o DebtsContext.
		const debts = await getDebts();
		const [first, second] = await Promise.allSettled([ensureDebtBills(debts), ensureDebtBills(debts)]);

		expect(first).toEqual({ status: 'fulfilled', value: 1 });
		// A segunda vê o que a primeira gravou: nada a fazer, nenhuma linha suja à toa.
		expect(second).toEqual({ status: 'fulfilled', value: 0 });
		expect(await liveBills()).toEqual([
			{ id: debtId, name: 'Empréstimo', amountCents: 30_000, accountId: nubank, debtId, active: 1 },
		]);
	});
});
