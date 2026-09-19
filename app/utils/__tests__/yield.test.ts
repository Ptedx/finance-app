import { accruedYieldCents, cdiDailyRate, parseBcbCdi } from '../yield';

const R = (reais: number) => Math.round(reais * 100);
const base = { anchorCents: R(10_000), anchorDate: '2026-09-11', flows: [], cdiAnnualBp: 1_490, percentOfCdiBp: 12_000 };

describe('taxa diária do CDI', () => {
	it('120% do CDI é 1,2 vez a taxa diária base 252', () => {
		const cdiDaily = (1.149) ** (1 / 252) - 1;
		expect(cdiDailyRate(1_490, 12_000)).toBeCloseTo(1.2 * cdiDaily, 12);
		expect(cdiDailyRate(1_490, 10_000)).toBeCloseTo(cdiDaily, 12);
	});

	it('sem CDI ou sem percentual, não rende', () => {
		expect(cdiDailyRate(0, 12_000)).toBe(0);
		expect(cdiDailyRate(1_490, 0)).toBe(0);
	});
});

describe('rendimento acumulado', () => {
	it('rende só nos dias úteis antes de hoje', () => {
		// Âncora sexta 11/09; seg 14, ter 15 e qua 16 são úteis; hoje é qui 17.
		const daily = cdiDailyRate(1_490, 12_000);
		const expected = R(10_000) * ((1 + daily) ** 3 - 1);
		expect(accruedYieldCents({ ...base, today: '2026-09-17' })).toBe(Math.round(expected));
		// O fim de semana não rende: de sábado para segunda nada muda.
		expect(accruedYieldCents({ ...base, today: '2026-09-13' })).toBe(0);
	});

	it('um aporte rende a partir do dia útil seguinte', () => {
		const withDeposit = accruedYieldCents({ ...base, flows: [{ date: '2026-09-15', cents: R(4_020) }], today: '2026-09-17' });
		const without = accruedYieldCents({ ...base, today: '2026-09-17' });
		const daily = cdiDailyRate(1_490, 12_000);
		// O aporte de terça rende só na quarta.
		expect(withDeposit - without).toBeCloseTo(R(4_020) * daily, -1);
	});

	it('um ano útil a 120% de um CDI de 14,9% rende cerca de 18,1%', () => {
		const year = accruedYieldCents({ ...base, anchorDate: '2025-12-31', today: '2027-01-01' });
		expect(year / R(10_000)).toBeGreaterThan(0.17);
		expect(year / R(10_000)).toBeLessThan(0.19);
	});

	it('movimentos até a âncora já estão nela; saldo negativo não rende; hoje na âncora é zero', () => {
		expect(accruedYieldCents({ ...base, flows: [{ date: '2026-09-11', cents: R(99_999) }], today: '2026-09-17' })).toBe(accruedYieldCents({ ...base, today: '2026-09-17' }));
		expect(accruedYieldCents({ ...base, anchorCents: -R(100), today: '2026-09-17' })).toBe(0);
		expect(accruedYieldCents({ ...base, today: '2026-09-11' })).toBe(0);
	});
});

describe('resposta do Banco Central', () => {
	it('lê a taxa e a data', () => {
		expect(parseBcbCdi([{ data: '17/09/2026', valor: '14.90' }])).toEqual({ annualBp: 1_490, date: '2026-09-17' });
	});

	it('recusa formato estranho ou taxa implausível', () => {
		expect(parseBcbCdi([])).toBeNull();
		expect(parseBcbCdi({ data: '17/09/2026' })).toBeNull();
		expect(parseBcbCdi([{ data: '2026-09-17', valor: '14.90' }])).toBeNull();
		expect(parseBcbCdi([{ data: '17/09/2026', valor: '0' }])).toBeNull();
		expect(parseBcbCdi([{ data: '17/09/2026', valor: 'abc' }])).toBeNull();
	});
});
