import type { Account, Category } from '../../database/schema';
import { buildCardSummary, type CardEntry } from '../cardMath';
import {
	averageClosedMonths,
	averageReserveCapitalCents,
	buildMonthSeries,
	committedMonths,
	findDuplicateIncomes,
	incomeComposition,
	type MonthAccountRow,
	type MonthPoint,
	monthElapsedBp,
	monthKeysEnding,
	monthRangeOf,
	rankCategories,
	rankSpendSources,
	realizedYield12mCents,
} from '../reportSeries';

const R = (reais: number) => reais * 100;

const account = (overrides: Partial<Account>): Account => ({
	id: 'a',
	name: 'Conta',
	kind: 'checking',
	role: 'main',
	envelopeMonthlyCents: null,
	network: null,
	bankName: 'Nubank',
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
	openingBalanceDate: '2026-01-01',
	sortOrder: 0,
	archived: false,
	updatedAt: '2026-09-01T00:00:00.000Z',
	...overrides,
});

let seq = 0;
const purchase = (date: string, amountCents: number): CardEntry => ({
	id: `e${++seq}`,
	amountCents,
	isIncome: false,
	date,
	note: '',
	category: 'food',
	installmentGroup: null,
	installmentIndex: null,
	installmentCount: null,
});

const nu = account({ id: 'nu', name: 'Nubank PF', role: 'main' });
const card = account({ id: 'card', name: 'Cartão Nubank', kind: 'credit_card', role: 'card', closingDay: 25, closingDaysBefore: 7 });
const inter = account({ id: 'inter', name: 'Inter PF', role: 'envelope', envelopeMonthlyCents: R(1_000) });
const mp = account({ id: 'mp', name: 'Investimentos MP', kind: 'investment', role: 'reserve' });

const row = (month: string, accountId: string | null, incomeCents = 0, expenseCents = 0, passThroughCents = 0): MonthAccountRow => ({
	month,
	accountId,
	incomeCents,
	expenseCents,
	passThroughCents,
});

describe('chaves e intervalos', () => {
	it('conta meses para trás, do mais antigo para o mais novo', () => {
		expect(monthKeysEnding('2026-09', 3)).toEqual(['2026-07', '2026-08', '2026-09']);
		expect(monthKeysEnding('2026-01', 2)).toEqual(['2025-12', '2026-01']);
		expect(monthKeysEnding('2026-09', 0)).toEqual([]);
	});

	it('vai do primeiro dia do primeiro mês ao último do último', () => {
		expect(monthRangeOf(['2026-07', '2026-08', '2026-09'])).toEqual({ startDate: '2026-07-01', endDate: '2026-09-30' });
	});
});

