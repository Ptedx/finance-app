/**
 * Juntar cartões, levar um cartão para o débito e juntar contas de papéis diferentes
 * (SPD-152), no SQL **de verdade** e no `AccountsProvider` de verdade, com a "impressão
 * digital financeira" do SPD-144 (`accountsCloseSql.test.tsx`, copiada aqui).
 *
 * O critério é o do usuário: nenhuma ação muda patrimônio, histórico ou faturas sem ele saber
 * antes, com o valor em R$. Os três buracos que o SPD-144 deixou:
 * - juntar dois cartões perdia a fatura informada (âncora) e o ajuste com o banco do que sai:
 *   a dívida caía e o patrimônio subia em silêncio;
 * - levar o cartão para o débito apagava os pagamentos de fatura: a conta que pagou ficava
 *   com o dinheiro de volta, e a fatura informada sumia junto;
 * - juntar a reserva na corrente (papéis diferentes) mantinha o total de hoje, mas o
 *   "Guardado" de outubro sumia do histórico.
 *
 * Hoje é 11/11/2026, o mesmo banco de exemplo do SPD-144:
 * - Corrente: âncora R$ 1.000 em 30/09; mandou R$ 300 à Reserva (05/10) e pagou R$ 800 da
 *   fatura do cartão (15/10); recebeu R$ 12.000 da PJ em 05/10 e em 05/11; gastou R$ 200 em 03/11.
 * - Reserva: âncora 0 em 30/09; recebeu os R$ 300.
 * - Cartão: fatura informada de R$ 800 (âncora −800 em 30/09), compra de R$ 500 em 10/10.
 * - PJ (externa): âncora 0; mandou os 2 × R$ 12.000.
 * - Carteira: âncora R$ 500 em 30/09; gastou R$ 50 em 20/10.
 * E, para juntar, um segundo cartão (o duplicado do mesmo plástico que o extrato criou):
 * - Cartão 2: mesmo fechamento; fatura informada de R$ 300 (âncora −300 em 30/09), compra de
 *   R$ 120 em 05/11, ajuste com a fatura do banco de R$ 50 em 07/11, pagamento de R$ 100 da
 *   Corrente em 08/11. Deve R$ 370.
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
	addAccount,
	addTransaction,
	addTransfer,
	db,
	getAccountBalances,
	getAccounts,
	getMonthlyAccountActivity,
	getMonthlyTransferActivity,
	getTransactionsForAccounts,
	getTransfersByDateRange,
	getUnassignedNet,
	initDatabase,
} from '../../database/database';
import type { AccountDraft } from '../../database/schema';
import { netWorth, owedCents, provisionalEntriesByAccount } from '../../utils/accountMath';
import { DebitFutureError, MergeRoleError } from '../../utils/accountMerging';
import { CARD_ADJUSTMENT_NOTE, type CardEntry } from '../../utils/cardMath';
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
		'accountsMergeCardsSql.test.tsx pulado: rode com NODE_OPTIONS=--experimental-sqlite (Node 22.12).'
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


/** As faturas de um cartão, só o que o usuário lê: mês, valor, pago e saldo anterior. */
const invoicesOf = (fp: Fingerprint, cardId: string) =>
	(fp.cards[cardId]?.invoices ?? []).map((raw) => {
		const invoice = JSON.parse(raw) as {
			cycle: { key: string };
			amountCents: number;
			paidCents: number;
			previousUnpaidCents: number;
		};
		return {
			key: invoice.cycle.key,
			amount: invoice.amountCents,
			paid: invoice.paidCents,
			previous: invoice.previousUnpaidCents,
		};
	});

type InvoiceRow = ReturnType<typeof invoicesOf>[number];

/** As faturas de dois cartões somadas mês a mês: o que o cartão juntado tem que mostrar. */
const sumInvoices = (a: InvoiceRow[], b: InvoiceRow[]): InvoiceRow[] => {
	const byKey = new Map<string, InvoiceRow>();
	for (const row of [...a, ...b]) {
		const sum = byKey.get(row.key) ?? { key: row.key, amount: 0, paid: 0, previous: 0 };
		byKey.set(row.key, {
			key: row.key,
			amount: sum.amount + row.amount,
			paid: sum.paid + row.paid,
			previous: sum.previous + row.previous,
		});
	}
	return [...byKey.values()].sort((x, y) => x.key.localeCompare(y.key));
};

