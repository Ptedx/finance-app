/**
 * Money handling for Spendr.
 *
 * Every monetary value in the app is an integer number of cents. Floating point
 * reais/dollars are never stored, summed or compared — `0.1 + 0.2 !== 0.3` is not
 * a tolerable property for a ledger. Conversion to a decimal number happens only
 * at the formatting boundary, in `formatCents`.
 *
 * This module is intentionally free of React Native imports so it can be unit tested.
 */

/** An integer amount of cents. Negative means an outflow when a sign is meaningful. */
export type Cents = number;

/** Guards against overflow of the integer-cents representation. ~10 trillion units. */
const MAX_CENTS = 1e15;

let locale = 'en-US';
let currencyCode = 'USD';
let currencySymbol = '$';

export interface MoneyConfig {
	locale?: string;
	currencyCode?: string;
	currencySymbol?: string;
}

export const configureMoney = (config: MoneyConfig): void => {
	if (config.locale) locale = config.locale;
	if (config.currencyCode) currencyCode = config.currencyCode;
	if (config.currencySymbol) currencySymbol = config.currencySymbol;
};

export const getMoneyConfig = (): Required<MoneyConfig> => ({
	locale,
	currencyCode,
	currencySymbol,
});

/**
 * Decides which character in a numeric string is the decimal separator.
 *
 * The hard case is a single separator: `1.500` is 1500 to a Brazilian and 1.5 to an
 * American. We resolve it by shape rather than by locale, because the user may have a
 * keyboard that disagrees with their locale: a separator followed by exactly three
 * digits is a thousands separator, and a separator that repeats always is.
 * Nobody types three decimal places for money.
 */
const findDecimalSeparator = (cleaned: string): '.' | ',' | null => {
	const dotCount = (cleaned.match(/\./g) ?? []).length;
	const commaCount = (cleaned.match(/,/g) ?? []).length;

	if (dotCount === 0 && commaCount === 0) return null;

	// Both kinds present: the rightmost one is the decimal separator, the other groups.
	if (dotCount > 0 && commaCount > 0) {
		return cleaned.lastIndexOf('.') > cleaned.lastIndexOf(',') ? '.' : ',';
	}

	const separator = dotCount > 0 ? '.' : ',';
	const occurrences = dotCount > 0 ? dotCount : commaCount;

	// "1.234.567" — a repeated separator can only be grouping.
	if (occurrences > 1) return null;

	const firstIndex = cleaned.indexOf(separator);
	const head = cleaned.slice(0, firstIndex);
	const tail = cleaned.slice(firstIndex + 1);

	// "1.500" — three trailing digits is grouping, but only when the part before the
	// separator could itself be a leading group: one to three digits with no leading
	// zero. That keeps "1234.567" a decimal (a grouped form would be "1.234.567") and
	// keeps "0.004" a decimal, since no grouped number starts with a lone zero.
	if (/^\d{3}$/.test(tail) && /^[1-9]\d{0,2}$/.test(head)) return null;

	return separator;
};

interface NumericParts {
	isNegative: boolean;
	integerDigits: string;
	fractionDigits: string;
}

/** Splits free-form numeric input into sign, integer digits and fraction digits. */
const splitNumericInput = (input: string): NumericParts | null => {
	if (typeof input !== 'string') return null;

	const trimmed = input.trim();
	if (!trimmed) return null;

	const isNegative = trimmed.startsWith('-');
	const cleaned = trimmed.replace(/[^0-9.,]/g, '');

	if (!/\d/.test(cleaned)) return null;

	const separator = findDecimalSeparator(cleaned);

	if (separator === null) {
		return { isNegative, integerDigits: cleaned.replace(/[.,]/g, ''), fractionDigits: '' };
	}

	const splitAt = cleaned.lastIndexOf(separator);

	return {
		isNegative,
		integerDigits: cleaned.slice(0, splitAt).replace(/[.,]/g, ''),
		fractionDigits: cleaned.slice(splitAt + 1).replace(/[.,]/g, ''),
	};
};

/**
 * Parses user input into integer cents, accepting both `1.234,56` and `1,234.56`.
 *
 * Returns `null` for anything that is not a number, so callers can distinguish
 * "invalid" from "zero" — a distinction the old implementation lost by returning 0.
 */
