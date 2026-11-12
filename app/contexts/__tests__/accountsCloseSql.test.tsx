/**
 * Encerrar, juntar e apagar conta (SPD-144), no SQL **de verdade** e no `AccountsProvider` de
 * verdade, com a "impressão digital financeira".
 *
 * O app não guarda foto do passado: saldo, "Em caixa", patrimônio, o histórico mês a mês, a
 * reserva, a projeção e a saúde financeira são recalculados das linhas de hoje a cada carga.
 * Apagar uma conta com conteúdo reescrevia tudo isso sem aviso — apagar a PJ que mandou 2 ×
 * R$ 12.000 derrubava o patrimônio em R$ 24.000; apagar o cartão com fatura paga de R$ 800 o
 * fazia subir. A impressão digital (`fingerprint`) calcula de uma vez todos os números que o
 * usuário vê, com as mesmas funções das telas, e cada operação é comparada antes e depois.
 *
 * Hoje é 11/11/2026, como nos exemplos do relatório:
 * - Corrente: âncora R$ 1.000 em 30/09; mandou R$ 300 à Reserva (05/10) e pagou R$ 800 da
 *   fatura do cartão (15/10); recebeu R$ 12.000 da PJ em 05/10 e em 05/11; gastou R$ 200 em 03/11.
 * - Reserva: âncora 0 em 30/09; recebeu os R$ 300.
 * - Cartão: fatura informada de R$ 800 (âncora −800 em 30/09), compra de R$ 500 em 10/10.
 * - PJ (externa): âncora 0; mandou os 2 × R$ 12.000.
 * - Carteira: âncora R$ 500 em 30/09; gastou R$ 50 em 20/10.
 * - Vazia: nada, mas uma conta a pagar e uma dívida apontam para ela.
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
import { getPendingCaptures } from '../../database/captures';
import {
	AccountInUseError,
	addAccount,
	addBill,
	addDebt,
	addTransaction,
	addTransfer,
	applyPulledChanges,
	db,
	getAccountBalances,
	getAccounts,
	getMonthlyAccountActivity,
	getMonthlyTransferActivity,
	getTransactionsForAccounts,
	getTransfersByDateRange,
	getUnassignedNet,
	initDatabase,
	repairDeadAccountLinks,
} from '../../database/database';
import type { AccountDraft } from '../../database/schema';
import type { SyncChanges } from '../../sync/types';
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

const sqliteAvailable: boolean = jest.requireMock<{ mockSqliteAvailable: boolean }>(
	'expo-sqlite'
).mockSqliteAvailable;
if (!sqliteAvailable) {
	console.warn(
		'accountsCloseSql.test.tsx pulado: rode com NODE_OPTIONS=--experimental-sqlite (Node 22.12).'
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

/** Deixa a recarga do provider terminar (só o relógio é falso). */
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

