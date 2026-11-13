/**
 * As ferramentas do Mirai (SPD-163b) no SQL **de verdade**, contra os provedores de verdade
 * (`AccountsProvider`, `BudgetProvider`, `DebtsProvider`, `BillsProvider`) e o `useReportsData`
 * de verdade: cada ferramenta tem de devolver o número que a tela mostra.
 *
 * Hoje é 11/11/2026. Massa inventada (nenhum nome é de alguém):
 * - Corrente "Corrente Ricardo Tavares Moura" (o nome do usuário é Ricardo Tavares Moura, em
 *   Ajustes): âncora R$ 1.000 em 31/08; salário de R$ 9.000 em 05/09, 05/10 e 05/11; mercado;
 *   Pix para pessoas (com e sem captura), Pix de você mesmo, Pix para loja; R$ 300 para a
 *   Reserva em 06/11; R$ 800 da fatura em 10/10.
 * - Reserva (100% do CDI): âncora R$ 6.000 em 31/08.
 * - Cartão Roxo (final 4321, fecha dia 3, vence dia 10, limite R$ 5.000): fatura informada de
 *   R$ 800, padaria em 20/10 e um fone em 3 × R$ 100 (02/11, 02/12, 02/01).
 * - Carteira: R$ 200 em 31/08; táxi em 09/11.
 * - Contas a pagar: Aluguel (dia 10, R$ 2.000, pago até outubro), Celular (dia 20, varia) e
 *   Internet (dia 5, R$ 100, pago até setembro: outubro e novembro atrasados).
 * - Dívida: financiamento Price de R$ 20.000, 24 parcelas de R$ 1.000, 18% ao ano.
 * - Metas: reserva de 6 meses de R$ 3.000; aposentadoria de R$ 5.000/mês, R$ 10.000 fora do app.
 * - Orçamento de novembro: R$ 4.000. CDI guardado: 14,90%.
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
jest.mock('../../../sync/queue', () => ({
	schedule: jest.fn(),
	getState: () => ({ status: 'idle' }),
}));
jest.mock('../../../hooks/useAfterPull', () => ({ useAfterPull: jest.fn() }));
// O CDI guardado: o app e a ferramenta leem o mesmo; nada vai à internet.
const mockCdi = { annualBp: 1_490, date: '2026-11-10', fetchedAt: '2026-11-10T12:00:00.000Z' };
jest.mock('../../../api/cdi', () => ({
	loadCachedCdi: jest.fn(async () => mockCdi),
	refreshCdi: jest.fn(async () => mockCdi),
}));
// A mesma lista a cada render: uma nova dispararia a recarga sem parar.
const mockLedger = {
	transactions: [],
	categories: [] as unknown[],
	currentPeriodTransactions: [],
	periodTotals: { incomeCents: 0, expenseCents: 0, balanceCents: 0 },
	balanceCents: 0,
	monthlyData: { incomes: [], expenses: [] },
	categoryTotals: { expenses: [], incomes: [] },
	refreshData: jest.fn(async () => undefined),
};
jest.mock('../../../contexts/TransactionsContext', () => ({ useTransactions: () => mockLedger }));
const mockPeriod = { startDate: '2026-11-01', endDate: '2026-11-30', selectedMonth: 11, selectedYear: 2026 };
jest.mock('../../../contexts/PeriodContext', () => ({ usePeriod: () => mockPeriod }));
jest.mock('../../../contexts/SyncContext', () => ({ useSync: () => ({ lastSyncedAt: null }) }));
jest.mock('../../notificationUtils', () => ({
	...jest.requireActual('../../notificationUtils'),
	scheduleBillReminders: jest.fn(async () => 0),
	scheduleCardReminders: jest.fn(async () => 0),
}));
// O texto da linha dos encargos é o mesmo que a ferramenta usa sem o i18next iniciado.
const mockT = (key: string) => (key === 'cards.charges.reportLine' ? 'Encargos do cartão' : key);
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: mockT, i18n: { language: 'pt' } }) }));

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AccountsProvider, useAccounts } from '../../../contexts/AccountsContext';
import { BillsProvider, useBills } from '../../../contexts/BillsContext';
import { BudgetProvider, useBudget } from '../../../contexts/BudgetContext';
import { DebtsProvider, useDebts } from '../../../contexts/DebtsContext';
import { insertCapture } from '../../../database/captures';
import {
	addAccount,
	addBill,
	addDebt,
	addTransaction,
	addTransfer,
	db,
	getAccountBalances,
	getCategories,
	getTransactionsByDateRange,
	getUnassignedNet,
	initDatabase,
	setBudget,
	setReserveGoal,
	setRetirementGoal,
} from '../../../database/database';
import type { AccountDraft, BillDraft, Debt, TransactionDraft } from '../../../database/schema';
import { useReportsData } from '../../../hooks/useReportsData';
import { useRetirementGoal } from '../../../hooks/useRetirementGoal';
import { netWorth, owedCents } from '../../accountMath';
import { overdueBills } from '../../billRules';
import { monthKeyRange } from '../../dateUtils';
import { comparisonYield, debtStateOn, effectiveRateBp, monthlyRateBpOf, summarizeDebts, termsOf, worthPayingOff } from '../../debt';
import { healthSummary } from '../../healthScore';
import { getMoneyConfig } from '../../money';
import { setOwnBankName } from '../../ownNamePreference';
import { MIRAI_TOOL_NAMES } from '../contract';
import { executeMiraiTool, fitResult, MIRAI_RESULT_MAX_CHARS } from '../tools';

const sqliteAvailable: boolean = jest.requireMock<{ mockSqliteAvailable: boolean }>('expo-sqlite').mockSqliteAvailable;
if (!sqliteAvailable) {
	console.warn('toolsSql.test.tsx pulado: rode com NODE_OPTIONS=--experimental-sqlite (Node 22.12).');
}
const describeSql = sqliteAvailable ? describe : describe.skip;

jest.setTimeout(60_000);

// ---------------------------------------------------------------------------
// Massa
// ---------------------------------------------------------------------------

/** Nomes de pessoas da massa: nenhum pode sair em ferramenta nenhuma. */
const PERSON_NAMES = ['Joana', 'Bezerra', 'Lins', 'Caio', 'Mendes', 'Prado', 'Bruno', 'Teixeira', 'Ricardo', 'Tavares', 'Moura'];
const OWN_NAME = 'Ricardo Tavares Moura';

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
	openingBalanceDate: '2026-08-31',
	sortOrder: 0,
	archived: false,
	...overrides,
});

