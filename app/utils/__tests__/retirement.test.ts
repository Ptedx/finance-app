import {
	averageContributionCents,
	buildRetirementReadModel,
	contributionForHorizon,
	futureValueCents,
	MAX_HORIZON_MONTHS,
	monthlyRate,
	monthsToReach,
	monthsToReachStepped,
	passiveIncomeCents,
	progressBp,
	projectCapital,
	projectCapitalStepped,
	realizedYieldBp,
	requiredCapitalCents,
	requiredMonthlyCents,
	type RetirementInput,
} from '../retirement';

const R = (reais: number) => reais * 100;

const input = (overrides: Partial<RetirementInput> = {}): RetirementInput => ({
	goal: { targetMonthlyCents: R(10_000), reinvestBp: 2_500, expectedYieldBp: 1_000, outsideCapitalCents: 0 },
	trackedCapitalCents: 0,
	monthlyContributionCents: 0,
	realizedYield12mCents: null,
	averageCapital12mCents: null,
	asOfMonth: '2026-09',
	...overrides,
});

describe('a regra do usuário: renda desejada + 25%, a 10% ao ano', () => {
	it('R$ 10.000 líquidos pedem R$ 12.500 brutos e R$ 1.500.000 de capital', () => {
		expect(requiredMonthlyCents(R(10_000), 2_500)).toBe(R(12_500));
		expect(requiredCapitalCents(R(12_500), 1_000)).toBe(R(1_500_000));
	});

	it('a 8% seriam R$ 1.875.000; sem margem, R$ 10.000 mesmo', () => {
		expect(requiredCapitalCents(R(12_500), 800)).toBe(R(1_875_000));
		expect(requiredMonthlyCents(R(10_000), 0)).toBe(R(10_000));
	});

	it('o capital necessário gera exatamente a renda bruta', () => {
		expect(passiveIncomeCents(R(1_500_000), 1_000)).toBe(R(12_500));
	});

	it('rendimento zero não tem capital que resolva', () => {
		expect(requiredCapitalCents(R(12_500), 0)).toBeNull();
		expect(monthlyRate(0)).toBe(0);
	});

	it('arredonda uma vez, nos centavos', () => {
		expect(requiredMonthlyCents(1_001, 2_500)).toBe(1_251);
		expect(passiveIncomeCents(-5, 1_000)).toBe(0);
	});
});

describe('progresso', () => {
	it('é capital sobre o necessário, sem passar de 100%', () => {
		expect(progressBp(R(150_000), R(1_500_000))).toBe(1_000);
		expect(progressBp(R(2_000_000), R(1_500_000))).toBe(10_000);
		expect(progressBp(-1, R(1_500_000))).toBe(0);
	});

	it('não existe sem capital necessário', () => {
		expect(progressBp(R(100), null)).toBeNull();
	});
});

describe('meses até a meta', () => {
	const rate = monthlyRate(1_000);

	it('já chegou: zero', () => {
		expect(monthsToReach({ capitalCents: R(1_500_000), contributionCents: 0, monthlyRate: rate, requiredCapitalCents: R(1_500_000) })).toBe(0);
	});

	it('sem rendimento é linear, arredondando para cima', () => {
		expect(monthsToReach({ capitalCents: R(100), contributionCents: R(300), monthlyRate: 0, requiredCapitalCents: R(1_000) })).toBe(3);
	});

	it('sem aporte e sem rendimento não chega nunca', () => {
		expect(monthsToReach({ capitalCents: R(100), contributionCents: 0, monthlyRate: 0, requiredCapitalCents: R(1_000) })).toBeNull();
		expect(monthsToReach({ capitalCents: 0, contributionCents: 0, monthlyRate: rate, requiredCapitalCents: R(1_000) })).toBeNull();
	});

	it('o capital sozinho chega, só demora', () => {
		// R$ 100.000 a 10% a.a. dobram em uns 7 anos.
		const months = monthsToReach({ capitalCents: R(100_000), contributionCents: 0, monthlyRate: rate, requiredCapitalCents: R(200_000) });
		expect(months).not.toBeNull();
		expect(months as number).toBeGreaterThan(80);
		expect(months as number).toBeLessThan(90);
	});

	it('além de 100 anos é nunca', () => {
		expect(monthsToReach({ capitalCents: 0, contributionCents: 1, monthlyRate: 0, requiredCapitalCents: R(1_000) })).toBeNull();
	});

	it('é o menor n em que o valor futuro alcança a meta (bate com a força bruta)', () => {
		const cases = [
			{ capitalCents: 0, contributionCents: R(3_000), requiredCapitalCents: R(1_500_000) },
			{ capitalCents: R(50_000), contributionCents: R(1_000), requiredCapitalCents: R(300_000) },
			{ capitalCents: R(999), contributionCents: R(1), requiredCapitalCents: R(1_000) },
			{ capitalCents: R(10_000), contributionCents: R(500), requiredCapitalCents: R(12_000) },
		];
		for (const c of cases) {
			const months = monthsToReach({ ...c, monthlyRate: rate }) as number;
			let brute = 0;
			while (futureValueCents(c.capitalCents, c.contributionCents, rate, brute) < c.requiredCapitalCents) brute += 1;
			expect(months).toBe(brute);
		}
	});
});

