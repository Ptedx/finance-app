/**
 * Geometria dos gráficos em SVG: transforma séries em `d` de `<Path>`. Puro, para o
 * desenho ser testável sem montar componente nenhum.
 */

export interface ChartFrame {
	width: number;
	height: number;
	/** Margem interna, para a linha da meta e os rótulos não colarem na borda. */
	paddingTop?: number;
	paddingBottom?: number;
}

const round = (value: number): number => Math.round(value * 100) / 100;

/** A altura (em px, a partir do topo) de um valor numa escala de 0 a `maxValue`. */
export const yOf = (value: number, maxValue: number, frame: ChartFrame): number => {
	const top = frame.paddingTop ?? 0;
	const bottom = frame.height - (frame.paddingBottom ?? 0);
	if (maxValue <= 0) return bottom;
	const ratio = Math.min(1, Math.max(0, value / maxValue));
	return round(bottom - ratio * (bottom - top));
};

/** A posição horizontal do i-ésimo de `count` pontos, da borda esquerda à direita. */
export const xOf = (index: number, count: number, width: number): number => (count <= 1 ? 0 : round((index / (count - 1)) * width));

/**
 * Uma área fechada sob a série: sobe no primeiro ponto, percorre todos e volta pela
 * base. Vazia quando não há pontos.
 */
export const areaPath = (values: number[], maxValue: number, frame: ChartFrame): string => {
	if (values.length === 0) return '';
	const bottom = frame.height - (frame.paddingBottom ?? 0);
	const parts = values.map((value, index) => `${index === 0 ? 'M' : 'L'}${xOf(index, values.length, frame.width)} ${yOf(value, maxValue, frame)}`);
	return `${parts.join(' ')} L${xOf(values.length - 1, values.length, frame.width)} ${bottom} L0 ${bottom} Z`;
};

/** Só a linha da série, sem fechar. */
export const linePath = (values: number[], maxValue: number, frame: ChartFrame): string =>
	values.map((value, index) => `${index === 0 ? 'M' : 'L'}${xOf(index, values.length, frame.width)} ${yOf(value, maxValue, frame)}`).join(' ');

/**
 * Todo arquivo sob app/ é tratado como rota pelo expo-router, e uma rota sem export
 * default é um módulo quebrado do ponto de vista dele. Este export existe só para
 * satisfazer essa exigência — nada navega para cá.
 */
export default { areaPath, linePath, xOf, yOf };
