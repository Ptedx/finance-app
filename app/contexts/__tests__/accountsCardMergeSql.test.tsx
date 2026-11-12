/**
 * Juntar dois cartões (E2E-34, SPD-097), no SQL **de verdade** e no `AccountsProvider` de
 * verdade. A pergunta é o número da tela: depois de juntar o duplicado do OFX no "Nubank
 * Teste", a fatura aberta é R$ 195,90 — o `LEDGERBAL` do extrato, o que o banco diz —, e
 * não R$ 195,90 mais o ajuste que o duplicado tinha com a fatura **dele**.
 *
 * Como em `accountsTransferSql.test.tsx`, o `expo-sqlite` vira o `node:sqlite` em memória
 * e a suíte pede `NODE_OPTIONS=--experimental-sqlite`; sem a flag, é pulada com um aviso.
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

jest.mock('@react-native-async-storage/async-storage', () =>
	require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('../../sync/queue', () => ({ schedule: jest.fn() }));
jest.mock('../../hooks/useAfterPull', () => ({ useAfterPull: jest.fn() }));
jest.mock('../../api/cdi', () => ({
	loadCachedCdi: jest.fn(async () => null),
	refreshCdi: jest.fn(async () => null),
}));

// A mesma lista a cada render: uma nova dispararia a recarga sem parar.
const mockLedger = {
	transactions: [],
	categories: [],
	refreshData: jest.fn(async () => undefined),
};
jest.mock('../TransactionsContext', () => ({ useTransactions: () => mockLedger }));
const mockPeriod = { startDate: '2026-11-01', endDate: '2026-11-30' };
jest.mock('../PeriodContext', () => ({ usePeriod: () => mockPeriod }));

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { addAccount, addTransaction, db, initDatabase } from '../../database/database';
import type { AccountDraft } from '../../database/schema';
import * as syncQueue from '../../sync/queue';
import { CARD_ADJUSTMENT_NOTE } from '../../utils/cardMath';
import { AccountsProvider, useAccounts } from '../AccountsContext';

const sqliteAvailable: boolean = jest.requireMock<{ mockSqliteAvailable: boolean }>('expo-sqlite').mockSqliteAvailable;
if (!sqliteAvailable) {
	console.warn('accountsCardMergeSql.test.tsx pulado: rode com NODE_OPTIONS=--experimental-sqlite (Node 22.12).');
}
const describeSql = sqliteAvailable ? describe : describe.skip;

const draft = (overrides: Partial<AccountDraft> = {}): AccountDraft => ({
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

type Accounts = ReturnType<typeof useAccounts>;
let current: Accounts | null = null;
const Probe = () => {
	current = useAccounts();
	return null;
};
const ctx = (): Accounts => {
	if (!current) throw new Error('provider não montou');
	return current;
};

let renderer: ReactTestRenderer | null = null;

/** Deixa a recarga inicial do provider terminar (só o relógio é falso). */
const settle = async () => {
	for (let i = 0; i < 6; i++) {
		await act(async () => {
			await new Promise((resolve) => setImmediate(resolve));
		});
	}
};

const mount = async () => {
	await act(async () => {
		renderer = create(
			<AccountsProvider>
				<Probe />
			</AccountsProvider>
		);
	});
	await settle();
};

