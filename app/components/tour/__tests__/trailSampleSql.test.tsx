/**
 * O modo exemplo das trilhas (SPD-147) no SQL **de verdade**, com o `AccountsProvider` e o
 * `DebtsProvider` de verdade: as trilhas andam nas telas reais (o cartão, o cadastro do cartão,
 * a dívida, o cadastro da dívida, a conta, o lançamento) e o banco fica igual, linha por linha.
 *
 * - Sem cartão, dívida, conta nem lançamento: cada trilha abre a tela com o exemplo só em
 *   memória, marcado "Exemplo" (o rótulo no balão e a faixa na tela), e aponta o elemento do
 *   passo. Nenhuma linha muda em tabela nenhuma, nenhuma fica suja para o sync, e no aparelho só
 *   o estado do tutorial é gravado.
 * - Ao sair da trilha (o fim, o "Pular" ou o app fechado no meio), o exemplo some: a mesma rota
 *   diz "não encontrado".
 * - Com os registros do usuário, a trilha usa os dele.
 *
 * O "banco igual" é a foto de todas as tabelas (todas as colunas, `dirty` inclusive) antes e
 * depois. E os números das telas (saldo, "Em caixa", patrimônio, cartões, dívidas, relatórios —
 * a impressão digital do SPD-144) são calculados do estado em memória dos contextos, inclusive
 * com a tela de exemplo aberta: se o exemplo vazasse para os contextos sem tocar no banco,
 * apareceria ali.
 *
 * Como em `accountsCloseSql.test.tsx`, o `expo-sqlite` vira o `node:sqlite` em memória e a suíte
 * pede `NODE_OPTIONS=--experimental-sqlite`; sem a flag, é pulada com um aviso. O guia navega
 * numa pilha de mentira que desenha só a tela do topo; só a medida é de mentira (todo alvo
 * montado está no meio da tela). As chaves de tradução aparecem cruas.
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

const mockStorage = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
	getItem: jest.fn(async (key: string) => mockStorage.get(key) ?? null),
	setItem: jest.fn(async (key: string, value: string) => {
		mockStorage.set(key, value);
	}),
	removeItem: jest.fn(async (key: string) => {
		mockStorage.delete(key);
	}),
	multiGet: jest.fn(async (keys: string[]) =>
		keys.map((key) => [key, mockStorage.get(key) ?? null])
	),
	multiSet: jest.fn(async (pairs: [string, string][]) => {
		for (const [key, value] of pairs) mockStorage.set(key, value);
	}),
	getAllKeys: jest.fn(async () => [...mockStorage.keys()]),
}));
jest.mock('../../../sync/queue', () => ({
	schedule: jest.fn(),
	getState: () => ({ status: 'idle' }),
}));
jest.mock('../../../hooks/useAfterPull', () => ({ useAfterPull: jest.fn() }));
jest.mock('../../../api/cdi', () => ({
	loadCachedCdi: jest.fn(async () => null),
	refreshCdi: jest.fn(async () => null),
}));

/** Os parâmetros da tela do topo, para quem lê a rota (o lançamento, a conta). */
const mockNav: { params: Record<string, string> } = { params: {} };
jest.mock('expo-router', () => ({
	router: {
		push: jest.fn(),
		back: jest.fn(),
		navigate: jest.fn(),
		dismiss: jest.fn(),
		dismissAll: jest.fn(),
	},
	useRouter: () => ({
		replace: jest.fn(),
		back: jest.fn(),
		push: jest.fn(),
		canGoBack: () => true,
		dismissTo: jest.fn(),
		dismiss: jest.fn(),
	}),
	useLocalSearchParams: () => mockNav.params,
	useFocusEffect: (effect: () => void) => require('react').useEffect(effect, [effect]),
	Stack: { Screen: () => null },
}));

jest.mock('../registry', () => {
	const actual = jest.requireActual('../registry');
	return {
		...actual,
		measureTarget: async (id: string) =>
			actual.hasTarget(id) ? { x: 16, y: 200, width: 300, height: 50 } : null,
	};
});

