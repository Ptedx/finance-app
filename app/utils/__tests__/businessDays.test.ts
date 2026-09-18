import { bankHolidays, easterSunday, isBusinessDay, nextBusinessDay } from '../businessDays';

describe('easterSunday', () => {
	it.each([
		[2024, '2024-03-31'],
		[2025, '2025-04-20'],
		[2026, '2026-04-05'],
		[2027, '2027-03-28'],
		[2038, '2038-04-25'],
	])('%i', (year, date) => {
		expect(easterSunday(year)).toBe(date);
	});
});

describe('bankHolidays', () => {
	it('2026: fixos, Carnaval, Sexta-feira Santa, Corpus Christi e Consciência Negra', () => {
		const days = bankHolidays(2026);
		for (const day of ['2026-01-01', '2026-02-16', '2026-02-17', '2026-04-03', '2026-04-21', '2026-05-01', '2026-06-04', '2026-09-07', '2026-10-12', '2026-11-02', '2026-11-15', '2026-11-20', '2026-12-25']) {
			expect(days.has(day)).toBe(true);
		}
		expect(days.size).toBe(13);
	});

	it('20 de novembro só é feriado nacional a partir de 2024', () => {
		expect(bankHolidays(2023).has('2023-11-20')).toBe(false);
		expect(bankHolidays(2024).has('2024-11-20')).toBe(true);
	});
});

describe('nextBusinessDay', () => {
	it('dia útil fica onde está', () => {
		expect(nextBusinessDay('2026-09-25')).toBe('2026-09-25');
	});

	it('fim de semana vai para segunda', () => {
		expect(nextBusinessDay('2026-10-25')).toBe('2026-10-26');
		expect(nextBusinessDay('2026-10-24')).toBe('2026-10-26');
	});

	it('feriado emendado em fim de semana pula tudo', () => {
		expect(nextBusinessDay('2026-12-25')).toBe('2026-12-28');
		expect(nextBusinessDay('2026-02-14')).toBe('2026-02-18');
		expect(nextBusinessDay('2026-11-20')).toBe('2026-11-23');
	});

	it('isBusinessDay recusa sábado, domingo e feriado', () => {
		expect(isBusinessDay('2026-09-26')).toBe(false);
		expect(isBusinessDay('2026-09-27')).toBe(false);
		expect(isBusinessDay('2026-09-07')).toBe(false);
		expect(isBusinessDay('2026-09-08')).toBe(true);
	});
});
