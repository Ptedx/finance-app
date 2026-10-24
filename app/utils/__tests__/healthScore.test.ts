import { buildHealthIndicators, HEALTH_THRESHOLDS, type HealthInput, healthSummary, spendingPaceWindows } from '../healthScore';

const R = (reais: number) => reais * 100;

/** Um mês anterior com lançamentos, com o que se gastou nele até o mesmo dia. */
const sameDay = (reais: number) => ({ toDateCents: R(reais), hasData: true });

const input = (overrides: Partial<HealthInput> = {}): HealthInput => ({
	savingsRateBp: 2_500,
	neededSavingsRateBp: 2_000,
	liquidCents: R(30_000),
	averageMonthlySpendCents: R(5_000),
	fixedCostBp: 3_000,
	cardOwedCents: R(1_000),
	averageMonthlyIncomeCents: R(14_000),
	limitUsagePercent: 20,
	currentSpendCents: R(2_500),
	elapsedBp: 5_000,
	previousSpendToDate: [sameDay(2_500), sameDay(2_500), sameDay(2_500)],
	...overrides,
});

const byId = (overrides: Partial<HealthInput> = {}) => Object.fromEntries(buildHealthIndicators(input(overrides)).map((item) => [item.id, item]));

describe('a grade', () => {
	it('sempre tem os cinco indicadores, na mesma ordem', () => {
		expect(buildHealthIndicators(input()).map((item) => item.id)).toEqual([
			'savings-rate',
			'emergency-reserve',
			'fixed-cost',
			'card-load',
			'spending-trend',
		]);
	});

	it('um mês saudável é todo bom', () => {
		expect(healthSummary(buildHealthIndicators(input()))).toEqual({ good: 5, warn: 0, bad: 0, unknown: 0 });
	});
});

describe('taxa de poupança', () => {
	it('20% é bom, 10% é atenção, abaixo é ruim, sem renda é sem dados', () => {
		expect(byId({ savingsRateBp: 2_000 })['savings-rate'].status).toBe('good');
		expect(byId({ savingsRateBp: 1_000 })['savings-rate'].status).toBe('warn');
		expect(byId({ savingsRateBp: 999 })['savings-rate'].status).toBe('bad');
		expect(byId({ savingsRateBp: -500 })['savings-rate'].status).toBe('bad');
		expect(byId({ savingsRateBp: null })['savings-rate']).toMatchObject({ status: 'unknown', value: null });
	});

	it('carrega o que a meta pede', () => {
		expect(byId({ neededSavingsRateBp: 3_250 })['savings-rate']).toMatchObject({ neededBp: 3_250, params: { needed: '33%' } });
		expect(byId({ neededSavingsRateBp: null })['savings-rate'].params.needed).toBe('—');
	});
});

describe('reserva de emergência', () => {
	it('caixa mais guardado sobre o gasto médio, em meses com uma casa', () => {
		expect(byId({ liquidCents: R(30_000), averageMonthlySpendCents: R(5_000) })['emergency-reserve']).toMatchObject({
			status: 'good',
			value: 6,
			unit: 'months',
			params: { months: '6.0', target: 6 },
		});
		expect(byId({ liquidCents: R(17_500), averageMonthlySpendCents: R(5_000) })['emergency-reserve']).toMatchObject({ status: 'warn', value: 3.5 });
		expect(byId({ liquidCents: R(1_000), averageMonthlySpendCents: R(5_000) })['emergency-reserve']).toMatchObject({ status: 'bad', value: 0.2 });
	});

	it('caixa negativo é zero meses; sem gasto médio é sem dados', () => {
		expect(byId({ liquidCents: -R(100) })['emergency-reserve'].value).toBe(0);
		expect(byId({ averageMonthlySpendCents: null })['emergency-reserve'].status).toBe('unknown');
		expect(byId({ averageMonthlySpendCents: 0 })['emergency-reserve'].status).toBe('unknown');
	});
});

describe('custo fixo', () => {
	it('até 40% bom, até 50% atenção, acima ruim', () => {
		expect(byId({ fixedCostBp: 4_000 })['fixed-cost'].status).toBe('good');
		expect(byId({ fixedCostBp: 5_000 })['fixed-cost'].status).toBe('warn');
		expect(byId({ fixedCostBp: 5_001 })['fixed-cost'].status).toBe('bad');
		expect(byId({ fixedCostBp: null })['fixed-cost'].status).toBe('unknown');
	});
});

