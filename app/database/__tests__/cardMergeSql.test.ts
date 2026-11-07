/**
 * Juntar dois cartões (E2E-34, SPD-097), no SQL **de verdade** de `database.ts`.
 *
 * O extrato OFX do Nubank criou "NU PAGAMENTOS S.A. · cartão final 1111" ao lado do
 * "Nubank Teste" final 1111 que o usuário já tinha. `mergeCardInto` leva o que é do cartão
 * que sai — compras, parcelas, encargos, pagamentos de fatura, capturas, contas a pagar —
 * para o que fica, e apaga o que sai com lápide. O ajuste com a fatura do banco do que sai
 * não vem: ele acertava a fatura **dele** com o banco, e na fatura do que fica viraria
 * diferença inventada. Toda linha mudada fica suja, para o sync levar.
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

import { CARD_ADJUSTMENT_NOTE, cardChargeNote } from '../../utils/cardMath';
import {
	addAccount,
	addBill,
	addTransaction,
	addTransfer,
	db,
	getAccount,
	getAccounts,
	initDatabase,
	mergeCardInto,
} from '../database';
import type { AccountDraft } from '../schema';

const sqliteAvailable: boolean = jest.requireMock<{ mockSqliteAvailable: boolean }>('expo-sqlite').mockSqliteAvailable;
if (!sqliteAvailable) {
	console.warn('cardMergeSql.test.ts pulado: rode com NODE_OPTIONS=--experimental-sqlite (Node 22.12).');
}
const describeSql = sqliteAvailable ? describe : describe.skip;

const draft = (overrides: Partial<AccountDraft> = {}): AccountDraft => ({
	name: 'Cartão',
	kind: 'credit_card',
	role: 'card',
	envelopeMonthlyCents: null,
	bankName: 'Nubank',
	color: '#820AD1',
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

interface Row {
	id: string;
	accountId: string | null;
	amountCents: number;
	note: string;
	cardLast4: string | null;
	deletedAt: string | null;
	dirty: number;
}

const rowsOf = (table: string) => db.getAllAsync<Row & Record<string, unknown>>(`SELECT * FROM ${table}`);

const addCapture = async (id: string, accountId: string) => {
	await db.runAsync(
		`INSERT INTO captures (id, fingerprint, packageName, appLabel, title, text, postedAt, amountCents, direction, kind,
       status, autoConfirmed, accountId, createdAt, updatedAt, deletedAt, dirty)
     VALUES (?, ?, 'com.nu.production', 'Nubank', 'Compra', 'Compra de R$ 45,90', '2026-11-06T10:00:00.000Z', 4590, 'out',
       'purchase', 'pending', 0, ?, '2026-11-06T10:00:00.000Z', '2026-11-06T10:00:00.000Z', NULL, 1)`,
		[id, `fp-${id}`, accountId]
	);
};

describeSql('juntar cartões no SQL (mergeCardInto, SPD-097)', () => {
	let nubank: string;
	let duplicado: string;
	let corrente: string;

	beforeAll(async () => {
		jest.spyOn(console, 'log').mockImplementation(() => undefined);
		await initDatabase();
	});

	beforeEach(async () => {
		await db.execAsync(
			'DELETE FROM transactions; DELETE FROM transfers; DELETE FROM accounts; DELETE FROM captures; DELETE FROM bills;'
		);
		corrente = await addAccount(draft({ name: 'Corrente', kind: 'checking', role: 'main', bankName: 'Nubank' }));
		// O cartão cadastrado à mão: fecha dia 25, vence 7 dias depois, limite R$ 5.000.
		nubank = await addAccount(
			draft({
				name: 'Nubank Teste',
				last4: '1111',
				closingDay: 25,
				closingDaysBefore: 7,
				dueDay: 2,
				creditLimitCents: 500_000,
				packageName: 'com.nu.production',
				cardNames: JSON.stringify({ '6422': 'Virtual iFood' }),
				sortOrder: 1,
			})
		);
		// O que o import do OFX criou: sem fechamento nem limite, com a âncora do LEDGERBAL.
		duplicado = await addAccount(
			draft({
				name: 'NU PAGAMENTOS S.A. · cartão final 1111',
				bankName: 'NU PAGAMENTOS S.A.',
				last4: '1111',
				accountKey: 'e2e-1111',
				openingBalanceCents: -123_456,
				openingBalanceDate: '2026-10-31',
				cardNames: JSON.stringify({ '6422': 'Outro nome', '7788': 'Assinaturas' }),
				sortOrder: 2,
			})
		);
		await addTransaction({ accountId: nubank, date: '2026-11-01', amountCents: 5_000, isIncome: false, category: 'food', note: 'Padaria' });
		await addTransaction({ accountId: nubank, date: '2026-11-07', amountCents: 10_000, isIncome: false, category: 'food', note: 'Supermercado' });
		await addTransaction({ accountId: duplicado, date: '2026-11-06', amountCents: 4_590, isIncome: false, category: 'health', note: 'Drogasil' });
		await addTransaction({ accountId: duplicado, date: '2026-11-07', amountCents: 15_000, isIncome: false, category: 'other_expense', note: CARD_ADJUSTMENT_NOTE });
		await addTransaction({ accountId: duplicado, date: '2026-11-07', amountCents: 312, isIncome: false, category: 'other_expense', note: cardChargeNote('iof') });
		for (const index of [1, 2]) {
			await addTransaction({
				accountId: duplicado,
				date: index === 1 ? '2026-11-03' : '2026-12-03',
				amountCents: 30_000,
				isIncome: false,
				category: 'shopping',
				note: `Tênis (${index}/2)`,
				installmentGroup: 'g-tenis',
				installmentIndex: index,
				installmentCount: 2,
			});
		}
		await addTransfer({ fromAccountId: corrente, toAccountId: duplicado, amountCents: 4_590, date: '2026-11-07', note: '' });
		await addCapture('cap-drogasil', duplicado);
		await addBill({
			name: 'Anuidade',
			dueDay: 10,
			amountCents: 2_000,
			accountId: duplicado,
			category: null,
			matchHint: null,
			debtId: null,
			paidThrough: null,
			paidByRef: null,
			active: true,
			sortOrder: 0,
		});
		// Tudo já subiu: o que a junção mudar volta a ficar sujo.
		await db.execAsync(
			'UPDATE transactions SET dirty = 0; UPDATE transfers SET dirty = 0; UPDATE accounts SET dirty = 0; UPDATE captures SET dirty = 0; UPDATE bills SET dirty = 0;'
		);
	});

	it('o Nubank Teste fica com padaria, mercado e Drogasil; o ajuste do duplicado não vem', async () => {
		await mergeCardInto(duplicado, nubank);

		const alive = (await rowsOf('transactions')).filter((row) => row.deletedAt === null);
		const purchases = alive
			.filter((row) => row.accountId === nubank && row.installmentGroup === null && row.note !== cardChargeNote('iof'))
			.map((row) => [row.note, row.amountCents])
			.sort();
		expect(purchases).toEqual([
			['Drogasil', 4_590],
			['Padaria', 5_000],
			['Supermercado', 10_000],
		]);
		expect(alive.filter((row) => row.note === CARD_ADJUSTMENT_NOTE)).toEqual([]);
		// Nada fica "sem conta": nem o ajuste, que tem lápide em vez de perder o cartão.
		expect(alive.filter((row) => row.accountId !== nubank)).toEqual([]);
	});

	it('parcelas, encargo, pagamento de fatura, captura e conta a pagar passam para o que fica', async () => {
		await mergeCardInto(duplicado, nubank);

		const alive = (await rowsOf('transactions')).filter((row) => row.deletedAt === null);
		expect(alive.filter((row) => row.installmentGroup === 'g-tenis').map((row) => row.accountId)).toEqual([nubank, nubank]);
		expect(alive.find((row) => row.note === cardChargeNote('iof'))?.accountId).toBe(nubank);

		const transfers = (await rowsOf('transfers')).filter((row) => row.deletedAt === null);
		expect(transfers.map((row) => [row.fromAccountId, row.toAccountId, row.amountCents])).toEqual([[corrente, nubank, 4_590]]);

		const captures = await rowsOf('captures');
		expect(captures.map((row) => [row.id, row.accountId])).toEqual([['cap-drogasil', nubank]]);

		const bills = await rowsOf('bills');
		expect(bills.map((row) => row.accountId)).toEqual([nubank]);
	});

	it('o duplicado sai com lápide; o que fica mantém fechamento, limite e fatura informada', async () => {
		await mergeCardInto(duplicado, nubank);

		expect((await getAccounts()).map((account) => account.name).sort()).toEqual(['Corrente', 'Nubank Teste']);
		const gone = await db.getFirstAsync<{ deletedAt: string | null; dirty: number }>('SELECT deletedAt, dirty FROM accounts WHERE id = ?', [duplicado]);
		expect(gone?.deletedAt).not.toBeNull();
		expect(gone?.dirty).toBe(1);

		const kept = await getAccount(nubank);
		expect(kept).toEqual(
			expect.objectContaining({
				name: 'Nubank Teste',
				bankName: 'Nubank',
				last4: '1111',
				closingDay: 25,
				closingDaysBefore: 7,
				creditLimitCents: 500_000,
				openingBalanceCents: 0,
				openingBalanceDate: '2026-10-31',
				packageName: 'com.nu.production',
				// A chave do extrato vem junto: o próximo OFX cai no Nubank Teste.
				accountKey: 'e2e-1111',
			})
		);
		// Os finais do duplicado vêm, mas o nome que o Nubank Teste já dava a um final fica.
		expect(JSON.parse(kept?.cardNames ?? '{}')).toEqual({ '6422': 'Virtual iFood', '7788': 'Assinaturas' });
	});

	it('toda linha mudada fica suja para subir; a do Nubank Teste que não mudou, não', async () => {
		await mergeCardInto(duplicado, nubank);

		const transactions = await rowsOf('transactions');
		const dirtyOf = (note: string) => transactions.filter((row) => row.note === note).map((row) => row.dirty);
		expect(dirtyOf('Drogasil')).toEqual([1]);
		expect(dirtyOf(CARD_ADJUSTMENT_NOTE)).toEqual([1]);
		expect(dirtyOf(cardChargeNote('iof'))).toEqual([1]);
		expect(dirtyOf('Tênis (1/2)')).toEqual([1]);
		expect(dirtyOf('Padaria')).toEqual([0]);
		expect((await rowsOf('transfers')).map((row) => row.dirty)).toEqual([1]);
		expect((await rowsOf('captures')).map((row) => row.dirty)).toEqual([1]);
		expect((await rowsOf('bills')).map((row) => row.dirty)).toEqual([1]);
		const accounts = await db.getAllAsync<{ id: string; dirty: number }>('SELECT id, dirty FROM accounts');
		expect(Object.fromEntries(accounts.map((row) => [row.id, row.dirty]))).toEqual({ [corrente]: 0, [nubank]: 1, [duplicado]: 1 });
	});

	it('um pagamento entre os dois cartões some: era o mesmo dinheiro com duas fichas', async () => {
		await addTransfer({ fromAccountId: nubank, toAccountId: duplicado, amountCents: 1_000, date: '2026-11-05', note: '' });
		await mergeCardInto(duplicado, nubank);

		const transfers = (await rowsOf('transfers')).filter((row) => row.deletedAt === null);
		expect(transfers.map((row) => [row.fromAccountId, row.toAccountId])).toEqual([[corrente, nubank]]);
	});

	it('juntar um cartão nele mesmo, ou numa conta que não é cartão, não faz nada', async () => {
		await mergeCardInto(duplicado, duplicado);
		await mergeCardInto(duplicado, corrente);

		expect((await getAccounts()).map((account) => account.name).sort()).toEqual([
			'Corrente',
			'NU PAGAMENTOS S.A. · cartão final 1111',
			'Nubank Teste',
		]);
		const moved = (await rowsOf('transactions')).filter((row) => row.accountId === corrente);
		expect(moved).toEqual([]);
	});
});
