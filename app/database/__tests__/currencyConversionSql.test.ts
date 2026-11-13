/**
 * Trocar de moeda com taxa converte **todo** valor em dinheiro guardado (SPD-140), no SQL de
 * verdade de `database.ts`.
 *
 * O achado: a troca convertia lançamentos, orçamentos, dívidas, contas a pagar e a meta de
 * aposentadoria, mas deixava de fora o saldo de partida das contas, o limite do cartão, o
 * valor do envelope, as transferências, a tarifa da dívida, o custo mensal da reserva e as
 * capturas. Depois de R$ → US$ a 0,20, a conta de R$ 1.000 de saldo de partida continuava
 * com 1.000 — agora em dólar — e o pagamento de fatura de R$ 250 abatia 250 de uma fatura
 * que já estava em dólar. Os números ficavam misturados.
 *
 * O `expo-sqlite` vira um banco em memória do Node (`node:sqlite`), como em
 * `stampSql.test.ts`; sem `NODE_OPTIONS=--experimental-sqlite` a suíte é pulada.
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

import { buildCardSummary, type CardEntry, type CardMovement, type CardSummary } from '../../utils/cardMath';
import { insertCapture } from '../captures';
import {
	addAccount,
	addBill,
	addDebt,
	addRecurringTransaction,
	addTransaction,
	addTransfer,
	convertAllAmounts,
	db,
	getAccount,
	getAccountBalances,
	getAccountTransactions,
	getAccountTransfers,
	hasFinancialData,
	initDatabase,
	setBudget,
	setReserveGoal,
	setRetirementGoal,
} from '../database';
import type { AccountDraft, BillDraft, Capture, DebtDraft, TransactionDraft } from '../schema';

const sqliteAvailable: boolean = jest.requireMock<{ mockSqliteAvailable: boolean }>('expo-sqlite').mockSqliteAvailable;
if (!sqliteAvailable) {
	console.warn('currencyConversionSql.test.ts pulado: rode com NODE_OPTIONS=--experimental-sqlite (Node 22.12).');
}
const describeSql = sqliteAvailable ? describe : describe.skip;

/** R$ → US$: 1 real vale 0,20 dólar. */
const RATE = 0.2;
/** Um "hoje" fixo, para o saldo e a fatura não dependerem do dia em que o teste roda. */
const TODAY = '2026-11-11';
/** O carimbo que as linhas têm antes da troca, como se tivessem acabado de descer do servidor. */
const PULLED_AT = '2026-01-01T00:00:00.000Z';

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
	openingBalanceDate: '2026-10-01',
	sortOrder: 0,
	archived: false,
	...overrides,
});

const purchase = (overrides: Partial<TransactionDraft> = {}): TransactionDraft => ({
	amountCents: 12_345,
	category: 'food',
	date: '2026-10-10',
	note: '',
	isIncome: false,
	...overrides,
});

const debt = (overrides: Partial<DebtDraft> = {}): DebtDraft => ({
	name: 'Financiamento do carro',
	kind: 'financing',
	system: 'price',
	openingBalanceCents: 2_000_000,
	openingBalanceDate: '2026-10-15',
	installmentCents: 85_000,
	remainingAtOpening: 30,
	installmentsTotal: 48,
	dueDay: 15,
	rateBp: 1_800,
	feeCents: 3_500,
	adminFeeBp: null,
	accountId: null,
	category: null,
	archived: false,
	sortOrder: 0,
	...overrides,
});

