/**
 * Juntar duas contas leva as contas a pagar e as dívidas ligadas (SPD-099), no SQL **de
 * verdade** de `database.ts`.
 *
 * `mergeAccounts` levava lançamentos, capturas e transferências da conta que sai para a que
 * fica, mas a conta a pagar e a dívida ligadas à que sai continuavam apontando para ela —
 * uma conta com lápide. `moveAccountLedger` agora leva as duas, sujas para o sync, como
 * `mergeCardInto` faz nos cartões.
 *
 * Como em `accountSql.test.ts`, o `expo-sqlite` vira o `node:sqlite` em memória e a suíte
 * pede `NODE_OPTIONS=--experimental-sqlite`; sem a flag, é pulada com um aviso.
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
	addBill,
	addDebt,
	db,
	deleteAccount,
	deleteBill,
	foldAccountBalance,
	initDatabase,
	moveAccountLedger,
	repointTransfers,
} from '../database';
import type { AccountDraft, BillDraft } from '../schema';

const sqliteAvailable: boolean = jest.requireMock<{ mockSqliteAvailable: boolean }>('expo-sqlite').mockSqliteAvailable;
if (!sqliteAvailable) {
	console.warn('accountMergeSql.test.ts pulado: rode com NODE_OPTIONS=--experimental-sqlite (Node 22.12).');
}
const describeSql = sqliteAvailable ? describe : describe.skip;

const draft = (overrides: Partial<AccountDraft> = {}): AccountDraft => ({
	name: 'Conta',
	kind: 'checking',
	role: 'main',
	envelopeMonthlyCents: null,
	bankName: 'Inter',
	color: '#FF7A00',
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
	openingBalanceDate: '2026-10-31',
	sortOrder: 0,
	archived: false,
	...overrides,
});

const bill = (overrides: Partial<BillDraft>): BillDraft => ({
	name: 'Conta',
	dueDay: 10,
	amountCents: null,
	accountId: null,
	category: null,
	matchHint: null,
	debtId: null,
	paidThrough: null,
	paidByRef: null,
	active: true,
	sortOrder: 0,
	...overrides,
});

interface Row {
	id: string;
	accountId: string | null;
	deletedAt: string | null;
	updatedAt: string;
	dirty: number;
}

const rowOf = (table: 'bills' | 'debts', id: string) =>
	db.getFirstAsync<Row>(`SELECT id, accountId, deletedAt, updatedAt, dirty FROM ${table} WHERE id = ?`, [id]);

describeSql('juntar contas leva contas a pagar e dívidas (moveAccountLedger, SPD-099)', () => {
	let a: string;
	let b: string;
	let c: string;
	let luz: string;
	let emprestimo: string;
	let aluguelDeC: string;
	let apagada: string;
	let apagadaAntes: Row | null;

	// A mesma ordem de `mergeAccounts`: a soma, o livro, as transferências e a lápide.
	const juntar = async (fromId: string, intoId: string) => {
		await foldAccountBalance(fromId, intoId);
		await moveAccountLedger(fromId, intoId);
		await repointTransfers(fromId, intoId);
		await deleteAccount(fromId);
	};

	beforeAll(async () => {
		jest.spyOn(console, 'log').mockImplementation(() => undefined);
		await initDatabase();
	});

	beforeEach(async () => {
		await db.execAsync('DELETE FROM transactions; DELETE FROM transfers; DELETE FROM accounts; DELETE FROM bills; DELETE FROM debts;');
		a = await addAccount(draft({ name: 'Inter' }));
		b = await addAccount(draft({ name: 'Inter (aviso)', sortOrder: 1 }));
		c = await addAccount(draft({ name: 'Nubank', bankName: 'Nubank', sortOrder: 2 }));

		luz = await addBill(bill({ name: 'Luz', dueDay: 15, amountCents: 18_000, accountId: b }));
		// Empréstimo de 5 parcelas de R$ 300, uma já paga: a próxima é a 2/5.
		emprestimo = await addDebt({
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
			accountId: b,
			category: null,
			archived: false,
			sortOrder: 0,
		});
		aluguelDeC = await addBill(bill({ name: 'Aluguel', dueDay: 5, amountCents: 150_000, accountId: c, sortOrder: 1 }));
		apagada = await addBill(bill({ name: 'Academia', dueDay: 20, amountCents: 9_990, accountId: b, sortOrder: 2 }));
		await deleteBill(apagada);

		// Tudo já subiu: o que a junção mudar volta a ficar sujo.
		await db.execAsync(
			"UPDATE accounts SET dirty = 0; UPDATE bills SET dirty = 0, updatedAt = '2026-11-01T00:00:00.000Z'; UPDATE debts SET dirty = 0, updatedAt = '2026-11-01T00:00:00.000Z';"
		);
		apagadaAntes = await rowOf('bills', apagada);
	});

	it('a conta de luz (R$ 180) e o empréstimo (parcela 2/5 de R$ 300) de B passam para A, sujos', async () => {
		await juntar(b, a);

		const luzDepois = await rowOf('bills', luz);
		expect(luzDepois).toEqual(expect.objectContaining({ accountId: a, dirty: 1, deletedAt: null }));
		expect(luzDepois?.updatedAt).not.toBe('2026-11-01T00:00:00.000Z');

		const emprestimoDepois = await rowOf('debts', emprestimo);
		expect(emprestimoDepois).toEqual(expect.objectContaining({ accountId: a, dirty: 1, deletedAt: null }));
		expect(emprestimoDepois?.updatedAt).not.toBe('2026-11-01T00:00:00.000Z');
	});

	it('nenhuma conta a pagar ou dívida viva fica ligada à conta que saiu', async () => {
		await juntar(b, a);

		const orphans = await db.getAllAsync<{ id: string }>(
			`SELECT id FROM bills WHERE deletedAt IS NULL AND accountId = ?
       UNION ALL SELECT id FROM debts WHERE deletedAt IS NULL AND accountId = ?`,
			[b, b]
		);
		expect(orphans).toEqual([]);
	});

	it('a conta a pagar de outra conta (C) não muda nem fica suja', async () => {
		await juntar(b, a);

		expect(await rowOf('bills', aluguelDeC)).toEqual(
			expect.objectContaining({ accountId: c, dirty: 0, updatedAt: '2026-11-01T00:00:00.000Z' })
		);
	});

	it('a conta a pagar de B que já tinha lápide não é tocada', async () => {
		await juntar(b, a);

		expect(await rowOf('bills', apagada)).toEqual(apagadaAntes);
		expect(apagadaAntes).toEqual(expect.objectContaining({ accountId: b, dirty: 0 }));
	});
});
