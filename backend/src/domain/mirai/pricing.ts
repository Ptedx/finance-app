/**
 * Custo do Mirai (SPD-163, D7): o preço de cada chamada e o teto do mês.
 *
 * Tudo em micro-US$ (1 US$ = 1.000.000), inteiro: o teto de US$ 20 vira 20.000.000, e uma
 * pergunta típica (~US$ 0,003) vira ~3.000. A soma usa o `usage` da resposta.
 */

/**
 * Preços do Claude Haiku 5.5 em micro-US$ por milhão de tokens, conferidos em 12/11/2026.
 *
 * - entrada US$ 0,10 e saída US$ 0,50 por milhão (o raciocínio conta como saída);
 * - escrita de cache com TTL de 5 minutos: 1,25 × a entrada;
 * - leitura de cache: 0,1 × a entrada (`shared/prompt-caching.md` da documentação do SDK).
 *
 * Trocar `ASSISTANT_MODEL` por outro modelo exige trocar esta tabela junto.
 */
export const MIRAI_PRICES = {
	model: 'claude-haiku-5-5',
	checkedOn: '2026-11-12',
	inputPerMTok: 100_000,
	outputPerMTok: 500_000,
	cacheWritePerMTok: 125_000,
	cacheReadPerMTok: 10_000,
} as const;

/** Os campos do `usage` da resposta que entram na conta (os nulos contam como zero). */
export interface MiraiUsage {
	input_tokens: number;
	output_tokens: number;
	cache_creation_input_tokens?: number | null;
	cache_read_input_tokens?: number | null;
}

/** Os tokens de uma chamada, já sem nulos: é o que vai para `assistant_usage`. */
export interface MiraiTokens {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}

const count = (value: number | null | undefined): number =>
	typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

export const tokensOf = (usage: MiraiUsage): MiraiTokens => ({
	inputTokens: count(usage.input_tokens),
	outputTokens: count(usage.output_tokens),
	cacheReadTokens: count(usage.cache_read_input_tokens),
	cacheWriteTokens: count(usage.cache_creation_input_tokens),
});

/**
 * O custo de uma chamada, em micro-US$, arredondado para cima.
 *
 * `input_tokens` é só a parte fora do cache: o que foi lido ou escrito no cache vem nos
 * outros dois campos, cada um com o seu preço.
 */
export const costMicros = (tokens: MiraiTokens): number =>
	Math.ceil(
		(tokens.inputTokens * MIRAI_PRICES.inputPerMTok +
			tokens.outputTokens * MIRAI_PRICES.outputPerMTok +
			tokens.cacheWriteTokens * MIRAI_PRICES.cacheWritePerMTok +
			tokens.cacheReadTokens * MIRAI_PRICES.cacheReadPerMTok) /
			1_000_000
	);

/**
 * Folga para o que a API acrescenta ao pedido e não está no JSON: o texto que apresenta as
 * ferramentas ao modelo e as marcas de cada mensagem.
 */
const REQUEST_OVERHEAD_TOKENS = 2_000;

/**
 * O custo máximo possível de um pedido, em micro-US$, para conferir o teto **antes** de
 * chamar.
 *
 * Um token tem pelo menos um byte, então os bytes do JSON do pedido são um teto para os
 * tokens de entrada; todos são cobrados ao preço mais alto de entrada (a escrita de cache).
 * A saída é cobrada inteira, até `max_tokens`.
 */
export const maxCostMicros = (request: { max_tokens: number }): number => {
	const inputTokens = Buffer.byteLength(JSON.stringify(request), 'utf8') + REQUEST_OVERHEAD_TOKENS;
	return Math.ceil(
		(inputTokens * MIRAI_PRICES.cacheWritePerMTok +
			request.max_tokens * MIRAI_PRICES.outputPerMTok) /
			1_000_000
	);
};

/** US$ → micro-US$. */
export const usdToMicros = (usd: number): number => Math.round(usd * 1_000_000);