describeSql('juntar o cartão duplicado do OFX no Nubank Teste (E2E-34)', () => {
	let nubank: string;
	let duplicado: string;

	beforeAll(async () => {
		jest.spyOn(console, 'log').mockImplementation(() => undefined);
		await initDatabase();
	});

	beforeEach(async () => {
		// Só o relógio é falso (hoje = 07/11/2026): com os timers falsos o `act` não termina.
		jest.useFakeTimers({
			now: new Date(2026, 10, 7, 12, 0, 0),
			doNotFake: [
				'hrtime',
				'nextTick',
				'performance',
				'queueMicrotask',
				'requestAnimationFrame',
				'cancelAnimationFrame',
				'requestIdleCallback',
				'cancelIdleCallback',
				'setImmediate',
				'clearImmediate',
				'setInterval',
				'clearInterval',
				'setTimeout',
				'clearTimeout',
			],
		});
		jest.clearAllMocks();
		await db.execAsync('DELETE FROM transactions; DELETE FROM transfers; DELETE FROM accounts; DELETE FROM captures;');
		// Fecha dia 25 e vence 7 dias depois: 01/11 a 07/11 estão na fatura aberta de novembro.
		nubank = await addAccount(
			draft({ name: 'Nubank Teste', closingDay: 25, closingDaysBefore: 7, dueDay: 2, creditLimitCents: 500_000 })
		);
		duplicado = await addAccount(
			draft({ name: 'NU PAGAMENTOS S.A. · cartão final 1111', bankName: 'NU PAGAMENTOS S.A.', accountKey: 'e2e-1111', sortOrder: 1 })
		);
		await addTransaction({ accountId: nubank, date: '2026-11-01', amountCents: 5_000, isIncome: false, category: 'food', note: 'Padaria' });
		await addTransaction({ accountId: nubank, date: '2026-11-07', amountCents: 10_000, isIncome: false, category: 'food', note: 'Supermercado' });
		await addTransaction({ accountId: duplicado, date: '2026-11-06', amountCents: 4_590, isIncome: false, category: 'health', note: 'Drogasil' });
		// O duplicado foi "acertado com o banco" por conta própria: R$ 150 de ajuste nele.
		await addTransaction({ accountId: duplicado, date: '2026-11-07', amountCents: 15_000, isIncome: false, category: 'other_expense', note: CARD_ADJUSTMENT_NOTE });
		await mount();
	});

	afterEach(() => {
		act(() => renderer?.unmount());
		renderer = null;
		current = null;
		jest.useRealTimers();
	});

	it('antes: dois "final 1111"; depois: só o Nubank Teste, com a dívida dos dois somada (R$ 150 + R$ 195,90)', async () => {
		expect(ctx().creditCards.map((card) => card.name)).toEqual(['Nubank Teste', 'NU PAGAMENTOS S.A. · cartão final 1111']);
		expect(ctx().cardSummaries.get(nubank)?.openInvoiceCents).toBe(15_000);

		await act(async () => {
			await ctx().mergeCards(duplicado, nubank);
		});

		expect(ctx().creditCards.map((card) => card.name)).toEqual(['Nubank Teste']);
		expect(ctx().accounts.some((account) => account.id === duplicado)).toBe(false);
		const summary = ctx().cardSummaries.get(nubank);
		// Padaria 50 + Supermercado 100 + Drogasil 45,90 + o ajuste de R$ 150 do duplicado: o que os
		// dois deviam antes (SPD-152). Antes o ajuste sumia e a dívida caía R$ 150 sem aviso; se os
		// dois eram a mesma fatura, a confirmação diz a soma e o "Acertar valor" corrige depois.
		expect(summary?.openInvoiceCents).toBe(34_590);
		expect(summary?.owedCents).toBe(34_590);
		expect(summary?.limitAvailableCents).toBe(500_000 - 34_590);
		expect(ctx().cardSummaries.has(duplicado)).toBe(false);
		// O que fica mantém o próprio ciclo e limite.
		expect(ctx().accounts.find((account) => account.id === nubank)).toEqual(
			expect.objectContaining({ closingDay: 25, closingDaysBefore: 7, creditLimitCents: 500_000, accountKey: 'e2e-1111' })
		);
		expect(syncQueue.schedule).toHaveBeenCalled();
	});

	it('juntar com uma conta que não é cartão não faz nada', async () => {
		const corrente = await addAccount(draft({ name: 'Corrente', kind: 'checking', role: 'main', last4: null, sortOrder: 2 }));
		await act(async () => {
			await ctx().refresh();
		});
		await act(async () => {
			await ctx().mergeCards(duplicado, corrente);
		});
		expect(ctx().creditCards.map((card) => card.name)).toEqual(['Nubank Teste', 'NU PAGAMENTOS S.A. · cartão final 1111']);
	});
});