describe('aporte por horizonte', () => {
	const rate = monthlyRate(1_000);

	it('é o inverso de meses até a meta', () => {
		const required = R(1_500_000);
		for (const months of [60, 120, 180, 240]) {
			const monthly = contributionForHorizon({ capitalCents: R(20_000), requiredCapitalCents: required, monthlyRate: rate, months }) as number;
			expect(monthly).toBeGreaterThan(0);
			const reached = monthsToReach({ capitalCents: R(20_000), contributionCents: monthly, monthlyRate: rate, requiredCapitalCents: required });
			expect(reached).toBeLessThanOrEqual(months);
			expect(reached).toBeGreaterThanOrEqual(months - 1);
		}
	});

	it('já chegou: zero; sem prazo: nulo', () => {
		expect(contributionForHorizon({ capitalCents: R(2), requiredCapitalCents: R(1), monthlyRate: rate, months: 12 })).toBe(0);
		expect(contributionForHorizon({ capitalCents: 0, requiredCapitalCents: R(1), monthlyRate: rate, months: 0 })).toBeNull();
		expect(contributionForHorizon({ capitalCents: 0, requiredCapitalCents: null, monthlyRate: rate, months: 12 })).toBeNull();
	});

	it('sem rendimento é a diferença dividida pelos meses', () => {
		expect(contributionForHorizon({ capitalCents: R(100), requiredCapitalCents: R(1_300), monthlyRate: 0, months: 12 })).toBe(R(100));
	});
});

describe('projeção', () => {
	const rate = monthlyRate(1_000);

	it('começa no capital de hoje e termina no mês pedido', () => {
		const points = projectCapital({ capitalCents: R(1_000), contributionCents: R(100), monthlyRate: rate, months: 36 });
		expect(points[0]).toMatchObject({ monthOffset: 0, contributedCents: R(1_000), totalCents: R(1_000), interestCents: 0 });
		expect(points[points.length - 1].monthOffset).toBe(36);
	});

	it('juros é sempre total menos o que saiu do bolso, e cresce', () => {
		const points = projectCapital({ capitalCents: R(1_000), contributionCents: R(100), monthlyRate: rate, months: 120 });
		for (const point of points) expect(point.interestCents).toBe(point.totalCents - point.contributedCents);
		expect(points[points.length - 1].interestCents).toBeGreaterThan(0);
	});

	it('cabe em 121 pontos mesmo para 100 anos', () => {
		expect(projectCapital({ capitalCents: 0, contributionCents: R(1), monthlyRate: rate, months: MAX_HORIZON_MONTHS }).length).toBeLessThanOrEqual(121);
	});

	it('aporte negativo projeta como zero', () => {
		const points = projectCapital({ capitalCents: R(1_000), contributionCents: -R(50), monthlyRate: 0, months: 12 });
		expect(points[points.length - 1].totalCents).toBe(R(1_000));
	});
});

describe('médias', () => {
	it('aporte médio dos últimos k meses, ou zero sem histórico', () => {
		expect(averageContributionCents([R(100), R(200), R(300)], 2)).toBe(R(250));
		expect(averageContributionCents([R(100)], 6)).toBe(R(100));
		expect(averageContributionCents([], 6)).toBe(0);
	});

	it('rendimento observado só com capital médio', () => {
		expect(realizedYieldBp(R(1_000), R(10_000))).toBe(1_000);
		expect(realizedYieldBp(R(1_000), null)).toBeNull();
		expect(realizedYieldBp(null, R(10_000))).toBeNull();
		expect(realizedYieldBp(R(1_000), 0)).toBeNull();
	});
});

