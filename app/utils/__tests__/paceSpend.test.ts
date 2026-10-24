/*
 * SPD-034 (DEC-10 a), o lado dos Relatórios: o gasto de cada janela do ritmo de gastos,
 * do dia 1 ao dia do corte, na mesma conta do "Gastou" — e só com o que é até o corte.
 */
import type { Account } from '../../database/schema';
import type { CardEntry } from '../cardMath';
import { buildHealthIndicators, type HealthInput, spendingPaceWindows } from '../healthScore';
import { buildMonthSeries, type MonthAccountRow, type PaceWindowActivity, paceSpendToDate } from '../reportSeries';

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
	openingBalanceDate: '2026-01-01',
	sortOrder: 0,
	archived: false,
	updatedAt: '2026-01-01T00:00:00.000Z',
	...overrides,
});

const main = account('main', { name: 'Principal' });
const card = account('card', { name: 'Nubank', kind: 'credit_card', role: 'card', closingDay: 25, closingDaysBefore: 7 });

const entry = (id: string, date: string, amountCents: number): CardEntry => ({
	id,
	amountCents,
	isIncome: false,
	date,
	note: '',
	category: 'food',
	installmentGroup: null,
	installmentIndex: null,
	installmentCount: null,
});

const expenseRow = (month: string, expenseCents: number): MonthAccountRow => ({
	month,
	accountId: 'main',
	incomeCents: 0,
	expenseCents,
	passThroughCents: 0,
});

const window = (month: string, cutoffDate: string, expenseCents: number, hasData = true): PaceWindowActivity => ({
	month,
	cutoffDate,
	activity: expenseCents === 0 ? [] : [expenseRow(month, expenseCents)],
	transfers: [],
	hasData,
});

const input = (windows: PaceWindowActivity[], overrides: { cardEntries?: CardEntry[]; provisional?: CardEntry[] } = {}) => ({
	windows,
	accounts: [main, card],
	cardEntries: new Map([['card', overrides.cardEntries ?? []]]),
	provisional: new Map(overrides.provisional ? [['card', overrides.provisional]] : []),
	transferLines: [],
	currentMonth: '2026-10',
});

describe('paceSpendToDate: o gasto de cada janela do ritmo', () => {
	it('sem janela (mês futuro), nada', () => {
		expect(paceSpendToDate(input([]))).toBeNull();
	});

	it('o principal: o mês atual e os anteriores, cada um com as somas até o corte', () => {
		const result = paceSpendToDate(
			input([window('2026-10', '2026-10-10', 3_000_00), window('2026-09', '2026-09-10', 2_900_00), window('2026-08', '2026-08-10', 3_100_00)])
		);
		expect(result).toEqual({
			currentCents: 3_000_00,
			previous: [
				{ toDateCents: 2_900_00, hasData: true },
				{ toDateCents: 3_100_00, hasData: true },
			],
		});
	});

	it('o mês sem lançamentos diz que não tem dados, para o ritmo pular', () => {
		const result = paceSpendToDate(input([window('2026-10', '2026-10-10', 1_000_00), window('2026-09', '2026-09-10', 0, false)]));
		expect(result?.previous).toEqual([{ toDateCents: 0, hasData: false }]);
	});

	it('cartão: a compra datada depois do corte fica fora, também no mês atual', () => {
		const cardEntries = [entry('sep30', '2026-09-30', 100_00), entry('oct15', '2026-10-15', 50_00)];
		// O mês inteiro (sem corte) põe as duas na fatura que fecha em outubro.
		const [full] = buildMonthSeries({
			months: ['2026-10'],
			accounts: [main, card],
			activity: [],
			transfers: [],
			cardEntries: new Map([['card', cardEntries]]),
			currentMonth: '2026-10',
		});
		expect(full.overview.totalSpendCents).toBe(150_00);

		const result = paceSpendToDate(input([window('2026-10', '2026-10-10', 0)], { cardEntries }));
		expect(result?.currentCents).toBe(100_00);
	});

	it('a compra a revisar (provisória) entra até o corte e fica fora depois dele', () => {
		const provisional = [{ ...entry('p1', '2026-10-05', 40_00), pendingReview: true }, { ...entry('p2', '2026-10-12', 60_00), pendingReview: true }];
		const result = paceSpendToDate(input([window('2026-10', '2026-10-10', 0)], { provisional }));
		expect(result?.currentCents).toBe(40_00);
	});

	it('CALC-09 de ponta a ponta: o mesmo ritmo dos meses anteriores é ritmo normal', () => {
		const pace = spendingPaceWindows('2026-10', '2026-10-10');
		expect(pace).not.toBeNull();
		if (!pace) return;
		const windows = [pace.current, ...pace.previous].map((w) => window(w.month, w.cutoffDate, 3_245_00));
		const result = paceSpendToDate(input(windows));
		const health: HealthInput = {
			savingsRateBp: 2_000,
			neededSavingsRateBp: null,
			liquidCents: 30_000_00,
			averageMonthlySpendCents: 5_000_00,
			fixedCostBp: 3_000,
			cardOwedCents: 0,
			averageMonthlyIncomeCents: 14_000_00,
			limitUsagePercent: null,
			currentSpendCents: result?.currentCents ?? 0,
			elapsedBp: 3_226,
			previousSpendToDate: result?.previous ?? null,
		};
		const trend = buildHealthIndicators(health).find((indicator) => indicator.id === 'spending-trend');
		expect(trend?.status).toBe('good');
		expect(trend?.value).toBe(0);
	});
});
