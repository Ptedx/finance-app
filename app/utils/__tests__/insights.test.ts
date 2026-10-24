import { buildHealthIndicators, type HealthInput } from '../healthScore';
import {
	buildDebtInsights,
	buildFixedCostInsights,
	buildGoalInsights,
	buildInsights,
	buildSavingsRateInsights,
	computeWealthMetrics,
	FIXED_COST_INSIGHT_IDS,
	type Insight,
	mergeInsights,
	SAVINGS_RATE_INSIGHT_IDS,
	type WealthSnapshot,
} from '../insights';
import { fixedCostShare } from '../metrics';
import { buildMonthOverview } from '../monthOverview';
import { buildRetirementReadModel, type RetirementInput } from '../retirement';

const snapshotOf = (overrides: Partial<WealthSnapshot> = {}): WealthSnapshot => ({
	month: 6,
	periodTotals: { incomeCents: 10_000_00, expenseCents: 7_000_00 },
	previousPeriodTotals: { incomeCents: 10_000_00, expenseCents: 7_500_00 },
	liquidCents: 30_000_00,
	recurring: [
		{ recurrenceType: 'monthly', day: 5, amountCents: 3_000_00, isIncome: false, active: true },
	],
	expenseTotalsByNature: { essentialCents: 4_000_00, discretionaryCents: 3_000_00 },
	categoryTotals: [{ categoryId: 'food', totalCents: 1_000_00 }],
	previousCategoryTotals: [{ categoryId: 'food', totalCents: 900_00 }],
	monthlyIncome: Array.from({ length: 6 }, (_, i) => ({ month: i + 1, totalCents: 10_000_00 })),
	monthlyExpense: Array.from({ length: 6 }, (_, i) => ({ month: i + 1, totalCents: 7_000_00 })),
	categoryNameById: { food: 'Food' },
	...overrides,
});

const idsOf = (insights: Insight[]) => insights.map((insight) => insight.id);

describe('computeWealthMetrics', () => {
	it('composes the whole read-model from the raw aggregates', () => {
		const metrics = computeWealthMetrics(snapshotOf());

		expect(metrics.savingsRate.basisPoints).toBe(3_000);
		expect(metrics.previousSavingsRate?.basisPoints).toBe(2_500);
		expect(metrics.savingsRateDeltaBasisPoints).toBe(500);
		expect(metrics.monthlyFixedCents).toBe(3_000_00);
		expect(metrics.fixedCostBasisPoints).toBe(3_000);
		expect(metrics.runwayMonths).toBe(10);
		expect(metrics.split.needsBasisPoints).toBe(4_000);
		expect(metrics.trend).toHaveLength(12);
	});

	it('leaves the comparison out when there is no previous period', () => {
		const metrics = computeWealthMetrics(snapshotOf({ previousPeriodTotals: null }));

		expect(metrics.previousSavingsRate).toBeNull();
		expect(metrics.savingsRateDeltaBasisPoints).toBeNull();
	});

	// Sem recorrência cadastrada não existe custo fixo, e sem custo fixo o fôlego é uma
	// divisão por zero — `null` em vez de "infinitos meses de reserva".
	it('has no runway to report without recurring expenses', () => {
		const metrics = computeWealthMetrics(snapshotOf({ recurring: [] }));

		expect(metrics.monthlyFixedCents).toBe(0);
		expect(metrics.runwayMonths).toBeNull();
		expect(metrics.fixedCostBasisPoints).toBe(0);
	});
});

/**
 * A tela de Relatórios tinha duas contas de "sobrou" num mesmo scroll: a grade de saúde vinha
 * do quadro do mês e o insight, da soma crua do período — "taxa de poupança 4%" em cima e
 * "54% da sua renda virou poupança" embaixo. `buildSavingsRateInsights` existe para que quem
 * monta a tela escolha uma base e as duas frases saiam dela.
 */