describe('buildMonthSeries — o quadro do mês, mês a mês', () => {
	it('repete a regra da Home para cada mês, com repasse e envelope', () => {
		const series = buildMonthSeries({
			months: ['2026-08', '2026-09'],
			accounts: [nu, inter, mp],
			activity: [
				row('2026-08', 'nu', R(20_000), R(6_500), R(6_000)),
				row('2026-09', 'nu', R(20_000), R(6_200), R(6_000)),
				row('2026-09', 'inter', 0, R(845.2)),
			],
			transfers: [
				{ month: '2026-08', accountId: 'inter', inCents: R(1_000), outCents: 0 },
				{ month: '2026-08', accountId: 'mp', inCents: R(3_000), outCents: 0 },
				{ month: '2026-09', accountId: 'inter', inCents: R(1_000), outCents: 0 },
			],
			cardEntries: new Map(),
			currentMonth: '2026-09',
		});

		expect(series.map((point) => point.month)).toEqual(['2026-08', '2026-09']);
		expect(series[0]).toMatchObject({ isCurrent: false, overview: { incomeCents: R(14_000), mainSpendCents: R(500), envelopeFundingCents: R(1_000), totalSpendCents: R(1_500), savedCents: R(3_000) } });
		expect(series[1]).toMatchObject({ isCurrent: true, overview: { incomeCents: R(14_000), mainSpendCents: R(200), totalSpendCents: R(1_200), savedCents: 0 } });
	});

	it('cartão: o gasto do mês é a fatura que fecha nele, não as compras datadas nele', () => {
		// Fecha dia 25. Compra no dia 24 cai na fatura de agosto; no dia 25, na de setembro.
		const entries = [purchase('2026-08-24', R(100)), purchase('2026-08-25', R(300))];
		const series = buildMonthSeries({
			months: ['2026-08', '2026-09'],
			accounts: [nu, card],
			activity: [row('2026-08', 'card', 0, R(400))],
			transfers: [],
			cardEntries: new Map([['card', entries]]),
			currentMonth: '2026-10',
		});
		expect(series[0].overview.cardSpendCents).toBe(R(100));
		expect(series[1].overview.cardSpendCents).toBe(R(300));
	});

	it('cartão sem fechamento cai nas compras datadas no mês', () => {
		const loose = account({ id: 'loose', kind: 'credit_card', role: 'card' });
		const series = buildMonthSeries({
			months: ['2026-08'],
			accounts: [loose],
			activity: [row('2026-08', 'loose', R(50), R(400))],
			transfers: [],
			cardEntries: new Map([['loose', [purchase('2026-08-10', R(400))]]]),
			currentMonth: '2026-09',
		});
		expect(series[0].overview.cardSpendCents).toBe(R(350));
	});

	it('conta arquivada vira externa, conta desconhecida some, sem conta vira "sem conta"', () => {
		const old = account({ id: 'old', role: 'main', archived: true });
		const series = buildMonthSeries({
			months: ['2026-08'],
			accounts: [nu, old],
			activity: [row('2026-08', 'old', R(999), R(999)), row('2026-08', 'ghost', R(500), 0), row('2026-08', null, R(100), R(40), R(10))],
			transfers: [],
			cardEntries: new Map(),
			currentMonth: '2026-09',
		});
		expect(series[0].overview).toMatchObject({ incomeCents: R(90), mainSpendCents: R(30) });
	});
});

const point = (month: string, overrides: Partial<MonthPoint['overview']>, isCurrent = false): MonthPoint => ({
	month,
	isCurrent,
	overview: {
		incomeCents: 0,
		grossIncomeCents: 0,
		passThroughCents: 0,
		cardSpendCents: 0,
		cardPurchasesCents: 0,
		mainSpendCents: 0,
		envelopeFundingCents: 0,
		totalSpendCents: 0,
		savedCents: 0,
		yieldCents: 0,
		leftoverCents: 0,
		savingsRateBp: null,
		cards: [],
		envelopes: [],
		...overrides,
	},
});

describe('médias e reserva', () => {
	const series = [
		point('2026-06', { totalSpendCents: R(4_000), savedCents: R(1_000), yieldCents: R(50) }),
		point('2026-07', { totalSpendCents: R(5_000), savedCents: R(2_000), yieldCents: R(60) }),
		point('2026-08', { totalSpendCents: R(6_000), savedCents: R(3_000), yieldCents: R(70) }),
		point('2026-09', { totalSpendCents: R(9_000), savedCents: R(9_000), yieldCents: R(80) }, true),
	];

	it('a média ignora o mês em andamento', () => {
		expect(averageClosedMonths(series, (o) => o.totalSpendCents, 3)).toBe(R(5_000));
		expect(averageClosedMonths(series, (o) => o.savedCents, 2)).toBe(R(2_500));
		expect(averageClosedMonths([series[3]], (o) => o.savedCents, 3)).toBeNull();
	});

	it('anda para trás a partir do saldo de hoje para achar o capital médio', () => {
		// Hoje 20.000. Agosto fechou com 20.000 − (9.000 + 80); julho com isso − (3.000 + 70)...
		const ends = [R(20_000) - R(9_080) - R(3_070) - R(2_060), R(20_000) - R(9_080) - R(3_070), R(20_000) - R(9_080), R(20_000)];
		expect(averageReserveCapitalCents(series, R(20_000))).toBe(Math.round(ends.reduce((a, b) => a + b, 0) / 4));
		expect(averageReserveCapitalCents(series.slice(0, 2), R(20_000))).toBeNull();
	});

	it('rendimento dos últimos 12 meses', () => {
		expect(realizedYield12mCents(series)).toBe(R(260));
	});

	it('quanto do mês já passou', () => {
		expect(monthElapsedBp('2026-08', '2026-09-17')).toBe(10_000);
		expect(monthElapsedBp('2026-10', '2026-09-17')).toBe(0);
		expect(monthElapsedBp('2026-09', '2026-09-15')).toBe(5_000);
		expect(monthElapsedBp('2026-02', '2026-02-28')).toBe(10_000);
	});
});