jest.mock('../../../utils/onboardingUtils', () => ({
	isOnboardingCompleted: jest.fn(async () => true),
}));
jest.mock('../../../utils/dateUtils', () => ({
	...jest.requireActual('../../../utils/dateUtils'),
	todayISO: () => '2026-11-07',
}));
jest.mock('../../../utils/accountResolver', () => ({
	...jest.requireActual('../../../utils/accountResolver'),
	findCheckingForCard: jest.fn(async () => null),
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => {
	const { View } = require('react-native');
	return {
		SafeAreaView: View,
		useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
	};
});
// O `t` é o mesmo a cada desenho, como no app: a tela do lançamento roda um efeito por ele.
jest.mock('react-i18next', () => {
	const t = (key: string, params?: Record<string, unknown>) =>
		params ? `${key}${JSON.stringify(params)}` : key;
	return { useTranslation: () => ({ t }) };
});

// As folhas (que gravam) a trilha nunca abre; com o exemplo, nem montam.
jest.mock('../../debts/AmortizeSheet', () => () => null);
jest.mock('../../accounts/AdjustAccountSheet', () => () => null);
jest.mock('../../cards/Sheet', () => () => null);
jest.mock('../../cards/RenameCardSheet', () => () => null);
jest.mock('../../MergeTargetSheet', () => () => null);
jest.mock('../../TransactionItem', () => () => null);

// Os dados que não são do banco desta suíte: os lançamentos (sem nenhum), o mês, o sync, a captura.
const mockLedger = {
	transactions: [],
	categories: [],
	refreshData: jest.fn(async () => undefined),
	removeTransaction: jest.fn(),
	removeInstallmentGroup: jest.fn(),
};
jest.mock('../../../contexts/TransactionsContext', () => ({ useTransactions: () => mockLedger }));
const mockPeriod = {
	startDate: '2026-11-01',
	endDate: '2026-11-30',
	selectedYear: 2026,
	selectedMonth: 11,
};
jest.mock('../../../contexts/PeriodContext', () => ({ usePeriod: () => mockPeriod }));
const mockSync = { lastSyncedAt: null };
jest.mock('../../../contexts/SyncContext', () => ({ useSync: () => mockSync }));
const mockCaptures = { pending: [], supported: false };
jest.mock('../../../contexts/CapturesContext', () => ({ useCaptures: () => mockCaptures }));
jest.mock('../../../hooks/useRetirementGoal', () => ({
	useRetirementGoal: () => ({ goal: null, isLoading: false, save: jest.fn(), clear: jest.fn() }),
}));

import type React from 'react';
import { useState } from 'react';
import { AccessibilityInfo, Text } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { AccountsProvider, useAccounts } from '../../../contexts/AccountsContext';
import { DebtsProvider, useDebts } from '../../../contexts/DebtsContext';
import { getPendingCaptures } from '../../../database/captures';
import {
	addAccount,
	addDebt,
	addTransaction,
	db,
	getAccountBalances,
	getAccounts,
	getMonthlyAccountActivity,
	getMonthlyTransferActivity,
	getTransactionsForAccounts,
	getTransfersByDateRange,
	getUnassignedNet,
	initDatabase,
} from '../../../database/database';
import AccountEditScreen from '../../../screens/AccountEditScreen';
import CardDetailScreen from '../../../screens/CardDetailScreen';
import CardEditScreen from '../../../screens/CardEditScreen';
import CardsScreen from '../../../screens/CardsScreen';
import DebtDetailScreen from '../../../screens/DebtDetailScreen';
import DebtEditScreen from '../../../screens/DebtEditScreen';
import TransactionDetailScreen from '../../../transaction/[id]';
import { netWorth, owedCents, provisionalEntriesByAccount } from '../../../utils/accountMath';
import type { CardEntry } from '../../../utils/cardMath';
import { monthKeyOf, monthKeyRange, todayISO } from '../../../utils/dateUtils';
import { buildReserveReadModel, contributionDelayMonths } from '../../../utils/emergencyReserve';
import { buildHealthIndicators } from '../../../utils/healthScore';
import { configureMoney } from '../../../utils/money';
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
} from '../../../utils/reportSeries';
import { buildRetirementReadModel, monthlyRate } from '../../../utils/retirement';
import { STORAGE_KEYS } from '../../../utils/storageUtils';
import type { TrailId, TrailLocation, TrailNavAction } from '../../../utils/trails';
import { clearTourRegistry } from '../registry';
import { type TourContextValue, useTour } from '../TourContext';
import TourProvider from '../TourProvider';
import TrailRecordsSource from '../TrailRecordsSource';
import { useTrailSampleOn } from '../TrailSample';

const sqliteAvailable: boolean = jest.requireMock<{ mockSqliteAvailable: boolean }>(
	'expo-sqlite'
).mockSqliteAvailable;
if (!sqliteAvailable) {
	console.warn(
		'trailSampleSql.test.tsx pulado: rode com NODE_OPTIONS=--experimental-sqlite (Node 22.12).'
	);
}
const describeSql = sqliteAvailable ? describe : describe.skip;

jest.setTimeout(120_000);
jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);