describe('a taxa de poupança tem uma base só', () => {
	// A fatura que **fecha** no mês é R$ 6.800; a soma crua do período veria só o que foi
	// lançado e pago. É a diferença que fazia os dois números discordarem.
	const month = buildMonthOverview({
		accounts: [
			{
				accountId: 'nu',
				name: 'Nubank PF',
				kind: 'checking',
				role: 'main',
				incomeCents: 1_000_000,
				expenseCents: 200_000,
				transfersInCents: 0,
				transfersOutCents: 680_000,
			},
			{
				accountId: 'card',
				name: 'Cartão',
				kind: 'credit_card',
				role: 'card',
				incomeCents: 0,
				expenseCents: 0,
				transfersInCents: 680_000,
				transfersOutCents: 0,
				invoiceCents: 680_000,
			},
		],
		unassigned: { incomeCents: 0, expenseCents: 0 },
	});

	const rateOf = (overview: typeof month) => ({
		incomeCents: overview.incomeCents,
		netCents: overview.leftoverCents,
		basisPoints: overview.savingsRateBp,
	});

	it('a frase sai do mesmo número que a grade de saúde mostra', () => {
		expect(month.savingsRateBp).toBe(1_200);
		const insights = buildSavingsRateInsights(rateOf(month));
		expect(idsOf(insights)).toEqual([]); // 12%: nem saudável (20%) nem baixa (10%)
		expect(buildSavingsRateInsights({ incomeCents: 1_000_000, netCents: 540_000, basisPoints: 5_400 })[0]).toMatchObject({
			id: 'savings-rate-healthy',
			params: { percent: '54%' },
		});
	});

	it('mês no vermelho pelo quadro do mês é mês no vermelho na frase', () => {
		const red = buildMonthOverview({
			accounts: [
				{
					accountId: 'nu',
					name: 'Nubank PF',
					kind: 'checking',
					role: 'main',
					incomeCents: 500_000,
					expenseCents: 600_000,
					transfersInCents: 0,
					transfersOutCents: 0,
				},
			],
			unassigned: { incomeCents: 0, expenseCents: 0 },
		});
		expect(buildSavingsRateInsights(rateOf(red))[0]).toMatchObject({ id: 'savings-rate-negative', severity: 'critical' });
	});

	it('as quedas seguidas vêm de fora, para que venham da mesma base', () => {
		expect(idsOf(buildSavingsRateInsights(rateOf(month), 3))).toContain('savings-rate-falling');
		expect(idsOf(buildSavingsRateInsights(rateOf(month), 2))).not.toContain('savings-rate-falling');
	});

	it('todas as frases de taxa de poupança estão na lista que a tela troca', () => {
		const produced = new Set([
			...idsOf(buildSavingsRateInsights({ incomeCents: 100, netCents: -100, basisPoints: null }, 3)),
			...idsOf(buildSavingsRateInsights({ incomeCents: 100, netCents: 50, basisPoints: 5_000 })),
			...idsOf(buildSavingsRateInsights({ incomeCents: 100, netCents: 5, basisPoints: 500 })),
		]);
		for (const id of produced) expect(SAVINGS_RATE_INSIGHT_IDS).toContain(id);
	});
});

/**
 * O mesmo para o custo fixo (SPD-032): a grade de saúde lê a receita do quadro do mês e o
 * insight lia a receita crua do período. Quem recebe pela PJ (entrada vinda de conta
 * `external`) via "custo fixo 23%" na grade e "300% da renda comprometida" no insight.
 */