describe('peso do cartão', () => {
	it('faturas sobre a renda média', () => {
		expect(byId({ cardOwedCents: R(4_200), averageMonthlyIncomeCents: R(14_000) })['card-load']).toMatchObject({ status: 'good', value: 3_000 });
		expect(byId({ cardOwedCents: R(7_000), averageMonthlyIncomeCents: R(14_000) })['card-load']).toMatchObject({ status: 'warn', value: 5_000 });
		expect(byId({ cardOwedCents: R(8_000), averageMonthlyIncomeCents: R(14_000) })['card-load'].status).toBe('bad');
	});

	it('limite quase todo usado rebaixa de bom para atenção', () => {
		expect(byId({ limitUsagePercent: HEALTH_THRESHOLDS.cardLoad.limitWarnPercent })['card-load']).toMatchObject({
			status: 'warn',
			params: { limitPercent: '80%' },
		});
		// Já ruim continua ruim: o limite não piora o que já está no chão.
		expect(byId({ cardOwedCents: R(10_000), limitUsagePercent: 95 })['card-load'].status).toBe('bad');
	});

	it('sem renda média é sem dados', () => {
		expect(byId({ averageMonthlyIncomeCents: null })['card-load'].status).toBe('unknown');
	});
});

describe('ritmo de gastos', () => {
	it('compara com o que os meses anteriores gastaram até o mesmo dia', () => {
		const history = { previousSpendToDate: [sameDay(2_500), sameDay(2_500), sameDay(2_500)] };
		// O mesmo que nos meses anteriores até aqui: em dia.
		expect(byId({ ...history, currentSpendCents: R(2_500) })['spending-trend']).toMatchObject({ status: 'good', value: 0, params: { percent: '0%' } });
		// 10% acima do mesmo ponto dos meses anteriores.
		expect(byId({ ...history, currentSpendCents: R(2_750) })['spending-trend']).toMatchObject({ status: 'warn', value: 1_000, params: { percent: '+10%' } });
		expect(byId({ ...history, currentSpendCents: R(4_000) })['spending-trend'].status).toBe('bad');
		// Gastar menos é bom, com sinal.
		expect(byId({ ...history, currentSpendCents: R(2_000) })['spending-trend'].params.percent).toBe('-20%');
	});

	it('CALC-09: no dia 10, com fatura, envelope e contas no começo do mês, o ritmo de sempre é ritmo normal', () => {
		/*
		 * Média dos meses fechados: R$ 6.000 = cartão 3.000 (fecha dia 25) + envelope 1.000 +
		 * Pix 2.000. Em 10/10 a fatura de outubro já tem 1.600, o envelope custa o combinado
		 * inteiro desde o dia 1 (1.000) e o Pix vai em 645: 3.245. A projeção linear esperava
		 * 6.000 × 32% = 1.935 e acusava +68%. Nos meses anteriores, até o dia 10, era o mesmo.
		 */
		const toDay10 = 160_000 + 100_000 + 64_516;
		const trend = byId({
			averageMonthlySpendCents: 600_000,
			currentSpendCents: toDay10,
			elapsedBp: Math.round((10 * 10_000) / 31),
			previousSpendToDate: [
				{ toDateCents: toDay10, hasData: true },
				{ toDateCents: toDay10, hasData: true },
				{ toDateCents: toDay10, hasData: true },
			],
		})['spending-trend'];
		expect({ status: trend.status, value: trend.value }).toEqual({ status: 'good', value: 0 });
	});

	it('a base é a média dos até 3 meses mais recentes que têm lançamentos', () => {
		// Os três primeiros (o mais recente primeiro): média 3.000. O quarto não entra.
		const three = byId({ currentSpendCents: R(3_300), previousSpendToDate: [sameDay(3_000), sameDay(2_000), sameDay(4_000), sameDay(10_000)] });
		expect(three['spending-trend']).toMatchObject({ status: 'warn', value: 1_000 });
		// Mês sem lançamento nenhum (antes de começar a usar o app) não é mês de gasto zero.
		const gap = byId({ currentSpendCents: R(2_500), previousSpendToDate: [sameDay(3_000), { toDateCents: 0, hasData: false }, sameDay(2_000)] });
		expect(gap['spending-trend']).toMatchObject({ status: 'good', value: 0 });
	});

	it('um mês só de histórico já serve de base', () => {
		expect(byId({ currentSpendCents: R(2_200), previousSpendToDate: [sameDay(2_000)] })['spending-trend']).toMatchObject({ status: 'warn', value: 1_000 });
	});

	it('sem histórico é sem dados', () => {
		for (const previousSpendToDate of [[], [{ toDateCents: R(2_000), hasData: false }], null, undefined]) {
			expect(byId({ previousSpendToDate })['spending-trend']).toMatchObject({ status: 'unknown', value: null, params: { percent: '—' } });
		}
	});

	it('a média do mês inteiro não é a base: só o mesmo ponto conta', () => {
		// Média mensal de 5.000 e metade do mês passada: a projeção diria "em dia". Até o mesmo
		// dia, porém, os meses anteriores tinham gastado 2.000, e o mês está 25% acima.
		expect(byId({ averageMonthlySpendCents: R(5_000), currentSpendCents: R(2_500), previousSpendToDate: [sameDay(2_000)] })['spending-trend'].value).toBe(2_500);
	});

	it('meses anteriores sem gasto nenhum até o mesmo dia não dão base', () => {
		expect(byId({ currentSpendCents: R(500), previousSpendToDate: [sameDay(0), sameDay(0)] })['spending-trend'].status).toBe('unknown');
	});

	it('cedo demais no mês é sem dados', () => {
		expect(byId({ elapsedBp: 1_000 })['spending-trend'].status).toBe('unknown');
	});
});

