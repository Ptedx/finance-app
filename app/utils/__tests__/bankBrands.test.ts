import { BANK_BRANDS, brandFor, contrastRatio, NEUTRAL_CARD_COLOR, readableTextOn } from '../bankBrands';

describe('brandFor', () => {
	it.each([
		['Nubank', 'nubank'],
		['Nu', 'nubank'],
		['NU PAGAMENTOS', 'nubank'],
		['Banco Inter', 'inter'],
		['Inter', 'inter'],
		['Mercado Pago', 'mercadopago'],
		['Itaú', 'itau'],
		['Banco do Brasil', 'bb'],
		['C6 Bank', 'c6'],
	])('%s → %s', (name, id) => {
		expect(brandFor(name)?.id).toBe(id);
	});

	it('não inventa marca', () => {
		expect(brandFor('Banco Desconhecido XPTO')).toBeNull();
		expect(brandFor('')).toBeNull();
		expect(brandFor(null)).toBeNull();
		// Alias curto não casa dentro de outra palavra.
		expect(brandFor('Numero')).toBeNull();
	});
});

describe('contraste do texto sobre a cor do cartão (WCAG AA)', () => {
	it.each([...BANK_BRANDS.map((b) => [b.name, b.color]), ['neutro', NEUTRAL_CARD_COLOR]])(
		'%s: o texto escolhido tem pelo menos 4,5:1',
		(_name, color) => {
			expect(contrastRatio(color, readableTextOn(color))).toBeGreaterThanOrEqual(4.5);
		}
	);

	it('amarelo pede preto, roxo pede branco', () => {
		expect(readableTextOn('#FCFC30')).toBe('#000000');
		expect(readableTextOn('#820AD1')).toBe('#FFFFFF');
	});

	it('razão de contraste conhecida: preto e branco é 21', () => {
		expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
	});
});