describe('o custo fixo tem uma base só', () => {
	const fixed = 300_000;
	// Receita lançada R$ 1.000 + pró-labore de R$ 12.000 que chega da PJ por transferência.
	const pj = buildMonthOverview({
		accounts: [
			{
				accountId: 'nu',
				name: 'Nubank PF',
				kind: 'checking',
				role: 'main',
				incomeCents: 100_000,
				expenseCents: 50_000,
				transfersInCents: 1_200_000,
				transfersInFromExternalCents: 1_200_000,
				transfersOutCents: 0,
			},
		],
		unassigned: { incomeCents: 0, expenseCents: 0 },
	});

	it('cenário PJ: a frase e a grade dão o mesmo percentual (23%, sem alerta)', () => {
		expect(pj.incomeCents).toBe(1_300_000);
		const grid = fixedCostShare({ monthlyFixedCents: fixed, incomeCents: pj.incomeCents });
		expect(grid).toBe(2_308);
		const insights = buildFixedCostInsights({ monthlyFixedCents: fixed, basisPoints: grid });
		expect(insights.find((i) => i.id === 'fixed-cost-heavy')?.basisPoints ?? grid).toBe(grid);
		expect(idsOf(insights)).toEqual([]);

		// A base crua, que a tela troca: 3.000 / 1.000 = 300%.
		const raw = buildInsights(
			computeWealthMetrics(
				snapshotOf({
					periodTotals: { incomeCents: 100_000, expenseCents: 50_000 },
					recurring: [{ recurrenceType: 'monthly', day: 5, amountCents: fixed, isIncome: false, active: true }],
				})
			)
		);
		expect(raw.find((i) => i.id === 'fixed-cost-heavy')?.basisPoints).toBe(30_000);
	});

	it('custo fixo pesado pela receita do quadro: a frase traz o percentual da grade', () => {
		const grid = fixedCostShare({ monthlyFixedCents: 900_000, incomeCents: pj.incomeCents });
		expect(grid).toBe(6_923);
		expect(buildFixedCostInsights({ monthlyFixedCents: 900_000, basisPoints: grid })).toEqual([
			expect.objectContaining({ id: 'fixed-cost-heavy', basisPoints: grid, valueCents: 900_000, params: expect.objectContaining({ percent: '69%' }) }),
		]);
		// Abaixo da metade da renda do quadro não há alerta.
		expect(buildFixedCostInsights({ monthlyFixedCents: 600_000, basisPoints: fixedCostShare({ monthlyFixedCents: 600_000, incomeCents: pj.incomeCents }) })).toEqual([]);
	});

	it('sem receita no quadro não há frase', () => {
		expect(buildFixedCostInsights({ monthlyFixedCents: fixed, basisPoints: null })).toEqual([]);
	});

	it('a frase do helper é a mesma de buildInsights, e está na lista que a tela troca', () => {
		const insights = buildInsights(
			computeWealthMetrics(snapshotOf({ recurring: [{ recurrenceType: 'monthly', day: 5, amountCents: 9_000_00, isIncome: false, active: true }] }))
		);
		const fromHelper = buildFixedCostInsights({ monthlyFixedCents: 9_000_00, basisPoints: 9_000 });
		expect(fromHelper).toHaveLength(1);
		expect(insights.find((i) => i.id === 'fixed-cost-heavy')).toEqual(fromHelper[0]);
		for (const id of idsOf(fromHelper)) expect(FIXED_COST_INSIGHT_IDS).toContain(id);
	});
});

describe('buildInsights', () => {
	const insightsOf = (overrides: Partial<WealthSnapshot> = {}) => {
		const snapshot = snapshotOf(overrides);
		return buildInsights(computeWealthMetrics(snapshot), snapshot);
	};

	it('celebrates a healthy savings rate', () => {
		const insights = insightsOf();

		expect(idsOf(insights)).toContain('savings-rate-healthy');
		expect(insights.find((i) => i.id === 'savings-rate-healthy')?.params.percent).toBe('30%');
	});

	it('flags a month that closed in the red as critical', () => {
		const insights = insightsOf({
			periodTotals: { incomeCents: 5_000_00, expenseCents: 6_000_00 },
		});

		const negative = insights.find((i) => i.id === 'savings-rate-negative');
		expect(negative?.severity).toBe('critical');
		expect(negative?.valueCents).toBe(-1_000_00);
		// A pior notícia vem primeiro — é o que o usuário lê antes de rolar a tela.
		expect(insights[0].severity).toBe('critical');
	});

	it('does not talk about a savings rate that does not exist', () => {
		const insights = insightsOf({
			periodTotals: { incomeCents: 0, expenseCents: 800_00 },
			previousPeriodTotals: null,
		});

		expect(idsOf(insights)).not.toContain('savings-rate-negative');
		expect(idsOf(insights)).not.toContain('savings-rate-low');
		expect(idsOf(insights)).not.toContain('savings-rate-healthy');
		expect(idsOf(insights)).not.toContain('fixed-cost-heavy');
	});

	it('reports a run of falling months, but only once it is a trend', () => {
		const falling = [3_000_00, 3_500_00, 4_000_00, 4_500_00, 5_000_00, 5_500_00];

		expect(
			idsOf(
				insightsOf({
					monthlyExpense: falling.map((totalCents, i) => ({ month: i + 1, totalCents })),
				})
			)
		).toContain('savings-rate-falling');

		expect(
			idsOf(
				insightsOf({
					monthlyExpense: [4_000_00, 5_000_00, 5_500_00, 4_000_00, 4_000_00, 4_500_00].map(
						(totalCents, i) => ({ month: i + 1, totalCents })
					),
				})
			)
		).not.toContain('savings-rate-falling');
	});

	it('warns when fixed costs already eat half the income', () => {
		const insights = insightsOf({
			recurring: [
				{ recurrenceType: 'monthly', day: 5, amountCents: 6_000_00, isIncome: false, active: true },
			],
		});

		const heavy = insights.find((i) => i.id === 'fixed-cost-heavy');
		expect(heavy?.basisPoints).toBe(6_000);
		expect(heavy?.params.amount).toBeDefined();
	});

	it('treats a thin runway as critical and a solid one as good news', () => {
		expect(idsOf(insightsOf({ liquidCents: 5_000_00 }))).toContain('runway-thin');
		expect(idsOf(insightsOf({ liquidCents: 100_000_00 }))).toContain('runway-solid');
	});

	// Enquanto nada está classificado tudo cai em "desejos", e comparar isso com a
	// referência de 50% falaria de um dado que o usuário nunca forneceu.
	it('stays quiet about the 50/30/20 reference while nothing is tagged', () => {
		const insights = insightsOf({
			expenseTotalsByNature: { essentialCents: 0, discretionaryCents: 7_000_00 },
		});

		expect(idsOf(insights)).not.toContain('needs-over-target');
	});

	it('names the category that explains the month', () => {
		const insights = insightsOf({
			categoryTotals: [{ categoryId: 'food', totalCents: 1_500_00 }],
			previousCategoryTotals: [{ categoryId: 'food', totalCents: 1_000_00 }],
		});

		const jump = insights.find((i) => i.id === 'category-jump');
		expect(jump?.params.category).toBe('Food');
		expect(jump?.params.percent).toBe('50%');
		expect(jump?.valueCents).toBe(500_00);
	});

	// Um aumento percentual grande sobre uma base minúscula não é notícia.
	it('ignores a big percentage over a trivial amount', () => {
		const insights = insightsOf({
			categoryTotals: [{ categoryId: 'food', totalCents: 20_00 }],
			previousCategoryTotals: [{ categoryId: 'food', totalCents: 5_00 }],
		});

		expect(idsOf(insights)).not.toContain('category-jump');
	});

	it('falls back to the category id when no name was supplied', () => {
		const insights = insightsOf({
			categoryTotals: [{ categoryId: 'food', totalCents: 1_500_00 }],
			previousCategoryTotals: [{ categoryId: 'food', totalCents: 1_000_00 }],
			categoryNameById: undefined,
		});

		expect(insights.find((i) => i.id === 'category-jump')?.params.category).toBe('food');
	});

	it('orders the most urgent first', () => {
		const rank = { critical: 0, attention: 1, positive: 2, neutral: 3 };
		const insights = insightsOf({
			periodTotals: { incomeCents: 5_000_00, expenseCents: 6_000_00 },
			liquidCents: 1_000_00,
		});

		const ranks = insights.map((insight) => rank[insight.severity]);

		expect(insights.length).toBeGreaterThan(1);
		expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
	});
});

