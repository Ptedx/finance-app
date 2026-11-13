/**
 * SPD-126: o custo fixo (e o fôlego) contam as compras parceladas no cartão até a última parcela.
 *
 * Os números são os do aparelho de teste: renda de R$ 8.000, contas a pagar de R$ 1.620 e duas
 * compras parceladas no cartão — Notebook, R$ 300 por mês, faltam 3 de 5; Loja, R$ 50 por mês,
 * faltam 7 de 10. Antes o custo fixo era só R$ 1.620 (20%); agora é R$ 1.970 (24,6% → 25%).
 *
 * As parcelas saem de `buildInstallmentPlans`, a mesma lista de "Parcelas em andamento" do cartão.
 */

import { buildInstallmentPlans, type CardEntry } from '../cardMath';
import { buildHealthIndicators, type HealthInput } from '../healthScore';
import { computeWealthMetrics, type WealthSnapshot } from '../insights';
import { cardInstallmentsMonthlyCents, fixedCostShare, monthlyFixedCommitmentsCents } from '../metrics';

const TODAY = '2026-11-09';

/** As parcelas de uma compra, uma por mês a partir de `firstMonth` (`YYYY-MM`), no dia 25. */
const purchase = (group: string, note: string, parcelCents: number, count: number, firstMonth: string): CardEntry[] => {
	const [year, month] = firstMonth.split('-').map(Number);
	return Array.from({ length: count }, (_, index) => {
		const total = month - 1 + index;
		const date = `${year + Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}-25`;
		return {
			id: `${group}-${index + 1}`,
			amountCents: parcelCents,
			isIncome: false,
			date,
			note: `${note} (${index + 1}/${count})`,
			category: 'shopping',
			installmentGroup: group,
			installmentIndex: index + 1,
			installmentCount: count,
		};
	});
};

// Notebook: 5 × R$ 300, a primeira em 25/09 e a segunda em 25/10 — em 09/11 faltam 3 (nov, dez, jan).
const notebook = purchase('notebook', 'Notebook', 300_00, 5, '2026-09');
// Loja: 10 × R$ 50, a primeira em 25/08 — em 09/11 faltam 7 (nov a mai).
const loja = purchase('loja', 'Loja', 50_00, 10, '2026-08');
// Fone: 3 × R$ 100, a última em 25/10 — já acabou.
const fone = purchase('fone', 'Fone', 100_00, 3, '2026-08');

const bill = (amountCents: number, debtId: string | null = null) => ({ amountCents, active: true, debtId });
const BILLS = [bill(1_620_00)];
const INCOME = 8_000_00;

