/**
 * Contrato do Mirai (SPD-163), igual no app e no backend.
 *
 * Este arquivo existe em duas cópias idênticas: `app/utils/mirai/contract.ts` (app) e
 * `backend/src/domain/mirai/contract.ts` (backend). Não importa nada, para valer nos dois
 * lados. Mudar o contrato é mudar as duas cópias juntas; o ordenador confere com `cmp` na
 * integração. A especificação está em `cards/SPD-163-assistente.md`.
 *
 * - O backend manda `MIRAI_TOOLS` ao Claude e recusa qualquer ferramenta fora da lista.
 * - O app executa cada ferramenta no aparelho (SQLite + as funções das telas) e devolve o
 *   resultado como `tool_result`.
 */

// ---------------------------------------------------------------------------
// Ferramentas
// ---------------------------------------------------------------------------

/** Mês no formato `YYYY-MM`. */
export const MONTH_PATTERN = '^\\d{4}-(0[1-9]|1[0-2])$';
/** Data no formato `YYYY-MM-DD`. */
export const DATE_PATTERN = '^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])$';

/**
 * As ferramentas, no formato da API do Claude (`strict: true`). Com `strict`, todo campo
 * está em `required`; o opcional é `null` (`type: [..., 'null']`).
 */
export const MIRAI_TOOLS = [
	{
		name: 'get_month_overview',
		description:
			'O "Este mês" de um mês: receita, gastos (principal, cartões, envelopes), sobrou, guardado e rendimento, em centavos. Os mesmos números da tela inicial. Sobrou (leftoverCents) é receita menos gastos; guardado (savedCents) é o que foi transferido para a reserva no mês: não é gasto e não sai do que sobrou.',
		input_schema: {
			type: 'object',
			properties: { month: { type: 'string', pattern: MONTH_PATTERN, description: 'Mês YYYY-MM' } },
			required: ['month'],
			additionalProperties: false,
		},
	},
	{
		name: 'get_accounts',
		description: 'As contas (não os cartões de crédito): nome, tipo, papel, saldo em centavos e quanto rendem do CDI.',
		input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
	},
	{
		name: 'get_cards',
		description:
			'Os cartões de crédito: fatura aberta e fechada, vencimento, limite e parcelas futuras, em centavos. Numa compra parcelada, chargedCount parcelas já entraram em faturas e a próxima é a de número nextNumber (de totalCount), em nextDate: ela não é a primeira, diga "a parcela 4/6 cai em 15/12".',
		input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
	},
	{
		name: 'list_transactions',
		description:
			'Lançamentos de um período, do mais novo para o mais antigo: data, valor em centavos, categoria, conta e estabelecimento. Nomes de pessoas vêm trocados por "pessoa".',
		input_schema: {
			type: 'object',
			properties: {
				from: { type: 'string', pattern: DATE_PATTERN },
				to: { type: 'string', pattern: DATE_PATTERN },
				category: { type: ['string', 'null'], description: 'Id da categoria, ou null para todas' },
				accountId: { type: ['string', 'null'], description: 'Id da conta ou do cartão, ou null para todas' },
				text: { type: ['string', 'null'], description: 'Trecho do estabelecimento ou da nota, ou null' },
				kind: { type: ['string', 'null'], enum: ['expense', 'income', 'transfer', null] },
				limit: { type: 'integer', minimum: 1, maximum: 100 },
			},
			required: ['from', 'to', 'category', 'accountId', 'text', 'kind', 'limit'],
			additionalProperties: false,
		},
	},
	{
		name: 'get_category_totals',
		description:
			'Gastos por categoria num mês, em centavos, e a diferença para outro mês quando compareWith vier.',
		input_schema: {
			type: 'object',
			properties: {
				month: { type: 'string', pattern: MONTH_PATTERN },
				compareWith: { type: ['string', 'null'], pattern: MONTH_PATTERN },
			},
			required: ['month', 'compareWith'],
			additionalProperties: false,
		},
	},
	{
		name: 'get_bills',
		description:
			'Contas a pagar com vencimento no período: valor, vencimento, pago, pulado ou em atraso. As em atraso dos meses do período vêm mesmo com vencimento antes de from; overdueBeforeThisMonth soma o atraso dos meses anteriores.',
		input_schema: {
			type: 'object',
			properties: {
				from: { type: 'string', pattern: DATE_PATTERN },
				to: { type: 'string', pattern: DATE_PATTERN },
			},
			required: ['from', 'to'],
			additionalProperties: false,
		},
	},
	{
		name: 'get_debts',
		description: 'As dívidas: saldo, juros ao mês, parcela e prazo restante.',
		input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
	},
	{
		name: 'get_reserve_and_goals',
		description: 'A reserva de emergência (atual, meta, meses cobertos) e as metas.',
		input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
	},
	{
		name: 'get_net_worth',
		description: 'O patrimônio atual e, se months vier, a série mensal dos últimos meses (até 12).',
		input_schema: {
			type: 'object',
			properties: { months: { type: ['integer', 'null'], minimum: 1, maximum: 12 } },
			required: ['months'],
			additionalProperties: false,
		},
	},
	{
		name: 'get_health',
		description: 'A saúde financeira: cada fator do app com o seu status e a contagem de fatores por status.',
		input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
	},
	{
		name: 'get_rates',
		description: 'A taxa do CDI ao ano que o app usa (a última buscada no Banco Central, guardada no aparelho), a moeda e o idioma do app.',
		input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
	},
] as const;

