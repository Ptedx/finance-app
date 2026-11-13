/**
 * Repetidos depois de juntar cartões (SPD-124, lacunas do SPD-097 e do SPD-098), com o SQL
 * **de verdade** de `mergeCardInto` e a marcação de `cardDuplicates`.
 *
 * O Nubank Teste (final 1111) tem a padaria de R$ 50 que o aviso do banco lançou (final 1111)
 * e o pagamento de R$ 1.234,56 do "Pagar fatura". O extrato OFX criou outro cartão, com o fim
 * do ACCTID como final (4821), e pôs nele a mesma padaria, sem final, e o mesmo "Pagamento
 * recebido". Juntar leva tudo para o Nubank Teste e dá o final 4821 à padaria do extrato.
 * Antes, finais diferentes eram "duas compras", e pagamento nem entrava: nada era marcado.
 *
 * Como em `cardMergeSql.test.ts`, o `expo-sqlite` vira o `node:sqlite` em memória e a suíte
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
	addTransaction,
	addTransfer,
	db,
	getAccountTransactions,
	getAccountTransfers,
	initDatabase,
	mergeCardInto,
} from '../../database/database';
import type { AccountDraft } from '../../database/schema';
import { accountPairKey } from '../accountBinding';
import { cardPaymentEntries, findCardDuplicates, summarizeCardDuplicates } from '../cardDuplicates';

const sqliteAvailable: boolean = jest.requireMock<{ mockSqliteAvailable: boolean }>('expo-sqlite').mockSqliteAvailable;
if (!sqliteAvailable) {
	console.warn('cardDuplicatesMergeSql.test.ts pulado: rode com NODE_OPTIONS=--experimental-sqlite (Node 22.12).');
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

describeSql('repetidos depois de juntar cartões (SPD-124)', () => {
	let corrente: string;
	let nubank: string;
	let duplicado: string;

	beforeAll(async () => {
		jest.spyOn(console, 'log').mockImplementation(() => undefined);
		await initDatabase();
	});

	beforeEach(async () => {
		await db.execAsync('DELETE FROM transactions; DELETE FROM transfers; DELETE FROM accounts; DELETE FROM captures;');
		corrente = await addAccount(draft({ name: 'Corrente', kind: 'checking', role: 'main' }));
		nubank = await addAccount(draft({ name: 'Nubank Teste', last4: '1111', closingDay: 25, closingDaysBefore: 7 }));
		duplicado = await addAccount(
			draft({ name: 'NU PAGAMENTOS S.A. · cartão final 4821', bankName: 'NU PAGAMENTOS S.A.', last4: '4821', accountKey: '260:7f3a-4821' })
		);
		// O aviso do banco: a padaria no plástico final 1111. O extrato: a mesma, sem final.
		await addTransaction({ accountId: nubank, date: '2026-11-01', amountCents: 5_000, isIncome: false, category: 'food', note: 'PADARIA', cardLast4: '1111' });
		await addTransaction({ accountId: duplicado, date: '2026-11-01', amountCents: 5_000, isIncome: false, category: 'food', note: 'PADARIA' });
		await addTransaction({ accountId: duplicado, date: '2026-11-06', amountCents: 4_590, isIncome: false, category: 'health', note: 'DROGASIL' });
		// O mesmo pagamento: "Pagar fatura" no Nubank Teste e o "Pagamento recebido" do extrato.
		await addTransfer({ fromAccountId: corrente, toAccountId: nubank, amountCents: 123_456, date: '2026-11-05', note: '' });
		await addTransfer({ fromAccountId: null, toAccountId: duplicado, amountCents: 123_456, date: '2026-11-05', note: '' });
	});

	const marked = async () => {
		const transactions = await getAccountTransactions(nubank);
		const payments = cardPaymentEntries(await getAccountTransfers(nubank), nubank);
		return { transactions, payments, found: findCardDuplicates([...transactions, ...payments]) };
	};

	it('a padaria do extrato chega com o final 4821, e a do aviso tem 1111: as duas ficam marcadas', async () => {
		await mergeCardInto(duplicado, nubank);
		// Só os lançamentos, como a tela do cartão os tinha antes deste card.
		const transactions = await getAccountTransactions(nubank);
		const found = findCardDuplicates(transactions);

		const padarias = transactions.filter((tx) => tx.note === 'PADARIA');
		expect(padarias.map((tx) => tx.cardLast4).sort()).toEqual(['1111', '4821']);
		expect(found.pairs.map((pair) => pair.key)).toContainEqual(accountPairKey(padarias[0].id, padarias[1].id));
		expect(found.groups.some((group) => group.some((member) => member.id === transactions.find((tx) => tx.note === 'DROGASIL')?.id))).toBe(false);
	});

	it('os dois pagamentos de R$ 1.234,56 em 05/11 ficam no Nubank Teste e são marcados', async () => {
		await mergeCardInto(duplicado, nubank);
		const { payments, found } = await marked();

		expect(payments.map((payment) => payment.amountCents)).toEqual([123_456, 123_456]);
		expect(found.pairs.map((pair) => pair.key)).toContainEqual(accountPairKey(payments[0].id, payments[1].id));
		const summary = summarizeCardDuplicates(found.groups);
		// Padaria a mais na fatura; um pagamento a mais no "Pago".
		expect(summary.count).toBe(2);
		expect(summary.extraCents).toBe(5_000);
		expect(summary.paymentExtraCents).toBe(123_456);
	});

	it('a padaria e o pagamento nunca são par entre si', async () => {
		await mergeCardInto(duplicado, nubank);
		const { transactions, payments, found } = await marked();
		const purchaseIds = new Set(transactions.map((tx) => tx.id));
		const paymentIds = new Set(payments.map((payment) => payment.id));
		for (const pair of found.pairs) {
			expect(purchaseIds.has(pair.a)).toBe(purchaseIds.has(pair.b));
			expect(paymentIds.has(pair.a)).toBe(paymentIds.has(pair.b));
		}
	});
});