const bill = (overrides: Partial<BillDraft> = {}): BillDraft => ({
	name: 'Internet',
	dueDay: 10,
	amountCents: 9_990,
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

const capture = (overrides: Partial<Capture> = {}): Omit<Capture, 'id' | 'createdAt' | 'updatedAt'> => ({
	fingerprint: `fp-${Math.random()}`,
	packageName: 'com.example.banco',
	appLabel: 'Banco',
	title: 'Banco',
	text: 'Compra aprovada: R$ 45,00 em LOJA ABC.',
	postedAt: '2026-11-05T15:00:00.000Z',
	amountCents: 4_500,
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

type Stamped = { updatedAt: string; dirty: number };

const ALL_TABLES = [
	'transactions',
	'recurring_transactions',
	'transfers',
	'accounts',
	'budgets',
	'retirement_goals',
	'reserve_goals',
	'debts',
	'bills',
	'captures',
] as const;

const wipe = async () => {
	await db.execAsync(ALL_TABLES.map((table) => `DELETE FROM ${table};`).join('\n'));
};

/** Todas as linhas como se tivessem acabado de descer: carimbo antigo e limpas. */
const markPulled = async () => {
	for (const table of ALL_TABLES) {
		await db.runAsync(`UPDATE ${table} SET updatedAt = ?, dirty = 0`, [PULLED_AT]);
	}
};

const one = async <T>(sql: string, params: Array<string | number | null> = []): Promise<T> => (await db.getFirstAsync<T>(sql, params)) as T;

/** O resumo do cartão como a tela monta: a âncora, os lançamentos e as transferências dele. */
const cardSummaryOf = async (cardId: string): Promise<CardSummary> => {
	const card = await getAccount(cardId);
	if (!card) throw new Error('cartão sumiu');
	const entries: CardEntry[] = (await getAccountTransactions(cardId)).map((tx) => ({
		id: tx.id,
		amountCents: tx.amountCents,
		isIncome: tx.isIncome,
		date: tx.date,
		note: tx.note ?? '',
		category: tx.category,
		installmentGroup: tx.installmentGroup ?? null,
		installmentIndex: tx.installmentIndex ?? null,
		installmentCount: tx.installmentCount ?? null,
	}));
	const movements: CardMovement[] = (await getAccountTransfers(cardId)).map((transfer) => ({
		amountCents: transfer.amountCents,
		date: transfer.date,
		inbound: transfer.toAccountId === cardId,
	}));
	return buildCardSummary(card, entries, movements, TODAY);
};

/** A base do card: uma de cada coisa que guarda dinheiro. */
const seed = async () => {
	const checkingId = await addAccount(account({ name: 'Conta corrente', openingBalanceCents: 100_000 }));
	const cardId = await addAccount(
		account({
			name: 'Cartão',
			kind: 'credit_card',
			role: 'card',
			closingDay: 5,
			dueDay: 12,
			closingDaysBefore: 7,
			creditLimitCents: 500_000,
			// Fatura informada no cadastro: o cartão devia R$ 400.
			openingBalanceCents: -40_000,
		})
	);
	const envelopeId = await addAccount(account({ name: 'Mercado', role: 'envelope', envelopeMonthlyCents: 30_000 }));

	const transactionId = await addTransaction(purchase({ accountId: cardId }));
	// Pagamento da fatura: da conta corrente para o cartão.
	const transferId = await addTransfer({
		fromAccountId: checkingId,
		toAccountId: cardId,
		amountCents: 25_000,
		date: '2026-10-20',
		note: '',
	});
	const recurringId = await addRecurringTransaction({
		amountCents: 5_000,
		isIncome: false,
		note: 'Academia',
		category: 'food',
		recurrenceType: 'monthly',
		day: 5,
		active: true,
	});
	const debtId = await addDebt(debt());
	const billId = await addBill(bill());
	const variableBillId = await addBill(bill({ name: 'Celular', amountCents: null }));
	const budgetId = await setBudget(2026, 11, 150_000);
	await setRetirementGoal({ targetMonthlyCents: 1_000_000, reinvestBp: 2_500, expectedYieldBp: 1_000, outsideCapitalCents: 500_000 });
	await setReserveGoal({ targetMonths: 6, customMonthlyCostCents: 450_000 });
	const pending = await insertCapture(capture({ accountId: cardId }));

	return { checkingId, cardId, envelopeId, transactionId, transferId, recurringId, debtId, billId, variableBillId, budgetId, captureId: pending.id };
};

describeSql('troca de moeda com taxa converte todo valor em dinheiro (SPD-140)', () => {
	beforeAll(async () => {
		jest.spyOn(console, 'log').mockImplementation(() => undefined);
		await initDatabase();
	});
	beforeEach(wipe);

	it('R$ → US$ a 0,20: cada valor guardado vira 0,20 do que era', async () => {
		const ids = await seed();

		await convertAllAmounts(RATE);

		const accountOf = (id: string) =>
			one<{ openingBalanceCents: number; creditLimitCents: number | null; envelopeMonthlyCents: number | null }>(
				'SELECT openingBalanceCents, creditLimitCents, envelopeMonthlyCents FROM accounts WHERE id = ?',
				[id]
			);
		// Saldo de partida R$ 1.000,00 → US$ 200,00.
		expect(await accountOf(ids.checkingId)).toEqual({ openingBalanceCents: 20_000, creditLimitCents: null, envelopeMonthlyCents: null });
		// Limite R$ 5.000,00 → US$ 1.000,00; fatura informada R$ 400,00 → US$ 80,00.
		expect(await accountOf(ids.cardId)).toEqual({ openingBalanceCents: -8_000, creditLimitCents: 100_000, envelopeMonthlyCents: null });
		// Envelope R$ 300,00 → US$ 60,00.
		expect(await accountOf(ids.envelopeId)).toEqual({ openingBalanceCents: 0, creditLimitCents: null, envelopeMonthlyCents: 6_000 });

		// Transferência R$ 250,00 → US$ 50,00.
		expect(await one('SELECT amountCents FROM transfers WHERE id = ?', [ids.transferId])).toEqual({ amountCents: 5_000 });
		// Lançamento R$ 123,45 → US$ 24,69.
		expect(await one('SELECT amountCents FROM transactions WHERE id = ?', [ids.transactionId])).toEqual({ amountCents: 2_469 });
		expect(await one('SELECT amountCents FROM recurring_transactions WHERE id = ?', [ids.recurringId])).toEqual({ amountCents: 1_000 });
		// Dívida: saldo R$ 20.000 → US$ 4.000, parcela R$ 850 → US$ 170, tarifa R$ 35 → US$ 7.
		expect(await one('SELECT openingBalanceCents, installmentCents, feeCents FROM debts WHERE id = ?', [ids.debtId])).toEqual({
			openingBalanceCents: 400_000,
			installmentCents: 17_000,
			feeCents: 700,
		});
		expect(await one('SELECT amountCents FROM bills WHERE id = ?', [ids.billId])).toEqual({ amountCents: 1_998 });
		// A conta que varia continua sem valor.
		expect(await one('SELECT amountCents FROM bills WHERE id = ?', [ids.variableBillId])).toEqual({ amountCents: null });
		expect(await one('SELECT amountCents FROM budgets WHERE id = ?', [ids.budgetId])).toEqual({ amountCents: 30_000 });
		expect(await one('SELECT targetMonthlyCents, outsideCapitalCents, reinvestBp, expectedYieldBp FROM retirement_goals')).toEqual({
			targetMonthlyCents: 200_000,
			outsideCapitalCents: 100_000,
			// Percentuais não convertem.
			reinvestBp: 2_500,
			expectedYieldBp: 1_000,
		});
		// Custo mensal da reserva R$ 4.500 → US$ 900; os meses não mudam.
		expect(await one('SELECT targetMonths, customMonthlyCostCents FROM reserve_goals')).toEqual({ targetMonths: 6, customMonthlyCostCents: 90_000 });
		// O aviso pendente de R$ 45,00 já conta no saldo do cartão: vira US$ 9,00.
		expect(await one('SELECT amountCents FROM captures WHERE id = ?', [ids.captureId])).toEqual({ amountCents: 900 });
	});

	it('o saldo de cada conta e a fatura do cartão depois da troca são os de antes × 0,20', async () => {
		const ids = await seed();
		const balancesBefore = await getAccountBalances(TODAY);
		const cardBefore = await cardSummaryOf(ids.cardId);
		// Conferência da base: R$ 1.000 − R$ 250 na conta; R$ 400 + R$ 123,45 − R$ 250 no cartão.
		expect(balancesBefore.get(ids.checkingId)).toBe(75_000);
		expect(balancesBefore.get(ids.cardId)).toBe(-27_345);
		expect(cardBefore.owedCents).toBe(27_345);
		expect(cardBefore.limitAvailableCents).toBe(500_000 - 27_345);
		// A fatura fechada em novembro tem a compra de R$ 123,45.
		expect(cardBefore.closedInvoiceCents).toBe(12_345);

		await convertAllAmounts(RATE);

		const balancesAfter = await getAccountBalances(TODAY);
		for (const id of [ids.checkingId, ids.cardId, ids.envelopeId]) {
			expect(balancesAfter.get(id)).toBe(Math.round((balancesBefore.get(id) ?? 0) * RATE));
		}
		expect(balancesAfter.get(ids.checkingId)).toBe(15_000);
		expect(balancesAfter.get(ids.cardId)).toBe(-5_469);

		const cardAfter = await cardSummaryOf(ids.cardId);
		expect(cardAfter.owedCents).toBe(5_469);
		expect(cardAfter.limitCents).toBe(100_000);
		expect(cardAfter.limitAvailableCents).toBe(100_000 - 5_469);
		expect(cardAfter.limitUsagePercent).toBe(cardBefore.limitUsagePercent);
		expect(cardAfter.toPayCents).toBe(Math.round(cardBefore.toPayCents * RATE));
		expect(cardAfter.openInvoiceCents).toBe(Math.round(cardBefore.openInvoiceCents * RATE));
		expect(cardAfter.closedInvoiceCents).toBe(2_469);
		expect(cardAfter.invoices.map((invoice) => [invoice.cycle.key, invoice.amountCents])).toEqual(
			cardBefore.invoices.map((invoice) => [invoice.cycle.key, Math.round(invoice.amountCents * RATE)])
		);
	});

	it('arredonda para o centavo como o resto da conversão, inclusive valor negativo', async () => {
		// 1.003 × 0,2 = 200,6 → 201; −1.003 × 0,2 = −200,6 → −201.
		const id = await addAccount(account({ kind: 'credit_card', role: 'card', openingBalanceCents: -1_003, creditLimitCents: 1_003 }));
		const envelopeId = await addAccount(account({ role: 'envelope', envelopeMonthlyCents: 1_003 }));
		const transferId = await addTransfer({ fromAccountId: id, toAccountId: null, amountCents: 1_003, date: '2026-10-20', note: '' });
		const transactionId = await addTransaction(purchase({ amountCents: 1_003 }));

		await convertAllAmounts(RATE);

		expect(await one('SELECT openingBalanceCents, creditLimitCents FROM accounts WHERE id = ?', [id])).toEqual({
			openingBalanceCents: -201,
			creditLimitCents: 201,
		});
		expect(await one('SELECT envelopeMonthlyCents FROM accounts WHERE id = ?', [envelopeId])).toEqual({ envelopeMonthlyCents: 201 });
		expect(await one('SELECT amountCents FROM transfers WHERE id = ?', [transferId])).toEqual({ amountCents: 201 });
		expect(await one('SELECT amountCents FROM transactions WHERE id = ?', [transactionId])).toEqual({ amountCents: 201 });
	});

	it('cada linha convertida sai carimbada e suja, para a mudança viajar no sync', async () => {
		const ids = await seed();
		await markPulled();
		// Uma conta com carimbo de relógio adiantado: a conversão tem de passar dele (SPD-107/127).
		const ahead = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
		await db.runAsync('UPDATE accounts SET updatedAt = ? WHERE id = ?', [ahead, ids.checkingId]);
		const before = new Date().toISOString();

		await convertAllAmounts(RATE);

		const stampOf = (table: string, id: string) => one<Stamped>(`SELECT updatedAt, dirty FROM ${table} WHERE id = ?`, [id]);
		const converted: Array<[table: string, id: string]> = [
			['accounts', ids.cardId],
			['accounts', ids.envelopeId],
			['transfers', ids.transferId],
			['transactions', ids.transactionId],
			['recurring_transactions', ids.recurringId],
			['debts', ids.debtId],
			['bills', ids.billId],
			['budgets', ids.budgetId],
			['retirement_goals', 'retirement'],
			['reserve_goals', 'emergency'],
			['captures', ids.captureId],
		];
		for (const [table, id] of converted) {
			const row = await stampOf(table, id);
			expect({ table, dirty: row.dirty, fresh: row.updatedAt >= before }).toEqual({ table, dirty: 1, fresh: true });
		}
		const aheadRow = await stampOf('accounts', ids.checkingId);
		expect(aheadRow.dirty).toBe(1);
		expect(aheadRow.updatedAt).toBe(new Date(new Date(ahead).getTime() + 1).toISOString());
	});

	it('linha apagada fica como está: a lápide não muda nem volta a subir', async () => {
		const id = await addAccount(account({ openingBalanceCents: 100_000 }));
		const transferId = await addTransfer({ fromAccountId: id, toAccountId: null, amountCents: 25_000, date: '2026-10-20', note: '' });
		await db.runAsync('UPDATE accounts SET deletedAt = ?, updatedAt = ?, dirty = 0 WHERE id = ?', [PULLED_AT, PULLED_AT, id]);
		await db.runAsync('UPDATE transfers SET deletedAt = ?, updatedAt = ?, dirty = 0 WHERE id = ?', [PULLED_AT, PULLED_AT, transferId]);

		await convertAllAmounts(RATE);

		expect(await one('SELECT openingBalanceCents, updatedAt, dirty FROM accounts WHERE id = ?', [id])).toEqual({
			openingBalanceCents: 100_000,
			updatedAt: PULLED_AT,
			dirty: 0,
		});
		expect(await one('SELECT amountCents, updatedAt, dirty FROM transfers WHERE id = ?', [transferId])).toEqual({
			amountCents: 25_000,
			updatedAt: PULLED_AT,
			dirty: 0,
		});
	});

	it('taxa inválida não mexe em nada', async () => {
		const ids = await seed();
		for (const rate of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			await expect(convertAllAmounts(rate)).rejects.toThrow();
		}
		expect(await one('SELECT openingBalanceCents FROM accounts WHERE id = ?', [ids.checkingId])).toEqual({ openingBalanceCents: 100_000 });
		expect(await one('SELECT amountCents FROM transfers WHERE id = ?', [ids.transferId])).toEqual({ amountCents: 25_000 });
	});
});

describeSql('quando a troca pergunta a taxa: há algum valor guardado (SPD-140)', () => {
	beforeAll(async () => {
		jest.spyOn(console, 'log').mockImplementation(() => undefined);
		await initDatabase();
	});
	beforeEach(wipe);

	it('base vazia, ou só com conta zerada: não há o que converter', async () => {
		expect(await hasFinancialData()).toBe(false);
		await addAccount(account());
		expect(await hasFinancialData()).toBe(false);
	});

	// Antes só lançamentos e recorrentes contavam: quem tinha só o saldo de partida das contas
	// trocava de moeda sem ser perguntado, e R$ 1.000 viravam US$ 1.000.
	it.each<[string, () => Promise<unknown>]>([
		['saldo de partida', () => addAccount(account({ openingBalanceCents: 100_000 }))],
		['limite do cartão', () => addAccount(account({ kind: 'credit_card', role: 'card', creditLimitCents: 500_000 }))],
		['valor do envelope', () => addAccount(account({ role: 'envelope', envelopeMonthlyCents: 30_000 }))],
		['transferência', () => addTransfer({ fromAccountId: null, toAccountId: null, amountCents: 25_000, date: '2026-10-20', note: '' })],
		['dívida', () => addDebt(debt())],
		['conta a pagar', () => addBill(bill())],
		['orçamento', () => setBudget(2026, 11, 150_000)],
		[
			'meta de aposentadoria',
			() => setRetirementGoal({ targetMonthlyCents: 1_000_000, reinvestBp: 2_500, expectedYieldBp: 1_000, outsideCapitalCents: 0 }),
		],
		['custo da reserva', () => setReserveGoal({ targetMonths: 6, customMonthlyCostCents: 450_000 })],
		['aviso na caixa de entrada', () => insertCapture(capture())],
	])('%s já é valor a converter', async (_label, add) => {
		await add();
		expect(await hasFinancialData()).toBe(true);
	});

	it('meta da reserva só com os meses (custo calculado) não é valor guardado', async () => {
		await setReserveGoal({ targetMonths: 6, customMonthlyCostCents: null });
		expect(await hasFinancialData()).toBe(false);
	});

	it('o que foi apagado não conta', async () => {
		const id = await addAccount(account({ openingBalanceCents: 100_000 }));
		await db.runAsync('UPDATE accounts SET deletedAt = ? WHERE id = ?', [PULLED_AT, id]);
		expect(await hasFinancialData()).toBe(false);
	});
});
