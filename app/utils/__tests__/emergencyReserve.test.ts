import type { CategoryNature } from '../../database/schema';
import {
	buildReserveReadModel,
	contributionDelayMonths,
	essentialMonthlyCostCents,
	essentialShareBp,
	type ReserveInput,
	resolveMonthlyCost,
	splitSavings,
} from '../emergencyReserve';
import type { MonthPoint } from '../reportSeries';

const R = (reais: number) => reais * 100;

const natures = new Map<string, CategoryNature>([
	['moradia', 'essential'],
	['mercado', 'essential'],
	['lazer', 'discretionary'],
	['repasse', 'passthrough'],
]);

const point = (month: string, totalSpendCents: number, isCurrent = false): MonthPoint =>
	({ month, isCurrent, overview: { totalSpendCents } }) as unknown as MonthPoint;

const input = (overrides: Partial<ReserveInput> = {}): ReserveInput => ({
	accounts: [{ balanceCents: R(10_526.51), purpose: null }],
	targetMonths: 12,
	cost: { cents: R(4_000), source: 'history' },
	monthlyContributionCents: R(2_000),
	monthlyRate: 0,
	...overrides,
});

describe('fatia essencial', () => {
	it('essencial ÷ (essencial + discricionário), com o repasse fora', () => {
		const rows = [
			{ month: '2026-08', categoryId: 'moradia', totalCents: R(3_000) },
			{ month: '2026-08', categoryId: 'lazer', totalCents: R(1_000) },
			{ month: '2026-08', categoryId: 'repasse', totalCents: R(6_000) },
		];
		expect(essentialShareBp(rows, natures)).toBe(7_500);
	});

	it('categoria desconhecida conta como discricionária; sem gasto, nula', () => {
		expect(essentialShareBp([{ month: '2026-08', categoryId: 'nova', totalCents: R(100) }], natures)).toBe(0);
		expect(essentialShareBp([], natures)).toBeNull();
		expect(essentialShareBp([{ month: '2026-08', categoryId: 'repasse', totalCents: R(100) }], natures)).toBeNull();
	});
});

describe('custo essencial médio', () => {
	const rows = [
		{ month: '2026-06', categoryId: 'moradia', totalCents: R(3_000) },
		{ month: '2026-06', categoryId: 'lazer', totalCents: R(3_000) },
		{ month: '2026-07', categoryId: 'mercado', totalCents: R(4_000) },
		{ month: '2026-08', categoryId: 'moradia', totalCents: R(1_000) },
		{ month: '2026-08', categoryId: 'lazer', totalCents: R(1_000) },
		{ month: '2026-09', categoryId: 'moradia', totalCents: R(9_000) },
	];

	it('gasto do mês × fatia essencial, na média dos meses fechados', () => {
		const series = [point('2026-06', R(6_000)), point('2026-07', R(4_000)), point('2026-08', R(2_000)), point('2026-09', R(9_000), true)];
		// 3.000 + 4.000 + 1.000, em três meses; setembro (o de hoje) fica de fora.
		expect(essentialMonthlyCostCents(series, rows, natures)).toBe(Math.round(R(8_000) / 3));
	});

	it('um mês fechado vazio é de antes do app, não um mês sem custo', () => {
		const series = [point('2026-05', 0), point('2026-06', 0), point('2026-07', R(4_000)), point('2026-09', R(9_000), true)];
		expect(essentialMonthlyCostCents(series, rows, natures)).toBe(R(4_000));
	});

	it('sem mês fechado, nulo', () => {
		expect(essentialMonthlyCostCents([point('2026-09', R(9_000), true)], rows, natures)).toBeNull();
	});
});

describe('de onde vem o custo', () => {
	it('à mão vence o histórico, que vence o orçamento', () => {
		expect(resolveMonthlyCost({ customCents: R(5_000), historyCents: R(4_000), budgetCents: R(6_000), currentShareBp: 5_000 })).toEqual({
			cents: R(5_000),
			source: 'custom',
		});
		expect(resolveMonthlyCost({ customCents: null, historyCents: R(4_000), budgetCents: R(6_000), currentShareBp: 5_000 })).toEqual({
			cents: R(4_000),
			source: 'history',
		});
		expect(resolveMonthlyCost({ customCents: null, historyCents: null, budgetCents: R(6_000), currentShareBp: 5_000 })).toEqual({
			cents: R(3_000),
			source: 'budget',
		});
	});

	it('sem nenhum, nulo', () => {
		expect(resolveMonthlyCost({ customCents: null, historyCents: null, budgetCents: R(6_000), currentShareBp: null })).toBeNull();
		expect(resolveMonthlyCost({ customCents: null, historyCents: null, budgetCents: null, currentShareBp: 5_000 })).toBeNull();
	});
});