/** O gasto de cada mês da série, e a soma dos 13 meses. */
const spendOf = (fp: Fingerprint) => {
	const months = Object.fromEntries(fp.history.map((point) => [point.month, point.spend]));
	return { months, total: fp.history.reduce((total, point) => total + point.spend, 0) };
};

/** Tudo da série menos o gasto (e o que sai dele): renda, guardado, rendimento. */
const withoutSpend = (fp: Fingerprint) =>
	fp.history.map((point) => ({
		month: point.month,
		income: point.income,
		grossIncome: point.grossIncome,
		saved: point.saved,
		yield: point.yield,
	}));

/** A saúde financeira sem o uso do limite (o limite do cartão que sai deixa de existir). */
const healthWithoutLimit = (fp: Fingerprint) =>
	fp.health.map((indicator) =>
		indicator.id === 'card-load'
			? { ...indicator, params: { ...indicator.params, limitPercent: '' } }
			: indicator
	);

interface TransferRow {
	fromAccountId: string;
	toAccountId: string;
	amountCents: number;
	deletedAt: string | null;
}

const liveTransfersOf = async (accountId: string) =>
	db.getAllAsync<TransferRow>(
		'SELECT fromAccountId, toAccountId, amountCents, deletedAt FROM transfers WHERE (fromAccountId = ? OR toAccountId = ?) AND deletedAt IS NULL',
		[accountId, accountId]
	);

// ---------------------------------------------------------------------------

