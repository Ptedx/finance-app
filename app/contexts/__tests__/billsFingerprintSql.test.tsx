/**
 * Pular um mês e pagar fora de ordem (SPD-146), no SQL **de verdade**, com o `AccountsProvider`
 * e o `BillsProvider` de verdade e a "impressão digital financeira" de
 * `accountsCloseSql.test.tsx` (copiada: saldos, "Em caixa", patrimônio, cartões, "Este mês", a
 * série dos Relatórios, médias, reserva, aposentadoria, saúde e o patrimônio passado).
 *
 * - "Não vou pagar este mês" não mexe em número nenhum: só grava o mês.
 * - "Pagar só novembro" com outubro em aberto acrescenta **só** o lançamento dele: tirando esse
 *   lançamento, a impressão digital volta a ser a de antes; e o desfazer volta tudo.
 *
 * Hoje é 11/11/2026. Corrente com âncora de R$ 3.000 em 30/09, salário de R$ 5.000 em 05/10 e
 * 05/11, mercado de R$ 400 em 03/11; Reserva recebeu R$ 1.000 em 06/10; cartão com compra de
 * R$ 250 em 20/10. O Plano (R$ 500, dia 10, pago pela Corrente) está pago até setembro:
 * outubro e novembro em aberto.
 *
 * Como em `accountSql.test.ts`, o `expo-sqlite` vira o `node:sqlite` em memória e a suíte pede
 * `NODE_OPTIONS=--experimental-sqlite`; sem a flag, é pulada com um aviso.
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
			return {
				execAsync: async (sql: string) => {
					raw.exec(sql);
				},
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
jest.mock('../../sync/queue', () => ({
	schedule: jest.fn(),
	getState: () => ({ status: 'idle' }),
}));
jest.mock('../../hooks/useAfterPull', () => ({ useAfterPull: jest.fn() }));
// Sem CDI, nenhuma conta rende.
const mockCdiRate: { annualBp: number; date: string; fetchedAt: string } | null = null;
jest.mock('../../api/cdi', () => ({
	loadCachedCdi: jest.fn(async () => mockCdiRate),
	refreshCdi: jest.fn(async () => mockCdiRate),
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

jest.mock('../SyncContext', () => ({ useSync: () => ({ lastSyncedAt: null }) }));
jest.mock('../../utils/notificationUtils', () => ({
	...jest.requireActual('../../utils/notificationUtils'),
	scheduleBillReminders: jest.fn(async () => 0),
	scheduleCardReminders: jest.fn(async () => 0),
}));

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { getPendingCaptures } from '../../database/captures';
import {
	addAccount,
	addBill,
	addTransaction,
	addTransfer,
	db,
	getAccountBalances,
	getAccounts,
	getBillPayments,
	getBills,
	getMonthlyAccountActivity,
	getMonthlyTransferActivity,
	getTransactionsForAccounts,
	getTransfersByDateRange,
	getUnassignedNet,
	initDatabase,
} from '../../database/database';
import type { AccountDraft, BillDraft } from '../../database/schema';
import { netWorth, owedCents, provisionalEntriesByAccount } from '../../utils/accountMath';
import type { CardEntry } from '../../utils/cardMath';
import { monthKeyOf, monthKeyRange, todayISO } from '../../utils/dateUtils';
import { buildReserveReadModel, contributionDelayMonths } from '../../utils/emergencyReserve';
import { buildHealthIndicators } from '../../utils/healthScore';
import {
	averageClosedMonths,
	averageReserveCapitalCents,
	buildMonthSeries,
	investmentIncomeRows,
	monthElapsedBp,
	monthKeysEnding,
	monthRangeOf,
	toCardEntry,
	withProvisionalActivity,
	yield12m,
} from '../../utils/reportSeries';
import { buildRetirementReadModel, monthlyRate } from '../../utils/retirement';
import { AccountsProvider, useAccounts } from '../AccountsContext';
import { BillsProvider, markPaidTransactionId, useBills } from '../BillsContext';

const sqliteAvailable: boolean = jest.requireMock<{ mockSqliteAvailable: boolean }>(
	'expo-sqlite'
).mockSqliteAvailable;
if (!sqliteAvailable) {
	console.warn(
		'billsFingerprintSql.test.tsx pulado: rode com NODE_OPTIONS=--experimental-sqlite (Node 22.12).'
	);
}
const describeSql = sqliteAvailable ? describe : describe.skip;

jest.setTimeout(30_000);

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
	openingBalanceDate: '2026-09-30',
	sortOrder: 0,
	archived: false,
	...overrides,
});

type Accounts = ReturnType<typeof useAccounts>;
type Bills = ReturnType<typeof useBills>;
let current: Accounts | null = null;
let currentBills: Bills | null = null;
const Probe = () => {
	current = useAccounts();
	currentBills = useBills();
	return null;
};
const ctx = (): Accounts => {
	if (!current) throw new Error('provider não montou');
	return current;
};
const bills = (): Bills => {
	if (!currentBills) throw new Error('provider não montou');
	return currentBills;
};

let renderer: ReactTestRenderer | null = null;

/** Deixa a recarga dos providers terminar (só o relógio é falso). */
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
				<BillsProvider>
					<Probe />
				</BillsProvider>
			</AccountsProvider>
		);
	});
	await settle();
};