const reload = async () => {
	await act(async () => {
		await ctx().refresh();
	});
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

type Fingerprint = Awaited<ReturnType<typeof fingerprint>>;

/** Os números de um mês da série. */
const monthOf = (fp: Fingerprint, month: string) =>
	fp.history.find((point) => point.month === month);

const activeIds = () => ctx().activeAccounts.map((account) => account.id);

// ---------------------------------------------------------------------------

describeSql('encerrar, juntar e apagar conta sem mexer nos números (SPD-144)', () => {
	let corrente: string;
	let reserva: string;
	let cartao: string;
	let pj: string;
	let carteira: string;
	let vazia: string;
	let luz: string;
	let emprestimo: string;

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
			'DELETE FROM transactions; DELETE FROM transfers; DELETE FROM accounts; DELETE FROM bills; DELETE FROM debts; DELETE FROM captures;'
		);

		corrente = await addAccount(draft({ name: 'Corrente', openingBalanceCents: 100_000 }));
		reserva = await addAccount(
			draft({ name: 'Reserva', kind: 'savings', role: 'reserve', sortOrder: 1 })
		);
		cartao = await addAccount(
			draft({
				name: 'Cartão',
				kind: 'credit_card',
				role: 'card',
				closingDay: 3,
				dueDay: 10,
				closingDaysBefore: 7,
				creditLimitCents: 500_000,
				openingBalanceCents: -80_000,
				sortOrder: 2,
			})
		);
		pj = await addAccount(draft({ name: 'PJ', role: 'external', sortOrder: 3 }));
		carteira = await addAccount(
			draft({ name: 'Carteira', kind: 'cash', openingBalanceCents: 50_000, sortOrder: 4 })
		);
		vazia = await addAccount(
			draft({ name: 'Vazia', openingBalanceDate: '2026-10-31', sortOrder: 5 })
		);

		await addTransfer({
			fromAccountId: corrente,
			toAccountId: reserva,
			amountCents: 30_000,
			date: '2026-10-05',
			note: '',
		});
		await addTransaction({
			accountId: cartao,
			date: '2026-10-10',
			amountCents: 50_000,
			isIncome: false,
			category: 'food',
			note: 'Mercado',
		});
		await addTransfer({
			fromAccountId: corrente,
			toAccountId: cartao,
			amountCents: 80_000,
			date: '2026-10-15',
			note: '',
		});
		await addTransfer({
			fromAccountId: pj,
			toAccountId: corrente,
			amountCents: 1_200_000,
			date: '2026-10-05',
			note: '',
		});
		await addTransfer({
			fromAccountId: pj,
			toAccountId: corrente,
			amountCents: 1_200_000,
			date: '2026-11-05',
			note: '',
		});
		await addTransaction({
			accountId: corrente,
			date: '2026-11-03',
			amountCents: 20_000,
			isIncome: false,
			category: 'food',
			note: 'Feira',
		});
		await addTransaction({
			accountId: carteira,
			date: '2026-10-20',
			amountCents: 5_000,
			isIncome: false,
			category: 'food',
			note: 'Pão',
		});

		luz = await addBill({
			name: 'Luz',
			dueDay: 15,
			amountCents: 18_000,
			accountId: vazia,
			category: null,
			matchHint: null,
			debtId: null,
			paidThrough: null,
			paidByRef: null,
			active: true,
			sortOrder: 0,
		});
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
			accountId: vazia,
			category: null,
			archived: false,
			sortOrder: 0,
		});
		// Tudo já subiu: o que a operação mudar volta a ficar sujo.
		await db.execAsync(
			"UPDATE accounts SET dirty = 0, updatedAt = '2026-11-01T00:00:00.000Z'; UPDATE transactions SET dirty = 0; UPDATE transfers SET dirty = 0; UPDATE bills SET dirty = 0, updatedAt = '2026-11-01T00:00:00.000Z'; UPDATE debts SET dirty = 0, updatedAt = '2026-11-01T00:00:00.000Z';"
		);
		await mount();
	});

	afterEach(() => {
		act(() => renderer?.unmount());
		renderer = null;
		current = null;
		jest.useRealTimers();
	});

	it('o ponto de partida: os números do relatório', async () => {
		const fp = await fingerprint();
		// Corrente: 1.000 − 300 − 800 + 12.000 + 12.000 − 200.
		expect(fp.balances[corrente]).toBe(2_370_000);
		expect(fp.balances[reserva]).toBe(30_000);
		expect(fp.balances[carteira]).toBe(45_000);
		expect(fp.cards[cartao].owed).toBe(50_000);
		// Em caixa: Corrente + Carteira; o cartão deve R$ 500.
		expect(fp.overview.cashCents).toBe(2_415_000);
		expect(fp.overview.netCents).toBe(2_365_000);
		expect(fp.netWorth).toBe(2_395_000);
		expect(monthOf(fp, '2026-10')?.saved).toBe(30_000);
		expect(monthOf(fp, '2026-10')?.income).toBe(1_200_000);
		expect(monthOf(fp, '2026-11')?.income).toBe(1_200_000);
	});

	describe('apagar: só conta vazia', () => {
		it.each([
			['a PJ que mandou 2 × R$ 12.000 (o patrimônio caía R$ 24.000)', () => pj],
			['a Reserva que recebeu R$ 300 (o "Guardado" de outubro sumia)', () => reserva],
			['o Cartão com fatura paga de R$ 800 (o patrimônio subia)', () => cartao],
			['a Corrente que pagou o cartão (o cartão voltava a dever R$ 1.300)', () => corrente],
			['a Carteira, só com saldo e um gasto', () => carteira],
		])('%s: recusado, e nada muda', async (_label, idOf) => {
			const before = await fingerprint();
			let error: unknown = null;
			await act(async () => {
				try {
					await ctx().removeAccount(idOf());
				} catch (caught) {
					error = caught;
				}
			});
			expect(error).toBeInstanceOf(AccountInUseError);
			await reload();
			expect(await fingerprint()).toEqual(before);
			const row = await db.getFirstAsync<{ deletedAt: string | null }>(
				'SELECT deletedAt FROM accounts WHERE id = ?',
				[idOf()]
			);
			expect(row?.deletedAt).toBeNull();
			expect(
				await db.getFirstAsync<{ n: number }>(
					'SELECT COUNT(*) AS n FROM transfers WHERE deletedAt IS NOT NULL'
				)
			).toEqual({ n: 0 });
		});

		it('a conta vazia sai, nada muda nos números, e a conta a pagar e a dívida dela ficam sem conta (sujas, para o sync)', async () => {
			const before = await fingerprint({ skipBalances: [vazia] });
			await act(async () => {
				await ctx().removeAccount(vazia);
			});
			await reload();

			expect(await fingerprint({ skipBalances: [vazia] })).toEqual(before);
			expect(ctx().accounts.map((account) => account.id)).not.toContain(vazia);
			const bill = await db.getFirstAsync<{
				accountId: string | null;
				dirty: number;
				updatedAt: string;
			}>('SELECT accountId, dirty, updatedAt FROM bills WHERE id = ?', [luz]);
			expect(bill).toEqual(expect.objectContaining({ accountId: null, dirty: 1 }));
			expect((bill?.updatedAt ?? '') > '2026-11-01T00:00:00.000Z').toBe(true);
			const debt = await db.getFirstAsync<{ accountId: string | null; dirty: number }>(
				'SELECT accountId, dirty FROM debts WHERE id = ?',
				[emprestimo]
			);
			expect(debt).toEqual({ accountId: null, dirty: 1 });
		});
	});

	describe('encerrar', () => {
		it('Carteira (R$ 450) para a Corrente: a impressão digital fica igual; só a Carteira sai das listas ativas', async () => {
			const before = await fingerprint({ skipBalances: [carteira, corrente] });
			expect(activeIds()).toContain(carteira);

			await act(async () => {
				await ctx().closeAccount(carteira, corrente);
			});
			await reload();

			expect(await fingerprint({ skipBalances: [carteira, corrente] })).toEqual(before);
			expect(ctx().balances.get(carteira)).toBe(0);
			expect(ctx().balances.get(corrente)).toBe(2_415_000);
			expect(activeIds()).not.toContain(carteira);
			// Encerrada não é apagada: continua viva, arquivada, e a transferência é de hoje.
			expect(ctx().accounts.find((account) => account.id === carteira)?.archived).toBe(true);
			const closing = await db.getAllAsync<{
				fromAccountId: string;
				toAccountId: string;
				amountCents: number;
				date: string;
				dirty: number;
			}>(
				'SELECT fromAccountId, toAccountId, amountCents, date, dirty FROM transfers WHERE fromAccountId = ? AND deletedAt IS NULL',
				[carteira]
			);
			expect(closing).toEqual([
				{
					fromAccountId: carteira,
					toAccountId: corrente,
					amountCents: 45_000,
					date: '2026-11-11',
					dirty: 1,
				},
			]);
		});

		it('Reserva (R$ 300) para a Corrente (caso A): patrimônio igual, o "Guardado" de outubro continua R$ 300; o único novo é o resgate de novembro', async () => {
			const before = await fingerprint({ skipBalances: [reserva, corrente] });

			await act(async () => {
				await ctx().closeAccount(reserva, corrente);
			});
			await reload();
			const after = await fingerprint({ skipBalances: [reserva, corrente] });

			expect(after.netWorth).toBe(before.netWorth);
			expect(after.pastWorth).toEqual(before.pastWorth);
			expect(after.cards).toEqual(before.cards);
			expect(after.averages).toEqual(before.averages);
			// Os meses fechados não mudam.
			expect(after.history.slice(0, -1)).toEqual(before.history.slice(0, -1));
			expect(monthOf(after, '2026-10')?.saved).toBe(30_000);
			// O que muda é verdade: R$ 300 saíram da reserva hoje.
			expect(monthOf(after, '2026-11')?.saved).toBe(
				(monthOf(before, '2026-11')?.saved ?? 0) - 30_000
			);
			expect(after.overview.cashCents).toBe(before.overview.cashCents + 30_000);
			expect(after.overview.savedCents).toBe(before.overview.savedCents - 30_000);
			expect(ctx().balances.get(reserva)).toBe(0);
			expect(activeIds()).not.toContain(reserva);
		});

		it('com saldo diferente de zero e sem destino: recusado, nada muda', async () => {
			const before = await fingerprint();
			await expect(ctx().closeAccount(carteira, null)).rejects.toThrow();
			await reload();
			expect(await fingerprint()).toEqual(before);
			expect(activeIds()).toContain(carteira);
		});

		it('cartão devendo R$ 500: recusado; pago, encerra e as faturas pagas continuam pagas', async () => {
			const plan = await ctx().planClose(cartao);
			expect(plan).toEqual({ kind: 'blocked', reason: 'cardOwes', amountCents: 50_000, count: 0 });
			await expect(ctx().closeAccount(cartao, null)).rejects.toThrow();

			await act(async () => {
				await ctx().recordCardPayment(cartao, corrente, 50_000, '2026-11-11');
			});
			const before = await fingerprint();
			expect(await ctx().planClose(cartao)).toEqual({ kind: 'direct' });

			await act(async () => {
				await ctx().closeAccount(cartao, null);
			});
			await reload();

			const after = await fingerprint();
			// O único número que muda é verdade: o limite de R$ 5.000 do cartão encerrado deixa de
			// estar disponível (era o único cartão ativo, então a soma fica sem limite).
			expect(before.cardsTotals.limitAvailableCents).toBe(500_000);
			expect(after.cardsTotals.limitAvailableCents).toBeNull();
			expect({ ...after, cardsTotals: { ...after.cardsTotals, limitAvailableCents: 0 } }).toEqual({
				...before,
				cardsTotals: { ...before.cardsTotals, limitAvailableCents: 0 },
			});
			expect(activeIds()).not.toContain(cartao);
			expect(ctx().creditCards.map((card) => card.id)).not.toContain(cartao);
		});

		it('PJ (externa) com R$ 24.000 que já saíram: encerra direto, e a renda de outubro e novembro continua', async () => {
			const before = await fingerprint();
			expect(await ctx().planClose(pj)).toEqual({ kind: 'direct' });
			await act(async () => {
				await ctx().closeAccount(pj, null);
			});
			await reload();
			expect(await fingerprint()).toEqual(before);
			expect(activeIds()).not.toContain(pj);
		});

		it('reabrir a Carteira encerrada: volta às listas, nada muda', async () => {
			await act(async () => {
				await ctx().closeAccount(carteira, corrente);
			});
			await reload();
			const before = await fingerprint();
			await act(async () => {
				await ctx().reopenAccount(carteira);
			});
			await reload();
			expect(await fingerprint()).toEqual(before);
			expect(activeIds()).toContain(carteira);
		});
	});

	it('juntar a Carteira na Corrente: a impressão digital fica igual, e a Corrente fica com os R$ 450', async () => {
		const before = await fingerprint({ skipBalances: [carteira, corrente] });
		await act(async () => {
			await ctx().mergeAccounts(carteira, corrente);
		});
		await reload();
		expect(await fingerprint({ skipBalances: [carteira, corrente] })).toEqual(before);
		expect(ctx().balances.get(corrente)).toBe(2_415_000);
		expect(ctx().balances.has(carteira)).toBe(false);
	});

	describe('sync: lançamento de outro aparelho para uma conta apagada', () => {
		const changes = (overrides: Partial<SyncChanges>): SyncChanges => ({
			categories: [],
			transactions: [],
			recurringTransactions: [],
			budgets: [],
			...overrides,
		});

		it('a conta volta encerrada (o lançamento não fica órfão), e o patrimônio é o de antes', async () => {
			await act(async () => {
				await ctx().removeAccount(vazia);
			});
			await reload();
			const before = await fingerprint({ skipBalances: [vazia] });
			const tombstone = await db.getFirstAsync<{ updatedAt: string }>(
				'SELECT updatedAt FROM accounts WHERE id = ?',
				[vazia]
			);

			// O outro aparelho ainda via a Vazia e lançou nela uma compra de R$ 50.
			await applyPulledChanges(
				changes({
					transactions: [
						{
							id: 'remota-1',
							amountCents: 5_000,
							category: 'food',
							date: '2026-11-10',
							note: 'Padaria',
							isIncome: false,
							accountId: vazia,
							installmentGroup: null,
							installmentIndex: null,
							installmentCount: null,
							cardLast4: null,
							updatedAt: '2026-11-11T10:00:00.000Z',
							deletedAt: null,
						},
					],
				})
			);
			await reload();

			const account = await db.getFirstAsync<{
				deletedAt: string | null;
				archived: number;
				dirty: number;
				updatedAt: string;
			}>('SELECT deletedAt, archived, dirty, updatedAt FROM accounts WHERE id = ?', [vazia]);
			expect(account).toEqual(expect.objectContaining({ deletedAt: null, archived: 1, dirty: 1 }));
			expect((account?.updatedAt ?? '') > (tombstone?.updatedAt ?? '')).toBe(true);
			const remote = await db.getFirstAsync<{ accountId: string }>(
				"SELECT accountId FROM transactions WHERE id = 'remota-1'"
			);
			expect(remote?.accountId).toBe(vazia);
			expect(activeIds()).not.toContain(vazia);
			// Encerrada fica fora dos totais de hoje: o patrimônio, o caixa e os cartões são os de
			// antes. A compra de R$ 50 aconteceu, e o gasto de novembro a mostra (R$ 700 → R$ 750).
			const after = await fingerprint({ skipBalances: [vazia] });
			expect(after.netWorth).toBe(before.netWorth);
			expect(after.overview).toEqual(before.overview);
			expect(after.cards).toEqual(before.cards);
			expect(after.pastWorth).toEqual(before.pastWorth);
			expect(monthOf(before, '2026-11')?.spend).toBe(70_000);
			expect(monthOf(after, '2026-11')?.spend).toBe(75_000);
			expect(ctx().balances.get(vazia)).toBe(-5_000);
		});

		it('transferência de outro aparelho para a conta apagada: a conta volta encerrada com os R$ 300, e a transferência vale dos dois lados', async () => {
			await act(async () => {
				await ctx().removeAccount(vazia);
			});
			await applyPulledChanges(
				changes({
					transfers: [
						{
							id: 'remota-2',
							fromAccountId: corrente,
							toAccountId: vazia,
							amountCents: 30_000,
							date: '2026-11-10',
							note: null,
							updatedAt: '2026-11-11T10:00:00.000Z',
							deletedAt: null,
						},
					],
				})
			);
			await reload();

			expect(ctx().accounts.find((account) => account.id === vazia)?.archived).toBe(true);
			expect(ctx().balances.get(vazia)).toBe(30_000);
			expect(ctx().balances.get(corrente)).toBe(2_340_000);
		});

		it('conta a pagar e captura pendente de outro aparelho para a conta apagada: ficam sem conta, sem ressuscitar a conta', async () => {
			await act(async () => {
				await ctx().removeAccount(vazia);
			});
			await applyPulledChanges(
				changes({
					bills: [
						{
							id: 'conta-remota',
							name: 'Água',
							dueDay: 12,
							amountCents: 9_000,
							accountId: vazia,
							category: null,
							matchHint: null,
							debtId: null,
							paidThrough: null,
							paidByRef: null,
							active: true,
							sortOrder: 1,
							updatedAt: '2026-11-11T10:00:00.000Z',
							deletedAt: null,
						},
					],
					captures: [
						{
							id: 'fp-remota',
							packageName: 'com.banco.teste',
							appLabel: 'Banco',
							title: 'Compra aprovada',
							text: 'Compra de R$ 12,00 aprovada em LOJA TESTE',
							postedAt: '2026-11-10T09:00:00.000Z',
							amountCents: 1_200,
							direction: 'out',
							kind: 'purchase',
							counterparty: 'LOJA TESTE',
							merchantKey: null,
							cardLast4: null,
							status: 'pending',
							question: null,
							relatedFingerprint: null,
							suggestedCategory: null,
							transactionId: null,
							autoConfirmed: false,
							reason: null,
							accountId: vazia,
							transferId: null,
							installments: null,
							createdAt: '2026-11-10T09:00:00.000Z',
							updatedAt: '2026-11-11T10:00:00.000Z',
							deletedAt: null,
						},
					],
				})
			);

			const account = await db.getFirstAsync<{ deletedAt: string | null }>(
				'SELECT deletedAt FROM accounts WHERE id = ?',
				[vazia]
			);
			expect(account?.deletedAt).not.toBeNull();
			expect(
				await db.getFirstAsync("SELECT accountId, dirty FROM bills WHERE id = 'conta-remota'")
			).toEqual({ accountId: null, dirty: 1 });
			expect(
				await db.getFirstAsync(
					"SELECT accountId, dirty FROM captures WHERE fingerprint = 'fp-remota'"
				)
			).toEqual({ accountId: null, dirty: 1 });
		});
	});

	it('reparo no carregamento: conta a pagar, dívida e captura pendente deixam de apontar para conta apagada, e nenhum número de hoje muda', async () => {
		// Como ficou nos aparelhos com a exclusão antiga: "Já paguei" e captura gravando o id
		// morto — um lançamento de R$ 90 e uma compra pendente de R$ 12 na Vazia apagada.
		await db.runAsync("UPDATE accounts SET deletedAt = '2026-11-02T00:00:00.000Z' WHERE id = ?", [
			vazia,
		]);
		await db.runAsync(
			"INSERT INTO transactions (id, amountCents, category, date, note, isIncome, accountId, updatedAt, deletedAt, dirty) VALUES ('orfa', 9000, 'food', '2026-11-05', 'Luz', 0, ?, '2026-11-05T00:00:00.000Z', NULL, 0)",
			[vazia]
		);
		await db.runAsync(
			"INSERT INTO captures (id, fingerprint, packageName, appLabel, title, text, postedAt, amountCents, direction, kind, status, autoConfirmed, accountId, createdAt, updatedAt, deletedAt, dirty) VALUES ('cap-1', 'fp-1', 'com.banco.teste', 'Banco', 'Compra', 'Compra de R$ 12,00', '2026-11-04T00:00:00.000Z', 1200, 'out', 'purchase', 'pending', 0, ?, '2026-11-04T00:00:00.000Z', '2026-11-04T00:00:00.000Z', NULL, 0)",
			[vazia]
		);
		await reload();
		const before = await fingerprint();

		const repaired = await repairDeadAccountLinks();
		expect(repaired.unlinked).toBe(3);
		expect(repaired.orphaned).toBe(0);
		await reload();

		// Nenhum número de hoje muda. O lançamento de R$ 90 fica onde estava, e a conta dele volta
		// encerrada (SPD-149): o histórico de novembro passa a vê-lo, e o aviso único diz isso
		// (`closedReviewSql.test.tsx`).
		const after = await fingerprint({ skipBalances: [vazia] });
		expect(after.balances).toEqual(before.balances);
		expect(after.overview).toEqual(before.overview);
		expect(after.netWorth).toBe(before.netWorth);
		expect(after.cards).toEqual(before.cards);
		expect(repaired.revived.map((account) => account.id)).toEqual([vazia]);
		expect(await db.getFirstAsync('SELECT deletedAt, archived FROM accounts WHERE id = ?', [vazia])).toEqual({
			deletedAt: null,
			archived: 1,
		});
		expect(
			await db.getFirstAsync(
				"SELECT amountCents, accountId, dirty FROM transactions WHERE id = 'orfa'"
			)
		).toEqual({
			amountCents: 9_000,
			accountId: vazia,
			dirty: 0,
		});
		// Conta a pagar, dívida e captura pendente: sem conta (sujas, para o sync), nunca um id morto.
		expect(
			await db.getFirstAsync('SELECT accountId, dirty FROM bills WHERE id = ?', [luz])
		).toEqual({ accountId: null, dirty: 1 });
		expect(
			await db.getFirstAsync('SELECT accountId, dirty FROM debts WHERE id = ?', [emprestimo])
		).toEqual({ accountId: null, dirty: 1 });
		expect(
			await db.getFirstAsync("SELECT accountId, dirty FROM captures WHERE id = 'cap-1'")
		).toEqual({ accountId: null, dirty: 1 });

		// Idempotente: a segunda carga não acha mais nada.
		expect(await repairDeadAccountLinks()).toEqual({ unlinked: 0, orphaned: 0, revived: [] });
	});
});
