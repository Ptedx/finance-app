import {
	categoryDeltas,
	consecutiveSavingsRateDrops,
	fixedCostShare,
	monthlyBillsCents,
	monthlyFixedCommitmentsCents,
	needsWantsSavingsSplit,
	runwayMonths,
	savingsRate,
	savingsRateDelta,
	savingsRateTrend,
} from '../metrics';

describe('savingsRate', () => {
	it('divides what was kept by what came in', () => {
		const rate = savingsRate({ incomeCents: 5_000_00, expenseCents: 4_000_00 });

		expect(rate.netCents).toBe(1_000_00);
		expect(rate.ratio).toBeCloseTo(0.2);
		expect(rate.basisPoints).toBe(2_000);
	});

	// Sem renda a taxa não é ruim, ela não existe. Devolver 0% ou -100% afirmaria algo
	// que os dados não dizem, e é o que a UI acabaria exibindo como "poupou 0%".
	it('has no rate at all when nothing came in', () => {
		const rate = savingsRate({ incomeCents: 0, expenseCents: 800_00 });

		expect(rate.ratio).toBeNull();
		expect(rate.basisPoints).toBeNull();
		expect(rate.netCents).toBe(-800_00);
	});

	it('goes negative when the month closed in the red', () => {
		const rate = savingsRate({ incomeCents: 1_000_00, expenseCents: 1_500_00 });

		expect(rate.netCents).toBe(-500_00);
		expect(rate.basisPoints).toBe(-5_000);
	});

	it('is 100% when nothing was spent', () => {
		expect(savingsRate({ incomeCents: 3_000_00, expenseCents: 0 }).basisPoints).toBe(10_000);
	});

	// Pontos-base saem dos centavos inteiros, sem passar por um float intermediário.
	it('rounds to whole basis points', () => {
		expect(savingsRate({ incomeCents: 3_00, expenseCents: 2_00 }).basisPoints).toBe(3_333);
	});

	it('ignores values that are not numbers', () => {
		const rate = savingsRate({ incomeCents: Number.NaN, expenseCents: 100_00 });

		expect(rate.incomeCents).toBe(0);
		expect(rate.basisPoints).toBeNull();
	});
});

describe('savingsRateDelta', () => {
	it('reports the movement in basis points', () => {
		const current = savingsRate({ incomeCents: 1_000_00, expenseCents: 700_00 });
		const previous = savingsRate({ incomeCents: 1_000_00, expenseCents: 800_00 });

		expect(savingsRateDelta(current, previous)).toBe(1_000);
	});

	it('has no arrow to draw when either side has no rate', () => {
		const current = savingsRate({ incomeCents: 1_000_00, expenseCents: 700_00 });
		const empty = savingsRate({ incomeCents: 0, expenseCents: 0 });

		expect(savingsRateDelta(current, empty)).toBeNull();
		expect(savingsRateDelta(empty, current)).toBeNull();
	});
});

describe('runwayMonths', () => {
	it('divides the reserve by the monthly fixed cost', () => {
		expect(runwayMonths({ liquidCents: 12_000_00, monthlyFixedCents: 3_000_00 })).toBe(4);
	});

	// Dividir por zero daria Infinity, e "sua reserva dura infinitos meses" é uma
	// afirmação sobre a ausência de dados, não sobre a reserva.
	it('has no answer without a fixed cost', () => {
		expect(runwayMonths({ liquidCents: 12_000_00, monthlyFixedCents: 0 })).toBeNull();
	});

	it('gives no runway to someone in the red', () => {
		expect(runwayMonths({ liquidCents: -500_00, monthlyFixedCents: 3_000_00 })).toBe(0);
	});

	it('keeps the fractional part', () => {
		expect(runwayMonths({ liquidCents: 4_500_00, monthlyFixedCents: 3_000_00 })).toBeCloseTo(1.5);
	});
});

describe('fixedCostShare', () => {
	it('reports the committed share of income in basis points', () => {
		expect(fixedCostShare({ monthlyFixedCents: 2_000_00, incomeCents: 5_000_00 })).toBe(4_000);
	});

	it('has no share to report without income', () => {
		expect(fixedCostShare({ monthlyFixedCents: 2_000_00, incomeCents: 0 })).toBeNull();
	});
});

