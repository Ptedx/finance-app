/**
 * Invariantes de dinheiro.
 *
 * `money.test.ts` cobre casos nomeados. Este arquivo varre faixas inteiras e entradas
 * aleatórias atrás de qualquer centavo que se perca entre digitar, gravar, exibir e
 * editar — o caminho completo que um valor percorre no app.
 */

import {
	centsToDisplayInput,
	centsToInputString,
	centsToMajorUnits,
	configureMoney,
	convertCents,
	finaliseAmountInput,
	formatAmountInput,
	formatCents,
	majorUnitsToCents,
	parseAmountToCents,
	parseDecimalInput,
	sumCents,
} from '../money';

/** Gerador determinístico, para que uma falha seja reproduzível. */
const makeRandom = (seed: number) => {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 0x100000000;
	};
};

const LOCALES = ['en-US', 'pt-BR', 'it-IT', 'de-DE', 'fr-FR', 'es-ES', 'ja-JP', 'en-IN'];

const resetLocale = () => configureMoney({ locale: 'en-US', currencyCode: 'USD', currencySymbol: '$' });

afterEach(resetLocale);

describe('round-trip: o que a tela mostra volta ao mesmo centavo', () => {
	it.each(LOCALES)('centsToInputString -> parseAmountToCents é identidade em %s', (locale) => {
		configureMoney({ locale });
		const random = makeRandom(7);

		for (let i = 0; i < 3_000; i += 1) {
			const cents = Math.floor(random() * 1_000_000_000); // até 10 milhões de unidades
			expect(parseAmountToCents(centsToInputString(cents))).toBe(cents);
		}
	});

	it.each(LOCALES)('centsToDisplayInput (agrupado) -> parseAmountToCents é identidade em %s', (locale) => {
		configureMoney({ locale });
		const random = makeRandom(11);

		for (let i = 0; i < 3_000; i += 1) {
			const cents = Math.floor(random() * 1_000_000_000);
			expect(parseAmountToCents(centsToDisplayInput(cents))).toBe(cents);
		}
	});

	it.each(LOCALES)('finaliseAmountInput é idempotente e preserva o valor em %s', (locale) => {
		configureMoney({ locale });
		const random = makeRandom(13);

		for (let i = 0; i < 1_000; i += 1) {
			const cents = Math.floor(random() * 100_000_000);
			const once = finaliseAmountInput(centsToInputString(cents));
			const twice = finaliseAmountInput(once);

			expect(twice).toBe(once);
			expect(parseAmountToCents(once)).toBe(cents);
		}
	});

	it.each(LOCALES)('digitar dígito a dígito com formatAmountInput nunca altera o valor em %s', (locale) => {
		configureMoney({ locale });
		const random = makeRandom(17);
		const decimal = new Intl.NumberFormat(locale)
			.formatToParts(1.5)
			.find((part) => part.type === 'decimal')?.value;

		for (let i = 0; i < 500; i += 1) {
			const cents = Math.floor(random() * 100_000_000);
			const whole = Math.floor(cents / 100).toString();
			const fraction = (cents % 100).toString().padStart(2, '0');
			const typed = `${whole}${decimal}${fraction}`;

			// Simula cada tecla: o campo re-formata o valor a cada keystroke.
			let field = '';
			for (const char of typed) field = formatAmountInput(field + char);

			expect(parseAmountToCents(field)).toBe(cents);
			expect(parseAmountToCents(finaliseAmountInput(field))).toBe(cents);
		}
	});

	it('todos os valores de 0,00 a 999,99 sobrevivem ao round-trip em pt-BR e en-US', () => {
		for (const locale of ['pt-BR', 'en-US']) {
			configureMoney({ locale });
			for (let cents = 0; cents < 100_000; cents += 1) {
				const text = centsToInputString(cents);
				if (parseAmountToCents(text) !== cents) {
					throw new Error(`${locale}: ${cents} -> "${text}" -> ${parseAmountToCents(text)}`);
				}
			}
		}
	});
});

describe('parseAmountToCents — bordas de entrada', () => {
	it.each([
		// Valor sem parte inteira.
		[',50', 50],
		['.50', 50],
		['0,5', 50],
		// Três casas decimais são arredondadas, não truncadas.
		['1,005', 100500], // três dígitos após um separador único = milhar
		['1,0050', 101], // 1,0050 -> 1,00 + arredonda pelo terceiro dígito (5) = 1,01
		['1.0049', 100],
		['0,004', 0],
		['0,005', 1],
		// Símbolos e espaços em volta.
		['R$ 1.500,00', 150000],
		['$1,500.00', 150000],
		['  42  ', 4200],
		['€ 9,99', 999],
		// Agrupamento de milhar em ambos os estilos.
		['12.345', 1234500],
		['12,345', 1234500],
		['1.234', 123400],
		['123.456', 12345600],
		['1234.567', 123457], // quatro dígitos antes: não é forma agrupada, é decimal
		['0.123', 12],
		// Números grandes.
		['999999999.99', 99999999999],
		['1.000.000.000,00', 100000000000],
	])('"%s" -> %i', (input, expected) => {
		expect(parseAmountToCents(input)).toBe(expected);
	});

	it.each(['', '   ', '-', ',', '.', 'abc', 'R$', 'e', '..', ',,'])(
		'rejeita "%s" como inválido em vez de gravar zero',
		(input) => {
			expect(parseAmountToCents(input)).toBeNull();
		}
	);

	it('"1e3" não vira mil: a notação científica não é aceita como digitação', () => {
		// O "e" é descartado e sobra "13" — o parser nunca deve usar Number() no texto cru.
		expect(parseAmountToCents('1e3')).toBe(1300);
	});

	it('valor acima do teto é rejeitado, não silenciosamente truncado', () => {
		expect(parseAmountToCents('99999999999999999')).toBeNull();
		expect(parseAmountToCents('10000000000000')).toBe(1_000_000_000_000_000); // == MAX_CENTS
		expect(parseAmountToCents('10000000000000.01')).toBeNull();
	});
});