// ---------------------------------------------------------------------------
// A pilha de mentira, o guia e a foto do banco
// ---------------------------------------------------------------------------

let renderer: ReactTestRenderer | null = null;
let setStack: React.Dispatch<React.SetStateAction<TrailLocation[]>> | null = null;
let currentStack: TrailLocation[] = [];
let tour: TourContextValue | null = null;
let sampleOn = false;

const FakeStack: React.FC<{ initial: TrailLocation[] }> = ({ initial }) => {
	const [stack, update] = useState(initial);
	setStack = update;
	currentStack = stack;
	const top = stack[stack.length - 1];
	if (!top) return null;
	mockNav.params = { ...(top.params ?? {}) };
	const id = top.params?.id;
	const key = `${stack.length}:${top.screen}:${id ?? top.params?.exemplo ?? ''}`;
	switch (top.screen) {
		// A lista de cartões de verdade (SPD-158): o "?" do guia da fatura fica nela.
		case 'cards':
			return <CardsScreen key={key} />;
		case 'card':
			return <CardDetailScreen key={key} cardId={id ?? ''} />;
		case 'cardNew':
			return <CardEditScreen key={key} sampleForm={top.params?.exemplo} />;
		case 'cardEdit':
			return <CardEditScreen key={key} cardId={id} />;
		case 'debt':
			return <DebtDetailScreen key={key} debtId={id ?? ''} />;
		case 'debtNew':
			return <DebtEditScreen key={key} sampleForm={top.params?.exemplo} />;
		case 'debtEdit':
			return <DebtEditScreen key={key} debtId={id} />;
		case 'account':
			return <AccountEditScreen key={key} accountId={id} />;
		case 'transaction':
			return <TransactionDetailScreen key={key} />;
		default:
			return <Text key={key}>{`tela ${top.screen}`}</Text>;
	}
};

let accountsState: ReturnType<typeof useAccounts> | null = null;
let debtsState: ReturnType<typeof useDebts> | null = null;

const Probe = () => {
	tour = useTour();
	sampleOn = useTrailSampleOn();
	accountsState = useAccounts();
	debtsState = useDebts();
	return null;
};

const accountsOf = () => {
	if (!accountsState) throw new Error('AccountsProvider não montou');
	return accountsState;
};
const debtsOf = () => {
	if (!debtsState) throw new Error('DebtsProvider não montou');
	return debtsState;
};

const navigator = {
	run: (action: TrailNavAction) => {
		setStack?.((stack) => {
			if (action.type === 'push') return [...stack, action.location];
			if (action.type === 'pop') return stack.slice(0, Math.max(0, stack.length - action.count));
			if (action.type === 'root') return [];
			return [{ screen: action.screen }];
		});
	},
};

const wait = (ms: number) =>
	act(async () => new Promise<void>((resolve) => setTimeout(resolve, ms)));

