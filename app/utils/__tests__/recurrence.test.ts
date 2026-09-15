import { addDays } from '../dateUtils';
import {
	firstDueOnOrAfter,
	MAX_CATCH_UP_OCCURRENCES,
	monthlyEquivalentCents,
	nextCycleStart,
	nextDueAfter,
	nextDueAfterEdit,
	occurrenceId,
	occurrencesBetween,
	type RecurrenceRule,
	weekdayOf,
} from '../recurrence';

const monthly = (day: number): RecurrenceRule => ({ recurrenceType: 'monthly', day });
const yearly = (month: number, day: number): RecurrenceRule => ({
	recurrenceType: 'yearly',
	month,
	day,
});
const weekly = (weekday: number): RecurrenceRule => ({ recurrenceType: 'weekly', weekday });

describe('weekdayOf', () => {
	it('maps Monday to 1 and Sunday to 7', () => {
		expect(weekdayOf('2026-07-20')).toBe(1); // Monday
		expect(weekdayOf('2026-07-22')).toBe(3); // Wednesday
		expect(weekdayOf('2026-07-26')).toBe(7); // Sunday
	});
});

describe('firstDueOnOrAfter — monthly', () => {
	it('returns the same day when the due date is today', () => {
		expect(firstDueOnOrAfter(monthly(22), '2026-07-22')).toBe('2026-07-22');
	});

	it('rolls into next month once the day has passed', () => {
		expect(firstDueOnOrAfter(monthly(5), '2026-07-22')).toBe('2026-08-05');
	});

	// Regression: `setDate(31)` in February overflowed into March, so a bill due on the
	// 31st vanished from every short month.
	it.each([
		['2026-02-01', '2026-02-28'],
		['2024-02-01', '2024-02-29'],
		['2026-04-01', '2026-04-30'],
		['2026-06-15', '2026-06-30'],
	])('clamps day 31 inside the month starting %s', (from, expected) => {
		expect(firstDueOnOrAfter(monthly(31), from)).toBe(expected);
	});

	it('crosses the year boundary', () => {
		expect(firstDueOnOrAfter(monthly(5), '2026-12-10')).toBe('2027-01-05');
	});
});

describe('nextDueAfter — monthly', () => {
	// The crucial property: clamping must not be sticky. A rule for the 31st that was
	// clamped to 28 February has to return to 31 March, not stay near month start.
	it('returns to the preferred day after being clamped', () => {
		expect(nextDueAfter(monthly(31), '2026-02-28')).toBe('2026-03-31');
		expect(nextDueAfter(monthly(31), '2026-04-30')).toBe('2026-05-31');
	});

	it('produces exactly one occurrence per month for a full year', () => {
		const rule = monthly(31);
		const dates: string[] = [];
		let current = firstDueOnOrAfter(rule, '2026-01-01');

		for (let i = 0; i < 12; i++) {
			dates.push(current);
			current = nextDueAfter(rule, current);
		}

		expect(dates).toEqual([
			'2026-01-31',
			'2026-02-28',
			'2026-03-31',
			'2026-04-30',
			'2026-05-31',
			'2026-06-30',
			'2026-07-31',
			'2026-08-31',
			'2026-09-30',
			'2026-10-31',
			'2026-11-30',
			'2026-12-31',
		]);
	});
});

describe('firstDueOnOrAfter — yearly', () => {
	it('rolls to next year once the date has passed', () => {
		expect(firstDueOnOrAfter(yearly(3, 10), '2026-07-22')).toBe('2027-03-10');
	});

	it('returns this year when the date is still ahead', () => {
		expect(firstDueOnOrAfter(yearly(11, 5), '2026-07-22')).toBe('2026-11-05');
	});

	it('clamps 29 February in non-leap years', () => {
		expect(firstDueOnOrAfter(yearly(2, 29), '2026-01-01')).toBe('2026-02-28');
		expect(firstDueOnOrAfter(yearly(2, 29), '2024-01-01')).toBe('2024-02-29');
	});
});