export type MiraiToolName = (typeof MIRAI_TOOLS)[number]['name'];

export const MIRAI_TOOL_NAMES: readonly MiraiToolName[] = MIRAI_TOOLS.map((tool) => tool.name);

export const isMiraiToolName = (value: string): value is MiraiToolName =>
	(MIRAI_TOOL_NAMES as readonly string[]).includes(value);

/** No máximo esta quantidade de rodadas de ferramenta por pergunta. */
export const MIRAI_MAX_TOOL_ROUNDS = 6;

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------

export type MiraiLocale = 'pt' | 'en' | 'it';

/** Bloco de conteúdo no formato da API (só os tipos que o Mirai usa). */
export type MiraiContentBlock =
	| { type: 'text'; text: string }
	| { type: 'tool_use'; id: string; name: string; input: unknown }
	| { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
	| { type: 'thinking'; thinking: string; signature: string }
	/** Raciocínio cifrado pela API: volta no histórico exatamente como veio. */
	| { type: 'redacted_thinking'; data: string };

export type MiraiMessage = { role: 'user' | 'assistant'; content: string | MiraiContentBlock[] };

/**
 * `POST /api/assistant/turn`, autenticado. Uma chamada ao Claude por POST; o app conduz o
 * ciclo. `conversationId` é um uuid gerado pelo app por conversa; `questionId` muda a cada
 * pergunta nova (é por ele que se contam as perguntas do dia e as rodadas).
 */
export interface MiraiTurnRequest {
	conversationId: string;
	questionId: string;
	messages: MiraiMessage[];
	/** Nome da tela de onde o botão foi tocado (ex.: "cards"), ou null. */
	screen: string | null;
	locale: MiraiLocale;
	/**
	 * A data de hoje no aparelho (`YYYY-MM-DD`): o Mirai entende "este mês" e "hoje" a partir dela.
	 * Opcional para o servidor aceitar versões do app sem o campo; sem ela, vale o dia de Brasília.
	 */
	today?: string;
}

export interface MiraiTurnResponse {
	/** O conteúdo da resposta do assistente, inteiro (inclua no histórico como veio). */
	content: MiraiContentBlock[];
	stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause_turn';
	remainingToday: number;
}

/** `GET /api/assistant/status`, autenticado: o app mostra o botão só com `enabled`. */
export interface MiraiStatusResponse {
	enabled: boolean;
	remainingToday: number;
}

/** Corpo dos erros das duas rotas. */
export type MiraiErrorCode =
	| 'not_enabled' // 403: conta fora da lista
	| 'daily_limit' // 429: perguntas do dia acabaram
	| 'monthly_cap' // 429: teto do mês atingido
	| 'too_many_rounds' // 429: mais de MIRAI_MAX_TOOL_ROUNDS rodadas na mesma pergunta
	| 'unavailable' // 503: sem chave ou a API falhou
	| 'bad_request'; // 400: corpo inválido ou ferramenta fora da lista

export interface MiraiErrorResponse {
	error: string;
	code: MiraiErrorCode;
}

// ---------------------------------------------------------------------------
// Avatar e tom
// ---------------------------------------------------------------------------

export type MiraiExpression = 'normal' | 'thinking' | 'happy' | 'worried' | 'sad' | 'sorry' | 'goal';

/** A marca de tom que a instrução pede no fim de toda resposta. A mesma em todos os idiomas. */
export const MIRAI_TONE_PATTERN = /\[tom:\s*(feliz|neutro|preocupado|triste)\]\s*$/i;

export const MIRAI_TONE_TO_EXPRESSION: Record<string, MiraiExpression> = {
	feliz: 'happy',
	neutro: 'normal',
	preocupado: 'worried',
	triste: 'sad',
};