const reload = async () => {
	await act(async () => {
		await ctx().refresh();
	});
	await settle();
};

// ---------------------------------------------------------------------------
// A impressão digital financeira
// ---------------------------------------------------------------------------

/** O custo essencial da reserva e a meta de aposentadoria são fixos: o que varia é o dinheiro. */
const RESERVE_COST = { cents: 300_000, source: 'custom' as const };
const GOAL = {
	targetMonthlyCents: 500_000,
	reinvestBp: 2_500,
	expectedYieldBp: 1_000,
	outsideCapitalCents: 0,
};

interface FingerprintOptions {
	/** Contas cujo saldo muda de propósito (as duas pontas da transferência de encerramento). */
	skipBalances?: string[];
}

/**
 * Todos os números que o usuário vê, calculados com as mesmas funções das telas: o saldo de
 * cada conta e "Em caixa"/"Depois das faturas" (AccountsContext), o patrimônio (a conta da
 * tela de Patrimônio), cada cartão (fatura aberta, fechada, falta pagar, limite e as faturas
 * uma a uma), "Este mês", a série de 13 meses dos Relatórios (receita, gasto, guardado,
 * rendimento, sobra), as médias, a reserva, a projeção da aposentadoria, a saúde financeira e
 * o patrimônio no fim de cada mês fechado.
 *
 * O patrimônio passado não tem tela; aqui é o saldo de **todas** as contas vivas no fim do
 * mês (inclusive as encerradas: o dinheiro estava lá), mais os "Sem conta", menos o que os
 * cartões deviam. É a medida de que o passado não foi reescrito.
 */