const texts = (): string[] =>
	(
		renderer?.root.findAll(
			(node) => (node.type as unknown) === Text || (node.type as unknown) === 'Text'
		) ?? []
	).map((node) => [node.props.children].flat().join(''));

const waitUntil = async (check: () => boolean, what: string, timeout = 10_000) => {
	const start = Date.now();
	while (!check() && Date.now() - start < timeout) await wait(25);
	if (!check()) throw new Error(`${what} não aconteceu. Na tela: ${texts().join(' | ')}`);
};

const pressLabel = async (label: string) => {
	const node = renderer?.root.findAll(
		(candidate: ReactTestInstance) =>
			candidate.props.accessibilityLabel === label && typeof candidate.props.onPress === 'function'
	)[0];
	if (!node) throw new Error(`nada tocável: ${label}`);
	await act(async () => {
		node.props.onPress();
	});
};

/** O "?" de uma trilha, achado pelo rótulo de acessibilidade que diz o nome do guia. */
const helpButtons = (trail: TrailId) =>
	renderer?.root.findAll(
		(candidate: ReactTestInstance) =>
			typeof candidate.props.onPress === 'function' &&
			candidate.props.accessibilityHint ===
				`trails.helpHint${JSON.stringify({ trail: `trails.${trail}.title` })}`
	) ?? [];

const pointing = () =>
	(renderer?.root.findAll((node) => node.props.testID === 'trail-outline').length ?? 0) > 0;
const top = () => currentStack[currentStack.length - 1];
const where = (location: TrailLocation | undefined) =>
	location
		? `${location.screen}${location.params ? `:${Object.values(location.params).join('/')}` : ''}`
		: '';

/** Deixa as recargas dos providers terminarem. */
const settle = async () => {
	for (let i = 0; i < 8; i++) {
		await act(async () => {
			await new Promise((resolve) => setImmediate(resolve));
		});
	}
};

const mount = async (initial: TrailLocation[]) => {
	await act(async () => {
		renderer = create(
			<AccountsProvider>
				<DebtsProvider>
					<TourProvider trailOptions={{ navigator, settleMs: 0, readyTimeoutMs: 1_500 }}>
						<TrailRecordsSource />
						<Probe />
						<FakeStack initial={initial} />
					</TourProvider>
				</DebtsProvider>
			</AccountsProvider>
		);
	});
	await settle();
	await wait(50);
};

const unmount = async () => {
	await act(async () => {
		renderer?.unmount();
	});
	renderer = null;
	tour = null;
	sampleOn = false;
};

interface Shown {
	id: string;
	at: string;
	pointing: boolean;
	sample: boolean;
	banner: boolean;
}

/**
 * Abre a trilha como o "?" abre e anda até o fim pelo "Próximo" (ou para no passo `stopAt`),
 * anotando cada passo: onde, se aponta e se está marcado "Exemplo".
 */
const walk = async (
	trail: TrailId,
	here: TrailLocation,
	{ from, stopAt, press }: { from?: string; stopAt?: string; press?: boolean } = {}
): Promise<Shown[]> => {
	// `press`: começa pelo "?" da tela, como o usuário (SPD-158), em vez de pedir a trilha direto.
	const button = press ? helpButtons(trail)[0] : undefined;
	if (press && !button) throw new Error(`sem "?" da trilha ${trail}. Na tela: ${texts().join(' | ')}`);
	await act(async () => {
		if (button) button.props.onPress();
		else tour?.startTrail(trail, { here, from });
	});
	const shown: Shown[] = [];
	const titleOf = () =>
		texts().find((text) => text.startsWith(`trails.${trail}.steps.`) && text.endsWith('.title'));
	let last = '';
	for (let guard = 0; guard < 20; guard++) {
		await waitUntil(() => {
			const title = titleOf();
			return title !== undefined && title !== last;
		}, `o passo depois de ${last}`);
		last = titleOf() as string;
		const id = last.split('.')[3];
		shown.push({
			id,
			at: where(top()),
			pointing: pointing(),
			sample: texts().includes('trails.sample.tag'),
			banner: texts().includes('trails.sample.banner'),
		});
		if (id === stopAt) return shown;
		const done = texts().includes('tutorial.done');
		await pressLabel(done ? 'tutorial.done' : 'tutorial.next');
		if (done) break;
	}
	await waitUntil(() => titleOf() === undefined, 'o fim da trilha');
	await waitUntil(() => where(top()) === where(here), 'a volta para a tela de origem');
	return shown;
};