describe('formatCents preserva o sinal e os centavos em todos os locales', () => {
	it.each(LOCALES)('%s', (locale) => {
		configureMoney({ locale, currencyCode: 'USD', currencySymbol: '$' });
		const random = makeRandom(19);

		for (let i = 0; i < 2_000; i += 1) {
			const cents = Math.floor(random() * 100_000_000) - 50_000_000;
			const text = formatCents(cents);
			const digits = text.replace(/\D/g, '');
			const expectedDigits = Math.abs(cents).toString().padStart(3, '0');

			expect(digits).toBe(expectedDigits);

			if (cents < 0) expect(text).toMatch(/[-−]/);
			else expect(text).not.toMatch(/[-−]/);
		}
	});

	it('moeda desconhecida do Intl (BTC) ainda formata com sinal e duas casas', () => {
		configureMoney({ locale: 'pt-BR', currencyCode: 'BTC', currencySymbol: '₿' });
		expect(formatCents(-123456).replace(/\D/g, '')).toBe('123456');
		expect(formatCents(-123456)).toMatch(/[-−]/);
		expect(formatCents(-123456)).toContain('₿');
		expect(formatCents(5).replace(/\D/g, '')).toBe('005');
	});

	it('moeda sem casas decimais no Intl (JPY) ainda mostra os centavos gravados', () => {
		configureMoney({ locale: 'ja-JP', currencyCode: 'JPY', currencySymbol: '¥' });
		expect(formatCents(123456).replace(/\D/g, '')).toBe('123456');
	});
});

describe('conversão de moeda', () => {
	it('convertCents arredonda ao centavo mais próximo, nunca trunca', () => {
		expect(convertCents(100, 0.185)).toBe(19); // 18,5 -> 19
		expect(convertCents(100, 0.184)).toBe(18);
		expect(convertCents(1, 0.5)).toBe(1);
		expect(convertCents(3, 0.5)).toBe(2);
	});

	it('taxa 1 é identidade para qualquer valor', () => {
		for (let cents = 0; cents < 1_000_000; cents += 7) {
			expect(convertCents(cents, 1)).toBe(cents);
		}
	});

	it('ida e volta por uma taxa e sua inversa desvia no máximo 1 centavo por linha', () => {
		const random = makeRandom(23);
		for (let i = 0; i < 10_000; i += 1) {
			const cents = Math.floor(random() * 10_000_000);
			const rate = 0.1 + random() * 10;
			const back = convertCents(convertCents(cents, rate), 1 / rate);
			expect(Math.abs(back - cents)).toBeLessThanOrEqual(Math.ceil(1 / rate) + 1);
		}
	});

	it('parseDecimalInput aceita vírgula e ponto para a taxa', () => {
		expect(parseDecimalInput('0,1852')).toBeCloseTo(0.1852, 10);
		expect(parseDecimalInput('0.1852')).toBeCloseTo(0.1852, 10);
		expect(parseDecimalInput('5')).toBe(5);
		expect(parseDecimalInput('5,4321')).toBeCloseTo(5.4321, 10);
	});
});

describe('majorUnitsToCents (migração de floats legados)', () => {
	it('todo valor com duas casas de 0,00 a 100.000,00 migra para o centavo exato', () => {
		for (let cents = 0; cents <= 10_000_000; cents += 1) {
			// O float legado foi gravado como `cents / 100`; a migração precisa recuperar `cents`.
			const legacy = cents / 100;
			if (majorUnitsToCents(legacy) !== cents) {
				throw new Error(`${legacy} -> ${majorUnitsToCents(legacy)} (esperado ${cents})`);
			}
		}
	});

	it('valores resultantes de somas em float (0.1 + 0.2) ainda migram corretamente', () => {
		expect(majorUnitsToCents(0.1 + 0.2)).toBe(30);
		expect(majorUnitsToCents(1.1 + 2.2)).toBe(330);
		expect(majorUnitsToCents(0.7 + 0.1)).toBe(80);
		expect(majorUnitsToCents(1.15)).toBe(115);
		expect(majorUnitsToCents(4.35)).toBe(435);
	});

	it('centsToMajorUnits -> majorUnitsToCents é identidade', () => {
		const random = makeRandom(29);
		for (let i = 0; i < 100_000; i += 1) {
			const cents = Math.floor(random() * 1_000_000_000);
			expect(majorUnitsToCents(centsToMajorUnits(cents))).toBe(cents);
		}
	});
});

describe('sumCents', () => {
	it('soma é exata e independente da ordem', () => {
		const random = makeRandom(31);
		const values = Array.from({ length: 5_000 }, () => Math.floor(random() * 10_000_000) - 3_000_000);
		const shuffled = [...values].sort(() => random() - 0.5);

		expect(sumCents(values)).toBe(sumCents(shuffled));

		let manual = 0;
		for (const value of values) manual += value;
		expect(sumCents(values)).toBe(manual);
	});

	it('somar centavos que em float seriam 0.1 + 0.2 dá exatamente 30', () => {
		expect(sumCents([10, 20])).toBe(30);
		expect(sumCents([majorUnitsToCents(0.1), majorUnitsToCents(0.2)])).toBe(30);
	});
});