const fingerprint = async (options: FingerprintOptions = {}) => {
	const skip = new Set(options.skipBalances ?? []);
	const c = ctx();
	const today = todayISO();
	const todayKey = monthKeyOf(today);
	const live = await getAccounts();

	const balances = Object.fromEntries(
		[...c.balances].filter(([id]) => !skip.has(id)).sort(([a], [b]) => a.localeCompare(b))
	);

	const cards = Object.fromEntries(
		[...c.cardSummaries].map(([id, summary]) => [
			id,
			{
				owed: summary.owedCents,
				toPay: summary.toPayCents,
				open: summary.openInvoiceCents,
				closed: summary.closedInvoiceCents,
				closedStatus: summary.closedStatus,
				future: summary.futureCommittedCents,
				limitUsed: summary.limitUsedCents,
				limitAvailable: summary.limitAvailableCents,
				invoices: summary.invoices.map((invoice) => JSON.stringify(invoice)),
			},
		])
	);
	let cardsCents = 0;
	for (const summary of c.cardSummaries.values())
		cardsCents += summary.owedCents + summary.futureCommittedCents;
	const worth = netWorth({
		cashCents: c.overview.cashCents,
		savedCents: c.overview.savedCents,
		outsideCents: 0,
		cardsCents,
		debtsCents: 0,
	});

	// A série dos Relatórios, como `useReportsData` com a âncora em hoje.
	const months = monthKeysEnding(todayKey, 13);
	const { startDate, endDate } = monthRangeOf(months);
	const cardIds = live
		.filter((account) => account.kind === 'credit_card')
		.map((account) => account.id);
	const reserveIds = live
		.filter((account) => account.kind !== 'credit_card' && account.role === 'reserve')
		.map((account) => account.id);
	const [activity, transfers, ledgerTransactions, transferLines, pending] = await Promise.all([
		getMonthlyAccountActivity(startDate, endDate),
		getMonthlyTransferActivity(startDate, endDate),
		getTransactionsForAccounts([...cardIds, ...reserveIds]),
		getTransfersByDateRange(startDate, endDate),
		getPendingCaptures(),
	]);
	const cardEntries = new Map<string, CardEntry[]>();
	for (const transaction of ledgerTransactions) {
		if (!transaction.accountId || !cardIds.includes(transaction.accountId)) continue;
		cardEntries.set(transaction.accountId, [
			...(cardEntries.get(transaction.accountId) ?? []),
			toCardEntry(transaction),
		]);
	}
	const merged = withProvisionalActivity(
		activity,
		cardEntries,
		provisionalEntriesByAccount(pending, live),
		months
	);
	const series = buildMonthSeries({
		months,
		accounts: live,
		activity: merged.activity,
		transfers,
		cardEntries: merged.cardEntries,
		transferLines,
		investmentIncome: investmentIncomeRows(ledgerTransactions),
		currentMonth: todayKey,
	});
	const history = series.map((point) => ({
		month: point.month,
		income: point.overview.incomeCents,
		grossIncome: point.overview.grossIncomeCents,
		spend: point.overview.totalSpendCents,
		cardSpend: point.overview.cardSpendCents,
		mainSpend: point.overview.mainSpendCents,
		saved: point.overview.savedCents,
		yield: point.overview.yieldCents,
		leftover: point.overview.leftoverCents,
		savingsRateBp: point.overview.savingsRateBp,
	}));
	const averages = {
		spend: averageClosedMonths(series, (o) => o.totalSpendCents, 3),
		income: averageClosedMonths(series, (o) => o.incomeCents, 3),
		saved: averageClosedMonths(series, (o) => o.savedCents, 6) ?? 0,
	};
	const reserve = buildReserveReadModel({
		accounts: live
			.filter(
				(account) =>
					!account.archived && account.kind !== 'credit_card' && account.role === 'reserve'
			)
			.map((account) => ({
				balanceCents: c.balances.get(account.id) ?? account.openingBalanceCents,
				purpose: null,
			})),
		targetMonths: 6,
		cost: RESERVE_COST,
		monthlyContributionCents: averages.saved,
		monthlyRate: monthlyRate(GOAL.expectedYieldBp),
	});
	const last12 = series.slice(-12);
	const yielded = yield12m(last12, null);
	const retirement = buildRetirementReadModel({
		goal: GOAL,
		trackedCapitalCents: reserve.split.investmentCents,
		monthlyContributionCents: averages.saved,
		realizedYield12mCents: yielded.cents,
		realizedYieldBasis: yielded.basis,
		averageCapital12mCents: averageReserveCapitalCents(last12, c.overview.savedCents),
		asOfMonth: todayKey,
		contributionDelayMonths: contributionDelayMonths(reserve),
	});
	let limitUsagePercent: number | null = null;
	for (const summary of c.cardSummaries.values()) {
		if (summary.limitUsagePercent !== null)
			limitUsagePercent = Math.max(limitUsagePercent ?? 0, summary.limitUsagePercent);
	}
	const selected = series[series.length - 1];
	const health = buildHealthIndicators({
		savingsRateBp: selected.overview.savingsRateBp,
		neededSavingsRateBp: null,
		liquidCents: c.overview.cashCents + c.overview.savedCents,
		averageMonthlySpendCents: averages.spend,
		fixedCostBp: null,
		cardOwedCents: c.cardsTotals.toPayCents + c.cardsTotals.openInvoicesCents,
		averageMonthlyIncomeCents: averages.income,
		limitUsagePercent,
		currentSpendCents: selected.overview.totalSpendCents,
		elapsedBp: monthElapsedBp(todayKey, today),
		previousSpendToDate: null,
		reserve:
			reserve.monthlyCostCents === null
				? null
				: {
						reserveCents: reserve.split.reserveCents,
						monthlyCostCents: reserve.monthlyCostCents,
						targetMonths: reserve.targetMonths,
					},
	});

	// O patrimônio no fim de cada mês fechado.
	const pastWorth: Record<string, number> = {};
	for (const month of months) {
		const end = monthKeyRange(month).endDate;
		if (end >= today) continue;
		const [atEnd, unassigned] = await Promise.all([getAccountBalances(end), getUnassignedNet(end)]);
		let total = unassigned;
		for (const account of live) {
			if (account.role === 'external') continue;
			const balance = atEnd.get(account.id) ?? 0;
			total += account.kind === 'credit_card' ? -owedCents(balance) : balance;
		}
		pastWorth[month] = total;
	}

	const month = c.month
		? {
				income: c.month.incomeCents,
				spend: c.month.totalSpendCents,
				saved: c.month.savedCents,
				yield: c.month.yieldCents,
				leftover: c.month.leftoverCents,
				cardSpend: c.month.cardSpendCents,
			}
		: null;

	return {
		balances,
		overview: c.overview,
		netWorth: worth.netCents,
		cards,
		cardsTotals: c.cardsTotals,
		month,
		history,
		averages,
		reserve,
		retirement,
		health,
		pastWorth,
	};
};

