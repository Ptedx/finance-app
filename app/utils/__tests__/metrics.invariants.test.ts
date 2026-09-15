/**
 * Invariantes das métricas de riqueza e do read-model de insights.
 *
 * As funções de `metrics.ts` são aritmética simples; o que se testa aqui é que a
 * aritmética fecha — as fatias somam 100%, a taxa é coerente com a razão, a série tem
 * sempre doze meses — para qualquer entrada, não só para os exemplos nomeados.
 */

import { buildInsights, computeWealthMetrics, type WealthSnapshot } from '../insights';
import {
	categoryDeltas,
	consecutiveSavingsRateDrops,
	fixedCostShare,
	FULL_BASIS_POINTS,
	monthlyFixedCostCents,
	monthlyRecurringIncomeCents,
	needsWantsSavingsSplit,
	type RecurringCommitment,
	runwayMonths,
	savingsRate,
	savingsRateDelta,
	savingsRateTrend,
} from '../metrics';
import { monthlyEquivalentCents } from '../recurrence';

const makeRandom = (seed: number) => {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 0x100000000;
	};
};

const randomInt = (random: () => number, min: number, max: number): number =>
	min + Math.floor(random() * (max - min + 1));

describe('savingsRate', () => {
	it('basisPoints é a razão arredondada e netCents é sempre renda − despesa', () => {
		const random = makeRandom(41);
		for (let i = 0; i < 20_000; i += 1) {
			const incomeCents = randomInt(random, 0, 5_000_000);
			const expenseCents = randomInt(random, 0, 5_000_000);
			const rate = savingsRate({ incomeCents, expenseCents });

			expect(rate.netCents).toBe(incomeCents - expenseCents);

			if (incomeCents === 0) {
				expect(rate.ratio).toBeNull();
				expect(rate.basisPoints).toBeNull();
			} else {
				expect(rate.ratio).toBeCloseTo((incomeCents - expenseCents) / incomeCents, 12);
				expect(rate.basisPoints).toBe(Math.round(((incomeCents - expenseCents) * 10_000) / incomeCents));
				expect(Number.isInteger(rate.basisPoints)).toBe(true);
			}
		}
	});

	it('renda igual à despesa é 0%, sem despesa é 100%, despesa dobrada é −100%', () => {
		expect(savingsRate({ incomeCents: 1234, expenseCents: 1234 }).basisPoints).toBe(0);
		expect(savingsRate({ incomeCents: 1234, expenseCents: 0 }).basisPoints).toBe(10_000);
		expect(savingsRate({ incomeCents: 1234, expenseCents: 2468 }).basisPoints).toBe(-10_000);
	});

	it('entradas não numéricas viram zero em vez de NaN na tela', () => {
		const rate = savingsRate({ incomeCents: Number.NaN, expenseCents: Number.POSITIVE_INFINITY });
		expect(rate.incomeCents).toBe(0);
		expect(rate.expenseCents).toBe(0);
		expect(rate.netCents).toBe(0);
		expect(rate.basisPoints).toBeNull();
	});

	it('savingsRateDelta é a diferença exata em pontos-base, ou null sem base', () => {
		const a = savingsRate({ incomeCents: 10_000, expenseCents: 7_500 }); // 25%
		const b = savingsRate({ incomeCents: 8_000, expenseCents: 7_200 }); // 10%
		expect(savingsRateDelta(a, b)).toBe(1_500);
		expect(savingsRateDelta(b, a)).toBe(-1_500);
		expect(savingsRateDelta(a, savingsRate({ incomeCents: 0, expenseCents: 10 }))).toBeNull();
	});
});

