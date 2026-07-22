/**
 * Date handling for Spendr.
 *
 * Transactions are keyed by *calendar date* (`YYYY-MM-DD`), not by instant. That
 * distinction matters: `new Date('2026-07-22')` is parsed by JS as midnight **UTC**,
 * so in UTC-3 it renders as 21 July — every date in the app was displayed a day early.
 * Likewise `new Date().toISOString()` rolls over to tomorrow after 21:00 in Brazil.
 *
 * The rule in this file: calendar dates are parsed and produced component-by-component
 * in local time, and `toISOString()` is never used to derive one.
 */

let locale = 'en-US';

export const configureDateLocale = (nextLocale: string): void => {
	locale = nextLocale;
};

/** Parses a `YYYY-MM-DD` string as local midnight, not UTC midnight. */
export const parseISODate = (dateString: string): Date => {
	const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateString);

	if (!match) {
		// Fall back to the engine's parser for full timestamps or unexpected shapes.
		return new Date(dateString);
	}

	const [, year, month, day] = match;
	return new Date(Number(year), Number(month) - 1, Number(day));
};

/** Formats a Date as `YYYY-MM-DD` using its local calendar day. */
export const getISODate = (date: Date): string => {
	const year = date.getFullYear();
	const month = (date.getMonth() + 1).toString().padStart(2, '0');
	const day = date.getDate().toString().padStart(2, '0');

	return `${year}-${month}-${day}`;
};

/** Today's calendar date, local. The single source of "today" across the app. */
export const todayISO = (): string => getISODate(new Date());

export const formatDate = (dateString: string): string =>
	parseISODate(dateString).toLocaleDateString(locale, {
		month: 'short',
		day: 'numeric',
	});

export const formatFullDate = (dateString: string): string =>
	parseISODate(dateString).toLocaleDateString(locale, {
		year: 'numeric',
		month: 'long',
		day: 'numeric',
	});

/** Number of days in a month. `month` is 1-12. */
export const lastDayOfMonth = (year: number, month: number): number =>
	new Date(year, month, 0).getDate();

/**
 * Adds months to a calendar date, clamping the day to the end of the target month.
 *
 * Plain `setMonth` overflows: 31 January + 1 month lands on 3 March, and a bill due on
 * the 31st silently skips every 30-day month. `addMonthsClamped('2026-01-31', 1)`
 * returns `2026-02-28`.
 */
export const addMonthsClamped = (dateString: string, months: number): string => {
	const date = parseISODate(dateString);
	const targetMonthIndex = date.getMonth() + months;
	const targetYear = date.getFullYear() + Math.floor(targetMonthIndex / 12);
	const targetMonth = ((targetMonthIndex % 12) + 12) % 12; // 0-11, handles negatives

	const day = Math.min(date.getDate(), lastDayOfMonth(targetYear, targetMonth + 1));

	return getISODate(new Date(targetYear, targetMonth, day));
};

/**
 * Builds a calendar date from parts, clamping the day into the month.
 * `buildClampedDate(2026, 2, 31)` returns `2026-02-28`.
 */
export const buildClampedDate = (year: number, month: number, day: number): string => {
	const clampedDay = Math.min(Math.max(day, 1), lastDayOfMonth(year, month));
	return getISODate(new Date(year, month - 1, clampedDay));
};

export const addDays = (dateString: string, days: number): string => {
	const date = parseISODate(dateString);
	date.setDate(date.getDate() + days);
	return getISODate(date);
};

export const addYearsClamped = (dateString: string, years: number): string =>
	addMonthsClamped(dateString, years * 12);

export const getCurrentMonthRange = (): { startDate: string; endDate: string } => {
	const today = new Date();
	return getMonthRange(today.getMonth() + 1, today.getFullYear());
};

export const getMonthRange = (
	month: number,
	year: number
): { startDate: string; endDate: string } => ({
	startDate: getISODate(new Date(year, month - 1, 1)),
	endDate: getISODate(new Date(year, month, 0)),
});

export const getMonthName = (month: number): string =>
	new Date(2000, month - 1, 1).toLocaleString(locale, { month: 'long' });

export const getCurrentMonthName = (): string =>
	getMonthName(new Date().getMonth() + 1).toUpperCase();

export const getCurrentYear = (): number => new Date().getFullYear();

export default {
	configureDateLocale,
	parseISODate,
	getISODate,
	todayISO,
	formatDate,
	formatFullDate,
	lastDayOfMonth,
	addMonthsClamped,
	buildClampedDate,
	addDays,
	addYearsClamped,
	getCurrentMonthRange,
	getMonthRange,
	getMonthName,
	getCurrentMonthName,
	getCurrentYear,
};