export const parseAmountToCents = (input: string): Cents | null => {
	const parts = splitNumericInput(input);
	if (!parts) return null;

	const { isNegative, integerDigits, fractionDigits } = parts;
	if (integerDigits === '' && fractionDigits === '') return null;

	const whole = integerDigits === '' ? 0 : Number(integerDigits);
	if (!Number.isSafeInteger(whole)) return null;

	let cents = whole * 100;

	if (fractionDigits.length > 0) {
		cents += Number(fractionDigits.slice(0, 2).padEnd(2, '0'));
		// Round rather than truncate when the user typed more precision than money has.
		if (fractionDigits.length > 2 && Number(fractionDigits[2]) >= 5) cents += 1;
	}

	if (!Number.isSafeInteger(cents) || Math.abs(cents) > MAX_CENTS) return null;

	return isNegative ? -cents : cents;
};

/**
 * Parses a plain decimal that is not money — an exchange rate, for instance, which
 * needs more than two decimal places. Same separator handling as amounts, so a
 * Brazilian keyboard's `0,1852` works.
 */
export const parseDecimalInput = (input: string): number | null => {
	const parts = splitNumericInput(input);
	if (!parts) return null;

	const { isNegative, integerDigits, fractionDigits } = parts;
	if (integerDigits === '' && fractionDigits === '') return null;

	const value = Number(`${integerDigits || '0'}.${fractionDigits || '0'}`);
	if (!Number.isFinite(value)) return null;

	return isNegative ? -value : value;
};

/**
 * Rescales an amount by an exchange rate.
 *
 * Applied once across the whole ledger when the user switches currency — previously
 * switching currency only swapped the symbol, so R$ 100 silently became $ 100.
 */
export const convertCents = (cents: Cents, rate: number): Cents => Math.round(cents * rate);

/** An exchange rate has to be a positive, finite, non-absurd number. */
export const isValidRate = (rate: number | null): rate is number =>
	rate !== null && Number.isFinite(rate) && rate > 0 && rate < 1e9;

/** True when the input parses to a strictly positive amount, as transaction forms require. */
export const isValidAmountInput = (input: string): boolean => {
	const cents = parseAmountToCents(input);
	return cents !== null && cents > 0;
};

/**
 * Formats cents for display, preserving the minus sign.
 *
 * The previous implementation stripped the sign along with the currency symbol
 * (`/^\D+/` matches `-R$`), rendering every negative balance as positive. We rebuild
 * from `formatToParts` so only the currency part is ever substituted.
 */
/**
 * ICU emits non-breaking and narrow no-break spaces between symbol and digits, and
 * which one varies by ICU version. Normalising keeps rendering and assertions stable.
 */
const normaliseSpaces = (text: string): string => text.replace(/[  ]/g, ' ');

export const formatCents = (cents: Cents): string => {
	const value = (Number.isFinite(cents) ? cents : 0) / 100;

	try {
		const formatter = new Intl.NumberFormat(locale, {
			style: 'currency',
			currency: currencyCode,
			minimumFractionDigits: 2,
			maximumFractionDigits: 2,
		});

		return normaliseSpaces(
			formatter
				.formatToParts(value)
				.map((part) => (part.type === 'currency' ? currencySymbol : part.value))
				.join('')
		);
	} catch {
		// Unsupported currency code, or an Intl build without currency data.
		const digits = new Intl.NumberFormat(locale, {
			minimumFractionDigits: 2,
			maximumFractionDigits: 2,
		}).format(Math.abs(value));

		return normaliseSpaces(`${value < 0 ? '-' : ''}${currencySymbol}${digits}`);
	}
};

/**
 * Renders cents as a plain editable string for text inputs, using the active locale's
 * decimal separator so that what the user sees round-trips back through
 * `parseAmountToCents` unchanged.
 */
export const centsToInputString = (cents: Cents): string => {
	const value = (Number.isFinite(cents) ? cents : 0) / 100;
	return new Intl.NumberFormat(locale, {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
		useGrouping: false,
	}).format(value);
};

/**
 * The active locale's grouping and decimal characters.
 *
 * Read from Intl rather than hardcoded: the app follows the device locale, so the same
 * build shows `1.234,56` on a Brazilian phone and `1,234.56` on an American one.
 */
