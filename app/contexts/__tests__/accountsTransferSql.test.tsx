/**
 * Transferência manual entre contas suas (E2E-28), no SQL **de verdade** e no
 * `AccountsProvider` de verdade.
 *
 * O "+" só tinha Despesa e Receita: mandar R$ 1.000 da Corrente para a Reserva não tinha
 * como ser registrado. `saveTransfer` grava a transferência pelo mesmo `addTransfer` da
 * captura (linha suja, que a fila de sync leva); para um cartão de crédito como destino,
 * é o pagamento de fatura de sempre (`recordCardPayment`). Aqui a pergunta é o número
 * que a tela mostra depois: saldo das duas contas, receita e gasto do mês, "Guardado".
 *
 * Como em `accountSql.test.ts`, o `expo-sqlite` vira o `node:sqlite` em memória e a
 * suíte pede `NODE_OPTIONS=--experimental-sqlite`; sem a flag, é pulada com um aviso.
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
import { addAccount, addTransaction, db, getTransfers, initDatabase } from '../../database/database';
import type { AccountDraft } from '../../database/schema';
import * as syncQueue from '../../sync/queue';
import { AccountsProvider, useAccounts } from '../AccountsContext';

const sqliteAvailable: boolean = jest.requireMock<{ mockSqliteAvailable: boolean }>('expo-sqlite').mockSqliteAvailable;
if (!sqliteAvailable) {
	console.warn('accountsTransferSql.test.tsx pulado: rode com NODE_OPTIONS=--experimental-sqlite (Node 22.12).');
}
const describeSql = sqliteAvailable ? describe : describe.skip;

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
	openingBalanceDate: '2026-11-06',
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

describeSql('transferência manual entre contas (E2E-28)', () => {
	let corrente: string;
	let reserva: string;

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
		await db.execAsync('DELETE FROM transactions; DELETE FROM transfers; DELETE FROM accounts;');
		// O banco mostra R$ 3.000 na Corrente e R$ 1.000 na Reserva em 06/11. O salário de
		// R$ 8.000 e a compra de R$ 50 do mês já estão dentro desse saldo (antes da âncora).
		corrente = await addAccount(draft({ name: 'Corrente', openingBalanceCents: 300_000 }));
		reserva = await addAccount(draft({ name: 'Reserva', kind: 'savings', role: 'reserve', openingBalanceCents: 100_000, sortOrder: 1 }));
		await addTransaction({ accountId: corrente, date: '2026-11-05', amountCents: 800_000, isIncome: true, category: 'salary', note: '' });
		await addTransaction({ accountId: corrente, date: '2026-11-03', amountCents: 5_000, isIncome: false, category: 'food', note: '' });
		await mount();
	});

	afterEach(() => {
		act(() => renderer?.unmount());
		renderer = null;
		current = null;
		jest.useRealTimers();
	});

	it('R$ 1.000 da Corrente para a Reserva em 07/11: saldos 2.000 e 2.000, mês igual, Guardado +1.000', async () => {
		expect(ctx().balances.get(corrente)).toBe(300_000);
		expect(ctx().balances.get(reserva)).toBe(100_000);
		const before = ctx().month;
		expect(before?.incomeCents).toBe(800_000);
		expect(before?.totalSpendCents).toBe(5_000);
		expect(before?.savedCents).toBe(0);

		let saved: boolean | undefined;
		await act(async () => {
			saved = await ctx().saveTransfer({ fromAccountId: corrente, toAccountId: reserva, amountCents: 100_000, date: '2026-11-07', note: '' });
		});

		expect(saved).toBe(true);
		expect(ctx().balances.get(corrente)).toBe(200_000);
		expect(ctx().balances.get(reserva)).toBe(200_000);
		// Fora de receitas e despesas: dinheiro trocando de bolso.
		expect(ctx().month?.incomeCents).toBe(800_000);
		expect(ctx().month?.totalSpendCents).toBe(5_000);
		expect(ctx().month?.leftoverCents).toBe(795_000);
		// "Guardado" na tela inicial e "Guardado neste mês" na linha da Reserva.
		expect(ctx().month?.savedCents).toBe(100_000);
		expect(ctx().month?.reserves).toEqual([expect.objectContaining({ accountId: reserva, savedCents: 100_000 })]);
		// Lançamentos lista "Transferência · De Corrente para Reserva".
		expect(ctx().periodTransfers).toEqual([
			expect.objectContaining({ fromAccountId: corrente, toAccountId: reserva, amountCents: 100_000, date: '2026-11-07' }),
		]);
		// O mesmo caminho da captura: linha suja no banco e a fila de sync chamada.
		const row = await db.getFirstAsync<{ dirty: number }>('SELECT dirty FROM transfers');
		expect(row?.dirty).toBe(1);
		expect(syncQueue.schedule).toHaveBeenCalled();
	});

	it('editar a transferência muda os dois saldos; apagar devolve tudo como era', async () => {
		await act(async () => {
			await ctx().saveTransfer({ fromAccountId: corrente, toAccountId: reserva, amountCents: 100_000, date: '2026-11-07', note: '' });
		});
		const [created] = await getTransfers();

		await act(async () => {
			await ctx().saveTransfer({ id: created.id, fromAccountId: corrente, toAccountId: reserva, amountCents: 50_000, date: '2026-11-07', note: 'CDB' });
		});
		expect(await getTransfers()).toEqual([expect.objectContaining({ id: created.id, amountCents: 50_000, note: 'CDB' })]);
		expect(ctx().balances.get(corrente)).toBe(250_000);
		expect(ctx().balances.get(reserva)).toBe(150_000);
		expect(ctx().month?.savedCents).toBe(50_000);

		await act(async () => {
			await ctx().removeTransfer(created.id);
		});
		expect(await getTransfers()).toEqual([]);
		expect(ctx().balances.get(corrente)).toBe(300_000);
		expect(ctx().balances.get(reserva)).toBe(100_000);
		expect(ctx().month?.savedCents).toBe(0);
		expect(ctx().periodTransfers).toEqual([]);
		// A lápide também vai pela fila.
		const row = await db.getFirstAsync<{ dirty: number; deletedAt: string | null }>('SELECT dirty, deletedAt FROM transfers');
		expect(row?.dirty).toBe(1);
		expect(row?.deletedAt).not.toBeNull();
	});

	it('para um cartão de crédito é o pagamento de fatura: o mesmo pagamento duas vezes vira um só', async () => {
		const nubank = await addAccount(
			draft({ name: 'Nubank', kind: 'credit_card', role: 'card', closingDay: 25, closingDaysBefore: 7, openingBalanceCents: -120_000, sortOrder: 2 })
		);
		await act(async () => {
			await ctx().refresh();
		});
		const owedBefore = ctx().cardSummaries.get(nubank)?.owedCents;
		const spendBefore = ctx().month?.totalSpendCents;
		const incomeBefore = ctx().month?.incomeCents;

		let first: boolean | undefined;
		let second: boolean | undefined;
		await act(async () => {
			first = await ctx().saveTransfer({ fromAccountId: corrente, toAccountId: nubank, amountCents: 120_000, date: '2026-11-07', note: '' });
		});
		await act(async () => {
			second = await ctx().saveTransfer({ fromAccountId: corrente, toAccountId: nubank, amountCents: 120_000, date: '2026-11-07', note: '' });
		});

		expect(first).toBe(true);
		// Já estava registrado (como no botão "Pagar fatura"): não debita a Corrente de novo.
		expect(second).toBe(false);
		expect(await getTransfers()).toHaveLength(1);
		expect(ctx().balances.get(corrente)).toBe(180_000);
		expect(ctx().cardSummaries.get(nubank)?.owedCents).toBe((owedBefore ?? 0) - 120_000);
		// Pagar a fatura não é gasto do mês (a fatura já conta no cartão).
		expect(ctx().month?.totalSpendCents).toBe(spendBefore);
		expect(ctx().month?.incomeCents).toBe(incomeBefore);
	});

	it('recusa De igual a Para e valor zero sem gravar nada', async () => {
		await expect(
			ctx().saveTransfer({ fromAccountId: corrente, toAccountId: corrente, amountCents: 100_000, date: '2026-11-07', note: '' })
		).rejects.toThrow();
		await expect(
			ctx().saveTransfer({ fromAccountId: corrente, toAccountId: reserva, amountCents: 0, date: '2026-11-07', note: '' })
		).rejects.toThrow();
		expect(await getTransfers()).toEqual([]);
	});
});
