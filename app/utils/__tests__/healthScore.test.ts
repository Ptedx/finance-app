import { buildHealthIndicators, HEALTH_THRESHOLDS, type HealthInput, healthSummary } from '../healthScore';

const R = (reais: number) => reais * 100;

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
	it('compara com a média proporcional ao dia do mês', () => {
		// Metade do mês, metade da média: em dia.
		expect(byId({ currentSpendCents: R(2_500), elapsedBp: 5_000 })['spending-trend']).toMatchObject({ status: 'good', value: 0, params: { percent: '0%' } });
		// Metade do mês, 55% da média: +10%.
		expect(byId({ currentSpendCents: R(2_750), elapsedBp: 5_000 })['spending-trend']).toMatchObject({ status: 'warn', value: 1_000, params: { percent: '+10%' } });
		expect(byId({ currentSpendCents: R(4_000), elapsedBp: 5_000 })['spending-trend'].status).toBe('bad');
		// Gastar menos é bom, com sinal.
		expect(byId({ currentSpendCents: R(2_000), elapsedBp: 5_000 })['spending-trend'].params.percent).toBe('-20%');
	});

	it('mês fechado compara inteiro', () => {
		expect(byId({ currentSpendCents: R(5_000), elapsedBp: 10_000 })['spending-trend'].value).toBe(0);
	});

	it('cedo demais no mês, ou sem média, é sem dados', () => {
		expect(byId({ elapsedBp: 1_000 })['spending-trend'].status).toBe('unknown');
		expect(byId({ averageMonthlySpendCents: null })['spending-trend'].status).toBe('unknown');
	});
});