describe('o quadro inteiro', () => {
	it('o caso do usuário: R$ 20.000 guardados, R$ 3.000 por mês', () => {
		const model = buildRetirementReadModel(input({ trackedCapitalCents: R(20_000), monthlyContributionCents: R(3_000) }));
		expect(model).toMatchObject({
			targetMonthlyCents: R(10_000),
			requiredMonthlyCents: R(12_500),
			requiredCapitalCents: R(1_500_000),
			capitalCents: R(20_000),
			passiveIncomeNowCents: Math.round(R(20_000) * monthlyRate(1_000)),
			progressBp: 133,
			realizedYieldBp: null,
		});
		expect(model.reach.kind).toBe('eta');
		if (model.reach.kind === 'eta') {
			expect(model.reach.months).toBeGreaterThan(180);
			expect(model.reach.months).toBeLessThan(210);
			expect(model.reach.month).toMatch(/^\d{4}-\d{2}$/);
			expect(model.reach.years).toBeCloseTo(model.reach.months / 12, 0);
			expect(model.projection[model.projection.length - 1].monthOffset).toBe(model.reach.months);
		}
		expect(model.contributionByHorizon.map((h) => h.years)).toEqual([5, 10, 15, 20]);
		for (const horizon of model.contributionByHorizon) expect(horizon.monthlyCents).toBeGreaterThan(0);
	});

	it('capital fora do app soma ao das reservas', () => {
		const model = buildRetirementReadModel(
			input({ trackedCapitalCents: R(20_000), goal: { ...input().goal, outsideCapitalCents: R(80_000) } })
		);
		expect(model.capitalCents).toBe(R(100_000));
	});

	it('rendimento zero: nunca, por falta de rendimento', () => {
		const model = buildRetirementReadModel(input({ goal: { ...input().goal, expectedYieldBp: 0 }, trackedCapitalCents: R(1_000) }));
		expect(model.requiredCapitalCents).toBeNull();
		expect(model.reach).toEqual({ kind: 'never', reason: 'no-yield' });
		expect(model.passiveIncomeNowCents).toBe(0);
		expect(model.contributionByHorizon.every((h) => h.monthlyCents === null)).toBe(true);
	});

	it('sem aporte e sem capital: nunca, por falta de aporte', () => {
		expect(buildRetirementReadModel(input()).reach).toEqual({ kind: 'never', reason: 'no-contribution' });
	});

	it('já chegou', () => {
		const model = buildRetirementReadModel(input({ trackedCapitalCents: R(1_600_000) }));
		expect(model.reach).toEqual({ kind: 'reached' });
		expect(model.progressBp).toBe(10_000);
		expect(model.contributionByHorizon.every((h) => h.monthlyCents === 0)).toBe(true);
		expect(model.projection).toHaveLength(1);
	});

	it('rendimento observado entra quando há histórico', () => {
		const model = buildRetirementReadModel(input({ realizedYield12mCents: R(900), averageCapital12mCents: R(10_000) }));
		expect(model.realizedYieldBp).toBe(900);
	});
});

describe('aporte em degraus: a parcela vira aporte quando a dívida quita', () => {
	const rate = monthlyRate(1_000);

	it('sem degraus, bate com a projeção e a conta de hoje', () => {
		const flat = projectCapital({ capitalCents: R(20_000), contributionCents: R(3_000), monthlyRate: rate, months: 120 });
		const stepped = projectCapitalStepped({ capitalCents: R(20_000), contributionCents: R(3_000), monthlyRate: rate, months: 120, steps: [] });
		expect(stepped.map((p) => p.monthOffset)).toEqual(flat.map((p) => p.monthOffset));
		stepped.forEach((point, index) => expect(Math.abs(point.totalCents - flat[index].totalCents)).toBeLessThanOrEqual(1));
		const required = R(1_500_000);
		expect(monthsToReachStepped({ capitalCents: R(20_000), contributionCents: R(3_000), monthlyRate: rate, steps: [], requiredCapitalCents: required })).toBe(
			monthsToReach({ capitalCents: R(20_000), contributionCents: R(3_000), monthlyRate: rate, requiredCapitalCents: required })
		);
	});

	it('o degrau só vale a partir do mês dele', () => {
		const points = projectCapitalStepped({ capitalCents: 0, contributionCents: R(100), monthlyRate: 0, months: 4, steps: [{ fromMonth: 3, addCents: R(50) }] });
		expect(points.map((p) => p.contributedCents)).toEqual([0, R(100), R(200), R(350), R(500)]);
	});

	it('com a parcela virando aporte, a meta chega antes', () => {
		const base = { capitalCents: R(20_000), contributionCents: R(3_000), monthlyRate: rate, requiredCapitalCents: R(1_500_000) };
		const without = monthsToReachStepped({ ...base, steps: [] }) as number;
		const withDebtFreed = monthsToReachStepped({ ...base, steps: [{ fromMonth: 36, addCents: R(1_500) }] }) as number;
		expect(withDebtFreed).toBeLessThan(without);
	});

	it('já chegou é zero; sem capital necessário é nulo', () => {
		expect(monthsToReachStepped({ capitalCents: R(10), contributionCents: 0, monthlyRate: rate, steps: [], requiredCapitalCents: R(5) })).toBe(0);
		expect(monthsToReachStepped({ capitalCents: 0, contributionCents: R(1), monthlyRate: rate, steps: [], requiredCapitalCents: null })).toBeNull();
	});
});