describe('needsWantsSavingsSplit', () => {
	it('as três fatias somam exatamente 10.000 pontos-base para qualquer entrada positiva', () => {
		const random = makeRandom(43);
		for (let i = 0; i < 20_000; i += 1) {
			const essentialCents = randomInt(random, 0, 1_000_000);
			const discretionaryCents = randomInt(random, 0, 1_000_000);
			const savingsCents = randomInt(random, -500_000, 1_000_000);
			const split = needsWantsSavingsSplit({ essentialCents, discretionaryCents }, savingsCents);

			expect(split.baseCents).toBe(essentialCents + discretionaryCents + savingsCents);

			if (split.baseCents <= 0) {
				expect(split.needsBasisPoints).toBeNull();
				continue;
			}

			expect(
				(split.needsBasisPoints ?? 0) + (split.wantsBasisPoints ?? 0) + (split.savingsBasisPoints ?? 0)
			).toBe(FULL_BASIS_POINTS);
			expect(split.needsBasisPoints).toBe(Math.round((essentialCents * 10_000) / split.baseCents));
		}
	});

	it('a base é a renda do período quando a poupança é o resultado dele', () => {
		const incomeCents = 500_000;
		const essentialCents = 200_000;
		const discretionaryCents = 150_000;
		const rate = savingsRate({ incomeCents, expenseCents: essentialCents + discretionaryCents });
		const split = needsWantsSavingsSplit({ essentialCents, discretionaryCents }, rate.netCents);

		expect(split.baseCents).toBe(incomeCents);
		expect(split.needsBasisPoints).toBe(4_000);
		expect(split.wantsBasisPoints).toBe(3_000);
		expect(split.savingsBasisPoints).toBe(3_000);
	});
});

describe('custo fixo, renda recorrente e fôlego', () => {
	const commitment = (
		partial: Partial<RecurringCommitment> & Pick<RecurringCommitment, 'amountCents'>
	): RecurringCommitment => ({
		recurrenceType: 'monthly',
		isIncome: false,
		active: true,
		...partial,
	});

	it('somam só as recorrências ativas do lado certo, já normalizadas para o mês', () => {
		const random = makeRandom(47);
		for (let i = 0; i < 2_000; i += 1) {
			const rules: RecurringCommitment[] = Array.from({ length: randomInt(random, 0, 12) }, () =>
				commitment({
					amountCents: randomInt(random, 0, 500_000),
					recurrenceType: (['weekly', 'monthly', 'yearly'] as const)[randomInt(random, 0, 2)],
					isIncome: random() < 0.4,
					active: random() < 0.8,
				})
			);

			let expectedFixed = 0;
			let expectedIncome = 0;
			for (const rule of rules) {
				if (!rule.active) continue;
				const monthly = monthlyEquivalentCents(rule, rule.amountCents);
				if (rule.isIncome) expectedIncome += monthly;
				else expectedFixed += monthly;
			}

			expect(monthlyFixedCostCents(rules)).toBe(expectedFixed);
			expect(monthlyRecurringIncomeCents(rules)).toBe(expectedIncome);
		}
	});

	it('runwayMonths: null sem custo fixo, 0 no vermelho, saldo/custo caso contrário', () => {
		expect(runwayMonths({ liquidCents: 100_000, monthlyFixedCents: 0 })).toBeNull();
		expect(runwayMonths({ liquidCents: -1, monthlyFixedCents: 1_000 })).toBe(0);
		expect(runwayMonths({ liquidCents: 0, monthlyFixedCents: 1_000 })).toBe(0);
		expect(runwayMonths({ liquidCents: 300_000, monthlyFixedCents: 100_000 })).toBe(3);
		expect(runwayMonths({ liquidCents: 250_000, monthlyFixedCents: 100_000 })).toBe(2.5);
	});

	it('fixedCostShare pode passar de 100% e é null sem renda', () => {
		expect(fixedCostShare({ monthlyFixedCents: 150_000, incomeCents: 100_000 })).toBe(15_000);
		expect(fixedCostShare({ monthlyFixedCents: 50_000, incomeCents: 0 })).toBeNull();
		expect(fixedCostShare({ monthlyFixedCents: 0, incomeCents: 100 })).toBe(0);
	});
});

