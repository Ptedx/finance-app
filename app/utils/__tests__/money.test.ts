import {
	centsToInputString,
	configureMoney,
	convertCents,
	formatCents,
	isValidAmountInput,
	isValidRate,
	majorUnitsToCents,
	parseAmountToCents,
	parseDecimalInput,
	sumCents,
} from '../money';

describe('parseAmountToCents', () => {
	describe('comma as decimal separator (pt-BR keyboards)', () => {
		// Regression: the old parser stripped the comma instead of converting it,
		// turning "1500,50" into 150050 — a 100x error on every amount typed.
		it.each([
			['1500,50', 150050],
			['0,99', 99],
			['1.500,00', 150000],
			['1.234.567,89', 123456789],
			['10,5', 1050],
		])('parses %s as %i cents', (input, expected) => {
			expect(parseAmountToCents(input)).toBe(expected);
		});
	});

	describe('dot as decimal separator (en-US keyboards)', () => {
		it.each([
			['1500.50', 150050],
			['0.99', 99],
			['1,500.00', 150000],
			['1,234,567.89', 123456789],
			['10.5', 1050],
		])('parses %s as %i cents', (input, expected) => {
			expect(parseAmountToCents(input)).toBe(expected);
		});
	});

	describe('separator disambiguation', () => {
		// A lone separator with exactly three trailing digits is grouping, not cents:
		// nobody types three decimal places for money.
		it.each([
			['1.500', 150000],
			['1,500', 150000],
			['1.234.567', 123456700],
			['1,234,567', 123456700],
		])('treats %s as a grouped integer', (input, expected) => {
			expect(parseAmountToCents(input)).toBe(expected);
		});

		it.each([
			['1.50', 150],
			['1,50', 150],
			['.50', 50],
			[',50', 50],
		])('treats %s as a decimal fraction', (input, expected) => {
			expect(parseAmountToCents(input)).toBe(expected);
		});
	});

	describe('rounding beyond two decimals', () => {
		it.each([
			['1234.567', 123457],
			['1234.564', 123456],
			['0.005', 1],
			['0.004', 0],
		])('rounds %s to %i cents', (input, expected) => {
			expect(parseAmountToCents(input)).toBe(expected);
		});
	});

	describe('invalid input', () => {
		// Returning null rather than 0 lets callers tell "invalid" from "zero";
		// the old parser collapsed both to 0.
		it.each([['', ' ', 'abc', '.', ',', '-', 'R$']])('rejects %s', (input) => {
			expect(parseAmountToCents(input)).toBeNull();
		});

		it('rejects amounts that would overflow the integer-cents representation', () => {
			expect(parseAmountToCents('999999999999999999')).toBeNull();
		});
	});

	it('strips currency symbols and whitespace', () => {
		expect(parseAmountToCents('R$ 1.234,56')).toBe(123456);
		expect(parseAmountToCents('  $1,234.56  ')).toBe(123456);
	});

	it('preserves a leading minus sign', () => {
		expect(parseAmountToCents('-1500,50')).toBe(-150050);
	});
});

describe('isValidAmountInput', () => {
	it('accepts positive amounts', () => {
		expect(isValidAmountInput('0,01')).toBe(true);
		expect(isValidAmountInput('1500,50')).toBe(true);
	});

	it('rejects zero, negatives and garbage', () => {
		expect(isValidAmountInput('0')).toBe(false);
		expect(isValidAmountInput('0,00')).toBe(false);
		expect(isValidAmountInput('-10')).toBe(false);
		expect(isValidAmountInput('abc')).toBe(false);
	});
});

