/**
 * O AccountsContext com compras na caixa de entrada (SPD-020) e com ida e volta da PJ
 * (SPD-033): saldo da conta corrente, "Depois das faturas", "Gastou" do mês e o acerto de
 * saldo, montados pelo provider de verdade sobre um banco em memória.
 */

import type { Account, Capture, Transfer } from '../../database/schema';

const mockStore: {
	accounts: Account[];
	captures: Capture[];
	transfers: Transfer[];
	balances: Map<string, number>;
} = { accounts: [], captures: [], transfers: [], balances: new Map() };

jest.mock('../../database/database', () => ({
	db: { withTransactionAsync: jest.fn(async (fn: () => Promise<void>) => fn()) },
	getAccounts: jest.fn(async () => mockStore.accounts.map((account) => ({ ...account }))),
	getAccountBalances: jest.fn(async () => new Map(mockStore.balances)),
	getUnassignedNet: jest.fn(async () => 0),
	getUnassignedPeriodSummary: jest.fn(async () => ({ incomeCents: 0, expenseCents: 0, passThroughCents: 0 })),
	getTransfersByDateRange: jest.fn(async () => mockStore.transfers),
	getAccountActivity: jest.fn(async () => ({ incomeCents: 0, expenseCents: 0, passThroughCents: 0, transfersInCents: 0, transfersOutCents: 0 })),
	getAccountTransactions: jest.fn(async () => []),
	getAccountTransfers: jest.fn(async () => []),
	getCardPurchasesOriginated: jest.fn(async () => 0),
	getTransactions: jest.fn(async () => []),
	addTransaction: jest.fn(async () => 'tx-novo'),
	setAccountBalanceToday: jest.fn(async () => undefined),
}));

jest.mock('../../database/captures', () => ({
	getPendingCaptures: jest.fn(async () => mockStore.captures.filter((capture) => capture.status === 'pending')),
	getAllCaptures: jest.fn(async () => mockStore.captures),
	updateCapture: jest.fn(async () => undefined),
}));

jest.mock('../../sync/queue', () => ({ schedule: jest.fn() }));
jest.mock('../../hooks/useAfterPull', () => ({ useAfterPull: jest.fn() }));
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('../../api/cdi', () => ({
	loadCachedCdi: jest.fn(async () => null),
	refreshCdi: jest.fn(async () => null),
}));
// "Hoje" fixo: o saldo e a âncora do acerto dependem dele.
jest.mock('../../utils/dateUtils', () => ({ ...jest.requireActual('../../utils/dateUtils'), todayISO: () => '2026-09-20' }));

const mockLedger = { transactions: [], categories: [], refreshData: jest.fn(async () => undefined) };
jest.mock('../TransactionsContext', () => ({ useTransactions: () => mockLedger }));
const mockPeriod = { startDate: '2026-09-01', endDate: '2026-09-30' };
jest.mock('../PeriodContext', () => ({ usePeriod: () => mockPeriod }));

import { act, create } from 'react-test-renderer';
import { setAccountBalanceToday } from '../../database/database';
import { AccountsProvider, useAccounts } from '../AccountsContext';

const account = (overrides: Partial<Account>): Account => ({
	id: 'x',
	name: 'Conta',
	kind: 'checking',
	role: 'main',
	envelopeMonthlyCents: null,
	network: null,
	bankName: null,
	color: '#000',
	last4: null,
	closingDay: null,
	dueDay: null,
	closingDaysBefore: null,
	creditLimitCents: null,
	cardNames: null,
	packageName: null,
	accountKey: null,
	openingBalanceCents: 0,
	openingBalanceDate: '2026-09-01',
	sortOrder: 0,
	archived: false,
	updatedAt: '',
	...overrides,
});

const capture = (overrides: Partial<Capture>): Capture => ({
	id: 'c',
	fingerprint: 'f',
	packageName: 'com.nu.production',
	appLabel: 'Nubank',
	title: 'Compra aprovada',
	text: '',
	postedAt: new Date(2026, 8, 17, 12, 0).toISOString(),
	amountCents: 48_000,
	direction: 'out',
	kind: 'purchase',
	counterparty: 'Mercado',
	merchantKey: 'mercado',
	cardLast4: null,
	status: 'pending',
	question: null,
	relatedId: null,
	suggestedCategory: 'food',
	transactionId: null,
	autoConfirmed: false,
	reason: null,
	accountId: 'main',
	transferId: null,
	installments: null,
	createdAt: '',
	updatedAt: '',
	...overrides,
});

type Api = ReturnType<typeof useAccounts>;

const mount = async (): Promise<() => Api> => {
	let latest: Api | null = null;
	const Probe = () => {
		latest = useAccounts();
		return null;
	};
	await act(async () => {
		create(
			<AccountsProvider>
				<Probe />
			</AccountsProvider>
		);
	});
	return () => {
		if (!latest) throw new Error('provider não montou');
		return latest;
	};
};

