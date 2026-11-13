/**
 * "R$ X comprados neste mês" no SQL **de verdade** de `getCardPurchasesOriginated`: o
 * lançamento de ajuste com a fatura do banco conta na fatura, mas não é compra (SPD-085,
 * E2E-06/10/15). O `expo-sqlite` vira um banco em memória do Node, como em
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

import { CARD_ADJUSTMENT_NOTE, CARD_CHARGE_NOTE, cardChargeNote, isCardCharge } from '../../utils/cardMath';
import { addAccount, addTransaction, db, getCardPurchasesOriginated, initDatabase } from '../database';
import type { AccountDraft } from '../schema';

const sqliteAvailable: boolean = jest.requireMock<{ mockSqliteAvailable: boolean }>('expo-sqlite').mockSqliteAvailable;
if (!sqliteAvailable) {
	console.warn('cardPurchasesSql.test.ts pulado: rode com NODE_OPTIONS=--experimental-sqlite (Node 22.12).');
}
const describeSql = sqliteAvailable ? describe : describe.skip;

const card: AccountDraft = {
	name: 'Nubank Teste',
	kind: 'credit_card',
	role: 'card',
	envelopeMonthlyCents: null,
	bankName: 'Nubank',
	color: '#820AD1',
	last4: null,
	network: null,
	closingDay: 10,
	dueDay: 17,
	closingDaysBefore: 7,
	creditLimitCents: null,
	cardNames: null,
	yieldCdiBp: null,
	reservePurpose: null,
	packageName: null,
	accountKey: null,
	openingBalanceCents: 0,
	openingBalanceDate: '2026-11-06',
	sortOrder: 0,
	archived: false,
};

describeSql('getCardPurchasesOriginated — ajuste não é compra', () => {
	beforeAll(async () => {
		jest.spyOn(console, 'log').mockImplementation(() => undefined);
		await initDatabase();
	});
	beforeEach(async () => {
		await db.execAsync('DELETE FROM transactions; DELETE FROM transfers; DELETE FROM accounts;');
	});

	it('Nubank: R$ 1.234,56 informado no cadastro + padaria de R$ 50 + compra de R$ 100 = R$ 150 comprados', async () => {
		const id = await addAccount(card);
		const add = (date: string, amountCents: number, isIncome: boolean, note: string, category: string) =>
			addTransaction({ accountId: id, date, amountCents, isIncome, note, category });
		await add('2026-11-07', 123_456, false, CARD_ADJUSTMENT_NOTE, 'other_expense');
		await add('2026-11-01', 5_000, false, 'Padaria dia 1', 'food');
		await add('2026-11-07', 10_000, false, 'Compra', 'shopping');
		expect(await getCardPurchasesOriginated(id, '2026-11-01', '2026-11-30')).toBe(15_000);
	});

	it('Inter: o acerto de −R$ 2.000 e +R$ 1.920 não vira R$ 2.000 comprados', async () => {
		const id = await addAccount({ ...card, name: 'Inter Teste', closingDay: 5 });
		await addTransaction({ accountId: id, date: '2026-11-07', amountCents: 200_000, isIncome: false, note: CARD_ADJUSTMENT_NOTE, category: 'other_expense' });
		await addTransaction({ accountId: id, date: '2026-11-07', amountCents: 192_000, isIncome: true, note: CARD_ADJUSTMENT_NOTE, category: 'other_income' });
		expect(await getCardPurchasesOriginated(id, '2026-11-01', '2026-11-30')).toBe(0);
	});

	// SPD-092: o encargo (juros, IOF, anuidade) está na fatura, mas não é compra — o mesmo
	// critério de `isCardCharge`, inclusive o que ele não reconhece.
	it('encargo do cartão não entra em "comprados"; nota só parecida entra', async () => {
		const id = await addAccount(card);
		const add = (amountCents: number, note: string) =>
			addTransaction({ accountId: id, date: '2026-11-07', amountCents, isIncome: false, note, category: 'other_expense' });
		await add(3_890, cardChargeNote('bank'));
		await add(2_500, cardChargeNote('annualFee'));
		await add(1_000, ` ${CARD_CHARGE_NOTE} `);
		await add(10_000, 'Compra');
		await add(700, `${CARD_CHARGE_NOTE} extra`);
		await add(300, 'encargo do cartão (juros)');
		const notes = [cardChargeNote('bank'), cardChargeNote('annualFee'), ` ${CARD_CHARGE_NOTE} `, 'Compra', `${CARD_CHARGE_NOTE} extra`, 'encargo do cartão (juros)'];
		const expected = notes.map((note, index) => ({ note, cents: [3_890, 2_500, 1_000, 10_000, 700, 300][index] }));
		const bought = expected.filter(({ note }) => !isCardCharge({ note })).reduce((sum, { cents }) => sum + cents, 0);
		expect(bought).toBe(11_000);
		expect(await getCardPurchasesOriginated(id, '2026-11-01', '2026-11-30')).toBe(bought);
	});
});
