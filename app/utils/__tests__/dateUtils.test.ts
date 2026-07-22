import {
	addDays,
	addMonthsClamped,
	addYearsClamped,
	buildClampedDate,
	configureDateLocale,
	formatFullDate,
	getISODate,
	getMonthRange,
	lastDayOfMonth,
	parseISODate,
	todayISO,
} from '../dateUtils';

describe('parseISODate', () => {
	// Regression: `new Date('2026-07-22')` is midnight UTC, which is 21 July in UTC-3.
	// Every date in the app rendered one day early. These assertions hold in any
	// timezone precisely because parsing is now component-wise and local.
	it('parses a calendar date as local midnight', () => {
		const date = parseISODate('2026-07-22');
		expect(date.getFullYear()).toBe(2026);
		expect(date.getMonth()).toBe(6); // July, 0-indexed
		expect(date.getDate()).toBe(22);
		expect(date.getHours()).toBe(0);
	});

	it('round-trips through getISODate', () => {
		for (const iso of ['2026-01-01', '2026-07-22', '2026-12-31', '2024-02-29']) {
			expect(getISODate(parseISODate(iso))).toBe(iso);
		}
	});
});

describe('formatFullDate', () => {
	afterEach(() => configureDateLocale('en-US'));

	it('displays the stored calendar day, not the UTC one', () => {
		expect(formatFullDate('2026-07-22')).toBe('July 22, 2026');
	});

	it('follows the configured locale', () => {
		configureDateLocale('pt-BR');
		expect(formatFullDate('2026-07-22')).toContain('22');
		expect(formatFullDate('2026-07-22')).toContain('2026');
	});
});

describe('todayISO', () => {
	// Regression: `new Date().toISOString().split('T')[0]` returns tomorrow after
	// 21:00 in UTC-3, so recurring transactions were posted on the wrong day.
	it('agrees with the local calendar regardless of the time of day', () => {
		const now = new Date();
		const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
			now.getDate()
		).padStart(2, '0')}`;
		expect(todayISO()).toBe(expected);
	});
});

describe('lastDayOfMonth', () => {
	it.each([
		[2026, 1, 31],
		[2026, 2, 28],
		[2024, 2, 29], // leap year
		[2026, 4, 30],
		[2026, 12, 31],
	])('%i-%i has %i days', (year, month, expected) => {
		expect(lastDayOfMonth(year, month)).toBe(expected);
	});
});

describe('addMonthsClamped', () => {
	// Regression: `setDate(31)` in February overflows to 3 March, and stepping a
	// 31st-of-the-month bill forward from March landed on 1 May — skipping April
	// entirely. Clamping keeps the bill inside its month.
	it.each([
		['2026-01-31', 1, '2026-02-28'],
		['2024-01-31', 1, '2024-02-29'],
		['2026-03-31', 1, '2026-04-30'],
		['2026-01-15', 1, '2026-02-15'],
		['2026-12-31', 1, '2027-01-31'],
		['2026-01-31', 12, '2027-01-31'],
	])('%s + %i month(s) = %s', (from, months, expected) => {
		expect(addMonthsClamped(from, months)).toBe(expected);
	});

	it('steps backwards across a year boundary', () => {
		expect(addMonthsClamped('2026-01-15', -1)).toBe('2025-12-15');
		expect(addMonthsClamped('2026-03-31', -1)).toBe('2026-02-28');
	});

	it('never drifts when stepped repeatedly from a month end', () => {
		// A rent due on the 31st must appear in all twelve months.
		let current = '2026-01-31';
		const days: number[] = [];
		for (let i = 0; i < 12; i++) {
			current = addMonthsClamped(current, 1);
			days.push(parseISODate(current).getMonth() + 1);
		}
		expect(days).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 1]);
	});
});

describe('buildClampedDate', () => {
	it('clamps a day past the end of the month', () => {
		expect(buildClampedDate(2026, 2, 31)).toBe('2026-02-28');
		expect(buildClampedDate(2024, 2, 31)).toBe('2024-02-29');
		expect(buildClampedDate(2026, 4, 31)).toBe('2026-04-30');
	});

	it('passes valid days through', () => {
		expect(buildClampedDate(2026, 7, 22)).toBe('2026-07-22');
	});
});

describe('addDays', () => {
	it('crosses month and year boundaries', () => {
		expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
		expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
		expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
		expect(addDays('2026-07-22', 7)).toBe('2026-07-29');
	});
});

describe('addYearsClamped', () => {
	it('handles 29 February', () => {
		expect(addYearsClamped('2024-02-29', 1)).toBe('2025-02-28');
		expect(addYearsClamped('2024-02-29', 4)).toBe('2028-02-29');
	});
});

describe('getMonthRange', () => {
	it.each([
		[1, 2026, '2026-01-01', '2026-01-31'],
		[2, 2026, '2026-02-01', '2026-02-28'],
		[2, 2024, '2024-02-01', '2024-02-29'],
		[4, 2026, '2026-04-01', '2026-04-30'],
		[12, 2026, '2026-12-01', '2026-12-31'],
	])('month %i of %i spans %s..%s', (month, year, startDate, endDate) => {
		expect(getMonthRange(month, year)).toEqual({ startDate, endDate });
	});
});