describe('SPD-126 — parcelas do cartão no custo fixo', () => {
	it('as parcelas em andamento do aparelho: Notebook faltam 3 de 5, Loja faltam 7 de 10', () => {
		const plans = buildInstallmentPlans([...notebook, ...loja, ...fone], TODAY);
		expect(plans.map((plan) => [plan.note, plan.parcelCents, plan.remainingCount, plan.totalCount])).toEqual([
			['Loja', 50_00, 7, 10],
			['Notebook', 300_00, 3, 5],
		]);
		expect(cardInstallmentsMonthlyCents(plans)).toBe(350_00);
	});

	it('antes: só as contas a pagar, R$ 1.620 contra R$ 8.000 = 2.025 pb (20%)', () => {
		const monthlyFixedCents = monthlyFixedCommitmentsCents({ bills: BILLS, debtInstallmentsCents: 0 });
		expect(monthlyFixedCents).toBe(1_620_00);
		expect(fixedCostShare({ monthlyFixedCents, incomeCents: INCOME })).toBe(2_025);
	});

	it('depois: R$ 1.620 + R$ 350 das parcelas = R$ 1.970, 2.463 pb, "25%" no indicador', () => {
		const cardInstallmentsCents = cardInstallmentsMonthlyCents(buildInstallmentPlans([...notebook, ...loja], TODAY));
		const monthlyFixedCents = monthlyFixedCommitmentsCents({ bills: BILLS, debtInstallmentsCents: 0, cardInstallmentsCents });
		expect(monthlyFixedCents).toBe(1_970_00);

		const fixedCostBp = fixedCostShare({ monthlyFixedCents, incomeCents: INCOME });
		// 1.970 / 8.000 = 24,625% → 2.463 pb.
		expect(fixedCostBp).toBe(2_463);

		const input: HealthInput = {
			savingsRateBp: null,
			neededSavingsRateBp: null,
			liquidCents: 0,
			averageMonthlySpendCents: null,
			fixedCostBp,
			cardOwedCents: 0,
			averageMonthlyIncomeCents: null,
			limitUsagePercent: null,
			currentSpendCents: 0,
			elapsedBp: 10_000,
		};
		const indicator = buildHealthIndicators(input).find((item) => item.id === 'fixed-cost');
		// Como o app formata hoje: inteiro acima de 10% — o "20%" de antes vira "25%".
		expect(indicator?.params.percent).toBe('25%');
		expect(indicator?.status).toBe('good');
	});

	it('as métricas de riqueza (indicador, insight e fôlego) usam o mesmo custo fixo', () => {
		const snapshot: WealthSnapshot = {
			month: 11,
			periodTotals: { incomeCents: INCOME, expenseCents: 0 },
			liquidCents: 19_700_00,
			bills: BILLS,
			debtInstallmentsCents: 0,
			cardInstallmentsCents: cardInstallmentsMonthlyCents(buildInstallmentPlans([...notebook, ...loja], TODAY)),
			expenseTotalsByNature: { essentialCents: 0, discretionaryCents: 0 },
			categoryTotals: [],
			previousCategoryTotals: [],
			monthlyIncome: [],
			monthlyExpense: [],
		};
		const metrics = computeWealthMetrics(snapshot);
		expect(metrics.monthlyFixedCents).toBe(1_970_00);
		expect(metrics.fixedCostBasisPoints).toBe(2_463);
		// R$ 19.700 pagam dez meses de R$ 1.970.
		expect(metrics.runwayMonths).toBe(10);
	});

	it('a parcela que acabou não conta: o Fone (3 de 3, a última em 25/10) fica de fora', () => {
		expect(cardInstallmentsMonthlyCents(buildInstallmentPlans(fone, TODAY))).toBe(0);
		// A última do Notebook cai em 25/01/2027: no dia seguinte, ele sai do custo fixo.
		expect(cardInstallmentsMonthlyCents(buildInstallmentPlans(notebook, '2027-01-24'))).toBe(300_00);
		expect(cardInstallmentsMonthlyCents(buildInstallmentPlans(notebook, '2027-01-25'))).toBe(0);
		// Um plano sem parcela por cair (se chegar assim) também não conta.
		expect(cardInstallmentsMonthlyCents([{ group: 'x', parcelCents: 99_00, remainingCount: 0 }])).toBe(0);
	});

	it('estorno, ajuste e encargo do cartão não são parcela', () => {
		const extras: CardEntry[] = [
			// Estorno de uma parcela do Notebook: crédito, não compromisso.
			{ ...notebook[4], id: 'estorno', isIncome: true },
			{ id: 'ajuste', amountCents: 80_00, isIncome: false, date: '2026-11-20', note: 'Ajuste com a fatura do banco', category: 'other', installmentGroup: null, installmentIndex: null, installmentCount: null },
			{ id: 'juros', amountCents: 40_00, isIncome: false, date: '2026-11-20', note: 'Encargo do cartão (juros)', category: 'other', installmentGroup: null, installmentIndex: null, installmentCount: null },
		];
		expect(cardInstallmentsMonthlyCents(buildInstallmentPlans([...notebook, ...loja, ...extras], TODAY))).toBe(350_00);
	});

	it('não conta em dobro: a dívida entra pela parcela, a conta ligada a ela não, e a mesma compra entra uma vez', () => {
		const plans = buildInstallmentPlans([...notebook, ...loja], TODAY);
		// A mesma compra vista duas vezes (o mesmo grupo em dois resumos): uma parcela só.
		const cardInstallmentsCents = cardInstallmentsMonthlyCents([...plans, ...plans]);
		expect(cardInstallmentsCents).toBe(350_00);

		const monthlyFixedCents = monthlyFixedCommitmentsCents({
			// A conta a pagar do financiamento (ligada à dívida) fica de fora: a parcela vem da dívida.
			bills: [...BILLS, bill(1_500_00, 'carro')],
			debtInstallmentsCents: 1_500_00,
			cardInstallmentsCents,
		});
		expect(monthlyFixedCents).toBe(1_620_00 + 1_500_00 + 350_00);
	});
});