describe('E2E-24 — o custo fixo conta as contas a pagar', () => {
	const bill = (overrides: Partial<{ amountCents: number | null; active: boolean; debtId: string | null }> = {}) => ({
		amountCents: 120_00,
		active: true,
		debtId: null,
		...overrides,
	});

	it('conta a pagar de R$ 120 por mês contra R$ 8.000 de receita: 1,5%', () => {
		const monthlyFixedCents = monthlyFixedCommitmentsCents({ bills: [bill()], debtInstallmentsCents: 0 });
		expect(monthlyFixedCents).toBe(120_00);
		expect(fixedCostShare({ monthlyFixedCents, incomeCents: 8_000_00 })).toBe(150);
	});

	it('só as ativas, com valor; a de dívida entra pela parcela da dívida, não pela conta', () => {
		expect(monthlyBillsCents([bill(), bill({ active: false }), bill({ amountCents: null }), bill({ amountCents: 0 }), bill({ debtId: 'car', amountCents: 1_500_00 })])).toBe(120_00);
		expect(monthlyFixedCommitmentsCents({ bills: [bill(), bill({ debtId: 'car', amountCents: 1_500_00 })], debtInstallmentsCents: 1_497_72 })).toBe(120_00 + 1_497_72);
	});

	// SPD-122: as recorrências antigas saíram do custo fixo — nem somam, nem escondem mais a
	// conta a pagar de mesmo valor. O custo fixo é só contas + parcelas (ver também
	// `hooks/__tests__/wealthMetricsNoRecurring.test.tsx`, com as regras no contexto).
	it('duas contas de R$ 120 e R$ 300 e uma parcela de R$ 1.500: R$ 1.920', () => {
		expect(monthlyBillsCents([bill(), bill({ amountCents: 300_00 })])).toBe(420_00);
		expect(monthlyFixedCommitmentsCents({ bills: [bill(), bill({ amountCents: 300_00 })], debtInstallmentsCents: 1_500_00 })).toBe(1_920_00);
	});
});

describe('categoryDeltas', () => {
	it('ranks categories by how much the month moved', () => {
		const deltas = categoryDeltas(
			[
				{ categoryId: 'food', totalCents: 900_00 },
				{ categoryId: 'transport', totalCents: 300_00 },
			],
			[
				{ categoryId: 'food', totalCents: 600_00 },
				{ categoryId: 'transport', totalCents: 280_00 },
			]
		);

		expect(deltas[0]).toMatchObject({ categoryId: 'food', deltaCents: 300_00 });
		expect(deltas[0].pct).toBeCloseTo(0.5);
		expect(deltas[1]).toMatchObject({ categoryId: 'transport', deltaCents: 20_00 });
	});

	// Sair de nada para alguma coisa não é "aumento de X%", é uma categoria nova.
	it('has no percentage against an empty previous month', () => {
		const [delta] = categoryDeltas([{ categoryId: 'health', totalCents: 250_00 }], []);

		expect(delta).toMatchObject({ categoryId: 'health', previousCents: 0, deltaCents: 250_00 });
		expect(delta.pct).toBeNull();
	});

	it('covers categories that disappeared from the current month', () => {
		const deltas = categoryDeltas([], [{ categoryId: 'shopping', totalCents: 400_00 }]);

		expect(deltas).toHaveLength(1);
		expect(deltas[0]).toMatchObject({ currentCents: 0, deltaCents: -400_00 });
		expect(deltas[0].pct).toBeCloseTo(-1);
	});

	it('is empty when both months are', () => {
		expect(categoryDeltas([], [])).toEqual([]);
	});

	it('breaks ties by id so the order is stable', () => {
		const deltas = categoryDeltas(
			[
				{ categoryId: 'transport', totalCents: 100_00 },
				{ categoryId: 'food', totalCents: 100_00 },
			],
			[]
		);

		expect(deltas.map((entry) => entry.categoryId)).toEqual(['food', 'transport']);
	});
});

