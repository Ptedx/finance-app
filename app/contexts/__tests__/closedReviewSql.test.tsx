/**
 * Conta apagada que volta encerrada no carregamento (SPD-149) e encerradas com saldo decididas
 * pelo usuário (SPD-150), no SQL **de verdade** e no `AccountsProvider` de verdade, com a
 * "impressão digital financeira" do SPD-144 (copiada de `accountsCloseSql.test.tsx`).
 *
 * Critério: nenhum número muda sem o usuário saber e escolher.
 * - SPD-149: lançamento ou transferência viva numa conta apagada (o "Já paguei" e a captura
 *   confirmada gravavam o id morto) não entrava em saldo nem no mês. No carregamento a conta
 *   volta **encerrada**: o saldo das contas vivas e o patrimônio ficam iguais; o histórico do
 *   mês do lançamento muda, e o aviso único diz quanto, mês a mês, com o mesmo número.
 * - SPD-150: conta ou cartão encerrado com saldo não muda sozinho. Cada decisão (transferir ou
 *   pagar, reabrir, zerar) dá exatamente a diferença que a lista mostrou antes.
 *
 * Hoje é 11/11/2026. A base é a do SPD-144:
 * - Corrente: âncora R$ 1.000 em 30/09; mandou R$ 300 à Reserva (05/10) e pagou R$ 800 da
 *   fatura do cartão (15/10); recebeu R$ 12.000 da PJ em 05/10 e em 05/11; gastou R$ 200 em 03/11.
 * - Reserva: âncora 0 em 30/09; recebeu os R$ 300.
 * - Cartão: fatura informada de R$ 800 (âncora −800 em 30/09), compra de R$ 500 em 10/10.
 * - PJ (externa): âncora 0; mandou os 2 × R$ 12.000.
 * - Carteira: âncora R$ 500 em 30/09; gastou R$ 50 em 20/10.
 * - Vazia: nada.
 *
 * Pede `NODE_OPTIONS=--experimental-sqlite`; sem a flag, é pulada com um aviso.
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

import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { getPendingCaptures } from '../../database/captures';
import {
	addAccount,
	addTransaction,
	addTransfer,
	applyPulledChanges,
	buildRevivalNotice,
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
import { CLOSING_TRANSFER_NOTE } from '../../utils/accountClosing';
import { netWorth, owedCents, provisionalEntriesByAccount } from '../../utils/accountMath';
import { addRevivalNotice, getRevivalNotices } from '../../utils/accountRevival';
import type { CardEntry } from '../../utils/cardMath';
import { type ClosedDecision, closedDecisionEffect } from '../../utils/closedReview';
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
		'closedReviewSql.test.tsx pulado: rode com NODE_OPTIONS=--experimental-sqlite (Node 22.12).'
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
		cardsCents,
	};
};

type Fingerprint = Awaited<ReturnType<typeof fingerprint>>;

/** Os números de um mês da série. */
const monthOf = (fp: Fingerprint, month: string) =>
	fp.history.find((point) => point.month === month);

/** As partes do Patrimônio como a tela as soma, para o efeito que a lista mostra. */
const totalsOf = (fp: Fingerprint) => ({
	cashCents: fp.overview.cashCents,
	savedCents: fp.overview.savedCents,
	outsideCents: 0,
	cardsCents: fp.cardsCents,
	debtsCents: 0,
	netCents: fp.overview.netCents,
});

/** O que o histórico mudou mês a mês, no formato do aviso (só os meses que mudaram). */
const historyDiff = (before: Fingerprint, after: Fingerprint) =>
	after.history
		.map((point) => {
			const old = monthOf(before, point.month);
			return {
				month: point.month,
				incomeCents: point.income - (old?.income ?? 0),
				spendCents: point.spend - (old?.spend ?? 0),
				savedCents: point.saved - (old?.saved ?? 0),
			};
		})
		.filter((row) => row.incomeCents !== 0 || row.spendCents !== 0 || row.savedCents !== 0);