describe('onde foi o dinheiro', () => {
	const category = (overrides: Partial<Category>): Category => ({
		id: 'x',
		name: 'X',
		color: '#fff',
		icon: 'a',
		type: 'expense',
		nature: 'discretionary',
		updatedAt: '',
		...overrides,
	});
	const categories = [
		category({ id: 'food', name: 'Comida' }),
		category({ id: 'fun', name: 'Lazer' }),
		category({ id: 'passthrough', name: 'Repasse', nature: 'passthrough' }),
	];

	it('ordena por valor, dá a fatia e a variação, e deixa o repasse de fora', () => {
		const rows = rankCategories(
			[
				{ month: '2026-09', categoryId: 'food', totalCents: R(600) },
				{ month: '2026-09', categoryId: 'fun', totalCents: R(400) },
				{ month: '2026-09', categoryId: 'passthrough', totalCents: R(6_000) },
			],
			[{ month: '2026-08', categoryId: 'food', totalCents: R(500) }],
			categories
		);
		expect(rows.map((r) => r.categoryId)).toEqual(['food', 'fun']);
		expect(rows[0]).toMatchObject({ name: 'Comida', currentCents: R(600), previousCents: R(500), deltaCents: R(100), pct: 0.2, shareBp: 6_000 });
		expect(rows[1]).toMatchObject({ name: 'Lazer', pct: null, shareBp: 4_000 });
	});

	it('categoria que zerou some; categoria apagada fica sem nome', () => {
		const rows = rankCategories(
			[{ month: '2026-09', categoryId: 'gone', totalCents: R(10) }],
			[{ month: '2026-08', categoryId: 'food', totalCents: R(500) }],
			categories
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ categoryId: 'gone', name: null, shareBp: 10_000 });
	});

	it('origem do gasto: cartão, débito por final, o Pix que sobrou, envelope e sem conta', () => {
		const p = point('2026-09', {
			cards: [{ accountId: 'card', name: 'Cartão Nubank', spendCents: R(3_000), purchasesCents: 0 }],
			envelopes: [{ accountId: 'inter', name: 'Inter PF', fundedCents: 0, spentCents: 0, costCents: R(1_000), monthlyCents: R(1_000), targetCents: 0, remainingCents: 0 }],
		});
		const rows = rankSpendSources(
			p,
			[nu, card, inter],
			[{ accountId: 'nu', last4: '1234', name: 'Débito físico', periodSpentCents: R(300) }],
			[row('2026-09', 'nu', R(20_000), R(6_500), R(6_000)), row('2026-09', null, 0, R(50))]
		);
		expect(rows.map((r) => [r.kind, r.cents])).toEqual([
			['card', R(3_000)],
			['envelope', R(1_000)],
			['debit', R(300)],
			['pix', R(200)],
			['unassigned', R(50)],
		]);
		expect(rows[2]).toMatchObject({ last4: '1234', name: 'Débito físico', accountId: 'nu' });
		expect(rows.reduce((sum, r) => sum + r.shareBp, 0)).toBeGreaterThanOrEqual(9_990);
	});

	it('zeros somem', () => {
		expect(rankSpendSources(point('2026-09', {}), [nu], [], [row('2026-09', 'nu', R(100), 0)])).toEqual([]);
	});
});