// ---------------------------------------------------------------------------

const PLANO: BillDraft = {
	name: 'Plano teste',
	dueDay: 10,
	amountCents: 50_000,
	accountId: null,
	category: null,
	matchHint: null,
	debtId: null,
	paidThrough: '2026-09',
	paidByRef: null,
	active: true,
	sortOrder: 0,
};

type LedgerRow = {
	id: string;
	amountCents: number;
	date: string;
	accountId: string | null;
	isIncome: number;
};
const ledger = async (): Promise<LedgerRow[]> =>
	db.getAllAsync<LedgerRow>(
		'SELECT id, amountCents, date, accountId, isIncome FROM transactions WHERE deletedAt IS NULL ORDER BY date, id'
	);
const transfersCount = async (): Promise<number> =>
	(
		await db.getFirstAsync<{ count: number }>(
			'SELECT COUNT(*) AS count FROM transfers WHERE deletedAt IS NULL'
		)
	)?.count ?? 0;

describeSql('pular um mês e pagar fora de ordem sem mexer em outros números (SPD-146)', () => {
	let corrente: string;
	let plano: string;

	beforeAll(async () => {
		jest.spyOn(console, 'log').mockImplementation(() => undefined);
		await initDatabase();
	});

	beforeEach(async () => {
		// Só o relógio é falso (hoje = 11/11/2026): com os timers falsos o `act` não termina.
		jest.useFakeTimers({
			now: new Date(2026, 10, 11, 12, 0, 0),
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
		await db.execAsync(
			'DELETE FROM transactions; DELETE FROM transfers; DELETE FROM accounts; DELETE FROM bills; DELETE FROM bill_payments; DELETE FROM debts; DELETE FROM captures;'
		);

		corrente = await addAccount(draft({ name: 'Corrente', openingBalanceCents: 300_000 }));
		const reserva = await addAccount(
			draft({ name: 'Reserva', kind: 'savings', role: 'reserve', sortOrder: 1 })
		);
		const cartao = await addAccount(
			draft({
				name: 'Cartão',
				kind: 'credit_card',
				role: 'card',
				closingDay: 3,
				dueDay: 10,
				closingDaysBefore: 7,
				creditLimitCents: 500_000,
				sortOrder: 2,
			})
		);
		for (const date of ['2026-10-05', '2026-11-05']) {
			await addTransaction({
				amountCents: 500_000,
				category: 'salary',
				date,
				note: 'Salário',
				isIncome: true,
				accountId: corrente,
			});
		}
		await addTransaction({
			amountCents: 40_000,
			category: 'food',
			date: '2026-11-03',
			note: 'Mercado',
			isIncome: false,
			accountId: corrente,
		});
		await addTransaction({
			amountCents: 25_000,
			category: 'food',
			date: '2026-10-20',
			note: 'Restaurante',
			isIncome: false,
			accountId: cartao,
		});
		await addTransfer({
			fromAccountId: corrente,
			toAccountId: reserva,
			amountCents: 100_000,
			date: '2026-10-06',
			note: '',
		});
		plano = await addBill({ ...PLANO, accountId: corrente });
		await mount();
	});

	afterEach(async () => {
		await act(async () => {
			renderer?.unmount();
		});
		renderer = null;
		current = null;
		currentBills = null;
		jest.useRealTimers();
	});

	it('"Não vou pagar este mês": nenhum número muda, nada é lançado', async () => {
		const before = await fingerprint();
		const ledgerBefore = await ledger();
		const transfersBefore = await transfersCount();

		let skipped: string | null = null;
		await act(async () => {
			skipped = await bills().skipMonth(plano, '2026-10');
		});
		await reload();

		expect(skipped).toBe('2026-10');
		expect(await fingerprint()).toEqual(before);
		expect(await ledger()).toEqual(ledgerBefore);
		expect(await transfersCount()).toBe(transfersBefore);
		// Só o mês foi gravado, e paidThrough passou por cima dele.
		expect(
			(await getBillPayments()).map((payment) => [
				payment.month,
				payment.status,
				payment.transactionId,
			])
		).toEqual([['2026-10', 'skipped', null]]);
		expect((await getBills()).find((bill) => bill.id === plano)?.paidThrough).toBe('2026-10');
	});

	it('"Pagar só novembro": acrescenta só o lançamento dele; sem ele, a impressão digital é a de antes', async () => {
		const before = await fingerprint();
		const ledgerBefore = await ledger();
		const transfersBefore = await transfersCount();

		await act(async () => {
			await bills().markPaid(plano, { month: '2026-11', post: true });
		});
		await reload();

		const created = markPaidTransactionId(plano, '2026-11');
		const after = await ledger();
		const added = after.filter((row) => !ledgerBefore.some((old) => old.id === row.id));
		expect(added).toEqual([
			{ id: created, amountCents: 50_000, date: '2026-11-11', accountId: corrente, isIncome: 0 },
		]);
		expect(after.filter((row) => row.id !== created)).toEqual(ledgerBefore);
		expect(await transfersCount()).toBe(transfersBefore);

		// O lançamento conta onde devia: R$ 500 a menos na Corrente, R$ 500 a mais no gasto do mês.
		const paid = await fingerprint();
		expect(paid.balances[corrente]).toBe(before.balances[corrente] - 50_000);
		expect(paid.month?.spend).toBe((before.month?.spend ?? 0) + 50_000);

		// O registro do mês aponta para ele; outubro continua em aberto.
		expect(
			(await getBillPayments()).map((payment) => [
				payment.month,
				payment.status,
				payment.transactionId,
				payment.amountCents,
			])
		).toEqual([['2026-11', 'paid', created, 50_000]]);
		expect((await getBills()).find((bill) => bill.id === plano)?.paidThrough).toBe('2026-09');

		// Sem esse lançamento, tudo volta a ser como antes: nada mais mudou.
		await db.runAsync('DELETE FROM transactions WHERE id = ?', [created]);
		await reload();
		expect(await fingerprint()).toEqual(before);
	});

	it('desfazer o "Pagar só novembro" volta todos os números e reabre só novembro', async () => {
		const before = await fingerprint();
		const ledgerBefore = await ledger();

		await act(async () => {
			await bills().markPaid(plano, { month: '2026-11', post: true });
		});
		await reload();
		await act(async () => {
			await bills().undoPaid(plano, '2026-11');
		});
		await reload();

		expect(await ledger()).toEqual(ledgerBefore);
		expect(await fingerprint()).toEqual(before);
		expect(await getBillPayments()).toEqual([]);
		expect((await getBills()).find((bill) => bill.id === plano)?.paidThrough).toBe('2026-09');
	});
});