describe('a cascata', () => {
	it('abaixo da meta, tudo é reserva', () => {
		expect(splitSavings([{ balanceCents: R(10_000), purpose: null }], R(48_000))).toEqual({ poolCents: R(10_000), reserveCents: R(10_000), investmentCents: 0 });
	});

	it('acima da meta, o excedente vira capital', () => {
		expect(splitSavings([{ balanceCents: R(60_000), purpose: null }], R(48_000))).toEqual({
			poolCents: R(60_000),
			reserveCents: R(48_000),
			investmentCents: R(12_000),
		});
	});

	it('conta "só investimento" fica fora, mesmo com a reserva incompleta', () => {
		expect(
			splitSavings(
				[
					{ balanceCents: R(10_000), purpose: null },
					{ balanceCents: R(5_000), purpose: 'investment' },
				],
				R(48_000)
			)
		).toEqual({ poolCents: R(10_000), reserveCents: R(10_000), investmentCents: R(5_000) });
	});

	it('sem meta, tudo é capital, como antes da reserva existir', () => {
		expect(splitSavings([{ balanceCents: R(10_000), purpose: null }], null)).toEqual({ poolCents: R(10_000), reserveCents: 0, investmentCents: R(10_000) });
	});

	it('saldo negativo não vira reserva negativa', () => {
		expect(splitSavings([{ balanceCents: -R(100), purpose: null }], R(1_000)).reserveCents).toBe(0);
	});
});

describe('o quadro da reserva', () => {
	it('o caso do usuário: R$ 10.526,51 contra 12 meses de R$ 4.000', () => {
		const model = buildReserveReadModel(input());
		expect(model).toMatchObject({
			// Abaixo de três meses (R$ 12.000): ainda fina.
			status: 'thin',
			targetCents: R(48_000),
			monthsCovered: 2.6,
			gapCents: R(48_000) - R(10_526.51),
			minimumGapCents: R(12_000) - R(10_526.51),
		});
		expect(model.split.investmentCents).toBe(0);
		// 37.473,49 a R$ 2.000 por mês, sem rendimento: 19 meses.
		expect(model.monthsToFill).toBe(19);
	});

	it('fina abaixo de três meses; construindo acima; cheia na meta', () => {
		expect(buildReserveReadModel(input({ accounts: [{ balanceCents: R(20_000), purpose: null }] })).status).toBe('building');
		expect(buildReserveReadModel(input({ accounts: [{ balanceCents: R(8_000), purpose: null }] }))).toMatchObject({
			status: 'thin',
			minimumGapCents: R(4_000),
		});
		expect(buildReserveReadModel(input({ accounts: [{ balanceCents: R(50_000), purpose: null }] }))).toMatchObject({
			status: 'ready',
			progressBp: 10_000,
			gapCents: 0,
			monthsToFill: 0,
		});
	});

	it('sem aporte nem rendimento, não enche', () => {
		expect(buildReserveReadModel(input({ monthlyContributionCents: 0 })).monthsToFill).toBeNull();
	});

	it('o rendimento ajuda a encher', () => {
		const withoutYield = buildReserveReadModel(input()).monthsToFill ?? 0;
		const withYield = buildReserveReadModel(input({ monthlyRate: 0.01 })).monthsToFill ?? 0;
		expect(withYield).toBeLessThan(withoutYield);
	});

	it('sem custo, desconhecida — e todo o guardado segue capital', () => {
		const model = buildReserveReadModel(input({ cost: null }));
		expect(model).toMatchObject({ status: 'unknown', targetCents: null, monthsToFill: null });
		expect(model.split.investmentCents).toBe(R(10_526.51));
	});
});

describe('quando o aporte vem para a aposentadoria', () => {
	it('depois de a reserva encher; já, com ela cheia ou sem meta', () => {
		expect(contributionDelayMonths(buildReserveReadModel(input()))).toBe(19);
		expect(contributionDelayMonths(buildReserveReadModel(input({ accounts: [{ balanceCents: R(50_000), purpose: null }] })))).toBe(0);
		expect(contributionDelayMonths(buildReserveReadModel(input({ cost: null })))).toBe(0);
	});

	it('nunca, se a reserva não enche no ritmo de hoje', () => {
		expect(contributionDelayMonths(buildReserveReadModel(input({ monthlyContributionCents: 0 })))).toBeNull();
	});
});
