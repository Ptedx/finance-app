/*
 * SPD-020 (DEC-07 a): a compra que está na caixa de entrada, sem pergunta em aberto, conta
 * como provisória em todo lugar — saldo da conta, cartão, "Gastou" da Home e dos Relatórios —
 * pela mesma regra (`provisionalEntries`). Confirmar mantém o valor; descartar tira.
 */
import type { Account, Capture } from '../../database/schema';
import {
	isProvisionalCapture,
	provisionalBalanceCents,
	provisionalEntries,
	provisionalEntriesByAccount,
	provisionalFlows,
	summarizeAccounts,
	withProvisionalBalances,
} from '../accountMath';
import { buildCardSummary, type CardEntry, invoicesClosingBetween } from '../cardMath';
import { getISODate } from '../dateUtils';
import { type AccountMonthActivity, buildMonthOverview, provisionalPart } from '../monthOverview';
import { buildMonthSeries, type MonthAccountRow, withProvisionalActivity } from '../reportSeries';

const account = (id: string, overrides: Partial<Account> = {}): Account => ({
	id,
	name: id,
	kind: 'checking',
	role: 'main',
	envelopeMonthlyCents: null,
	network: null,
	bankName: null,
	color: '#000',
	last4: null,
	closingDay: null,
	closingDaysBefore: null,
	dueDay: null,
	creditLimitCents: null,
	cardNames: null,
	packageName: null,
	accountKey: null,
	openingBalanceCents: 0,
	openingBalanceDate: '2026-08-31',
	sortOrder: 0,
	archived: false,
	updatedAt: '2026-08-31T00:00:00.000Z',
	...overrides,
});

/** Meio-dia local: a data local é a mesma em qualquer fuso do teste. */
const postedOn = (date: string): string => new Date(`${date}T12:00:00`).toISOString();

const capture = (overrides: Partial<Capture> = {}): Capture => ({
	id: 'cap1',
	fingerprint: 'f',
	packageName: 'com.nu.production',
	appLabel: 'Nubank',
	title: 'Compra aprovada',
	text: '',
	postedAt: postedOn('2026-10-20'),
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
	createdAt: '2026-10-20T12:00:00.000Z',
	updatedAt: '2026-10-20T12:00:00.000Z',
	...overrides,
});

const ledgerEntry = (date: string, amountCents: number): CardEntry => ({
	id: `l-${date}-${amountCents}`,
	amountCents,
	isIncome: false,
	date,
	note: 'Compra',
	category: 'shopping',
	installmentGroup: null,
	installmentIndex: null,
	installmentCount: null,
});

const main = account('main', { name: 'Principal' });
const card = account('card', { name: 'Nubank', kind: 'credit_card', role: 'card', closingDay: 25, closingDaysBefore: 7 });
const OCT = { startDate: '2026-10-01', endDate: '2026-10-31' };

describe('isProvisionalCapture — quem conta como provisória', () => {
	it('pendente sem pergunta e com conta: conta', () => {
		expect(isProvisionalCapture(capture())).toBe(true);
	});

	it('pergunta em aberto (duplicata, transferência) e captura sem conta: não contam', () => {
		expect(isProvisionalCapture(capture({ question: 'duplicate' }))).toBe(false);
		expect(isProvisionalCapture(capture({ question: 'transfer' }))).toBe(false);
		expect(isProvisionalCapture(capture({ accountId: null }))).toBe(false);
	});

	it('descartada, confirmada ou apagada: não é mais provisória', () => {
		expect(isProvisionalCapture(capture({ status: 'dismissed' }))).toBe(false);
		expect(isProvisionalCapture(capture({ status: 'confirmed', transactionId: 't1' }))).toBe(false);
		expect(isProvisionalCapture(capture({ deletedAt: '2026-10-21T00:00:00.000Z' }))).toBe(false);
	});
});

describe('provisionalEntries — a mesma linha que confirmar lançaria', () => {
	it('conta corrente: uma linha na data local do aviso, saída como despesa', () => {
		const [entry, ...rest] = provisionalEntries(capture(), main);
		expect(rest).toEqual([]);
		expect(entry).toMatchObject({ amountCents: 48_000, isIncome: false, date: getISODate(new Date(capture().postedAt)), pendingReview: true });
	});

	it('cartão parcelado: uma parcela por fatura, como no cartão hoje', () => {
		const entries = provisionalEntries(capture({ accountId: 'card', installments: 3, amountCents: 30_000 }), card);
		expect(entries.map((entry) => entry.amountCents)).toEqual([10_000, 10_000, 10_000]);
		expect(entries.every((entry) => entry.pendingReview && entry.installmentGroup === 'cap1')).toBe(true);
	});

	it('captura de outra conta não entra nesta', () => {
		expect(provisionalEntries(capture({ accountId: 'card' }), main)).toEqual([]);
	});
});