describe('needsWantsSavingsSplit', () => {
	it('splits the period into the three buckets', () => {
		const split = needsWantsSavingsSplit(
			{ essentialCents: 5_000_00, discretionaryCents: 3_000_00 },
			2_000_00
		);

		expect(split.baseCents).toBe(10_000_00);
		expect(split.needsBasisPoints).toBe(5_000);
		expect(split.wantsBasisPoints).toBe(3_000);
		expect(split.savingsBasisPoints).toBe(2_000);
	});

	// Enquanto ninguém classificou nada, tudo é "desejo" — leitura verdadeira de um app
	// sem a tag, não um erro. É esse o caminho de degradação da Fase 3.
	it('degrades to a single bucket while nothing is tagged', () => {
		const split = needsWantsSavingsSplit(
			{ essentialCents: 0, discretionaryCents: 8_000_00 },
			2_000_00
		);

		expect(split.needsBasisPoints).toBe(0);
		expect(split.wantsBasisPoints).toBe(8_000);
		expect(split.savingsBasisPoints).toBe(2_000);
	});

	// A barra empilhada da tela precisa fechar em 100% em todo mês, e não fecharia com
	// três arredondamentos independentes.
	it('always adds up to a hundred percent', () => {
		const split = needsWantsSavingsSplit(
			{ essentialCents: 1_00, discretionaryCents: 1_00 },
			1_00
		);

		expect(
			(split.needsBasisPoints ?? 0) + (split.wantsBasisPoints ?? 0) + (split.savingsBasisPoints ?? 0)
		).toBe(10_000);
	});

	it('has no shares when there is nothing to split', () => {
		const split = needsWantsSavingsSplit({ essentialCents: 0, discretionaryCents: 0 }, 0);

		expect(split.needsBasisPoints).toBeNull();
		expect(split.wantsBasisPoints).toBeNull();
		expect(split.savingsBasisPoints).toBeNull();
	});

	it('carries a negative result through as negative savings', () => {
		const split = needsWantsSavingsSplit(
			{ essentialCents: 800_00, discretionaryCents: 400_00 },
			-200_00
		);

		expect(split.baseCents).toBe(1_000_00);
		expect(split.savingsBasisPoints).toBe(-2_000);
	});
});

describe('savingsRateTrend', () => {
	it('always returns twelve months, zero-filled', () => {
		const trend = savingsRateTrend(
			[{ month: 3, totalCents: 1_000_00 }],
			[{ month: 3, totalCents: 400_00 }]
		);

		expect(trend).toHaveLength(12);
		expect(trend.map((entry) => entry.month)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
		expect(trend[2].rate.basisPoints).toBe(6_000);
		expect(trend[0].rate.basisPoints).toBeNull();
	});

	it('pairs each month with its own expenses, not with the next entry in the list', () => {
		const trend = savingsRateTrend(
			[
				{ month: 1, totalCents: 1_000_00 },
				{ month: 6, totalCents: 2_000_00 },
			],
			[{ month: 6, totalCents: 500_00 }]
		);

		expect(trend[0].rate.basisPoints).toBe(10_000);
		expect(trend[5].rate.basisPoints).toBe(7_500);
	});
});

describe('consecutiveSavingsRateDrops', () => {
	const trendOf = (rates: Array<[number, number]>) =>
		savingsRateTrend(
			rates.map(([income], index) => ({ month: index + 1, totalCents: income })),
			rates.map(([, expense], index) => ({ month: index + 1, totalCents: expense }))
		);

	it('counts a run of falling months', () => {
		const trend = trendOf([
			[1_000_00, 500_00], // 50%
			[1_000_00, 600_00], // 40%
			[1_000_00, 700_00], // 30%
			[1_000_00, 800_00], // 20%
		]);

		expect(consecutiveSavingsRateDrops(trend, 4)).toBe(3);
	});

	it('stops at the first month that did not fall', () => {
		const trend = trendOf([
			[1_000_00, 800_00], // 20%
			[1_000_00, 500_00], // 50%
			[1_000_00, 600_00], // 40%
		]);

		expect(consecutiveSavingsRateDrops(trend, 3)).toBe(1);
	});

	// Um mês sem renda não caiu nem subiu — não se sabe. Contá-lo como queda inventaria
	// uma tendência a partir de um buraco nos dados.
	it('breaks the run on a month with no income', () => {
		const trend = trendOf([
			[1_000_00, 500_00],
			[0, 0],
			[1_000_00, 900_00],
		]);

		expect(consecutiveSavingsRateDrops(trend, 3)).toBe(0);
	});

	it('is zero this early in the year', () => {
		expect(consecutiveSavingsRateDrops(trendOf([[1_000_00, 500_00]]), 1)).toBe(0);
	});
});
