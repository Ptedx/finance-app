import {
	configureDateLocale,
	formatDate,
	formatDayMonth,
	formatFullDate,
	formatMonthLong,
	formatMonthShort,
	getMonthName,
} from '../dateUtils';
import { groupDigits, resolveFormatLocale } from '../locale';

describe('resolveFormatLocale — o formato segue o idioma do app', () => {
	it('português sempre formata como Brasil, a menos que o aparelho seja de Portugal', () => {
		expect(resolveFormatLocale('en-US', 'pt')).toBe('pt-BR');
		expect(resolveFormatLocale('pt-BR', 'pt')).toBe('pt-BR');
		expect(resolveFormatLocale('pt-US', 'pt')).toBe('pt-BR');
		expect(resolveFormatLocale(null, 'pt')).toBe('pt-BR');
		expect(resolveFormatLocale('pt-PT', 'pt')).toBe('pt-PT');
	});

	it('inglês e italiano usam a região do aparelho quando é do mesmo idioma', () => {
		expect(resolveFormatLocale('en-GB', 'en')).toBe('en-GB');
		expect(resolveFormatLocale('pt-BR', 'en')).toBe('en-US');
		expect(resolveFormatLocale('it-CH', 'it')).toBe('it-CH');
		expect(resolveFormatLocale(undefined, 'it')).toBe('it-IT');
	});
});

describe('datas no formato do idioma, sem depender do Intl', () => {
	afterEach(() => configureDateLocale('en-US'));

	it('pt-BR', () => {
		configureDateLocale('pt-BR');
		expect(formatDate('2026-09-16')).toBe('16 set');
		expect(formatDayMonth('2026-09-05')).toBe('05/09');
		expect(formatFullDate('2026-09-16')).toBe('16 de setembro de 2026');
		expect(formatMonthLong('2026-10-01')).toBe('outubro');
		expect(formatMonthShort('2026-10-01')).toBe('out');
		expect(getMonthName(3)).toBe('março');
	});

	it('en-US', () => {
		expect(formatDate('2026-09-16')).toBe('Sep 16');
		expect(formatDayMonth('2026-09-05')).toBe('09/05');
		expect(formatFullDate('2026-07-22')).toBe('July 22, 2026');
	});

	it('it-IT', () => {
		configureDateLocale('it-IT');
		expect(formatDayMonth('2026-09-05')).toBe('05/09');
		expect(formatFullDate('2026-09-16')).toBe('16 settembre 2026');
	});
});

describe('dinheiro quando o Intl do aparelho ignora o locale', () => {
	const RealNumberFormat = Intl.NumberFormat;

	afterEach(() => {
		Intl.NumberFormat = RealNumberFormat;
	});

	it('cai para a formatação manual brasileira, e o que é mostrado volta ao mesmo centavo', () => {
		// Simula um motor que responde sempre em en-US, qualquer que seja o locale pedido.
		const fake = ((_locale?: string | string[], options?: Intl.NumberFormatOptions) =>
			new RealNumberFormat('en-US', options)) as unknown as typeof Intl.NumberFormat;
		Intl.NumberFormat = fake;

		jest.isolateModules(() => {
			const money = require('../money') as typeof import('../money');
			money.configureMoney({ locale: 'pt-BR', currencyCode: 'BRL', currencySymbol: 'R$' });

			expect(money.formatCents(383_280)).toBe('R$ 3.832,80');
			expect(money.formatCents(-16_460)).toBe('-R$ 164,60');
			expect(money.formatCents(5)).toBe('R$ 0,05');
			expect(money.centsToInputString(383_280)).toBe('3832,80');
			expect(money.centsToDisplayInput(383_280)).toBe('3.832,80');
			expect(money.formatAmountInput('1234567')).toBe('1.234.567');
			for (const cents of [0, 1, 99, 100, 383_280, 123_456_789]) {
				expect(money.parseAmountToCents(money.centsToDisplayInput(cents))).toBe(cents);
			}
		});
	});
});

describe('groupDigits', () => {
	it('agrupa de três em três', () => {
		expect(groupDigits('1234567', '.')).toBe('1.234.567');
		expect(groupDigits('123', '.')).toBe('123');
	});
});