describe('categoryDeltas', () => {
	it('cobre a união das categorias, com delta exato e ordenação estável', () => {
		const random = makeRandom(53);
		for (let i = 0; i < 2_000; i += 1) {
			const ids = Array.from({ length: randomInt(random, 0, 8) }, (_, k) => `cat-${k}`);
			const current = ids
				.filter(() => random() < 0.7)
				.map((categoryId) => ({ categoryId, totalCents: randomInt(random, 0, 100_000) }));
			const previous = ids
				.filter(() => random() < 0.7)
				.map((categoryId) => ({ categoryId, totalCents: randomInt(random, 0, 100_000) }));

			const deltas = categoryDeltas(current, previous);
			const union = new Set([...current, ...previous].map((row) => row.categoryId));

			expect(deltas.map((d) => d.categoryId).sort()).toEqual([...union].sort());

			for (const delta of deltas) {
				const cur = current.find((r) => r.categoryId === delta.categoryId)?.totalCents ?? 0;
				const prev = previous.find((r) => r.categoryId === delta.categoryId)?.totalCents ?? 0;
				expect(delta.currentCents).toBe(cur);
				expect(delta.previousCents).toBe(prev);
				expect(delta.deltaCents).toBe(cur - prev);
				if (prev > 0) expect(delta.pct).toBeCloseTo((cur - prev) / prev, 12);
				else expect(delta.pct).toBeNull();
			}

			for (let k = 1; k < deltas.length; k += 1) {
				expect(Math.abs(deltas[k - 1].deltaCents)).toBeGreaterThanOrEqual(Math.abs(deltas[k].deltaCents));
			}
		}
	});
});