describe('AUTO-01 — saldo da conta corrente com a compra pendente', () => {
	const sql = new Map([['main', 1_000_000]]);

	it('a compra de R$ 480 na caixa de entrada já sai do saldo da principal', () => {
		const byAccount = provisionalEntriesByAccount([capture()], [main]);
		expect(withProvisionalBalances(sql, [main], byAccount, '2026-10-22').get('main')).toBe(952_000);
	});

	it('com pergunta em aberto o saldo fica como o livro', () => {
		const byAccount = provisionalEntriesByAccount([capture({ question: 'duplicate' })], [main]);
		expect(withProvisionalBalances(sql, [main], byAccount, '2026-10-22').get('main')).toBe(1_000_000);
	});

	it('a âncora informada depois do aviso já inclui a compra: não desconta de novo', () => {
		const anchored = account('main', { openingBalanceDate: '2026-10-21' });
		const byAccount = provisionalEntriesByAccount([capture()], [anchored]);
		expect(withProvisionalBalances(sql, [anchored], byAccount, '2026-10-22').get('main')).toBe(1_000_000);
	});

	it('o saldo de um dia antes do aviso não vê a compra', () => {
		expect(provisionalBalanceCents(provisionalEntries(capture(), main), main.openingBalanceDate, '2026-10-19')).toBe(0);
	});

	it('confirmar mantém o valor (vira livro), descartar tira', () => {
		const pending = withProvisionalBalances(sql, [main], provisionalEntriesByAccount([capture()], [main]), '2026-10-22').get('main');
		// Confirmada: a transação está no SQL e a captura sai das provisórias.
		const afterConfirm = withProvisionalBalances(
			new Map([['main', 1_000_000 - 48_000]]),
			[main],
			provisionalEntriesByAccount([capture({ status: 'confirmed', transactionId: 't1' })], [main]),
			'2026-10-22'
		).get('main');
		const afterDismiss = withProvisionalBalances(sql, [main], provisionalEntriesByAccount([capture({ status: 'dismissed' })], [main]), '2026-10-22').get('main');
		expect({ pending, afterConfirm, afterDismiss }).toEqual({ pending: 952_000, afterConfirm: 952_000, afterDismiss: 1_000_000 });
	});
});

describe('CALC-04 — "Depois das faturas" desconta o devido do cartão', () => {
	it('com compra pendente no cartão, cardsOwedCents é o devido mostrado no cartão', () => {
		const pending = capture({ accountId: 'card' });
		const ledger = [ledgerEntry('2026-09-28', 40_000)];
		const byAccount = provisionalEntriesByAccount([pending], [main, card]);
		const summary = buildCardSummary(card, [...ledger, ...(byAccount.get('card') ?? [])], [], '2026-10-22');
		const sql = new Map([['main', 1_000_000], ['card', -40_000]]);
		const overview = summarizeAccounts([main, card], withProvisionalBalances(sql, [main, card], byAccount, '2026-10-22'), 0);
		expect(overview.cardsOwedCents).toBe(summary.owedCents);
		expect(overview.cardsOwedCents).toBe(88_000);
	});
});

describe('CALC-03 — Home e Relatórios dão o mesmo "Gastou" com pendentes', () => {
	const ledgerCard = [ledgerEntry('2026-09-28', 40_000)];
	const activity: MonthAccountRow[] = [
		{ month: '2026-10', accountId: 'main', incomeCents: 500_000, expenseCents: 100_000, passThroughCents: 0 },
		{ month: '2026-10', accountId: 'card', incomeCents: 0, expenseCents: 40_000, passThroughCents: 0 },
	];
	const captures = [capture({ id: 'c-card', accountId: 'card' }), capture({ id: 'c-main', amountCents: 7_000 }), capture({ id: 'c-ask', question: 'transfer', amountCents: 99_000 })];
	const accounts = [main, card];
	let byAccount = new Map<string, CardEntry[]>();
	beforeAll(() => {
		byAccount = provisionalEntriesByAccount(captures, accounts);
	});

	/** O que o AccountsContext monta para uma conta, com as provisórias somadas. */
	const homeActivity = (a: Account, income: number, expense: number, entries: CardEntry[] = []): AccountMonthActivity => {
		const provisional = provisionalFlows(byAccount.get(a.id) ?? [], OCT.startDate, OCT.endDate);
		return {
			accountId: a.id,
			name: a.name,
			kind: a.kind,
			role: a.role,
			incomeCents: income + provisional.incomeCents,
			expenseCents: expense + provisional.expenseCents,
			transfersInCents: 0,
			transfersOutCents: 0,
			invoiceCents: a.kind === 'credit_card' ? invoicesClosingBetween(a, [...entries, ...(byAccount.get(a.id) ?? [])], OCT.startDate, OCT.endDate) : undefined,
		};
	};

	it('a compra pendente no cartão e a da principal entram nos dois; a com pergunta, em nenhum', () => {
		const home = buildMonthOverview({
			accounts: [homeActivity(main, 500_000, 100_000), homeActivity(card, 0, 40_000, ledgerCard)],
			unassigned: { incomeCents: 0, expenseCents: 0 },
		});
		const merged = withProvisionalActivity(activity, new Map([['card', ledgerCard]]), byAccount, ['2026-10']);
		const [reports] = buildMonthSeries({ months: ['2026-10'], accounts, activity: merged.activity, transfers: [], cardEntries: merged.cardEntries, currentMonth: '2026-10' });
		expect({ home: home.totalSpendCents, reports: reports.overview.totalSpendCents }).toEqual({ home: 195_000, reports: 195_000 });
	});

	it('a parte "a revisar" do mês é a diferença para o livro', () => {
		const [ledgerOnly] = buildMonthSeries({ months: ['2026-10'], accounts, activity, transfers: [], cardEntries: new Map([['card', ledgerCard]]), currentMonth: '2026-10' });
		const merged = withProvisionalActivity(activity, new Map([['card', ledgerCard]]), byAccount, ['2026-10']);
		const [withPending] = buildMonthSeries({ months: ['2026-10'], accounts, activity: merged.activity, transfers: [], cardEntries: merged.cardEntries, currentMonth: '2026-10' });
		expect(provisionalPart(withPending.overview, ledgerOnly.overview)).toEqual({ incomeCents: 0, spendCents: 55_000 });
	});

	it('não mexe nas listas recebidas', () => {
		const cardEntries = new Map([['card', ledgerCard]]);
		withProvisionalActivity(activity, cardEntries, byAccount, ['2026-10']);
		expect(cardEntries.get('card')).toHaveLength(1);
		expect(activity[0].expenseCents).toBe(100_000);
	});
});