describe('firstDueOnOrAfter — weekly', () => {
	it('returns today when today is the target weekday', () => {
		expect(firstDueOnOrAfter(weekly(3), '2026-07-22')).toBe('2026-07-22'); // Wednesday
	});

	it('advances to the next matching weekday', () => {
		expect(firstDueOnOrAfter(weekly(1), '2026-07-22')).toBe('2026-07-27'); // next Monday
		expect(firstDueOnOrAfter(weekly(7), '2026-07-22')).toBe('2026-07-26'); // Sunday
	});

	it('steps exactly seven days each time', () => {
		expect(nextDueAfter(weekly(3), '2026-07-22')).toBe('2026-07-29');
	});
});

describe('occurrencesBetween', () => {
	// Regression: the old engine advanced a due date once per app launch, so three
	// months away from the app posted one month of rent instead of three.
	it('enumerates every missed monthly occurrence after a long absence', () => {
		expect(occurrencesBetween(monthly(5), '2026-04-06', '2026-07-22')).toEqual([
			'2026-05-05',
			'2026-06-05',
			'2026-07-05',
		]);
	});

	it('includes an occurrence falling exactly on the end date', () => {
		expect(occurrencesBetween(monthly(22), '2026-07-01', '2026-07-22')).toEqual(['2026-07-22']);
	});

	it('returns nothing when the window contains no due date', () => {
		expect(occurrencesBetween(monthly(15), '2026-07-16', '2026-08-14')).toEqual([]);
	});

	it('returns nothing when the window is inverted', () => {
		expect(occurrencesBetween(monthly(15), '2026-08-01', '2026-07-01')).toEqual([]);
	});

	it('enumerates weekly occurrences', () => {
		expect(occurrencesBetween(weekly(3), '2026-07-01', '2026-07-31')).toEqual([
			'2026-07-01',
			'2026-07-08',
			'2026-07-15',
			'2026-07-22',
			'2026-07-29',
		]);
	});

	it('caps runaway windows instead of flooding the ledger', () => {
		const result = occurrencesBetween(weekly(1), '1990-01-01', '2090-01-01');
		expect(result).toHaveLength(MAX_CATCH_UP_OCCURRENCES);
	});
});

describe('monthlyEquivalentCents', () => {
	// Regression: the home screen summed weekly, monthly and yearly amounts raw,
	// producing a "monthly" figure with no financial meaning.
	it('annualises weekly amounts over 52 weeks, not 4 per month', () => {
		expect(monthlyEquivalentCents(weekly(1), 15000)).toBe(65000); // R$150/wk -> R$650/mo
	});

	it('spreads yearly amounts across twelve months', () => {
		expect(monthlyEquivalentCents(yearly(1, 1), 300000)).toBe(25000); // R$3000/yr -> R$250/mo
	});

	it('passes monthly amounts through unchanged', () => {
		expect(monthlyEquivalentCents(monthly(1), 150000)).toBe(150000);
	});
});

describe('occurrenceId', () => {
	const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

	// Regression: each device minted a random UUID when posting a due occurrence, so a
	// phone and a tablet both catching up on the same rent created two rows for it.
	it('gives the same id for the same rule and due date', () => {
		expect(occurrenceId('rule-1', '2026-07-05')).toBe(occurrenceId('rule-1', '2026-07-05'));
	});

	it('gives different ids for different due dates of one rule', () => {
		expect(occurrenceId('rule-1', '2026-07-05')).not.toBe(occurrenceId('rule-1', '2026-08-05'));
	});

	it('gives different ids for different rules on the same date', () => {
		expect(occurrenceId('rule-1', '2026-07-05')).not.toBe(occurrenceId('rule-2', '2026-07-05'));
	});

	// The separator must not let one field bleed into the next: ('ab', 'c') and
	// ('a', 'bc') are different occurrences and must not collide.
	it('does not confuse a shifted boundary between its two inputs', () => {
		expect(occurrenceId('ab', 'c')).not.toBe(occurrenceId('a', 'bc'));
	});

	it('is shaped like a UUID, so it is indistinguishable from a generated id', () => {
		expect(occurrenceId('rule-1', '2026-07-05')).toMatch(UUID_SHAPE);
		expect(occurrenceId('', '')).toMatch(UUID_SHAPE);
	});

	it('spreads a year of monthly occurrences over distinct ids', () => {
		const ids = occurrencesBetween(monthly(5), '2026-01-01', '2026-12-31').map((date) =>
			occurrenceId('rule-1', date)
		);

		expect(ids).toHaveLength(12);
		expect(new Set(ids).size).toBe(12);
	});
});