const tx = (overrides: Partial<TransactionDraft> & Pick<TransactionDraft, 'amountCents' | 'date' | 'note'>): TransactionDraft => ({
	category: 'other_expense',
	isIncome: false,
	...overrides,
});

const bill = (overrides: Partial<BillDraft> & Pick<BillDraft, 'name' | 'dueDay'>): BillDraft => ({
	amountCents: null,
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

const ids = { corrente: '', reserva: '', cartao: '', carteira: '', pixJoana: '' };

const seed = async () => {
	ids.corrente = await addAccount(
		draft({ name: `Corrente ${OWN_NAME}`, bankName: 'Banco Azul', openingBalanceCents: 1_000_00 })
	);
	ids.reserva = await addAccount(
		draft({ name: 'Reserva', kind: 'savings', role: 'reserve', yieldCdiBp: 10_000, openingBalanceCents: 6_000_00, sortOrder: 1 })
	);
	ids.cartao = await addAccount(
		draft({
			name: 'Cartão Roxo',
			kind: 'credit_card',
			role: 'card',
			last4: '4321',
			closingDay: 3,
			dueDay: 10,
			closingDaysBefore: 7,
			creditLimitCents: 5_000_00,
			openingBalanceCents: -800_00,
			sortOrder: 2,
		})
	);
	ids.carteira = await addAccount(draft({ name: 'Carteira', kind: 'cash', openingBalanceCents: 200_00, sortOrder: 3 }));

	const { corrente, cartao, carteira } = ids;
	for (const date of ['2026-09-05', '2026-10-05', '2026-11-05']) {
		await addTransaction(
			tx({ amountCents: 9_000_00, date, note: 'Salário Empresa Fictícia Ltda', category: 'salary', isIncome: true, accountId: corrente })
		);
	}
	await addTransaction(tx({ amountCents: 350_00, date: '2026-10-12', note: 'Mercado Bom Preço', category: 'food', accountId: corrente }));
	await addTransaction(tx({ amountCents: 200_00, date: '2026-11-03', note: 'Mercado Bom Preço', category: 'food', accountId: corrente }));
	ids.pixJoana = await addTransaction(tx({ amountCents: 150_00, date: '2026-11-04', note: 'Joana Bezerra Lins', accountId: corrente }));
	await addTransaction(
		tx({ amountCents: 500_00, date: '2026-11-06', note: `Pix recebido de ${OWN_NAME}`, category: 'other_income', isIncome: true, accountId: corrente })
	);
	await addTransaction(tx({ amountCents: 90_00, date: '2026-11-07', note: 'Pix para Caio Mendes Prado', accountId: corrente }));
	await addTransaction(tx({ amountCents: 120_00, date: '2026-11-08', note: 'Pix para Loja Estrela Ltda', category: 'shopping', accountId: corrente }));
	await addTransaction(
		tx({ amountCents: 30_00, date: '2026-11-10', note: 'Pix para Bruno Alves Teixeira CPF 123.456.789-09', accountId: corrente })
	);
	await addTransaction(tx({ amountCents: 25_00, date: '2026-11-10', note: 'Assinatura contato@exemplo.com.br', category: 'entertainment', accountId: corrente }));
	await addTransaction(tx({ amountCents: 80_00, date: '2026-10-20', note: 'Padaria Sol Nascente', category: 'food', accountId: cartao }));
	for (const [index, date] of ['2026-11-02', '2026-12-02', '2027-01-02'].entries()) {
		await addTransaction(
			tx({
				amountCents: 100_00,
				date,
				note: 'Fone Bluetooth',
				category: 'shopping',
				accountId: cartao,
				installmentGroup: 'g-fone',
				installmentIndex: index + 1,
				installmentCount: 3,
			})
		);
	}
	await addTransaction(tx({ amountCents: 45_00, date: '2026-11-09', note: 'Táxi Cooperativa', category: 'transport', accountId: carteira }));
	await addTransfer({ fromAccountId: corrente, toAccountId: ids.reserva, amountCents: 300_00, date: '2026-11-06', note: 'Guardar' });
	await addTransfer({ fromAccountId: corrente, toAccountId: cartao, amountCents: 800_00, date: '2026-10-10', note: 'Pagamento de fatura' });

	// O Pix para a Joana veio de um aviso do banco: o texto cru tem o nome e o CPF mascarado.
	await insertCapture({
		fingerprint: 'fp-joana',
		packageName: 'com.exemplo.bancoazul',
		appLabel: 'Banco Azul',
		title: 'Pix enviado',
		text: 'Você enviou R$ 150,00 para Joana Bezerra Lins CPF ***.456.789-**',
		postedAt: '2026-11-04T12:00:00.000Z',
		amountCents: 150_00,
		direction: 'out',
		kind: 'pix_out',
		counterparty: 'Joana Bezerra Lins',
		merchantKey: null,
		cardLast4: null,
		status: 'confirmed',
		question: null,
		relatedId: null,
		suggestedCategory: null,
		transactionId: ids.pixJoana,
		autoConfirmed: false,
		reason: null,
		accountId: corrente,
		transferId: null,
		installments: null,
	});

	await addBill(bill({ name: 'Aluguel', dueDay: 10, amountCents: 2_000_00, accountId: corrente, paidThrough: '2026-10' }));
	await addBill(bill({ name: 'Celular', dueDay: 20, paidThrough: '2026-10', sortOrder: 1 }));
	await addBill(bill({ name: 'Internet', dueDay: 5, amountCents: 100_00, paidThrough: '2026-09', sortOrder: 2 }));
	await addDebt({
		name: 'Financiamento do carro',
		kind: 'financing',
		system: 'price',
		openingBalanceCents: 20_000_00,
		openingBalanceDate: '2026-08-15',
		installmentCents: 1_000_00,
		remainingAtOpening: 24,
		installmentsTotal: 36,
		dueDay: 15,
		rateBp: 1_800,
		feeCents: 0,
		adminFeeBp: null,
		accountId: corrente,
		category: null,
		archived: false,
		sortOrder: 0,
	});
	await setReserveGoal({ targetMonths: 6, customMonthlyCostCents: 3_000_00 });
	await setRetirementGoal({ targetMonthlyCents: 5_000_00, reinvestBp: 2_500, expectedYieldBp: 1_000, outsideCapitalCents: 10_000_00 });
	await setBudget(2026, 11, 4_000_00);
	await setOwnBankName(OWN_NAME);
};

// ---------------------------------------------------------------------------
// As telas
// ---------------------------------------------------------------------------

interface Screens {
	accounts: ReturnType<typeof useAccounts>;
	bills: ReturnType<typeof useBills>;
	debts: ReturnType<typeof useDebts>;
	budget: ReturnType<typeof useBudget>;
	goal: ReturnType<typeof useRetirementGoal>['goal'];
	reports: ReturnType<typeof useReportsData>;
}
let current: Screens | null = null;
/** O que o Patrimônio lê: `useReportsData(3, goal, 'today')` com a meta de aposentadoria. */
const Probe = () => {
	const accounts = useAccounts();
	const bills = useBills();
	const debts = useDebts();
	const budget = useBudget();
	const { goal } = useRetirementGoal();
	const reports = useReportsData(3, goal, 'today');
	current = { accounts, bills, debts, budget, goal, reports };
	return null;
};
const screens = (): Screens => {
	if (!current) throw new Error('provedores não montaram');
	return current;
};

let renderer: ReactTestRenderer | null = null;

const settle = async () => {
	for (let i = 0; i < 12; i++) {
		await act(async () => {
			await new Promise((resolve) => setImmediate(resolve));
		});
	}
};

const mount = async () => {
	await act(async () => {
		renderer = create(
			<AccountsProvider>
				<BudgetProvider>
					<DebtsProvider>
						<BillsProvider>
							<Probe />
						</BillsProvider>
					</DebtsProvider>
				</BudgetProvider>
			</AccountsProvider>
		);
	});
	await settle();
	// A recarga das dívidas cria a conta a pagar do financiamento: as telas releem depois dela.
	await act(async () => {
		await screens().debts.refresh();
		await screens().accounts.refresh();
	});
	await settle();
};

// biome-ignore lint/suspicious/noExplicitAny: o JSON da ferramenta é lido campo a campo
const call = async (name: string, input: unknown): Promise<any> => JSON.parse(await executeMiraiTool(name, input));

const NOVEMBER = { from: '2026-11-01', to: '2026-11-30' };
const listAll = { category: null, accountId: null, text: null, kind: null, limit: 100 };

describeSql('ferramentas do Mirai: o mesmo número da tela', () => {
	beforeAll(async () => {
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
		await initDatabase();
		await seed();
		mockLedger.categories = await getCategories();
		await mount();
	});

	afterAll(() => {
		act(() => renderer?.unmount());
		jest.useRealTimers();
	});

	it('as telas carregaram com a massa', () => {
		const { accounts, reports, bills, debts } = screens();
		expect(accounts.isLoading).toBe(false);
		expect(accounts.month).not.toBeNull();
		expect(reports.selected).not.toBeNull();
		expect(bills.bills.length).toBeGreaterThanOrEqual(3);
		expect(debts.activeDebts).toHaveLength(1);
	});

	it('get_month_overview é o "Este mês" da tela inicial e a barra do orçamento', async () => {
		const { accounts, budget } = screens();
		const month = accounts.month;
		if (!month) throw new Error('sem mês');
		const out = await call('get_month_overview', { month: '2026-11' });
		expect(out.incomeCents).toBe(month.incomeCents);
		expect(out.grossIncomeCents).toBe(month.grossIncomeCents);
		expect(out.spend).toEqual({
			totalCents: month.totalSpendCents,
			cardsCents: month.cardSpendCents,
			pixAndDebitCents: month.mainSpendCents,
			envelopesCents: month.envelopeFundingCents,
		});
		expect(out.leftoverCents).toBe(month.leftoverCents);
		expect(out.savedCents).toBe(month.savedCents);
		expect(out.yieldCents).toBe(month.yieldCents);
		expect(out.savingsRateBp).toBe(month.savingsRateBp);
		expect(out.pendingReview).toEqual(accounts.provisionalMonth);
		expect(out.budgetCents).toBe(budget.currentBudgetCents);
		expect(out.budgetCents).toBe(4_000_00);
		expect(out.cards.map((card: { spendCents: number }) => card.spendCents)).toEqual(month.cards.map((card) => card.spendCents));
		// A massa: R$ 9.000 de salário e R$ 500 de você para você entram como receita.
		expect(out.incomeCents).toBeGreaterThan(0);
	});

	it('get_month_overview de um mês passado é o card com aquele mês no seletor', async () => {
		Object.assign(mockPeriod, { ...monthKeyRange('2026-10'), selectedMonth: 10 });
		await act(async () => {
			await screens().accounts.refresh();
		});
		await settle();
		const october = screens().accounts.month;
		if (!october) throw new Error('sem mês');
		const out = await call('get_month_overview', { month: '2026-10' });
		Object.assign(mockPeriod, { ...monthKeyRange('2026-11'), selectedMonth: 11 });
		await act(async () => {
			await screens().accounts.refresh();
		});
		await settle();
		expect(out.incomeCents).toBe(october.incomeCents);
		expect(out.spend.totalCents).toBe(october.totalSpendCents);
		expect(out.leftoverCents).toBe(october.leftoverCents);
		expect(out.savedCents).toBe(october.savedCents);
		expect(out.month).toBe('2026-10');
	});

	it('get_accounts é a tela de Contas: o saldo de cada conta, "Em caixa" e "Depois das faturas"', async () => {
		const { accounts } = screens();
		const out = await call('get_accounts', {});
		const shown = accounts.accounts.filter((account) => account.kind !== 'credit_card' && !account.archived);
		expect(out.accounts.map((account: { id: string }) => account.id)).toEqual(shown.map((account) => account.id));
		for (const account of shown) {
			const row = out.accounts.find((item: { id: string }) => item.id === account.id);
			expect(row.balanceCents).toBe(accounts.balances.get(account.id) ?? account.openingBalanceCents);
		}
		expect(out.totals.cashCents).toBe(accounts.overview.cashCents);
		expect(out.totals.savedCents).toBe(accounts.overview.savedCents);
		expect(out.totals.afterCardsCents).toBe(accounts.overview.netCents);
		// A Reserva rende 100% do CDI guardado: o saldo da tela já soma o rendimento estimado.
		const reserva = out.accounts.find((item: { id: string }) => item.id === ids.reserva);
		expect(reserva.estimatedYieldCents).toBe(accounts.accruedYield.get(ids.reserva) ?? 0);
		expect(reserva.estimatedYieldCents).toBeGreaterThan(0);
		// O nome do usuário no nome da conta vira "você".
		expect(out.accounts[0].name).toBe('Corrente você');
	});

	it('get_cards é a tela de Cartões: faturas, limite, parcelas e as somas do topo', async () => {
		const { accounts } = screens();
		const out = await call('get_cards', {});
		const summary = accounts.cardSummaries.get(ids.cartao);
		if (!summary) throw new Error('sem cartão');
		expect(out.cards).toHaveLength(1);
		const card = out.cards[0];
		expect(card.last4).toBe('4321');
		expect(card.owedCents).toBe(summary.owedCents);
		expect(card.futureInstallmentsCents).toBe(summary.futureCommittedCents);
		expect(card.openInvoice.amountCents).toBe(summary.openInvoiceCents);
		expect(card.openInvoice.closingDate).toBe(summary.openCycle?.closingDate);
		expect(card.closedInvoice.amountCents).toBe(summary.closedInvoiceCents);
		expect(card.closedInvoice.toPayCents).toBe(summary.toPayCents);
		expect(card.closedInvoice.status).toBe(summary.closedStatus);
		expect(card.limitAvailableCents).toBe(summary.limitAvailableCents);
		expect(card.limitUsedCents).toBe(summary.limitUsedCents);
		expect(card.installments).toHaveLength(summary.installmentPlans.length);
		expect(card.installments[0]).toMatchObject({
			parcelCents: 100_00,
			remainingCount: 2,
			totalCount: 3,
			// O fone em 3 × R$ 100: a 1/3 já entrou; a próxima é a 2/3 (SPD-170).
			chargedCount: 1,
			nextNumber: 2,
		});
		expect(out.totals).toEqual(accounts.cardsTotals);
	});

	it('get_net_worth é o Patrimônio, somado como a tela soma', async () => {
		const { accounts, reports, debts, goal } = screens();
		let cardsCents = 0;
		for (const summary of accounts.cardSummaries.values()) cardsCents += summary.owedCents + summary.futureCommittedCents;
		// A conta do `WealthScreen`, linha a linha.
		const parts = {
			cashCents: accounts.overview.cashCents,
			reserveCents: reports.reserve.split.reserveCents,
			investedCents: accounts.overview.savedCents - reports.reserve.split.reserveCents,
			outsideCents: goal?.outsideCapitalCents ?? 0,
			cardsCents,
			debtsCents: debts.summary.balanceCents,
		};
		const worth = netWorth({ ...parts, savedCents: accounts.overview.savedCents });
		const out = await call('get_net_worth', { months: null });
		expect(out.netCents).toBe(worth.netCents);
		expect(out.assetsCents).toBe(worth.assetsCents);
		expect(out.liabilitiesCents).toBe(worth.liabilitiesCents);
		expect(out.parts).toEqual(parts);
		expect(out.parts.outsideCents).toBe(10_000_00);
		expect(out.series).toBeNull();
		expect(out.parts.debtsCents).toBeGreaterThan(0);
		expect(out.parts.reserveCents).toBeGreaterThan(0);
	});

	it('get_net_worth com months: os meses fechados pelo saldo no fim do mês, e hoje no fim', async () => {
		const out = await call('get_net_worth', { months: 3 });
		expect(out.series.map((point: { month: string }) => point.month)).toEqual(['2026-09', '2026-10', '2026-11']);
		expect(out.series[2].netCents).toBe(out.netCents);
		// Outubro: o saldo de cada conta em 31/10 (cartão pelo que devia), os "Sem conta", o de
		// fora do app e a dívida naquela data.
		const end = '2026-10-31';
		const [atEnd, unassigned] = await Promise.all([getAccountBalances(end), getUnassignedNet(end)]);
		const { debts } = screens();
		let expected = unassigned + 10_000_00;
		expected -= summarizeDebts(
			debts.activeDebts.map((debt: Debt) => ({ id: debt.id, name: debt.name, terms: termsOf(debt) })),
			end
		).balanceCents;
		for (const account of screens().accounts.accounts) {
			const balance = atEnd.get(account.id) ?? 0;
			expected += account.kind === 'credit_card' ? -owedCents(balance) : balance;
		}
		expect(out.series[1].netCents).toBe(expected);
	});

	it('get_category_totals é o ranking de categorias dos Relatórios', async () => {
		const { reports } = screens();
		const out = await call('get_category_totals', { month: '2026-11', compareWith: '2026-10' });
		expect(
			out.categories.map((row: { categoryId: string; totalCents: number; compareCents: number; shareBp: number }) => [
				row.categoryId,
				row.totalCents,
				row.compareCents,
				row.shareBp,
			])
		).toEqual(reports.categories.map((row) => [row.categoryId, row.currentCents, row.previousCents, row.shareBp]));
		expect(reports.categories.length).toBeGreaterThan(2);
		expect(out.totalCents).toBe(reports.categories.reduce((sum, row) => sum + row.currentCents, 0));
		const alone = await call('get_category_totals', { month: '2026-11', compareWith: null });
		expect(alone.categories.map((row: { totalCents: number }) => row.totalCents)).toEqual(
			reports.categories.map((row) => row.currentCents)
		);
		expect(alone.categories[0]).not.toHaveProperty('compareCents');
	});

	it('get_bills é Contas a pagar: o mês, o total a pagar e o atraso de antes', async () => {
		const { bills } = screens();
		const out = await call('get_bills', NOVEMBER);
		expect(
			out.bills.map((row: { billId: string; status: string; dueDate: string; amountCents: number | null }) => [
				row.billId,
				row.status,
				row.dueDate,
				row.amountCents,
			])
		).toEqual(bills.month.rows.map((row) => [row.bill.id, row.status, row.dueDate, row.bill.amountCents]));
		expect(out.totals.toPayCents).toBe(bills.month.dueCents);
		expect(out.totals.variableToPayCount).toBe(bills.month.variableCount);
		expect(out.totals.lateCount).toBe(bills.month.lateCount);
		const overdue = overdueBills(bills.bills, '2026-11', bills.payments);
		expect(out.overdueBeforeThisMonth.cents).toBe(overdue.cents);
		expect(out.overdueBeforeThisMonth.cents).toBe(100_00);
		// Só o período: de 01/11 a 09/11 sai a Internet (dia 5), não o Aluguel (dia 10).
		const firstDays = await call('get_bills', { from: '2026-11-01', to: '2026-11-09' });
		expect(firstDays.bills.map((row: { name: string }) => row.name)).toEqual(['Internet']);
		expect(firstDays.bills[0].status).toBe('late');
		// O atraso não some porque o período começa depois do vencimento (SPD-168): de hoje (11/11)
		// ao fim do mês ainda vêm a Internet (dia 5) e o Aluguel (dia 10), os dois atrasados.
		const fromToday = await call('get_bills', { from: '2026-11-11', to: '2026-11-30' });
		const before = fromToday.bills.filter((row: { dueDate: string }) => row.dueDate < '2026-11-11');
		expect(before.map((row: { name: string; status: string }) => [row.name, row.status]).sort()).toEqual([
			['Aluguel', 'late'],
			['Internet', 'late'],
		]);
		expect(fromToday.totals.lateCount).toBe(bills.month.lateCount);
	});

	it('get_debts é a lista de Dívidas: saldo, parcela, juros ao mês, veredito e o quadro', async () => {
		const { debts, accounts, goal } = screens();
		const out = await call('get_debts', {});
		const debt = debts.debts[0];
		const state = debtStateOn(termsOf(debt), '2026-11-11');
		const yieldBp = comparisonYield({ goalYieldBp: goal?.expectedYieldBp, cdiAnnualBp: accounts.cdi?.annualBp }).yieldBp;
		expect(out.debts[0]).toMatchObject({
			id: debt.id,
			balanceCents: state.balanceCents,
			installmentCents: state.next?.installmentCents,
			remainingInstallments: state.remaining,
			payoffDate: state.payoffDate,
			rateYearBp: 1_800,
			rateMonthBp: monthlyRateBpOf(1_800),
			verdict: worthPayingOff({ debtRateBp: effectiveRateBp(termsOf(debt), '2026-11-11'), investmentYieldBp: yieldBp }).verdict,
		});
		expect(out.summary.balanceCents).toBe(debts.summary.balanceCents);
		expect(out.summary.balanceCents).toBeGreaterThan(0);
		expect(out.summary.monthlyCents).toBe(debts.summary.monthlyCents);
		expect(out.summary.weightedRateYearBp).toBe(debts.summary.weightedRateBp);
		expect(out.comparisonYield).toEqual({ yearBp: yieldBp, source: 'goal' });
	});

	it('get_reserve_and_goals é a reserva e a aposentadoria do Patrimônio', async () => {
		const { reports } = screens();
		const out = await call('get_reserve_and_goals', {});
		expect(out.reserve).toMatchObject({
			status: reports.reserve.status,
			currentCents: reports.reserve.split.reserveCents,
			targetCents: reports.reserve.targetCents,
			targetMonths: 6,
			monthlyCostCents: 3_000_00,
			monthsCovered: reports.reserve.monthsCovered,
			progressBp: reports.reserve.progressBp,
			gapCents: reports.reserve.gapCents,
			monthsToFill: reports.reserve.monthsToFill,
		});
		expect(out.reserve.currentCents).toBeGreaterThan(0);
		const retirement = reports.retirement;
		if (!retirement) throw new Error('sem aposentadoria');
		expect(out.retirementGoal).toMatchObject({
			requiredMonthlyCents: retirement.requiredMonthlyCents,
			requiredCapitalCents: retirement.requiredCapitalCents,
			capitalCents: retirement.capitalCents,
			passiveIncomeNowCents: retirement.passiveIncomeNowCents,
			progressBp: retirement.progressBp,
			monthlyContributionCents: retirement.monthlyContributionCents,
			reach: retirement.reach,
		});
	});

	it('get_health é a saúde financeira: os mesmos fatores e a contagem', async () => {
		const { reports } = screens();
		const out = await call('get_health', {});
		expect(
			out.factors.map((item: { id: string; status: string; value: number | null; target: number }) => [item.id, item.status, item.value, item.target])
		).toEqual(reports.health.map((item) => [item.id, item.status, item.value, item.target]));
		expect(out.summary).toEqual(healthSummary(reports.health));
		expect(out.factors.filter((item: { status: string }) => item.status !== 'unknown').length).toBeGreaterThan(1);
	});

	it('get_rates é o CDI guardado, a moeda e o idioma', async () => {
		const out = await call('get_rates', {});
		expect(out).toEqual({ cdiYearBp: 1_490, cdiDate: '2026-11-10', currency: getMoneyConfig().currencyCode, language: null });
	});

	it('list_transactions: o livro do período, do mais novo para o mais antigo, com os totais', async () => {
		const out = await call('list_transactions', { ...NOVEMBER, ...listAll });
		const ledger = await getTransactionsByDateRange(NOVEMBER.from, NOVEMBER.to);
		const dates = out.transactions.map((row: { date: string }) => row.date);
		expect(dates).toEqual([...dates].sort().reverse());
		// Lançamentos de novembro mais a transferência para a Reserva.
		expect(out.matched).toBe(ledger.length + 1);
		const spent = ledger.filter((item) => !item.isIncome).reduce((sum, item) => sum + item.amountCents, 0);
		expect(out.totals.expenseCents).toBe(spent);
		const fone = out.transactions.find((row: { merchant: string }) => row.merchant === 'Fone Bluetooth');
		expect(fone).toMatchObject({ installment: '1/3', account: 'Cartão Roxo', category: expect.any(String) });
	});

	it('list_transactions: filtros e limite', async () => {
		const limited = await call('list_transactions', { ...NOVEMBER, ...listAll, limit: 2 });
		expect(limited.transactions).toHaveLength(2);
		expect(limited.returned).toBe(2);
		expect(limited.matched).toBeGreaterThan(2);

		const food = await call('list_transactions', { ...NOVEMBER, ...listAll, category: 'food' });
		expect(food.transactions.map((row: { merchant: string }) => row.merchant)).toEqual(['Mercado Bom Preço']);

		const wallet = await call('list_transactions', { ...NOVEMBER, ...listAll, accountId: ids.carteira });
		expect(wallet.transactions.map((row: { amountCents: number }) => row.amountCents)).toEqual([45_00]);

		const transfers = await call('list_transactions', { ...NOVEMBER, ...listAll, kind: 'transfer' });
		expect(transfers.transactions).toHaveLength(1);
		expect(transfers.transactions[0]).toMatchObject({ kind: 'transfer', amountCents: 300_00, to: 'Reserva' });

		const income = await call('list_transactions', { ...NOVEMBER, ...listAll, kind: 'income' });
		expect(income.totals.incomeCents).toBe(9_500_00);

		const text = await call('list_transactions', { ...NOVEMBER, ...listAll, text: 'mercado bom' });
		expect(text.matched).toBe(1);
	});

	it('list_transactions: Pix com pessoa vira "pessoa", o usuário vira "você", lojas ficam', async () => {
		const raw = await executeMiraiTool('list_transactions', { ...NOVEMBER, ...listAll });
		const merchants = JSON.parse(raw).transactions.map((row: { merchant: string }) => row.merchant);
		expect(merchants).toEqual(
			expect.arrayContaining([
				'Pix para pessoa',
				'Pix de você',
				'Pix para Loja Estrela Ltda',
				'Mercado Bom Preço',
				'Assinatura [e-mail]',
				'Táxi Cooperativa',
			])
		);
		// Joana (com captura), Caio e Bruno (sem): três Pix para pessoa.
		expect(merchants.filter((merchant: string) => merchant === 'Pix para pessoa')).toHaveLength(3);
		for (const name of PERSON_NAMES) expect(raw).not.toContain(name);
		expect(raw).not.toContain('123.456');
		expect(raw).not.toContain('exemplo.com');
		// Procurar pelo nome da pessoa não acha nem confirma nada.
		const search = await call('list_transactions', { ...NOVEMBER, ...listAll, text: 'Joana' });
		expect(search.matched).toBe(0);
	});

	it('nenhuma ferramenta deixa sair nome de pessoa, CPF ou e-mail', async () => {
		const inputs: Record<string, unknown> = {
			get_month_overview: { month: '2026-11' },
			get_accounts: {},
			get_cards: {},
			list_transactions: { from: '2026-09-01', to: '2026-11-30', ...listAll },
			get_category_totals: { month: '2026-11', compareWith: '2026-10' },
			get_bills: NOVEMBER,
			get_debts: {},
			get_reserve_and_goals: {},
			get_net_worth: { months: 12 },
			get_health: {},
			get_rates: {},
		};
		expect(Object.keys(inputs).sort()).toEqual([...MIRAI_TOOL_NAMES].sort());
		for (const [name, input] of Object.entries(inputs)) {
			const raw = await executeMiraiTool(name, input);
			const parsed = JSON.parse(raw);
			expect(parsed).not.toHaveProperty('error');
			expect(raw.length).toBeLessThanOrEqual(MIRAI_RESULT_MAX_CHARS);
			for (const person of PERSON_NAMES) expect(raw).not.toContain(person);
			expect(raw).not.toMatch(/\d{3}\.\d{3}\.\d{3}-\d{2}/);
			expect(raw).not.toContain('@');
		}
	});

	it('entrada inválida volta como erro, sem lançar', async () => {
		const cases: Array<[string, unknown, string]> = [
			['get_everything', {}, 'unknown_tool'],
			['get_month_overview', {}, 'invalid_input'],
			['get_month_overview', { month: '2026-13' }, 'invalid_input'],
			['get_month_overview', { month: '2026-11', extra: 1 }, 'invalid_input'],
			['get_month_overview', null, 'invalid_input'],
			['get_accounts', 'tudo', 'invalid_input'],
			['list_transactions', { ...NOVEMBER, ...listAll, limit: 0 }, 'invalid_input'],
			['list_transactions', { ...NOVEMBER, ...listAll, limit: 101 }, 'invalid_input'],
			['list_transactions', { ...NOVEMBER, ...listAll, limit: 2.5 }, 'invalid_input'],
			['list_transactions', { ...NOVEMBER, ...listAll, kind: 'gasto' }, 'invalid_input'],
			['list_transactions', { from: '2026-11-30', to: '2026-11-01', ...listAll }, 'invalid_input'],
			['list_transactions', { from: '2026-02-30', to: '2026-03-01', ...listAll }, 'invalid_input'],
			['get_bills', { from: '2020-01-01', to: '2026-11-30' }, 'invalid_input'],
			['get_net_worth', { months: 13 }, 'invalid_input'],
			['get_net_worth', {}, 'invalid_input'],
			['get_category_totals', { month: '2026-11' }, 'invalid_input'],
		];
		for (const [name, input, error] of cases) {
			const out = await call(name, input);
			expect(out.error).toBe(error);
		}
	});

	it('saída grande é cortada no fim da lista, com "truncated": true', async () => {
		const many = Array.from({ length: 140 }, (_, i) =>
			tx({ amountCents: 1_00 + i, date: '2026-11-11', note: `Loja Número Grande Comércio de Exemplo ${i}`, accountId: ids.carteira })
		);
		for (const item of many) await addTransaction(item);
		const raw = await executeMiraiTool('list_transactions', { ...NOVEMBER, ...listAll });
		const out = JSON.parse(raw);
		expect(raw.length).toBeLessThanOrEqual(MIRAI_RESULT_MAX_CHARS);
		expect(out.truncated).toBe(true);
		expect(out.transactions.length).toBeLessThan(100);
		expect(out.transactions.length).toBeGreaterThan(10);
		// A contagem é do todo; a lista é o começo dela (os mais novos).
		expect(out.matched).toBeGreaterThan(140);
		await db.execAsync("DELETE FROM transactions WHERE note LIKE 'Loja Número Grande%'");
	});
});

describe('fitResult', () => {
	it('não mexe no que cabe', () => {
		expect(fitResult({ a: [1, 2, 3] })).toBe('{"a":[1,2,3]}');
	});

	it('tira do fim da maior lista até caber e marca truncated', () => {
		const value = { total: 999, rows: Array.from({ length: 50 }, (_, i) => ({ i, text: 'x'.repeat(40) })), other: [1] };
		const text = fitResult(value, 1_000);
		const out = JSON.parse(text);
		expect(text.length).toBeLessThanOrEqual(1_000);
		expect(out.truncated).toBe(true);
		expect(out.total).toBe(999);
		expect(out.rows[0].i).toBe(0);
		expect(out.other).toEqual([1]);
		// O original não muda.
		expect(value.rows).toHaveLength(50);
	});
});