/** A foto do banco: cada tabela inteira, todas as colunas (o `dirty` inclusive). */
const snapshot = async () => {
	const tables = await db.getAllAsync<{ name: string }>(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
	);
	const photo: Record<string, { rows: number; dirty: number; data: string }> = {};
	for (const { name } of tables) {
		const rows = await db.getAllAsync<Record<string, unknown>>(
			`SELECT * FROM "${name}" ORDER BY rowid`
		);
		photo[name] = {
			rows: rows.length,
			dirty: rows.filter((row) => row.dirty === 1 || row.dirty === true).length,
			data: JSON.stringify(rows),
		};
	}
	return photo;
};

/** Tudo já subiu para o servidor: o que a trilha sujasse apareceria. */
const markAllClean = async () => {
	const tables = await db.getAllAsync<{ name: string }>(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
	);
	for (const { name } of tables) {
		const columns = await db.getAllAsync<{ name: string }>(`PRAGMA table_info("${name}")`);
		if (columns.some((column) => column.name === 'dirty'))
			await db.execAsync(`UPDATE "${name}" SET dirty = 0`);
	}
};

const storageKeys = () =>
	[...mockStorage.keys()].filter((key) => key !== STORAGE_KEYS.tutorial).sort();

const counts = (photo: Awaited<ReturnType<typeof snapshot>>) =>
	Object.fromEntries(
		Object.entries(photo).map(([name, { rows, dirty }]) => [name, { rows, dirty }])
	);

// ---------------------------------------------------------------------------
// A impressão digital financeira (copiada de `contexts/__tests__/accountsCloseSql.test.tsx`, SPD-144)
// ---------------------------------------------------------------------------
//
// Os números calculados do estado em memória dos contextos: se o exemplo vazasse para eles (sem
// tocar no banco), o saldo, o patrimônio, os cartões ou as dívidas mudariam aqui.

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
	const c = accountsOf();
	const d = debtsOf();
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
		debtsCents: d.summary.balanceCents,
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
		debts: d.debts.map((debt) => debt.id),
		debtsSummary: d.summary,
	};
};

// ---------------------------------------------------------------------------