describeSql('juntar cartões, levar cartão para o débito e juntar papéis diferentes (SPD-152)', () => {
	let corrente: string;
	let reserva: string;
	let cartao: string;
	let cartao2: string;
	let pj: string;
	let carteira: string;

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
		const card = {
			kind: 'credit_card' as const,
			role: 'card' as const,
			closingDay: 3,
			dueDay: 10,
			closingDaysBefore: 7,
		};
		cartao = await addAccount(
			draft({
				...card,
				name: 'Cartão',
				creditLimitCents: 500_000,
				openingBalanceCents: -80_000,
				sortOrder: 2,
			})
		);
		pj = await addAccount(draft({ name: 'PJ', role: 'external', sortOrder: 3 }));
		carteira = await addAccount(
			draft({ name: 'Carteira', kind: 'cash', openingBalanceCents: 50_000, sortOrder: 4 })
		);
		cartao2 = await addAccount(
			draft({
				...card,
				name: 'Cartão 2',
				creditLimitCents: 300_000,
				openingBalanceCents: -30_000,
				sortOrder: 5,
			})
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
		await addTransaction({
			accountId: cartao2,
			date: '2026-11-05',
			amountCents: 12_000,
			isIncome: false,
			category: 'food',
			note: 'Farmácia',
		});
		await addTransaction({
			accountId: cartao2,
			date: '2026-11-07',
			amountCents: 5_000,
			isIncome: false,
			category: 'other_expense',
			note: CARD_ADJUSTMENT_NOTE,
		});
		await addTransfer({
			fromAccountId: corrente,
			toAccountId: cartao2,
			amountCents: 10_000,
			date: '2026-11-08',
			note: '',
		});
		// Tudo já subiu: o que a operação mudar volta a ficar sujo.
		await db.execAsync(
			"UPDATE accounts SET dirty = 0, updatedAt = '2026-11-01T00:00:00.000Z'; UPDATE transactions SET dirty = 0; UPDATE transfers SET dirty = 0;"
		);
		await mount();
	});

	afterEach(() => {
		act(() => renderer?.unmount());
		renderer = null;
		current = null;
		jest.useRealTimers();
	});

	it('o ponto de partida: Cartão deve R$ 500, Cartão 2 deve R$ 370', async () => {
		const fp = await fingerprint();
		// Corrente: 1.000 − 300 − 800 + 12.000 + 12.000 − 200 − 100.
		expect(fp.balances[corrente]).toBe(2_360_000);
		expect(fp.cards[cartao].owed).toBe(50_000);
		// Cartão 2: 300 + 120 + 50 − 100.
		expect(fp.cards[cartao2].owed).toBe(37_000);
		expect(fp.overview.cashCents).toBe(2_405_000);
		expect(fp.overview.netCents).toBe(2_318_000);
		// Em caixa + Reserva − cartões: 24.050 + 300 − 500 − 370.
		expect(fp.netWorth).toBe(2_348_000);
		expect(monthOf(fp, '2026-10')?.saved).toBe(30_000);
	});

	describe('juntar dois cartões', () => {
		it('Cartão 2 no Cartão: a dívida soma (R$ 370 + R$ 500 = R$ 870); patrimônio, histórico e cada fatura (a soma das duas) iguais', async () => {
			const before = await fingerprint({ skipBalances: [cartao, cartao2] });
			const expectedInvoices = sumInvoices(invoicesOf(before, cartao), invoicesOf(before, cartao2));

			await act(async () => {
				await ctx().mergeCards(cartao2, cartao);
			});
			await reload();
			const after = await fingerprint({ skipBalances: [cartao, cartao2] });

			// Antes: R$ 520 — a fatura informada de R$ 300 e o ajuste de R$ 50 do Cartão 2 sumiam,
			// e o patrimônio subia R$ 350.
			expect(after.cards[cartao].owed).toBe(87_000);
			expect(ctx().balances.get(cartao)).toBe(-87_000);
			expect(after.cards[cartao2]).toBeUndefined();
			// Cada fatura do Cartão é a soma das duas: a de outubro, paga com os R$ 800, continua
			// com os R$ 800 pagos (e com os R$ 300 do Cartão 2, que não estavam pagos).
			expect(invoicesOf(after, cartao)).toEqual(expectedInvoices);
			expect(invoicesOf(after, cartao)[0]).toEqual({
				key: '2026-10',
				amount: 110_000,
				paid: 80_000,
				previous: 0,
			});
			// O único número que muda é verdade: o limite de R$ 3.000 do Cartão 2 deixa de existir.
			expect(after.cardsTotals.limitAvailableCents).toBe(
				(before.cardsTotals.limitAvailableCents ?? 0) - 300_000
			);
			const strip = (fp: Fingerprint) => ({
				...fp,
				cards: {},
				cardsTotals: { ...fp.cardsTotals, limitAvailableCents: 0 },
				health: healthWithoutLimit(fp),
			});
			expect(strip(after)).toEqual(strip(before));

			// O ajuste veio junto, vivo e sujo; o Cartão ficou com a âncora somada, o Cartão 2 com lápide.
			expect(
				await db.getAllAsync(
					'SELECT accountId, deletedAt, dirty FROM transactions WHERE note = ?',
					[CARD_ADJUSTMENT_NOTE]
				)
			).toEqual([{ accountId: cartao, deletedAt: null, dirty: 1 }]);
			expect(
				await db.getFirstAsync(
					'SELECT openingBalanceCents, openingBalanceDate, dirty FROM accounts WHERE id = ?',
					[cartao]
				)
			).toEqual({ openingBalanceCents: -110_000, openingBalanceDate: '2026-09-30', dirty: 1 });
			const gone = await db.getFirstAsync<{ deletedAt: string | null }>(
				'SELECT deletedAt FROM accounts WHERE id = ?',
				[cartao2]
			);
			expect(gone?.deletedAt).not.toBeNull();
		});

		it.each([
			['Cartão 2 no Cartão', () => [cartao2, cartao]],
			['Cartão no Cartão 2', () => [cartao, cartao2]],
		])(
			'faturas informadas em dias diferentes (30/09 e 31/10), %s: patrimônio igual, a fatura paga de outubro continua paga, e os R$ 300 do Cartão 2 mudam de novembro para outubro nos relatórios (o total gasto não muda)',
			async (_label, pair) => {
				await db.runAsync("UPDATE accounts SET openingBalanceDate = '2026-10-31' WHERE id = ?", [
					cartao2,
				]);
				await reload();
				const [from, into] = pair();
				const before = await fingerprint({ skipBalances: [cartao, cartao2] });
				expect(invoicesOf(before, cartao)[0]).toEqual({
					key: '2026-10',
					amount: 80_000,
					paid: 80_000,
					previous: 0,
				});

				await act(async () => {
					await ctx().mergeCards(from, into);
				});
				await reload();
				const after = await fingerprint({ skipBalances: [cartao, cartao2] });

				expect(after.cards[into].owed).toBe(87_000);
				expect(after.netWorth).toBe(before.netWorth);
				expect(after.overview).toEqual(before.overview);
				expect(after.pastWorth).toEqual(before.pastWorth);
				expect(after.balances).toEqual(before.balances);
				// Antes, juntando o Cartão (âncora mais antiga) no Cartão 2, a fatura de outubro — paga —
				// sumia dentro da fatura informada, e o gasto de outubro caía R$ 800.
				expect(invoicesOf(after, into)).toEqual([
					{ key: '2026-10', amount: 110_000, paid: 80_000, previous: 0 },
					{ key: '2026-11', amount: 50_000, paid: 10_000, previous: 30_000 },
					{ key: '2026-12', amount: 17_000, paid: 0, previous: 0 },
				]);
				// A única diferença, avisada na confirmação: R$ 300 de novembro para outubro.
				const spendBefore = spendOf(before);
				const spendAfter = spendOf(after);
				expect(spendAfter.total).toBe(spendBefore.total);
				expect(spendAfter.months['2026-10'] - spendBefore.months['2026-10']).toBe(30_000);
				expect(spendAfter.months['2026-11'] - spendBefore.months['2026-11']).toBe(-30_000);
				expect(withoutSpend(after)).toEqual(withoutSpend(before));
			}
		);
	});

	describe('levar o cartão para o débito', () => {
		it('Cartão para a Corrente: o pagamento de R$ 800 não volta para a Corrente; ela fica com a dívida (R$ 23.600 → R$ 23.100) e o patrimônio é o mesmo', async () => {
			const before = await fingerprint({ skipBalances: [cartao, corrente] });

			await act(async () => {
				await ctx().convertCardToDebit(cartao, corrente);
			});
			await reload();
			const after = await fingerprint({ skipBalances: [cartao, corrente] });

			// Antes: R$ 23.900 — os R$ 800 pagos voltavam, e a fatura informada sumia.
			expect(ctx().balances.get(corrente)).toBe(2_310_000);
			expect(ctx().balances.has(cartao)).toBe(false);
			expect(after.netWorth).toBe(before.netWorth);
			expect(after.pastWorth).toEqual(before.pastWorth);
			expect(after.balances).toEqual(before.balances);
			expect(after.overview).toEqual({
				...before.overview,
				// A dívida de R$ 500 sai do cartão e passa a sair do caixa.
				cashCents: before.overview.cashCents - 50_000,
				cardsOwedCents: before.overview.cardsOwedCents - 50_000,
			});
			expect(after.reserve).toEqual(before.reserve);
			expect(after.retirement).toEqual(before.retirement);
			// Renda, guardado e rendimento iguais em todos os meses. O gasto muda como a confirmação
			// diz: a compra de R$ 500 (10/10) conta em outubro, e não na fatura de novembro; a fatura
			// informada de R$ 800 (na fatura de outubro) deixa de ser gasto.
			expect(withoutSpend(after)).toEqual(withoutSpend(before));
			const spendBefore = spendOf(before);
			const spendAfter = spendOf(after);
			expect(spendAfter.months['2026-10'] - spendBefore.months['2026-10']).toBe(50_000 - 80_000);
			expect(spendAfter.months['2026-11'] - spendBefore.months['2026-11']).toBe(-50_000);
			expect(spendAfter.total - spendBefore.total).toBe(-80_000);

			// O pagamento da própria Corrente virou transferência dela para ela mesma e saiu; o do
			// Cartão 2 fica. Nada vivo aponta para o cartão.
			expect(await liveTransfersOf(cartao)).toEqual([]);
			expect((await liveTransfersOf(corrente)).map((row) => row.amountCents).sort()).toEqual([
				10_000, 1_200_000, 1_200_000, 30_000,
			]);
		});

		it('o pagamento de fatura feito pela Carteira continua saindo da Carteira e passa a entrar na Corrente', async () => {
			await addTransfer({
				fromAccountId: carteira,
				toAccountId: cartao,
				amountCents: 5_000,
				date: '2026-11-09',
				note: '',
			});
			await reload();
			const before = await fingerprint({ skipBalances: [cartao, corrente] });
			expect(before.balances[carteira]).toBe(40_000);

			await act(async () => {
				await ctx().convertCardToDebit(cartao, corrente);
			});
			await reload();
			const after = await fingerprint({ skipBalances: [cartao, corrente] });

			expect(after.balances[carteira]).toBe(40_000);
			// 23.600 − (500 − 50).
			expect(ctx().balances.get(corrente)).toBe(2_315_000);
			expect(after.netWorth).toBe(before.netWorth);
			expect(after.pastWorth).toEqual(before.pastWorth);
			expect(await liveTransfersOf(carteira)).toEqual([
				{ fromAccountId: carteira, toAccountId: corrente, amountCents: 5_000, deletedAt: null },
			]);
		});

		it('para a Reserva: recusado, e nada muda (os pagamentos de fatura virariam "Guardado")', async () => {
			const before = await fingerprint();
			await act(async () => {
				await ctx().convertCardToDebit(cartao, reserva);
			});
			await reload();
			expect(await fingerprint()).toEqual(before);
			expect(activeIds()).toContain(cartao);
		});

		it('com parcelas por cair (2 × R$ 250, dez e jan): recusado, e nada muda', async () => {
			for (const [date, note] of [
				['2026-12-10', 'Geladeira 2/3'],
				['2027-01-10', 'Geladeira 3/3'],
			]) {
				await addTransaction({ accountId: cartao, date, amountCents: 25_000, isIncome: false, category: 'other_expense', note });
			}
			await reload();
			const before = await fingerprint();
			let error: unknown = null;
			await act(async () => {
				try {
					await ctx().convertCardToDebit(cartao, corrente);
				} catch (caught) {
					error = caught;
				}
			});
			await reload();
			// O retrato primeiro: antes da recusa, é aqui que aparece o que mudava.
			expect(await fingerprint()).toEqual(before);
			expect(error).toBeInstanceOf(DebitFutureError);
			expect(activeIds()).toContain(cartao);
		});
	});

	describe('juntar contas de papéis diferentes', () => {
		it('a Reserva na Corrente: recusado, e nada muda (o "Guardado" de outubro continua R$ 300)', async () => {
			const before = await fingerprint();
			let error: unknown = null;
			await act(async () => {
				try {
					await ctx().mergeAccounts(reserva, corrente);
				} catch (caught) {
					error = caught;
				}
			});
			await reload();
			// Antes: juntava, o total de hoje ficava igual e o "Guardado" de outubro caía para R$ 0.
			expect(error).toBeInstanceOf(MergeRoleError);
			expect(await fingerprint()).toEqual(before);
			expect(monthOf(before, '2026-10')?.saved).toBe(30_000);
			expect(activeIds()).toContain(reserva);
		});

		it('a ficha vazia de outro papel (o que o app junta sozinho, SPD-116) continua juntando, e nada muda', async () => {
			const vazia = await addAccount(
				draft({ name: 'Caixinha', kind: 'savings', role: 'reserve', sortOrder: 6 })
			);
			await reload();
			const before = await fingerprint({ skipBalances: [vazia] });
			await act(async () => {
				await ctx().mergeAccounts(vazia, corrente);
			});
			await reload();
			expect(await fingerprint({ skipBalances: [vazia] })).toEqual(before);
			expect(ctx().accounts.map((account) => account.id)).not.toContain(vazia);
		});
	});
});
