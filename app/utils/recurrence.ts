/**
 * Recurrence scheduling for Spendr.
 *
 * Pure calendar arithmetic, deliberately free of database and React Native imports so
 * the rules can be tested directly. Two properties matter and were both broken before:
 *
 *  1. A series is always regenerated from `(year, month, preferredDay)`, never by
 *     stepping the previously clamped date. Stepping loses the intent: a bill due on
 *     the 31st, clamped to 28 February, must return to 31 March — not stay on the 28th.
 *
 *  2. Occurrences are enumerated over an interval rather than advanced once. If the app
 *     is not opened for three months, three months of rent are due — not one.
 */

import { addDays, buildClampedDate, parseISODate } from './dateUtils';

export type RecurrenceType = 'weekly' | 'monthly' | 'yearly';

export interface RecurrenceRule {
	recurrenceType: RecurrenceType;
	/** Day of month, 1-31. Clamped into short months rather than overflowing. */
	day?: number;
	/** Month, 1-12. Yearly rules only. */
	month?: number;
	/** 1 = Monday … 7 = Sunday. Weekly rules only. */
	weekday?: number;
}

/**
 * Ceiling on how many occurrences a single catch-up may generate, so a corrupt rule or
 * an absurd device clock cannot flood the ledger. Weekly over ten years is ~520.
 */
export const MAX_CATCH_UP_OCCURRENCES = 750;

const clamp = (value: number | undefined, min: number, max: number, fallback: number): number => {
	if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
	return Math.min(Math.max(Math.trunc(value), min), max);
};

/** Weekday of a calendar date in the app's convention: 1 = Monday … 7 = Sunday. */
export const weekdayOf = (dateString: string): number => {
	const jsWeekday = parseISODate(dateString).getDay(); // 0 = Sunday
	return jsWeekday === 0 ? 7 : jsWeekday;
};

/**
 * The first occurrence of `rule` falling on or after `fromDate`.
 * Both arguments and the result are `YYYY-MM-DD`, which compares correctly as a string.
 */
export const firstDueOnOrAfter = (rule: RecurrenceRule, fromDate: string): string => {
	switch (rule.recurrenceType) {
		case 'monthly': {
			const day = clamp(rule.day, 1, 31, 1);
			const from = parseISODate(fromDate);
			let year = from.getFullYear();
			let month = from.getMonth() + 1;

			let candidate = buildClampedDate(year, month, day);
			if (candidate < fromDate) {
				month += 1;
				if (month > 12) {
					month = 1;
					year += 1;
				}
				candidate = buildClampedDate(year, month, day);
			}
			return candidate;
		}

		case 'yearly': {
			const month = clamp(rule.month, 1, 12, 1);
			const day = clamp(rule.day, 1, 31, 1);
			const year = parseISODate(fromDate).getFullYear();

			const candidate = buildClampedDate(year, month, day);
			return candidate < fromDate ? buildClampedDate(year + 1, month, day) : candidate;
		}

		case 'weekly': {
			const target = clamp(rule.weekday, 1, 7, 1);
			const offset = (target - weekdayOf(fromDate) + 7) % 7;
			return addDays(fromDate, offset);
		}

		default:
			return fromDate;
	}
};

/** The first occurrence strictly after `afterDate`. */
export const nextDueAfter = (rule: RecurrenceRule, afterDate: string): string =>
	firstDueOnOrAfter(rule, addDays(afterDate, 1));

/**
 * Every occurrence in `[fromDate, toDate]`, oldest first.
 *
 * This is what makes catch-up correct: opening the app after a long absence posts one
 * transaction per missed due date, each carrying its own date, instead of collapsing
 * them into a single entry stamped today.
 */
export const occurrencesBetween = (
	rule: RecurrenceRule,
	fromDate: string,
	toDate: string
): string[] => {
	if (fromDate > toDate) return [];

	const occurrences: string[] = [];
	let current = firstDueOnOrAfter(rule, fromDate);

	while (current <= toDate && occurrences.length < MAX_CATCH_UP_OCCURRENCES) {
		occurrences.push(current);
		current = nextDueAfter(rule, current);
	}

	return occurrences;
};

/**
 * Describes a rule in terms of a monthly equivalent, so weekly, monthly and yearly
 * commitments can be summed into a meaningful "per month" figure.
 *
 * Summing them raw — as the home screen did — treats a R$ 3.000 annual insurance
 * premium as R$ 3.000 of monthly cost and a R$ 150 weekly expense as R$ 150.
 */
export const monthlyEquivalentCents = (rule: RecurrenceRule, amountCents: number): number => {
	switch (rule.recurrenceType) {
		case 'weekly':
			// 52 weeks a year, not 4 weeks a month: 4x undercounts by about 8%.
			return Math.round((amountCents * 52) / 12);
		case 'yearly':
			return Math.round(amountCents / 12);
		default:
			return amountCents;
	}
};

export default {
	weekdayOf,
	firstDueOnOrAfter,
	nextDueAfter,
	occurrencesBetween,
	monthlyEquivalentCents,
	MAX_CATCH_UP_OCCURRENCES,
};