describeSql('SPD-147 — o exemplo das trilhas, no SQL de verdade', () => {
	beforeAll(async () => {
		await initDatabase();
	});

	beforeEach(() => {
		clearTourRegistry();
		configureMoney({ locale: 'pt-BR', currencyCode: 'BRL', currencySymbol: 'R$' });
	});

	afterEach(async () => {
		await unmount();
		configureMoney({ locale: 'en-US', currencyCode: 'USD', currencySymbol: '$' });
	});

	it('sem cartão, dívida, conta nem lançamento: cada trilha mostra o exemplo, aponta o passo e o banco fica igual', async () => {
		await markAllClean();
		const keysBefore = storageKeys();
		await mount([{ screen: 'cards' }]);
		const before = await snapshot();
		const numbers = await fingerprint();
		expect(before.accounts.rows).toBe(0);
		expect(before.debts.rows).toBe(0);

		// Trilha 3 inteira no cartão de exemplo: o "Nenhum cartão ainda" não existe mais.
		const invoice = await walk('cardInvoice', { screen: 'cards' });
		expect(invoice.map((step) => step.id)).toEqual([
			'1',
			'2',
			'3',
			'4',
			'5',
			'6',
			'7',
			'8',
			'9',
			'10',
			'11',
			'12',
		]);
		expect(
			invoice.every((step) => step.at === 'card:exemplo-cartao' && step.sample && step.banner)
		).toBe(true);
		// Aponta tudo o que um cartão sem compra tem; "Aguardando revisão" e "pode estar repetido"
		// só existem com compras de verdade, e ficam no texto.
		expect(invoice.filter((step) => !step.pointing).map((step) => step.id)).toEqual(['10', '11']);

		// Trilha 2 do passo 8: o cadastro preenchido com o exemplo mostra as datas da fatura (o 8,
		// que antes ficava sem apontar), e o 11 abre o cartão de exemplo sem fechamento.
		const setup = await walk('cardSetup', { screen: 'cards' }, { from: '8' });
		expect(setup.map((step) => [step.id, step.at, step.pointing, step.sample])).toEqual([
			['8', 'cardNew:1', true, true],
			['9', 'cardNew:1', true, true],
			['10', 'cardNew:1', true, true],
			['11', 'card:exemplo-cartao-sem-fechamento', true, true],
		]);

		// Trilha 9 do passo 2, do Patrimônio: a prévia (6) aponta, e a dívida de exemplo (9 a 12).
		await act(async () => {
			setStack?.([{ screen: 'wealth' }]);
		});
		const debts = await walk('debts', { screen: 'wealth' }, { from: '2' });
		expect(debts.map((step) => [step.id, step.at, step.pointing, step.sample])).toEqual([
			['2', 'debtNew:1', true, true],
			['3', 'debtNew:1', true, true],
			['4', 'debtNew:1', true, true],
			['5', 'debtNew:1', true, true],
			['6', 'debtNew:1', true, true],
			['7', 'debtNew:1', true, true],
			['8', 'debtNew:1', false, true],
			['9', 'debt:exemplo-divida', true, true],
			['10', 'debt:exemplo-divida', true, true],
			['11', 'debt:exemplo-divida', true, true],
			['12', 'debtEdit:exemplo-divida', true, true],
		]);

		// Trilha 1 do passo 9: a conta de exemplo e a "criada pela captura", com o "Saldo não informado".
		await act(async () => {
			setStack?.([{ screen: 'accounts' }]);
		});
		const accounts = await walk('accounts', { screen: 'accounts' }, { from: '9' });
		expect(accounts.map((step) => [step.id, step.at, step.pointing, step.sample])).toEqual([
			['9', 'account:exemplo-conta', true, true],
			['10', 'account:exemplo-conta-captura', true, true],
			['11', 'accounts', false, false],
			['12', 'account:exemplo-conta', true, true],
		]);

		// Trilha 5, passo 11: o lançamento de exemplo, com "Editar" e "Apagar".
		await act(async () => {
			setStack?.([{ screen: 'home' }]);
		});
		const add = await walk('add', { screen: 'home' }, { from: '11' });
		expect(add[0]).toEqual({
			id: '11',
			at: 'transaction:exemplo-lancamento',
			pointing: true,
			sample: true,
			banner: true,
		});

		// Nada gravado: as mesmas linhas, nenhuma suja, e no aparelho só o estado do tutorial.
		const after = await snapshot();
		expect(counts(after)).toEqual(counts(before));
		expect(after).toEqual(before);
		expect(Object.values(after).reduce((total, table) => total + table.dirty, 0)).toBe(0);
		expect(storageKeys()).toEqual(keysBefore);
		// E nenhum número mudou: saldo, "Em caixa", patrimônio, cartões, dívidas, relatórios.
		expect(await fingerprint()).toEqual(numbers);
		expect(numbers.cards).toEqual({});
		expect(numbers.debts).toEqual([]);

		// Ao sair da trilha, o exemplo some: a mesma rota diz que não achou o cartão.
		await wait(800);
		expect(sampleOn).toBe(false);
		await act(async () => {
			setStack?.([{ screen: 'cards' }, { screen: 'card', params: { id: 'exemplo-cartao' } }]);
		});
		await waitUntil(() => texts().includes('cards.notFound'), '"não encontrado"');
		expect(texts()).not.toContain('trails.sample.card');
		expect(texts()).not.toContain('trails.sample.banner');
	});

	it('"Pular" no meio, ou o app fechado no meio: o exemplo some e nada foi gravado', async () => {
		await markAllClean();
		await mount([{ screen: 'cards' }]);
		const before = await snapshot();
		const numbers = await fingerprint();

		await walk('cardInvoice', { screen: 'cards' }, { stopAt: '3' });
		expect(sampleOn).toBe(true);
		// Com o cartão de exemplo na tela, os contextos não o veem: nenhum número muda.
		expect(await fingerprint()).toEqual(numbers);
		await pressLabel('tutorial.skip');
		await waitUntil(() => where(top()) === 'cards', 'a volta para Cartões');
		await wait(800);
		expect(sampleOn).toBe(false);

		// O app fecha com a trilha aberta numa tela de exemplo: nada fica guardado.
		await walk('debts', { screen: 'cards' }, { from: '9', stopAt: '10' });
		expect(where(top())).toBe('debt:exemplo-divida');
		expect(await fingerprint()).toEqual(numbers);
		await unmount();
		expect(await snapshot()).toEqual(before);

		// Aberto de novo, sem trilha: não há exemplo, nem na rota dele.
		await mount([{ screen: 'wealth' }, { screen: 'debt', params: { id: 'exemplo-divida' } }]);
		expect(sampleOn).toBe(false);
		await waitUntil(() => texts().includes('debts.detail.missing'), '"dívida não encontrada"');
		expect(texts()).not.toContain('trails.sample.debt');
	});

	it('SPD-158 — sem cartão, o "?" da lista de cartões abre o guia da fatura no exemplo, volta para a lista e o banco fica igual', async () => {
		await markAllClean();
		const keysBefore = storageKeys();
		await mount([{ screen: 'cards' }]);
		const before = await snapshot();
		const numbers = await fingerprint();
		expect(before.accounts.rows).toBe(0);
		expect(helpButtons('cardInvoice')).toHaveLength(1);

		// Concluir: os 12 passos no cartão de exemplo, com a faixa e o rótulo, e a volta para a lista.
		const invoice = await walk('cardInvoice', { screen: 'cards' }, { press: true });
		expect(invoice.map((step) => step.id)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);
		expect(invoice.every((step) => step.at === 'card:exemplo-cartao' && step.sample && step.banner)).toBe(true);
		expect(currentStack).toEqual([{ screen: 'cards' }]);
		await wait(800);
		expect(sampleOn).toBe(false);

		// Pular no meio: também volta para a lista.
		await walk('cardInvoice', { screen: 'cards' }, { press: true, stopAt: '4' });
		expect(where(top())).toBe('card:exemplo-cartao');
		expect(await fingerprint()).toEqual(numbers);
		await pressLabel('tutorial.skip');
		await waitUntil(() => where(top()) === 'cards', 'a volta para Cartões');
		expect(currentStack).toEqual([{ screen: 'cards' }]);
		await wait(800);
		expect(sampleOn).toBe(false);

		const after = await snapshot();
		expect(after).toEqual(before);
		expect(Object.values(after).reduce((total, table) => total + table.dirty, 0)).toBe(0);
		expect(storageKeys()).toEqual(keysBefore);
		expect(await fingerprint()).toEqual(numbers);
	});

	it('com os registros do usuário, a trilha usa os dele — e o banco também fica igual', async () => {
		const card = await addAccount({
			name: 'Cartão Teste',
			kind: 'credit_card',
			role: 'card',
			envelopeMonthlyCents: null,
			bankName: 'Banco Teste',
			color: '#000000',
			last4: '1234',
			network: null,
			closingDay: 3,
			dueDay: 10,
			closingDaysBefore: 7,
			creditLimitCents: 100_000,
			cardNames: null,
			yieldCdiBp: null,
			reservePurpose: null,
			packageName: null,
			accountKey: null,
			openingBalanceCents: 0,
			openingBalanceDate: '2026-10-31',
			sortOrder: 0,
			archived: false,
		});
		const checking = await addAccount({
			name: 'Corrente Teste',
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
			openingBalanceCents: 150_000,
			openingBalanceDate: '2026-10-31',
			sortOrder: 1,
			archived: false,
		});
		const debt = await addDebt({
			name: 'Carro Teste',
			kind: 'financing',
			system: 'price',
			openingBalanceCents: 1_000_000,
			openingBalanceDate: '2026-10-31',
			installmentCents: 50_000,
			remainingAtOpening: 24,
			installmentsTotal: 24,
			dueDay: 10,
			rateBp: 1_200,
			feeCents: 0,
			adminFeeBp: null,
			accountId: null,
			category: null,
			archived: false,
			sortOrder: 0,
		});
		await addTransaction({
			amountCents: 5_000,
			category: 'food',
			date: '2026-11-05',
			note: 'Compra Teste',
			isIncome: false,
			accountId: checking,
			installmentGroup: null,
			installmentIndex: null,
			installmentCount: null,
			cardLast4: null,
		});
		await mount([{ screen: 'cards' }]);
		await markAllClean();
		const before = await snapshot();
		const numbers = await fingerprint();
		expect(before.accounts.rows).toBe(2);
		expect(before.debts.rows).toBe(1);

		const invoice = await walk('cardInvoice', { screen: 'cards' }, { stopAt: '2' });
		expect(invoice.map((step) => [step.at, step.sample, step.banner])).toEqual([
			[`card:${card}`, false, false],
			[`card:${card}`, false, false],
		]);
		expect(texts()).toContain('Cartão Teste');
		await pressLabel('tutorial.skip');
		await waitUntil(() => where(top()) === 'cards', 'a volta para Cartões');

		await act(async () => {
			setStack?.([{ screen: 'wealth' }]);
		});
		const debts = await walk('debts', { screen: 'wealth' }, { from: '9' });
		expect(debts.map((step) => [step.id, step.at, step.sample])).toEqual([
			['9', `debt:${debt}`, false],
			['10', `debt:${debt}`, false],
			['11', `debt:${debt}`, false],
			['12', `debtEdit:${debt}`, false],
		]);

		await act(async () => {
			setStack?.([{ screen: 'accounts' }]);
		});
		const accounts = await walk('accounts', { screen: 'accounts' }, { from: '9', stopAt: '9' });
		expect(accounts[0]).toMatchObject({ at: `account:${checking}`, sample: false, banner: false });
		await pressLabel('tutorial.skip');
		await waitUntil(() => where(top()) === 'accounts', 'a volta para Contas');

		expect(await snapshot()).toEqual(before);
		expect(await fingerprint()).toEqual(numbers);
		expect(Object.keys(numbers.cards)).toEqual([card]);
		expect(numbers.debts).toEqual([debt]);
	});

	it('SPD-158 — com cartão de crédito, o "?" da lista de cartões abre o guia da fatura no cartão de verdade, sem exemplo', async () => {
		// O cartão do teste anterior continua no banco.
		const cards = await db.getAllAsync<{ id: string }>(
			"SELECT id FROM accounts WHERE kind = 'credit_card' AND deletedAt IS NULL ORDER BY sortOrder"
		);
		expect(cards).toHaveLength(1);
		const [{ id: card }] = cards;
		await mount([{ screen: 'cards' }]);
		await markAllClean();
		const before = await snapshot();
		const numbers = await fingerprint();
		expect(helpButtons('cardInvoice')).toHaveLength(1);

		const invoice = await walk('cardInvoice', { screen: 'cards' }, { press: true });
		expect(invoice).toHaveLength(12);
		expect(invoice.every((step) => step.at === `card:${card}` && !step.sample && !step.banner)).toBe(true);
		expect(currentStack).toEqual([{ screen: 'cards' }]);
		expect(sampleOn).toBe(false);

		await walk('cardInvoice', { screen: 'cards' }, { press: true, stopAt: '2' });
		expect(texts()).toContain('Cartão Teste');
		await pressLabel('tutorial.skip');
		await waitUntil(() => where(top()) === 'cards', 'a volta para Cartões');

		expect(await snapshot()).toEqual(before);
		expect(await fingerprint()).toEqual(numbers);
	});
});
