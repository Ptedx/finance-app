import { areaPath, linePath, xOf, yOf } from '../chartPaths';

describe('geometria dos gráficos', () => {
	const frame = { width: 100, height: 50, paddingTop: 10 };

	it('mapeia valores para alturas dentro do quadro', () => {
		expect(yOf(0, 100, frame)).toBe(50);
		expect(yOf(100, 100, frame)).toBe(10);
		expect(yOf(50, 100, frame)).toBe(30);
		expect(yOf(200, 100, frame)).toBe(10);
		expect(yOf(10, 0, frame)).toBe(50);
	});

	it('espalha os pontos pela largura', () => {
		expect(xOf(0, 3, 100)).toBe(0);
		expect(xOf(1, 3, 100)).toBe(50);
		expect(xOf(2, 3, 100)).toBe(100);
		expect(xOf(0, 1, 100)).toBe(0);
	});

	it('a área começa no primeiro ponto e fecha pela base', () => {
		expect(areaPath([0, 100], 100, frame)).toBe('M0 50 L100 10 L100 50 L0 50 Z');
		expect(areaPath([], 100, frame)).toBe('');
	});

	it('a linha não fecha', () => {
		expect(linePath([0, 50, 100], 100, frame)).toBe('M0 50 L50 30 L100 10');
	});
});