describe('ritmo de gastos: até que dia cada mês conta', () => {
	it('no mês em andamento, o mesmo dia de hoje nos três meses anteriores', () => {
		expect(spendingPaceWindows('2026-10', '2026-10-10')).toEqual({
			current: { month: '2026-10', startDate: '2026-10-01', cutoffDate: '2026-10-10' },
			previous: [
				{ month: '2026-09', startDate: '2026-09-01', cutoffDate: '2026-09-10' },
				{ month: '2026-08', startDate: '2026-08-01', cutoffDate: '2026-08-10' },
				{ month: '2026-07', startDate: '2026-07-01', cutoffDate: '2026-07-10' },
			],
		});
	});

	it('começo de mês: o dia 1 contra o dia 1', () => {
		const windows = spendingPaceWindows('2026-10', '2026-10-01');
		expect(windows?.current.cutoffDate).toBe('2026-10-01');
		expect(windows?.previous.map((window) => window.cutoffDate)).toEqual(['2026-09-01', '2026-08-01', '2026-07-01']);
	});

	it('dia 31 contra fevereiro: o mês mais curto vai até o último dia dele', () => {
		expect(spendingPaceWindows('2026-03', '2026-03-31')?.previous.map((window) => window.cutoffDate)).toEqual(['2026-02-28', '2026-01-31', '2025-12-31']);
		// Ano bissexto: fevereiro tem 29.
		expect(spendingPaceWindows('2028-03', '2028-03-30')?.previous.map((window) => window.cutoffDate)).toEqual(['2028-02-29', '2028-01-30', '2027-12-30']);
		// Dia 31 de maio contra abril, de 30 dias.
		expect(spendingPaceWindows('2026-05', '2026-05-31')?.previous[0].cutoffDate).toBe('2026-04-30');
	});

	it('virada de ano: janeiro olha para dezembro, novembro e outubro do ano anterior', () => {
		expect(spendingPaceWindows('2027-01', '2027-01-15')?.previous).toEqual([
			{ month: '2026-12', startDate: '2026-12-01', cutoffDate: '2026-12-15' },
			{ month: '2026-11', startDate: '2026-11-01', cutoffDate: '2026-11-15' },
			{ month: '2026-10', startDate: '2026-10-01', cutoffDate: '2026-10-15' },
		]);
	});

	it('mês já fechado compara meses inteiros', () => {
		expect(spendingPaceWindows('2026-03', '2026-10-24')).toEqual({
			current: { month: '2026-03', startDate: '2026-03-01', cutoffDate: '2026-03-31' },
			previous: [
				{ month: '2026-02', startDate: '2026-02-01', cutoffDate: '2026-02-28' },
				{ month: '2026-01', startDate: '2026-01-01', cutoffDate: '2026-01-31' },
				{ month: '2025-12', startDate: '2025-12-01', cutoffDate: '2025-12-31' },
			],
		});
	});

	it('mês que ainda não começou não tem ritmo', () => {
		expect(spendingPaceWindows('2026-11', '2026-10-24')).toBeNull();
	});
});

describe('reserva pelo custo essencial', () => {
	it('reserva da cascata ÷ custo essencial, contra a meta de meses', () => {
		const reserve = (reais: number) => ({ reserve: { reserveCents: R(reais), monthlyCostCents: R(4_000), targetMonths: 12 } });
		expect(byId(reserve(48_000))['emergency-reserve']).toMatchObject({ status: 'good', value: 12, target: 12, variant: 'essential' });
		expect(byId(reserve(12_000))['emergency-reserve']).toMatchObject({ status: 'warn', value: 3 });
		expect(byId(reserve(10_526.51))['emergency-reserve']).toMatchObject({ status: 'bad', value: 2.6 });
	});

	it('sem custo essencial, volta ao caixa + guardado ÷ gasto', () => {
		expect(byId({ reserve: null })['emergency-reserve']).toMatchObject({ status: 'good', value: 6 });
		expect(byId({ reserve: null })['emergency-reserve'].variant).toBeUndefined();
	});
});
