import { MIRAI_TONE_PATTERN, MIRAI_TONE_TO_EXPRESSION, type MiraiExpression } from './contract';

/**
 * A marca de tom do Mirai (SPD-163, §7.1).
 *
 * A instrução fixa pede que toda resposta termine com `[tom: feliz]`, `[tom: neutro]`,
 * `[tom: preocupado]` ou `[tom: triste]`. A marca é para o app, não para a pessoa: sai do
 * texto e vira a expressão do avatar ao lado da resposta. Sem marca (o modelo esqueceu, ou a
 * resposta foi cortada), a expressão é `normal`.
 */
export interface MiraiTone {
	/** O texto sem a marca, sem espaço sobrando no fim. */
	text: string;
	expression: MiraiExpression;
}

export const readTone = (raw: string): MiraiTone => {
	const match = MIRAI_TONE_PATTERN.exec(raw);
	if (!match) return { text: raw.trimEnd(), expression: 'normal' };
	const expression = MIRAI_TONE_TO_EXPRESSION[match[1].toLowerCase()] ?? 'normal';
	return { text: raw.slice(0, match.index).trimEnd(), expression };
};

/**
 * Todo arquivo sob app/ é tratado como rota pelo expo-router, e uma rota sem export
 * default é um módulo quebrado do ponto de vista dele. Este export existe só para
 * satisfazer essa exigência — nada navega para cá.
 */
export default { readTone };