beforeEach(() => {
	jest.clearAllMocks();
	mockStore.accounts = [
		account({ id: 'main', name: 'Principal' }),
		account({ id: 'card', name: 'Nubank', kind: 'credit_card', role: 'card', closingDay: 25, closingDaysBefore: 7 }),
	];
	mockStore.balances = new Map([['main', 1_000_000], ['card', 0]]);
	mockStore.transfers = [];
	mockStore.captures = [
		capture({ id: 'c-main' }),
		capture({ id: 'c-today', amountCents: 5_000, postedAt: new Date(2026, 8, 20, 9, 0).toISOString() }),
		capture({ id: 'c-card', accountId: 'card', amountCents: 30_000 }),
		capture({ id: 'c-ask', question: 'duplicate', amountCents: 99_000 }),
	];
});

describe('SPD-020 — pendente sem pergunta conta como provisória no AccountsContext', () => {
	it('AUTO-01: o saldo da principal já desconta as compras pendentes (a com pergunta, não)', async () => {
		const api = await mount();
		expect(api().balances.get('main')).toBe(1_000_000 - 48_000 - 5_000);
		expect(api().provisionalBalances.get('main')).toBe(-53_000);
	});

	it('CALC-04: "Depois das faturas" desconta o devido do cartão com a compra pendente', async () => {
		const api = await mount();
		expect(api().overview.cardsOwedCents).toBe(api().cardSummaries.get('card')?.owedCents);
		expect(api().overview.cardsOwedCents).toBe(30_000);
		expect(api().provisionalOverview).toEqual({ cashCents: -53_000, netCents: -83_000 });
	});

	it('CALC-03: o "Gastou" do mês conta a pendente da principal e a do cartão, com a parte a revisar', async () => {
		const api = await mount();
		expect(api().month?.totalSpendCents).toBe(83_000);
		expect(api().provisionalMonth).toEqual({ incomeCents: 0, spendCents: 83_000 });
	});

	it('descartar tira o valor: sem pendentes, saldo e mês voltam ao livro', async () => {
		mockStore.captures = mockStore.captures.map((item) => ({ ...item, status: 'dismissed' as const }));
		const api = await mount();
		expect(api().balances.get('main')).toBe(1_000_000);
		expect(api().month?.totalSpendCents).toBe(0);
		expect(api().provisionalMonth).toEqual({ incomeCents: 0, spendCents: 0 });
	});

	it('acerto de saldo: confirmar o saldo mostrado (com as pendentes) não move a âncora', async () => {
		const api = await mount();
		await act(async () => {
			await api().adjustAccountMonth('main', { spentCents: api().periodSpentByAccount.get('main') ?? 0, balanceCents: 947_000 });
		});
		expect(setAccountBalanceToday).not.toHaveBeenCalled();
	});

	it('acerto de saldo: o valor do banco já tem a pendente de hoje, que continua somando depois da âncora', async () => {
		const api = await mount();
		await act(async () => {
			await api().adjustAccountMonth('main', { spentCents: api().periodSpentByAccount.get('main') ?? 0, balanceCents: 900_000 });
		});
		// A âncora vai para ontem; a pendente de hoje (R$ 50) soma por cima e o saldo fica R$ 9.000.
		expect(setAccountBalanceToday).toHaveBeenCalledWith('main', 905_000);
	});
});

describe('SPD-033 — Home: ida e volta da PJ não é receita', () => {
	it('principal → PJ → principal no mesmo mês: receita zero', async () => {
		mockStore.accounts.push(account({ id: 'pj', name: 'PJ', role: 'external' }));
		mockStore.captures = [];
		mockStore.transfers = [
			{ id: 't1', fromAccountId: 'main', toAccountId: 'pj', amountCents: 100_000, date: '2026-09-03', note: '', updatedAt: '' },
			{ id: 't2', fromAccountId: 'pj', toAccountId: 'main', amountCents: 100_000, date: '2026-09-15', note: '', updatedAt: '' },
		] as Transfer[];
		const api = await mount();
		expect(api().month?.incomeCents).toBe(0);
	});

	it('pró-labore de R$ 1.000 depois de mandar R$ 300 para a PJ: receita R$ 700', async () => {
		mockStore.accounts.push(account({ id: 'pj', name: 'PJ', role: 'external' }));
		mockStore.captures = [];
		mockStore.transfers = [
			{ id: 't1', fromAccountId: 'main', toAccountId: 'pj', amountCents: 30_000, date: '2026-09-03', note: '', updatedAt: '' },
			{ id: 't2', fromAccountId: 'pj', toAccountId: 'main', amountCents: 100_000, date: '2026-09-15', note: '', updatedAt: '' },
		] as Transfer[];
		const api = await mount();
		expect(api().month?.incomeCents).toBe(70_000);
	});
});
