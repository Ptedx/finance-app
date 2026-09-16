import {
	detectNotificationInstallments,
	installmentDate,
	parseInstallmentMarker,
	splitInstallments,
} from '../installments';

describe('splitInstallments', () => {
	it('divide em parcelas inteiras e o resto vai para a primeira', () => {
		expect(splitInstallments(30000, 3)).toEqual([10000, 10000, 10000]);
		expect(splitInstallments(10000, 3)).toEqual([3334, 3333, 3333]);
		expect(splitInstallments(9999, 4)).toEqual([2502, 2499, 2499, 2499]);
	});

	it('à vista é uma parcela só', () => {
		expect(splitInstallments(5000, 1)).toEqual([5000]);
		expect(splitInstallments(5000, 0)).toEqual([5000]);
	});

	it('a soma sempre volta ao total, para qualquer valor e quantidade', () => {
		for (let total = 1; total < 5000; total += 37) {
			for (let count = 1; count <= 12; count += 1) {
				const parts = splitInstallments(total, count);
				expect(parts).toHaveLength(count);
				expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
				expect(Math.max(...parts) - Math.min(...parts)).toBeLessThanOrEqual(count - 1);
			}
		}
	});
});

describe('installmentDate', () => {
	it('uma parcela por mês a partir da compra, prendendo o dia em meses curtos', () => {
		expect(installmentDate('2026-01-31', 1)).toBe('2026-01-31');
		expect(installmentDate('2026-01-31', 2)).toBe('2026-02-28');
		expect(installmentDate('2026-01-31', 3)).toBe('2026-03-31');
		expect(installmentDate('2026-11-15', 3)).toBe('2027-01-15');
	});
});

describe('parseInstallmentMarker', () => {
	it.each([
		['IFOOD 2/3', { index: 2, count: 3 }],
		['MAGAZINE LUIZA PARC 02/12', { index: 2, count: 12 }],
		['Parcela 1 de 10 - LOJA', { index: 1, count: 10 }],
		['AMAZON (3/6)', { index: 3, count: 6 }],
	])('%s', (text, expected) => {
		expect(parseInstallmentMarker(text)).toEqual(expected);
	});

	it('data não é parcela e índice acima do total não vale', () => {
		expect(parseInstallmentMarker('PIX TRANSF JOAO 14/09')).toBeNull();
		expect(parseInstallmentMarker('LOJA 5/3')).toBeNull();
		expect(parseInstallmentMarker('LOJA 1/1')).toBeNull();
		expect(parseInstallmentMarker('Compra no débito - IFOOD')).toBeNull();
	});
});

describe('detectNotificationInstallments', () => {
	it('"em 3x" sem valor de parcela', () => {
		expect(detectNotificationInstallments('Compra de R$ 300,00 em 3x APROVADA em LOJA')).toEqual({
			count: 3,
			parcelCents: null,
		});
	});

	it('"3x de R$ 100,00" com valor de parcela', () => {
		expect(detectNotificationInstallments('Compra parcelada em 3x de R$ 100,00 APROVADA')).toEqual({
			count: 3,
			parcelCents: 10000,
		});
	});

	it('"parcelado em 12"', () => {
		expect(detectNotificationInstallments('Compra de R$ 1.200,00 parcelada em 12 APROVADA')).toEqual({
			count: 12,
			parcelCents: null,
		});
	});

	it('à vista e absurdos devolvem nulo', () => {
		expect(detectNotificationInstallments('Compra de R$ 50,00 em 1x APROVADA')).toBeNull();
		expect(detectNotificationInstallments('Compra de R$ 50,00 em 99x APROVADA')).toBeNull();
		expect(detectNotificationInstallments('Compra de R$ 50,00 APROVADA em LOJA XPTO')).toBeNull();
	});
});