describe('formatCents', () => {
	afterEach(() => {
		configureMoney({ locale: 'en-US', currencyCode: 'USD', currencySymbol: '$' });
	});

	it('formats Brazilian reais with pt-BR grouping', () => {
		configureMoney({ locale: 'pt-BR', currencyCode: 'BRL', currencySymbol: 'R$' });
		expect(formatCents(123450)).toBe('R$ 1.234,50');
	});

	// Regression: the old `.replace(/^\D+/, symbol)` consumed the minus sign along with
	// the currency symbol, so every negative balance rendered as positive.
	it('keeps the minus sign on negative amounts', () => {
		configureMoney({ locale: 'pt-BR', currencyCode: 'BRL', currencySymbol: 'R$' });
		expect(formatCents(-123450)).toBe('-R$ 1.234,50');

		configureMoney({ locale: 'en-US', currencyCode: 'USD', currencySymbol: '$' });
		expect(formatCents(-123450)).toBe('-$1,234.50');
	});

	it('substitutes the configured symbol for currencies Intl renders as a code', () => {
		configureMoney({ locale: 'pt-BR', currencyCode: 'BTC', currencySymbol: '₿' });
		expect(formatCents(123450)).toContain('₿');
		expect(formatCents(123450)).not.toContain('BTC');
	});

	it('falls back gracefully on an unsupported currency code', () => {
		configureMoney({ locale: 'pt-BR', currencyCode: 'NOTACURRENCY', currencySymbol: '¤' });
		expect(formatCents(-123450)).toBe('-¤1.234,50');
	});

	it('formats zero without a sign', () => {
		expect(formatCents(0)).toBe('$0.00');
	});
});

describe('centsToInputString', () => {
	afterEach(() => {
		configureMoney({ locale: 'en-US', currencyCode: 'USD', currencySymbol: '$' });
	});

	// Prefilled edit forms must round-trip: what we render has to parse back unchanged.
	it('round-trips through parseAmountToCents in pt-BR', () => {
		configureMoney({ locale: 'pt-BR', currencyCode: 'BRL', currencySymbol: 'R$' });
		for (const cents of [1, 99, 150050, 123456789]) {
			expect(parseAmountToCents(centsToInputString(cents))).toBe(cents);
		}
	});

	it('round-trips through parseAmountToCents in en-US', () => {
		for (const cents of [1, 99, 150050, 123456789]) {
			expect(parseAmountToCents(centsToInputString(cents))).toBe(cents);
		}
	});
});

describe('parseDecimalInput', () => {
	// Exchange rates need more precision than money, but the same separator handling:
	// a Brazilian keyboard produces "0,1852".
	it.each([
		['5.4321', 5.4321],
		['5,4321', 5.4321],
		['0,1852', 0.1852],
		['0.1852', 0.1852],
		['1', 1],
		['1.500', 1500], // grouped, same rule as amounts
	])('parses %s as %d', (input, expected) => {
		expect(parseDecimalInput(input)).toBeCloseTo(expected, 10);
	});

	it('rejects non-numeric input', () => {
		expect(parseDecimalInput('')).toBeNull();
		expect(parseDecimalInput('abc')).toBeNull();
	});
});

describe('isValidRate', () => {
	it('accepts positive finite rates', () => {
		expect(isValidRate(5.43)).toBe(true);
		expect(isValidRate(0.0001)).toBe(true);
	});

	it('rejects zero, negatives, null and absurd magnitudes', () => {
		expect(isValidRate(0)).toBe(false);
		expect(isValidRate(-1)).toBe(false);
		expect(isValidRate(null)).toBe(false);
		expect(isValidRate(Number.POSITIVE_INFINITY)).toBe(false);
		expect(isValidRate(1e12)).toBe(false);
	});
});

describe('convertCents', () => {
	it('rescales to whole cents', () => {
		expect(convertCents(10000, 5.43)).toBe(54300); // R$100 -> at 5.43 -> 543.00
		expect(convertCents(123456, 0.1852)).toBe(22864);
	});

	it('round-trips approximately through the inverse rate', () => {
		const original = 123456;
		const converted = convertCents(original, 5.43);
		expect(convertCents(converted, 1 / 5.43)).toBeCloseTo(original, -1);
	});

	it('always returns an integer', () => {
		for (const rate of [0.333333, 1.7, 5.4321]) {
			expect(Number.isInteger(convertCents(99999, rate))).toBe(true);
		}
	});
});

describe('integer cents arithmetic', () => {
	// The reason the whole module exists: 0.1 summed ten times as a float is
	// 0.9999999999999999, and `spent > budget` becomes a coin flip at the boundary.
	it('sums exactly where floating point does not', () => {
		expect(sumCents(Array(10).fill(10))).toBe(100);
		expect(sumCents(Array(3).fill(123456))).toBe(370368);
	});

	it('converts legacy float amounts without drift', () => {
		expect(majorUnitsToCents(1234.56)).toBe(123456);
		expect(majorUnitsToCents(0.1 + 0.2)).toBe(30);
	});
});