const localeSeparators = (): { group: string; decimal: string } => {
	try {
		const parts = new Intl.NumberFormat(locale).formatToParts(12345.6);
		return {
			group: parts.find((part) => part.type === 'group')?.value ?? ',',
			decimal: parts.find((part) => part.type === 'decimal')?.value ?? '.',
		};
	} catch {
		return { group: ',', decimal: '.' };
	}
};

/**
 * Formats what the user is typing into an amount field, as they type.
 *
 * Purely cosmetic: it groups thousands and nothing else. The digits keep the meaning
 * they had when typed — `15006` stays fifteen thousand and six, it does not become
 * 150,06 — and the result is still readable by `parseAmountToCents`, which remains the
 * only path from text to stored cents. Nothing about the database or the API changes.
 *
 * The fraction is left exactly as typed while the field has focus, so that a half-typed
 * `12,` or `12,5` is not rewritten under the user's cursor. `finaliseAmountInput`
 * squares it up on blur.
 */
export const formatAmountInput = (input: string): string => {
	if (typeof input !== 'string' || input === '') return '';

	const { group, decimal } = localeSeparators();

	// Drop the grouping we added on the previous keystroke, then split on the first
	// decimal separator — anything after it is fraction, however the user typed it.
	const ungrouped = input.split(group).join('');
	const [head, ...tail] = ungrouped.split(decimal);

	const integerDigits = (head ?? '').replace(/\D/g, '');
	const hasDecimal = tail.length > 0;
	const fractionDigits = hasDecimal ? tail.join('').replace(/\D/g, '').slice(0, 2) : '';

	if (integerDigits === '' && !hasDecimal) return '';

	let grouped: string;
	try {
		// BigInt keeps this exact for any length: Number would start rounding past 2^53,
		// and an amount field is exactly where a user pastes something absurd.
		grouped = new Intl.NumberFormat(locale, { useGrouping: true }).format(
			BigInt(integerDigits === '' ? '0' : integerDigits)
		);
	} catch {
		grouped = integerDigits === '' ? '0' : integerDigits;
	}

	return hasDecimal ? `${grouped}${decimal}${fractionDigits}` : grouped;
};

/**
 * Squares up an amount field when it loses focus: `12` becomes `12,00` and `12,5`
 * becomes `12,50`, so what is shown matches what was stored down to the cent.
 *
 * Empty input stays empty — an untouched field must not turn into `0,00`.
 */
export const finaliseAmountInput = (input: string): string => {
	const cents = parseAmountToCents(input);

	// Unparseable text is handed back untouched: silently blanking what someone typed
	// is worse than showing it as-is and letting the form's validation complain.
	if (cents === null) return input.trim() === '' ? '' : input;

	// `centsToInputString` renders the locale's decimal separator with exactly two
	// places and no grouping; `formatAmountInput` then adds the grouping.
	return formatAmountInput(centsToInputString(cents));
};

/**
 * Cents como texto agrupado e editável: o que um campo de valor mostra quando já vem
 * preenchido, na edição de um lançamento.
 *
 * `centsToInputString` sozinho devolve `15006,00`; aqui o resultado é `15.006,00`, que
 * é o que o usuário espera ver — e continua sendo lido de volta por `parseAmountToCents`
 * no mesmo valor.
 */
export const centsToDisplayInput = (cents: Cents): string =>
	formatAmountInput(centsToInputString(cents));

/** Sums cents. Trivial by construction — which is the whole point of integer cents. */
export const sumCents = (values: Cents[]): Cents => values.reduce((total, v) => total + v, 0);

/**
 * Converts a legacy floating point major-unit amount (e.g. 1234.56) to cents.
 * Used by the schema migration and by importers reading older backups.
 */
export const majorUnitsToCents = (amount: number): Cents => {
	if (!Number.isFinite(amount)) return 0;
	return Math.round(amount * 100);
};

/** Converts cents back to major units. For export formats that expect decimals. */
export const centsToMajorUnits = (cents: Cents): number => cents / 100;

export default {
	configureMoney,
	getMoneyConfig,
	parseAmountToCents,
	parseDecimalInput,
	isValidAmountInput,
	convertCents,
	isValidRate,
	formatCents,
	centsToInputString,
	centsToDisplayInput,
	formatAmountInput,
	finaliseAmountInput,
	sumCents,
	majorUnitsToCents,
	centsToMajorUnits,
};