describe('savingsRateTrend / consecutiveSavingsRateDrops', () => {
	it('sempre doze meses, alinhados por número do mês e não por posição', () => {
		const random = makeRandom(59);
		for (let i = 0; i < 1_000; i += 1) {
			const income = [...Array(12).keys()]
				.filter(() => random() < 0.6)
				.map((k) => ({ month: k + 1, totalCents: randomInt(random, 0, 100_000) }))
				.sort(() => random() - 0.5);
			const expense = [...Array(12).keys()]
				.filter(() => random() < 0.6)
				.map((k) => ({ month: k + 1, totalCents: randomInt(random, 0, 100_000) }))
				.sort(() => random() - 0.5);

			const trend = savingsRateTrend(income, expense);
			expect(trend.map((t) => t.month)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

			for (const entry of trend) {
				const inc = income.find((r) => r.month === entry.month)?.totalCents ?? 0;
				const exp = expense.find((r) => r.month === entry.month)?.totalCents ?? 0;
				expect(entry.rate).toEqual(savingsRate({ incomeCents: inc, expenseCents: exp }));
			}
		}
	});

	it('conta quedas consecutivas e corta em mês sem renda ou em estabilidade', () => {
		const mk = (bps: Array<number | null>) =>
			bps.map((bp, index) => ({
				month: index + 1,
				rate: savingsRate(
					bp === null
						? { incomeCents: 0, expenseCents: 0 }
						: { incomeCents: 10_000, expenseCents: 10_000 - bp }
				),
			}));

		expect(consecutiveSavingsRateDrops(mk([5000, 4000, 3000, 2000]), 4)).toBe(3);
		expect(consecutiveSavingsRateDrops(mk([5000, 4000, 4000, 2000]), 4)).toBe(1);
		expect(consecutiveSavingsRateDrops(mk([5000, null, 3000, 2000]), 4)).toBe(1);
		expect(consecutiveSavingsRateDrops(mk([5000, 4000, 3000, 2000]), 2)).toBe(1);
		expect(consecutiveSavingsRateDrops(mk([1000, 2000, 3000]), 3)).toBe(0);
		expect(consecutiveSavingsRateDrops([], 12)).toBe(0);
	});
});

describe('computeWealthMetrics / buildInsights — consistência entre camadas', () => {
	const snapshot = (partial: Partial<WealthSnapshot> = {}): WealthSnapshot => ({
		month: 9,
		periodTotals: { incomeCents: 800_000, expenseCents: 600_000 },
		previousPeriodTotals: { incomeCents: 800_000, expenseCents: 700_000 },
		liquidCents: 1_500_000,
		recurring: [
			{ recurrenceType: 'monthly', amountCents: 200_000, isIncome: false, active: true },
			{ recurrenceType: 'yearly', amountCents: 120_000, isIncome: false, active: true },
			{ recurrenceType: 'weekly', amountCents: 10_000, isIncome: false, active: false },
			{ recurrenceType: 'monthly', amountCents: 800_000, isIncome: true, active: true },
		],
		expenseTotalsByNature: { essentialCents: 350_000, discretionaryCents: 250_000 },
		categoryTotals: [{ categoryId: 'food', totalCents: 350_000 }],
		previousCategoryTotals: [{ categoryId: 'food', totalCents: 200_000 }],
		monthlyIncome: [],
		monthlyExpense: [],
		categoryNameById: { food: 'Food' },
		...partial,
	});

	it('os números do read-model batem com as funções de métrica chamadas diretamente', () => {
		const snap = snapshot();
		const metrics = computeWealthMetrics(snap);

		expect(metrics.savingsRate.basisPoints).toBe(2_500);
		expect(metrics.previousSavingsRate?.basisPoints).toBe(1_250);
		expect(metrics.savingsRateDeltaBasisPoints).toBe(1_250);
		expect(metrics.monthlyFixedCents).toBe(200_000 + 10_000); // anual/12; a semanal está inativa
		expect(metrics.monthlyRecurringIncomeCents).toBe(800_000);
		expect(metrics.fixedCostBasisPoints).toBe(Math.round((210_000 * 10_000) / 800_000));
		expect(metrics.runwayMonths).toBeCloseTo(1_500_000 / 210_000, 12);
		expect(metrics.split.baseCents).toBe(800_000);
		expect(metrics.split.needsBasisPoints).toBe(4_375);
		expect(metrics.split.savingsBasisPoints).toBe(2_500);
		expect(metrics.categoryDeltas[0]).toMatchObject({
			categoryId: 'food',
			deltaCents: 150_000,
			pct: 0.75,
		});
	});

	it('sem renda nada é inventado: nenhum insight de taxa, custo fixo ou necessidades', () => {
		const metrics = computeWealthMetrics(
			snapshot({
				periodTotals: { incomeCents: 0, expenseCents: 50_000 },
				previousPeriodTotals: null,
				expenseTotalsByNature: { essentialCents: 50_000, discretionaryCents: 0 },
			})
		);
		const ids = buildInsights(metrics, snapshot()).map((i) => i.id);

		expect(ids).not.toContain('savings-rate-negative');
		expect(ids).not.toContain('savings-rate-low');
		expect(ids).not.toContain('savings-rate-healthy');
		expect(ids).not.toContain('fixed-cost-heavy');
		expect(ids).not.toContain('needs-over-target');
		expect(metrics.savingsRateDeltaBasisPoints).toBeNull();
	});

	it('mês no vermelho gera exatamente um insight crítico de poupança com o valor certo', () => {
		const metrics = computeWealthMetrics(
			snapshot({ periodTotals: { incomeCents: 100_000, expenseCents: 130_000 } })
		);
		const insights = buildInsights(metrics, snapshot());
		const negative = insights.filter((i) => i.id.startsWith('savings-rate'));

		expect(negative.map((i) => i.id)).toEqual(['savings-rate-negative']);
		expect(negative[0].valueCents).toBe(-30_000);
		expect(negative[0].severity).toBe('critical');
		expect(insights[0].severity).toBe('critical');
	});

	it('insights saem ordenados por severidade e cada id aparece no máximo uma vez', () => {
		const order = { critical: 0, attention: 1, positive: 2, neutral: 3 };
		const random = makeRandom(61);

		for (let i = 0; i < 500; i += 1) {
			const metrics = computeWealthMetrics(
				snapshot({
					periodTotals: {
						incomeCents: randomInt(random, 0, 1_000_000),
						expenseCents: randomInt(random, 0, 1_000_000),
					},
					liquidCents: randomInt(random, -100_000, 3_000_000),
					expenseTotalsByNature: {
						essentialCents: randomInt(random, 0, 500_000),
						discretionaryCents: randomInt(random, 0, 500_000),
					},
				})
			);
			const insights = buildInsights(metrics, snapshot());
			const ids = insights.map((x) => x.id);

			expect(new Set(ids).size).toBe(ids.length);
			for (let k = 1; k < insights.length; k += 1) {
				expect(order[insights[k - 1].severity]).toBeLessThanOrEqual(order[insights[k].severity]);
			}
		}
	});
});
