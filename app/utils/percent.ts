/**
 * Porcentagens a partir de pontos-base, no separador decimal do idioma do app — "22,0%"
 * em português, "22.0%" em inglês. As contas continuam em pontos-base inteiros; isto só
 * vale para a tela e para os campos de digitação.
 */

import { languageOf, SEPARATORS } from './locale';
import { getMoneyConfig, parseDecimalInput } from './money';

const decimalSeparator = (): string => SEPARATORS[languageOf(getMoneyConfig().locale)].decimal;

/** 2.200 → "22,0%"; com `digits = 0`, "22%". */
export const formatPercentBp = (bp: number, digits = 1): string => `${(bp / 100).toFixed(digits).replace('.', decimalSeparator())}%`;

/** Para preencher um campo: 2.500 → "25", 1.050 → "10,5", sem casas falsas. */
export const bpToPercentInput = (bp: number): string => {
	const value = bp / 100;
	return (Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '')).replace('.', decimalSeparator());
};

/** O inverso do campo: "10,5" → 1.050. Nulo fora de 0-`max`%. */
export const percentInputToBp = (input: string, max = 100): number | null => {
	const value = parseDecimalInput(input);
	return value === null || value < 0 || value > max ? null : Math.round(value * 100);
};

/**
 * Todo arquivo sob app/ é tratado como rota pelo expo-router, e uma rota sem export
 * default é um módulo quebrado do ponto de vista dele. Este export existe só para
 * satisfazer essa exigência — nada navega para cá.
 */
export default { formatPercentBp, bpToPercentInput, percentInputToBp };