describe('buildGoalInsights', () => {
	const R = (reais: number) => reais * 100;
	const retirement = (overrides: Partial<RetirementInput> = {}) =>
		buildRetirementReadModel({
			goal: { targetMonthlyCents: R(10_000), reinvestBp: 2_500, expectedYieldBp: 1_000, outsideCapitalCents: 0 },
			trackedCapitalCents: R(20_000),
			monthlyContributionCents: R(3_000),
			realizedYield12mCents: null,
			averageCapital12mCents: null,
			asOfMonth: '2026-09',
			...overrides,
		});
	const health = (overrides: Partial<HealthInput> = {}) =>
		buildHealthIndicators({
			savingsRateBp: 2_500,
			neededSavingsRateBp: null,
			liquidCents: R(30_000),
			averageMonthlySpendCents: R(5_000),
			fixedCostBp: 3_000,
			cardOwedCents: R(1_000),
			averageMonthlyIncomeCents: R(14_000),
			limitUsagePercent: 20,
			currentSpendCents: R(2_500),
			elapsedBp: 5_000,
			...overrides,
		});

	it('sem meta: convida a definir uma', () => {
		expect(idsOf(buildGoalInsights(null, health(), []))).toEqual(['goal-unset']);
	});

	it('no ritmo: chega em até 20 anos', () => {
		const [insight] = buildGoalInsights(retirement(), health(), []);
		expect(insight).toMatchObject({ id: 'goal-on-track', severity: 'positive' });
		expect(insight.params.years).toBeDefined();
		expect(String(insight.params.month)).toMatch(/\d{4}$/);
	});

	it('devagar demais: diz quanto faltaria por mês para 20 anos', () => {
		const [insight] = buildGoalInsights(retirement({ monthlyContributionCents: R(100) }), health(), []);
		expect(insight).toMatchObject({ id: 'goal-needs-more', severity: 'attention', params: { years: 20 } });
		expect(insight.params.needed).not.toBe('—');
	});

	it('sem aporte nenhum', () => {
		expect(idsOf(buildGoalInsights(retirement({ trackedCapitalCents: 0, monthlyContributionCents: 0 }), health(), []))).toEqual(['goal-no-contribution']);
	});

	it('já chegou', () => {
		expect(idsOf(buildGoalInsights(retirement({ trackedCapitalCents: R(2_000_000) }), health(), []))).toEqual(['goal-reached']);
	});

	it('rendimento observado bem abaixo do esperado', () => {
		const ids = idsOf(buildGoalInsights(retirement({ realizedYield12mCents: R(300), averageCapital12mCents: R(10_000) }), health(), []));
		expect(ids).toContain('reserve-yield-low');
		// 6% contra 10% esperados ainda não é metade: silêncio.
		expect(idsOf(buildGoalInsights(retirement({ realizedYield12mCents: R(600), averageCapital12mCents: R(10_000) }), health(), []))).not.toContain('reserve-yield-low');
	});

	it('5.1 — base só estimada não sustenta "troque de investimento"', () => {
		// O número é uma conta do próprio app sobre a taxa contratada, não rendimento lançado:
		// a frase chegava a sugerir trocar um CDB de 120% do CDI.
		const base = { realizedYield12mCents: R(300), averageCapital12mCents: R(10_000) };
		expect(idsOf(buildGoalInsights(retirement({ ...base, realizedYieldBasis: 'estimated' }), health(), []))).not.toContain('reserve-yield-low');
		expect(idsOf(buildGoalInsights(retirement({ ...base, realizedYieldBasis: 'posted' }), health(), []))).toContain('reserve-yield-low');
		// Parte lançada, parte estimada: há livro suficiente para a frase.
		expect(idsOf(buildGoalInsights(retirement({ ...base, realizedYieldBasis: 'mixed' }), health(), []))).toContain('reserve-yield-low');
	});

	it('5.6 — com resgate, a frase é "nada foi para a reserva", não "hoje são R$ 0,00"', () => {
		const ids = idsOf(buildGoalInsights(retirement({ trackedCapitalCents: R(20_000), monthlyContributionCents: -R(300) }), health(), []));
		expect(ids).toContain('goal-no-contribution');
		expect(ids).not.toContain('goal-needs-more');
	});

	it('a grade só fala quando está no vermelho', () => {
		const ids = idsOf(buildGoalInsights(null, health({ cardOwedCents: R(10_000), currentSpendCents: R(5_000) }), []));
		expect(ids).toEqual(['card-load-heavy', 'spending-above-pace', 'goal-unset']);
	});

	it('receita repetida vem primeiro, com o valor e as datas', () => {
		const [insight] = buildGoalInsights(retirement(), health(), [
			{ amountCents: R(15_000), accountId: 'nu', ids: ['a', 'b'], dates: ['2026-09-20', '2026-09-22'] },
		]);
		expect(insight).toMatchObject({ id: 'income-possibly-duplicated', severity: 'critical', params: { first: '2026-09-20', second: '2026-09-22' } });
	});

	it('mergeInsights ordena por urgência', () => {
		const merged = mergeInsights(buildGoalInsights(retirement(), health(), []), buildInsights(computeWealthMetrics(snapshotOf())));
		const order = { critical: 0, attention: 1, positive: 2, neutral: 3 };
		for (let i = 1; i < merged.length; i += 1) expect(order[merged[i].severity]).toBeGreaterThanOrEqual(order[merged[i - 1].severity]);
	});
});

describe('buildDebtInsights', () => {
	const base = { id: 'car', name: 'Carro', rateBp: 2_200, netYieldBp: 850, perThousandCents: 13_500 };

	it('dívida cara: amortizar primeiro, com quanto rende a mais', () => {
		const [insight] = buildDebtInsights([{ ...base, verdict: 'pay' }]);
		expect(insight).toMatchObject({ id: 'debt-pay-first', severity: 'attention', params: { name: 'Carro', rate: '22%', net: '9%' } });
	});

	it('dívida barata: não vale antecipar', () => {
		expect(idsOf(buildDebtInsights([{ ...base, id: 'cons', name: 'Consórcio', rateBp: 500, verdict: 'invest', perThousandCents: -3_500 }]))).toEqual(['debt-keep-investing']);
	});

	it('empate não vira frase', () => {
		expect(buildDebtInsights([{ ...base, verdict: 'tie' }])).toEqual([]);
	});
});