describe('nextCycleStart', () => {
	it('monthly: the first day of the following month', () => {
		expect(nextCycleStart(monthly(10), '2026-09-10')).toBe('2026-10-01');
		expect(nextCycleStart(monthly(31), '2026-01-31')).toBe('2026-02-01');
	});

	it('monthly: December rolls into January of the next year', () => {
		expect(nextCycleStart(monthly(10), '2026-12-10')).toBe('2027-01-01');
	});

	it('yearly: 1 January of the next year', () => {
		expect(nextCycleStart(yearly(3, 15), '2026-03-15')).toBe('2027-01-01');
		expect(nextCycleStart(yearly(12, 31), '2026-12-31')).toBe('2027-01-01');
	});

	it('weekly: the Monday after the week containing lastProcessed', () => {
		expect(nextCycleStart(weekly(3), '2026-07-22')).toBe('2026-07-27'); // Wednesday
		expect(nextCycleStart(weekly(1), '2026-07-20')).toBe('2026-07-27'); // Monday
		expect(nextCycleStart(weekly(7), '2026-07-26')).toBe('2026-07-27'); // Sunday
	});
});

describe('nextDueAfterEdit — a rule already charged this cycle only charges again next cycle', () => {
	const TODAY = '2026-09-14';

	// Regression (auditoria, rodada 2): a gym fee charged on the 10th and moved to the
	// 20th on the 14th used to post again on the 20th of the same month.
	it('moving the day later in a charged month does not charge that month twice', () => {
		expect(nextDueAfterEdit(monthly(20), '2026-09-10', TODAY)).toBe('2026-10-20');
	});

	it('moving the day earlier lands on the new day next month, skipping nothing', () => {
		expect(nextDueAfterEdit(monthly(5), '2026-09-25', '2026-09-26')).toBe('2026-10-05');
	});

	it('keeping the same day simply schedules next month', () => {
		expect(nextDueAfterEdit(monthly(10), '2026-09-10', TODAY)).toBe('2026-10-10');
	});

	it('crosses the year boundary from December into January', () => {
		expect(nextDueAfterEdit(monthly(20), '2026-12-10', '2026-12-14')).toBe('2027-01-20');
	});

	it('a rule that never ran starts at its first occurrence from today', () => {
		expect(nextDueAfterEdit(monthly(20), null, TODAY)).toBe('2026-09-20');
		expect(nextDueAfterEdit(monthly(10), undefined, TODAY)).toBe('2026-10-10');
	});

	it('yearly: charged this year and moved to another month, it waits for next year', () => {
		expect(nextDueAfterEdit(yearly(11, 1), '2026-03-15', TODAY)).toBe('2027-11-01');
	});

	it('weekly: charged this week and moved to a later weekday, it waits for next week', () => {
		// Charged Tuesday 2026-09-08, moved to Friday, edited on Wednesday 2026-09-09.
		expect(nextDueAfterEdit(weekly(5), '2026-09-08', '2026-09-09')).toBe('2026-09-18');
	});

	// Mirrors the posting window in `processRecurringTransactions`: resume from the day
	// after `lastProcessed`, but never before `nextDue`. Locks the two halves together.
	it('the posting window then yields nothing this cycle and exactly one next cycle', () => {
		const rule = monthly(20);
		const lastProcessed = '2026-09-10';
		const nextDue = nextDueAfterEdit(rule, lastProcessed, TODAY);
		const resumeFrom = addDays(lastProcessed, 1);
		const windowStart = nextDue > resumeFrom ? nextDue : resumeFrom;

		expect(occurrencesBetween(rule, windowStart, '2026-09-30')).toEqual([]);
		expect(occurrencesBetween(rule, windowStart, '2026-10-31')).toEqual(['2026-10-20']);
	});
});
