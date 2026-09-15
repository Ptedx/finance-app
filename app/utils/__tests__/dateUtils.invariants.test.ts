/**
 * Invariantes de calendário.
 *
 * Todo lançamento é chaveado por `YYYY-MM-DD` local. Estes testes varrem décadas de
 * datas para garantir que parse, formatação e aritmética nunca deslizam um dia —
 * inclusive nas viradas de mês, ano bissexto e ano. Devem passar em qualquer fuso
 * (a suíte é rodada com `TZ` variado).
 */

import {
	addDays,
	addMonthsClamped,
	addYearsClamped,
	buildClampedDate,
	getISODate,
	getMonthRange,
	lastDayOfMonth,
	parseISODate,
	todayISO,
} from '../dateUtils';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Todos os dias entre dois anos, inclusive, como `YYYY-MM-DD`. */
const everyDay = (fromYear: number, toYear: number): string[] => {
	const days: string[] = [];
	const cursor = new Date(fromYear, 0, 1);
	while (cursor.getFullYear() <= toYear) {
		days.push(getISODate(cursor));
		cursor.setDate(cursor.getDate() + 1);
	}
	return days;
};

const DAYS = everyDay(1990, 2060);

describe('parseISODate / getISODate', () => {
	it('é identidade para todos os dias de 1990 a 2060', () => {
		for (const day of DAYS) {
			// Em dias de virada de horário de verão a meia-noite local pode não existir (o
			// relógio pula para 01:00); o que importa é que o dia de calendário é o mesmo.
			expect(getISODate(parseISODate(day))).toBe(day);
		}
	});

	it('nunca desloca o dia mesmo quando o fuso é negativo (regressão A4/A5)', () => {
		// `new Date('2026-07-22')` é meia-noite UTC, que em UTC-3 é 21/07 às 21h.
		expect(getISODate(parseISODate('2026-07-22'))).toBe('2026-07-22');
		expect(parseISODate('2026-07-22').getDate()).toBe(22);
	});

	it('todayISO tem o formato certo e corresponde ao dia local', () => {
		const now = new Date();
		expect(todayISO()).toMatch(ISO);
		expect(todayISO()).toBe(getISODate(now));
	});
});

describe('addDays', () => {
	it('é sequencial: cada dia +1 é o próximo da lista', () => {
		for (let index = 0; index < DAYS.length - 1; index += 1) {
			expect(addDays(DAYS[index], 1)).toBe(DAYS[index + 1]);
		}
	});

	it('+n seguido de -n é identidade', () => {
		for (let index = 0; index < DAYS.length; index += 97) {
			for (const n of [1, 7, 28, 30, 31, 365, 366, 1000]) {
				expect(addDays(addDays(DAYS[index], n), -n)).toBe(DAYS[index]);
			}
		}
	});

	it('atravessa a virada de ano e o 29 de fevereiro', () => {
		expect(addDays('2023-12-31', 1)).toBe('2024-01-01');
		expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
		expect(addDays('2024-02-29', 1)).toBe('2024-03-01');
		expect(addDays('2023-02-28', 1)).toBe('2023-03-01');
		expect(addDays('2100-02-28', 1)).toBe('2100-03-01'); // 2100 não é bissexto
	});
});

describe('lastDayOfMonth / buildClampedDate', () => {
	it('conhece os meses de 28, 29, 30 e 31 dias', () => {
		expect(lastDayOfMonth(2026, 2)).toBe(28);
		expect(lastDayOfMonth(2024, 2)).toBe(29);
		expect(lastDayOfMonth(2000, 2)).toBe(29);
		expect(lastDayOfMonth(1900, 2)).toBe(28);
		expect(lastDayOfMonth(2100, 2)).toBe(28);
		expect(lastDayOfMonth(2026, 4)).toBe(30);
		expect(lastDayOfMonth(2026, 12)).toBe(31);
	});

	it('buildClampedDate nunca transborda para o mês seguinte', () => {
		for (let year = 1990; year <= 2060; year += 1) {
			for (let month = 1; month <= 12; month += 1) {
				for (let day = 1; day <= 31; day += 1) {
					const built = buildClampedDate(year, month, day);
					expect(built).toMatch(ISO);
					expect(built.slice(0, 7)).toBe(`${year}-${month.toString().padStart(2, '0')}`);
					expect(Number(built.slice(8))).toBe(Math.min(day, lastDayOfMonth(year, month)));
				}
			}
		}
	});

	it('buildClampedDate trata dia 0 e negativo como 1', () => {
		expect(buildClampedDate(2026, 3, 0)).toBe('2026-03-01');
		expect(buildClampedDate(2026, 3, -5)).toBe('2026-03-01');
	});
});

describe('addMonthsClamped', () => {
	it('mantém o dia quando cabe e fixa no último dia quando não cabe', () => {
		for (const day of DAYS) {
			for (const months of [1, 2, 6, 11, 12, 13, 24, -1, -12]) {
				const result = addMonthsClamped(day, months);
				const source = parseISODate(day);
				const target = parseISODate(result);

				const expectedIndex = source.getFullYear() * 12 + source.getMonth() + months;
				expect(target.getFullYear() * 12 + target.getMonth()).toBe(expectedIndex);
				expect(target.getDate()).toBe(
					Math.min(source.getDate(), lastDayOfMonth(target.getFullYear(), target.getMonth() + 1))
				);
			}
		}
	});

	it('31 de janeiro + 1 mês é 28/29 de fevereiro, nunca 3 de março', () => {
		expect(addMonthsClamped('2026-01-31', 1)).toBe('2026-02-28');
		expect(addMonthsClamped('2024-01-31', 1)).toBe('2024-02-29');
		expect(addMonthsClamped('2026-03-31', 1)).toBe('2026-04-30');
		expect(addMonthsClamped('2026-12-31', 2)).toBe('2027-02-28');
		expect(addMonthsClamped('2026-03-31', -1)).toBe('2026-02-28');
	});

	it('addYearsClamped: 29 de fevereiro + 1 ano é 28 de fevereiro', () => {
		expect(addYearsClamped('2024-02-29', 1)).toBe('2025-02-28');
		expect(addYearsClamped('2024-02-29', 4)).toBe('2028-02-29');
	});
});

describe('getMonthRange', () => {
	it('cobre o mês inteiro sem sobreposição nem lacuna entre meses consecutivos', () => {
		for (let year = 1990; year <= 2060; year += 1) {
			for (let month = 1; month <= 12; month += 1) {
				const { startDate, endDate } = getMonthRange(month, year);
				expect(startDate).toBe(`${year}-${month.toString().padStart(2, '0')}-01`);
				expect(endDate).toBe(buildClampedDate(year, month, 31));

				const next = month === 12 ? getMonthRange(1, year + 1) : getMonthRange(month + 1, year);
				expect(addDays(endDate, 1)).toBe(next.startDate);
			}
		}
	});

	it('as bordas do intervalo comparam corretamente como texto com qualquer dia do mês', () => {
		const { startDate, endDate } = getMonthRange(2, 2024);
		for (let day = 1; day <= 29; day += 1) {
			const date = buildClampedDate(2024, 2, day);
			expect(date >= startDate && date <= endDate).toBe(true);
		}
		expect('2024-01-31' >= startDate).toBe(false);
		expect('2024-03-01' <= endDate).toBe(false);
	});
});