const accountRow = (id: string) =>
	db.getFirstAsync<{ deletedAt: string | null; archived: number; dirty: number; updatedAt: string }>(
		'SELECT deletedAt, archived, dirty, updatedAt FROM accounts WHERE id = ?',
		[id]
	);

describeSql('conta apagada que volta encerrada e encerradas com saldo (SPD-149/150)', () => {
	let corrente: string;
	let reserva: string;
	let cartao: string;
	let pj: string;
	let carteira: string;
	let vazia: string;

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
		await AsyncStorage.clear();
		await db.execAsync(
			'DELETE FROM transactions; DELETE FROM transfers; DELETE FROM accounts; DELETE FROM bills; DELETE FROM debts; DELETE FROM captures;'
		);

		corrente = await addAccount(draft({ name: 'Corrente', openingBalanceCents: 100_000 }));
		reserva = await addAccount(draft({ name: 'Reserva', kind: 'savings', role: 'reserve', sortOrder: 1 }));
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
		carteira = await addAccount(draft({ name: 'Carteira', kind: 'cash', openingBalanceCents: 50_000, sortOrder: 4 }));
		vazia = await addAccount(draft({ name: 'Vazia', openingBalanceDate: '2026-10-31', sortOrder: 5 }));

		await addTransfer({ fromAccountId: corrente, toAccountId: reserva, amountCents: 30_000, date: '2026-10-05', note: '' });
		await addTransaction({
			accountId: cartao,
			date: '2026-10-10',
			amountCents: 50_000,
			isIncome: false,
			category: 'food',
			note: 'Mercado',
		});
		await addTransfer({ fromAccountId: corrente, toAccountId: cartao, amountCents: 80_000, date: '2026-10-15', note: '' });
		await addTransfer({ fromAccountId: pj, toAccountId: corrente, amountCents: 1_200_000, date: '2026-10-05', note: '' });
		await addTransfer({ fromAccountId: pj, toAccountId: corrente, amountCents: 1_200_000, date: '2026-11-05', note: '' });
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

	describe('SPD-149: no carregamento, a conta apagada com lançamento vivo volta encerrada', () => {
		/** Como ficou nos aparelhos com a exclusão antiga: a conta com lápide e o lançamento vivo nela. */
		const killAccount = async (id: string) => {
			await db.runAsync("UPDATE accounts SET deletedAt = '2026-11-02T00:00:00.000Z', dirty = 0 WHERE id = ?", [id]);
		};

		it('"Já paguei" de R$ 90 em novembro na Vazia apagada: a conta volta encerrada, saldo das vivas e patrimônio iguais, e o aviso diz "novembro: gasto +R$ 90"', async () => {
			await killAccount(vazia);
			await db.runAsync(
				"INSERT INTO transactions (id, amountCents, category, date, note, isIncome, accountId, updatedAt, deletedAt, dirty) VALUES ('orfa', 9000, 'food', '2026-11-05', 'Luz', 0, ?, '2026-11-05T00:00:00.000Z', NULL, 0)",
				[vazia]
			);
			await reload();
			const before = await fingerprint();
			expect(before.balances[vazia]).toBeUndefined();
			expect(monthOf(before, '2026-11')?.spend).toBe(70_000);

			const repaired = await repairDeadAccountLinks();
			expect(repaired.revived).toEqual([
				{ id: vazia, name: 'Vazia', transactions: 1, transfers: 0, firstDate: '2026-11-05', lastDate: '2026-11-05' },
			]);
			await reload();

			// Encerrada (arquivada), sem lápide, suja e carimbada depois: o sync leva a volta.
			expect(await accountRow(vazia)).toEqual(expect.objectContaining({ deletedAt: null, archived: 1, dirty: 1 }));
			expect(((await accountRow(vazia))?.updatedAt ?? '') > '2026-11-02T00:00:00.000Z').toBe(true);
			expect(ctx().activeAccounts.map((account) => account.id)).not.toContain(vazia);
			expect(ctx().balances.get(vazia)).toBe(-9_000);

			const after = await fingerprint({ skipBalances: [vazia] });
			// O que é de hoje não muda: o saldo de cada conta viva, "Em caixa", "Depois das faturas",
			// o Patrimônio, os cartões e o passado fechado.
			expect(after.balances).toEqual(before.balances);
			expect(after.overview).toEqual(before.overview);
			expect(after.netWorth).toBe(before.netWorth);
			expect(after.cards).toEqual(before.cards);
			expect(after.cardsTotals).toEqual(before.cardsTotals);
			expect(after.pastWorth).toEqual(before.pastWorth);
			expect(after.averages).toEqual(before.averages);
			expect(after.history.slice(0, -1)).toEqual(before.history.slice(0, -1));
			// O que muda é o gasto de novembro (R$ 700 → R$ 790), também em "Este mês".
			expect(monthOf(after, '2026-11')?.spend).toBe(79_000);
			expect(after.month?.spend).toBe((before.month?.spend ?? 0) + 9_000);

			// O aviso diz exatamente isso.
			const notice = await buildRevivalNotice(repaired.revived);
			expect(notice).toEqual({
				accounts: [{ id: vazia, name: 'Vazia', transactions: 1, transfers: 0 }],
				months: [{ month: '2026-11', incomeCents: 0, spendCents: 9_000, savedCents: 0 }],
				// Conta encerrada fica fora dos totais de hoje: o Patrimônio não muda.
				worthDeltaCents: 0,
			});
			expect(notice.months).toEqual(historyDiff(before, after));

			// Idempotente: na próxima carga não há mais nada para trazer de volta.
			expect(await repairDeadAccountLinks()).toEqual({ unlinked: 0, orphaned: 0, revived: [] });
		});

		it('transferência viva de R$ 250 da Corrente para uma poupança apagada em outubro: a Corrente fica igual, a poupança volta com R$ 250, e o aviso diz "outubro: guardado +R$ 250"', async () => {
			const velha = await addAccount(draft({ name: 'Poupança velha', kind: 'savings', role: 'reserve', sortOrder: 6 }));
			await killAccount(velha);
			await db.runAsync(
				"INSERT INTO transfers (id, fromAccountId, toAccountId, amountCents, date, note, updatedAt, deletedAt, dirty) VALUES ('orfa-t', ?, ?, 25000, '2026-10-20', '', '2026-10-20T00:00:00.000Z', NULL, 0)",
				[corrente, velha]
			);
			await reload();
			const before = await fingerprint();
			// A perna da Corrente já contava: 23.700 − 250.
			expect(before.balances[corrente]).toBe(2_345_000);
			expect(monthOf(before, '2026-10')?.saved).toBe(30_000);

			const repaired = await repairDeadAccountLinks();
			expect(repaired.revived.map((account) => [account.id, account.transactions, account.transfers])).toEqual([[velha, 0, 1]]);
			await reload();

			const after = await fingerprint({ skipBalances: [velha] });
			expect(after.balances).toEqual(before.balances);
			expect(after.overview).toEqual(before.overview);
			expect(after.netWorth).toBe(before.netWorth);
			expect(after.cards).toEqual(before.cards);
			expect(ctx().balances.get(velha)).toBe(25_000);
			expect(monthOf(after, '2026-10')?.saved).toBe(55_000);

			const notice = await buildRevivalNotice(repaired.revived);
			expect(notice.months).toEqual([{ month: '2026-10', incomeCents: 0, spendCents: 0, savedCents: 25_000 }]);
			expect(notice.months).toEqual(historyDiff(before, after));
		});

		it('cartão apagado com compra viva: volta encerrado; Em caixa e Depois das faturas iguais, o Patrimônio cai R$ 540 (o devido dele), e o aviso diz isso e o efeito de cada mês', async () => {
			await killAccount(cartao);
			await db.runAsync(
				"INSERT INTO transactions (id, amountCents, category, date, note, isIncome, accountId, updatedAt, deletedAt, dirty) VALUES ('orfa-c', 4000, 'food', '2026-11-06', 'Lanche', 0, ?, '2026-11-06T00:00:00.000Z', NULL, 0)",
				[cartao]
			);
			await reload();
			const before = await fingerprint();
			expect(before.balances[cartao]).toBeUndefined();
			expect(before.netWorth).toBe(2_445_000);

			const repaired = await repairDeadAccountLinks();
			// A compra de outubro, a de novembro e o pagamento da fatura de outubro.
			expect(repaired.revived.map((account) => [account.id, account.transactions, account.transfers])).toEqual([[cartao, 2, 1]]);
			expect(repaired.orphaned).toBe(0);
			await reload();

			expect(await accountRow(cartao)).toEqual(expect.objectContaining({ deletedAt: null, archived: 1, dirty: 1 }));
			const after = await fingerprint({ skipBalances: [cartao] });
			// Hoje: o saldo das contas vivas, "Em caixa" e "Depois das faturas" não mudam (encerrado
			// fica fora deles)...
			expect(after.balances).toEqual(before.balances);
			expect(after.overview).toEqual(before.overview);
			// ...mas o Patrimônio soma o devido de todo cartão, inclusive o encerrado: R$ 500 da
			// fatura de outubro + R$ 40 de novembro.
			const summary = ctx().cardSummaries.get(cartao);
			expect((summary?.owedCents ?? 0) + (summary?.futureCommittedCents ?? 0)).toBe(54_000);
			expect(after.netWorth).toBe(2_445_000 - 54_000);

			// O aviso diz o efeito de cada mês e o do Patrimônio de hoje.
			const notice = await buildRevivalNotice(repaired.revived);
			expect(notice.accounts).toEqual([{ id: cartao, name: 'Cartão', transactions: 2, transfers: 1 }]);
			expect(notice.months).toEqual(historyDiff(before, after));
			expect(notice.months?.length).toBeGreaterThan(0);
			expect(notice.worthDeltaCents).toBe(after.netWorth - before.netWorth);
			expect(notice.worthDeltaCents).toBe(-54_000);

			// E ele entra na lista "Encerradas com saldo", para o usuário decidir.
			expect(ctx().closedReview.map((item) => [item.account.id, item.balanceCents, item.owedCents])).toEqual([[cartao, -54_000, 54_000]]);

			expect(await repairDeadAccountLinks()).toEqual({ unlinked: 0, orphaned: 0, revived: [] });
		});

		it('o aviso fica guardado até a tela de Contas mostrá-lo, e sai ao dispensar', async () => {
			await killAccount(vazia);
			await db.runAsync(
				"INSERT INTO transactions (id, amountCents, category, date, note, isIncome, accountId, updatedAt, deletedAt, dirty) VALUES ('orfa', 9000, 'food', '2026-11-05', 'Luz', 0, ?, '2026-11-05T00:00:00.000Z', NULL, 0)",
				[vazia]
			);
			const repaired = await repairDeadAccountLinks();
			await addRevivalNotice(await buildRevivalNotice(repaired.revived));
			await reload();

			expect(ctx().revivalNotices).toEqual([
				{
					accounts: [{ id: vazia, name: 'Vazia', transactions: 1, transfers: 0 }],
					months: [{ month: '2026-11', incomeCents: 0, spendCents: 9_000, savedCents: 0 }],
					worthDeltaCents: 0,
				},
			]);
			await act(async () => {
				ctx().dismissRevivalNotices();
			});
			await settle();
			expect(ctx().revivalNotices).toEqual([]);
			expect(await getRevivalNotices()).toEqual([]);
		});
	});

	describe('SPD-149: a volta pelo pull gera o mesmo aviso', () => {
		/** A lápide da conta já subiu: este aparelho apagou, o outro ainda lançou nela. */
		const killAccount = async (id: string) => {
			await db.runAsync("UPDATE accounts SET deletedAt = '2026-11-02T00:00:00.000Z', dirty = 0 WHERE id = ?", [id]);
		};
		const changes = (overrides: Partial<SyncChanges>): SyncChanges => ({
			categories: [],
			transactions: [],
			recurringTransactions: [],
			budgets: [],
			...overrides,
		});
		const remotePurchase = (id: string, accountId: string, amountCents: number, date: string) => ({
			id,
			amountCents,
			category: 'food',
			date,
			note: 'Do outro aparelho',
			isIncome: false,
			accountId,
			installmentGroup: null,
			installmentIndex: null,
			installmentCount: null,
			cardLast4: null,
			updatedAt: '2026-11-11T10:00:00.000Z',
			deletedAt: null,
		});

		it('compra de R$ 50 na Vazia apagada chega pelo pull: a conta volta encerrada, e o aviso diz "novembro: gasto +R$ 50", Patrimônio igual', async () => {
			await killAccount(vazia);
			await reload();
			const before = await fingerprint();
			expect(await getRevivalNotices()).toEqual([]);

			await applyPulledChanges(changes({ transactions: [remotePurchase('remota-1', vazia, 5_000, '2026-11-10')] }));
			await reload();

			expect(await accountRow(vazia)).toEqual(expect.objectContaining({ deletedAt: null, archived: 1, dirty: 1 }));
			const after = await fingerprint({ skipBalances: [vazia] });
			expect(after.balances).toEqual(before.balances);
			expect(after.overview).toEqual(before.overview);
			expect(after.netWorth).toBe(before.netWorth);

			const expected = {
				accounts: [{ id: vazia, name: 'Vazia', transactions: 1, transfers: 0 }],
				months: [{ month: '2026-11', incomeCents: 0, spendCents: 5_000, savedCents: 0 }],
				worthDeltaCents: 0,
			};
			expect(expected.months).toEqual(historyDiff(before, after));
			expect(await getRevivalNotices()).toEqual([expected]);
			expect(ctx().revivalNotices).toEqual([expected]);
			// Saldo −R$ 50 numa encerrada: entra na lista para o usuário decidir.
			expect(ctx().closedReview.map((item) => [item.account.id, item.balanceCents])).toEqual([[vazia, -5_000]]);
		});

		it('compra de R$ 20 no cartão apagado chega pelo pull: ele volta encerrado, o aviso diz o efeito de cada mês e "Patrimônio −R$ 520", e ele entra na lista', async () => {
			await killAccount(cartao);
			await reload();
			const before = await fingerprint();
			expect(before.netWorth).toBe(2_445_000);

			await applyPulledChanges(changes({ transactions: [remotePurchase('remota-c', cartao, 2_000, '2026-11-08')] }));
			await reload();

			expect(await accountRow(cartao)).toEqual(expect.objectContaining({ deletedAt: null, archived: 1, dirty: 1 }));
			const after = await fingerprint({ skipBalances: [cartao] });
			expect(after.balances).toEqual(before.balances);
			expect(after.overview).toEqual(before.overview);
			expect(after.netWorth).toBe(2_445_000 - 52_000);

			const notices = await getRevivalNotices();
			expect(notices).toHaveLength(1);
			expect(notices[0].accounts).toEqual([{ id: cartao, name: 'Cartão', transactions: 2, transfers: 1 }]);
			expect(notices[0].months).toEqual(historyDiff(before, after));
			expect(notices[0].worthDeltaCents).toBe(-52_000);
			expect(ctx().closedReview.map((item) => [item.account.id, item.balanceCents, item.owedCents])).toEqual([[cartao, -52_000, 52_000]]);
		});

		it('pull sem conta voltando não gera aviso', async () => {
			await applyPulledChanges(changes({ transactions: [remotePurchase('remota-2', corrente, 1_000, '2026-11-09')] }));
			expect(await getRevivalNotices()).toEqual([]);
		});
	});

	describe('SPD-150: encerradas com saldo, só com decisão', () => {
		/** Encerradas antes do SPD-144: arquivadas com saldo, sem transferência de encerramento. */
		const archiveOld = async () => {
			await db.runAsync('UPDATE accounts SET archived = 1 WHERE id IN (?, ?)', [carteira, cartao]);
			await reload();
		};

		it('a lista mostra a Carteira (R$ 450) e o Cartão (deve R$ 500); sem decisão, nenhum número muda', async () => {
			await archiveOld();
			const before = await fingerprint();
			expect(ctx().closedReview.map((item) => [item.account.id, item.balanceCents, item.owedCents])).toEqual([
				[cartao, -50_000, 50_000],
				[carteira, 45_000, 0],
			]);
			// A incoerência de hoje, mantida até a decisão: o Patrimônio conta o cartão encerrado
			// devendo; "Depois das faturas", não. 23.700 + 300 − 500 = 23.500 contra 23.700.
			expect(before.overview.cashCents).toBe(2_370_000);
			expect(before.overview.netCents).toBe(2_370_000);
			expect(before.netWorth).toBe(2_350_000);

			await reload();
			await reload();
			expect(await fingerprint()).toEqual(before);
		});

		type Decision = { kind: 'transfer'; target: () => string } | { kind: 'reopen' } | { kind: 'zero' };
		it.each<[string, () => string, Decision, number]>([
			['Carteira (R$ 450) → Corrente: Patrimônio R$ 23.500 → R$ 23.950', () => carteira, { kind: 'transfer', target: () => corrente }, 2_395_000],
			['Carteira (R$ 450) reaberta: Patrimônio R$ 23.500 → R$ 23.950', () => carteira, { kind: 'reopen' }, 2_395_000],
			['Carteira (R$ 450) zerada: Patrimônio fica R$ 23.500', () => carteira, { kind: 'zero' }, 2_350_000],
			['Cartão (deve R$ 500) pago pela Corrente: Patrimônio fica R$ 23.500, "Depois das faturas" R$ 23.700 → R$ 23.200', () => cartao, { kind: 'transfer', target: () => corrente }, 2_350_000],
			['Cartão (deve R$ 500) reaberto: Patrimônio fica R$ 23.500, "Depois das faturas" R$ 23.700 → R$ 23.200', () => cartao, { kind: 'reopen' }, 2_350_000],
			['Cartão (deve R$ 500) zerado (pago fora do app): Patrimônio R$ 23.500 → R$ 24.000', () => cartao, { kind: 'zero' }, 2_400_000],
		])('%s: a diferença é exatamente a mostrada', async (_label, idOf, decision, expectedWorth) => {
			await archiveOld();
			const id = idOf();
			const before = await fingerprint();
			const item = ctx().closedReview.find((candidate) => candidate.account.id === id);
			if (!item) throw new Error('fora da lista');
			const target = decision.kind === 'transfer' ? ctx().accounts.find((account) => account.id === decision.target()) : undefined;
			const shown: ClosedDecision =
				decision.kind === 'transfer' ? { kind: 'transfer', target: target as NonNullable<typeof target> } : decision;
			const effect = closedDecisionEffect(item, shown, totalsOf(before));
			expect(effect.worth.beforeCents).toBe(before.netWorth);
			expect(effect.net.beforeCents).toBe(before.overview.netCents);
			expect(effect.worth.afterCents).toBe(expectedWorth);

			await act(async () => {
				await ctx().settleClosedAccount(
					id,
					decision.kind === 'transfer' ? { kind: 'transfer', targetId: decision.target() } : decision
				);
			});
			await reload();
			const after = await fingerprint({ skipBalances: [id, ...(decision.kind === 'transfer' ? [decision.target()] : [])] });

			// Exatamente o que a lista mostrou.
			expect(after.netWorth).toBe(effect.worth.afterCents);
			expect(after.overview.netCents).toBe(effect.net.afterCents);
			expect((monthOf(after, '2026-11')?.saved ?? 0) - (monthOf(before, '2026-11')?.saved ?? 0)).toBe(effect.savedThisMonthCents);
			// Nenhum gasto nem receita no histórico, nem nos meses fechados nem neste.
			expect(after.history.slice(0, -1)).toEqual(before.history.slice(0, -1));
			expect(monthOf(after, '2026-11')?.spend).toBe(monthOf(before, '2026-11')?.spend);
			expect(monthOf(after, '2026-11')?.income).toBe(monthOf(before, '2026-11')?.income);
			expect(after.month?.spend).toBe(before.month?.spend);
			expect(after.month?.income).toBe(before.month?.income);
			// Decidida, sai da lista: zerada, transferida ou de volta aos totais.
			expect(ctx().closedReview.map((candidate) => candidate.account.id)).not.toContain(id);
			if (decision.kind !== 'reopen') {
				expect(ctx().balances.get(id)).toBe(0);
				expect(ctx().accounts.find((account) => account.id === id)?.archived).toBe(true);
			} else {
				expect(ctx().activeAccounts.map((account) => account.id)).toContain(id);
			}
			// O saldo das outras contas vivas não mudou (só o destino da transferência).
			expect(after.balances).toEqual(
				Object.fromEntries(Object.entries(before.balances).filter(([key]) => key !== id && (decision.kind !== 'transfer' || key !== decision.target())))
			);
			// Zerar não cria lançamento: nenhum gasto nem receita novo no banco.
			if (decision.kind === 'zero') {
				expect(await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM transactions WHERE deletedAt IS NULL')).toEqual({ n: 3 });
			}
		});

		it('zerar a Carteira tira os R$ 450 também do fim de cada mês passado, sem tocar no histórico de receita e gasto', async () => {
			await archiveOld();
			const before = await fingerprint();
			await act(async () => {
				await ctx().settleClosedAccount(carteira, { kind: 'zero' });
			});
			await reload();
			const after = await fingerprint();
			for (const [month, cents] of Object.entries(before.pastWorth)) expect(after.pastWorth[month]).toBe(cents - 45_000);
			expect(after.history).toEqual(before.history);
		});

		// SPD-155: só conta principal ativa paga a fatura do cartão encerrado, a mesma regra da
		// lista (`isDebitTarget`). Com a Reserva, o acerto de um cartão antigo viraria resgate deste mês.
		it.each<[string, () => string]>([
			['a Reserva', () => reserva],
			['a PJ (externa)', () => pj],
			['o próprio cartão', () => cartao],
		])('pagar o Cartão (deve R$ 500) com %s: recusado, e nenhum número muda', async (_label, payerOf) => {
			await archiveOld();
			const before = await fingerprint();

			await expect(ctx().settleClosedAccount(cartao, { kind: 'transfer', targetId: payerOf() })).rejects.toThrow();
			await reload();

			expect(await fingerprint()).toEqual(before);
			expect(ctx().closedReview.map((item) => item.account.id)).toContain(cartao);
		});

		// A mesma regra no transferir da conta encerrada: o saldo vai só para conta principal ativa.
		it.each<[string, () => string]>([
			['a Reserva', () => reserva],
			['a PJ (externa)', () => pj],
		])('transferir a Carteira (R$ 450) para %s: recusado, e nenhum número muda', async (_label, targetOf) => {
			await archiveOld();
			const before = await fingerprint();

			await expect(ctx().settleClosedAccount(carteira, { kind: 'transfer', targetId: targetOf() })).rejects.toThrow();
			await reload();

			expect(await fingerprint()).toEqual(before);
			expect(ctx().closedReview.map((item) => item.account.id)).toContain(carteira);
			expect(
				await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM transfers WHERE note = ?', [CLOSING_TRANSFER_NOTE])
			).toEqual({ n: 0 });
		});
	});
});