describe('já comprometido', () => {
	it('fatura que vence no mês, menos o já pago, mais o custo fixo', () => {
		// Compra em 3x de R$ 300 feita em 10/09: parcelas nas faturas de set, out e nov (fecham
		// dia 25, vencem 7 dias depois → out, nov e dez).
		const entries: CardEntry[] = [1, 2, 3].map((index) => ({
			...purchase(`2026-${String(8 + index).padStart(2, '0')}-10`, R(300)),
			installmentGroup: 'g',
			installmentIndex: index,
			installmentCount: 3,
		}));
		const summary = buildCardSummary(card, entries, [], '2026-09-17');
		const months = committedMonths([{ id: 'card', name: 'Cartão Nubank', summary }], R(2_000), '2026-09', 3);
		expect(months.map((m) => m.month)).toEqual(['2026-10', '2026-11', '2026-12']);
		for (const month of months) {
			expect(month.fixedCents).toBe(R(2_000));
			expect(month.cardCents).toBe(R(300));
			expect(month.totalCents).toBe(R(2_300));
			expect(month.cards[0]).toMatchObject({ accountId: 'card', name: 'Cartão Nubank' });
		}
	});

	it('sem cartão é só o custo fixo', () => {
		expect(committedMonths([], R(500), '2026-09', 2)).toEqual([
			{ month: '2026-10', cards: [], cardCents: 0, fixedCents: R(500), totalCents: R(500) },
			{ month: '2026-11', cards: [], cardCents: 0, fixedCents: R(500), totalCents: R(500) },
		]);
	});
});

describe('renda: o que conta, e o que pode estar contado duas vezes', () => {
	it('dois Pix e um repasse: renda 14.000', () => {
		expect(
			incomeComposition(
				[
					{ amountCents: R(5_000), isIncome: true, category: 'salary' },
					{ amountCents: R(15_000), isIncome: true, category: 'salary' },
					{ amountCents: R(6_000), isIncome: false, category: 'passthrough' },
					{ amountCents: R(100), isIncome: false, category: 'food' },
				],
				new Set(['passthrough'])
			)
		).toEqual({ grossCents: R(20_000), passThroughCents: R(6_000), netCents: R(14_000), incomeCount: 2, passThroughCount: 1 });
	});

	const income = (id: string, amountCents: number, date: string, accountId: string | null = 'nu') => ({ id, amountCents, isIncome: true, accountId, date });

	it('dois Pix de valores diferentes não são duplicata', () => {
		expect(findDuplicateIncomes([income('a', R(5_000), '2026-09-05'), income('b', R(15_000), '2026-09-20')])).toEqual([]);
	});

	it('o mesmo valor, na mesma conta, com dois dias de distância, é suspeito', () => {
		const found = findDuplicateIncomes([income('a', R(15_000), '2026-09-20'), income('b', R(15_000), '2026-09-22'), income('c', R(15_000), '2026-09-25')]);
		expect(found).toEqual([{ amountCents: R(15_000), accountId: 'nu', ids: ['a', 'b'], dates: ['2026-09-20', '2026-09-22'] }]);
	});

	it('contas diferentes, valores pequenos ou longe demais não disparam', () => {
		expect(findDuplicateIncomes([income('a', R(15_000), '2026-09-20'), income('b', R(15_000), '2026-09-20', 'pj')])).toEqual([]);
		expect(findDuplicateIncomes([income('a', R(50), '2026-09-20'), income('b', R(50), '2026-09-20')])).toEqual([]);
		expect(findDuplicateIncomes([income('a', R(15_000), '2026-09-20'), income('b', R(15_000), '2026-09-23')])).toEqual([]);
		expect(findDuplicateIncomes([{ id: 'x', amountCents: R(6_000), isIncome: false, accountId: 'nu', date: '2026-09-20' }, { id: 'y', amountCents: R(6_000), isIncome: false, accountId: 'nu', date: '2026-09-20' }])).toEqual([]);
	});
});
