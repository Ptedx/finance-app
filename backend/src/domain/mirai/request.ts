import { z } from 'zod';
import { isMiraiToolName, type MiraiLocale } from './contract.js';

/**
 * O corpo de `POST /api/assistant/turn` (contrato §Rotas), validado.
 *
 * O backend é um intermediário fino, mas é ele que fala com o Claude com a chave do
 * Spendr: o que chega do aparelho só passa com a forma do contrato. Em particular:
 *
 *  - só os blocos que o Mirai usa, e cada um no papel certo (`tool_result` só do usuário,
 *    `tool_use` e `thinking` só do assistente). Campo a mais é descartado — o aparelho não
 *    consegue pôr um `cache_control` nem uma mensagem `system` no pedido;
 *  - `tool_use` só com ferramenta da lista, e `tool_result` só para um `tool_use` que veio
 *    antes na conversa;
 *  - a conversa começa e termina com o usuário: o Claude responde à última mensagem;
 *  - `screen` é um nome de tela, não texto livre: ele vai para a mensagem de sistema.
 *
 * O bloco `redacted_thinking` (do contrato) é o que o Claude pode devolver no lugar de um
 * `thinking`; ele precisa voltar no histórico como veio.
 */

/** Teto do corpo da rota, no formato do `express.json`. */
export const MIRAI_BODY_LIMIT = '512kb';

export const MIRAI_LIMITS = {
	maxMessages: 400,
	maxBlocksPerMessage: 64,
	maxTextLength: 20_000,
	maxToolResultLength: 20_000,
	maxThinkingLength: 100_000,
	maxSignatureLength: 50_000,
	maxIdLength: 200,
} as const;

/** Id do aparelho (uuid): conferido pela forma, sem exigir a versão. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Nome de tela do app, como `cards` ou `home`. */
const SCREEN = /^[A-Za-z0-9_.-]{1,40}$/;

const id = z.string().min(1).max(MIRAI_LIMITS.maxIdLength);

const textBlock = z.object({
	type: z.literal('text'),
	text: z.string().min(1).max(MIRAI_LIMITS.maxTextLength),
});

const toolUseBlock = z.object({
	type: z.literal('tool_use'),
	id,
	name: z.string().min(1).max(64),
	input: z.record(z.string(), z.unknown()),
});

const toolResultBlock = z.object({
	type: z.literal('tool_result'),
	tool_use_id: id,
	content: z.string().max(MIRAI_LIMITS.maxToolResultLength),
	is_error: z.boolean().optional(),
});

const thinkingBlock = z.object({
	type: z.literal('thinking'),
	// Vazio é válido: com o raciocínio omitido, o texto vem vazio e só a assinatura conta.
	thinking: z.string().max(MIRAI_LIMITS.maxThinkingLength),
	signature: z.string().min(1).max(MIRAI_LIMITS.maxSignatureLength),
});

const redactedThinkingBlock = z.object({
	type: z.literal('redacted_thinking'),
	data: z.string().min(1).max(MIRAI_LIMITS.maxSignatureLength),
});

const block = z.discriminatedUnion('type', [
	textBlock,
	toolUseBlock,
	toolResultBlock,
	thinkingBlock,
	redactedThinkingBlock,
]);

const message = z.object({
	role: z.enum(['user', 'assistant']),
	content: z.union([
		z.string().min(1).max(MIRAI_LIMITS.maxTextLength),
		z.array(block).min(1).max(MIRAI_LIMITS.maxBlocksPerMessage),
	]),
});

const turnRequest = z.object({
	conversationId: z.string().regex(UUID),
	questionId: z.string().regex(UUID),
	messages: z.array(message).min(1).max(MIRAI_LIMITS.maxMessages),
	screen: z.string().regex(SCREEN).nullable(),
	locale: z.enum(['pt', 'en', 'it']),
	today: z
		.string()
		.regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/)
		.optional(),
});

export type MiraiInputBlock = z.infer<typeof block>;
export type MiraiInputMessage = z.infer<typeof message>;

export interface MiraiTurnInput {
	conversationId: string;
	questionId: string;
	messages: MiraiInputMessage[];
	screen: string | null;
	locale: MiraiLocale;
	today?: string | undefined;
}

const USER_BLOCKS = new Set(['text', 'tool_result']);
const ASSISTANT_BLOCKS = new Set(['text', 'tool_use', 'thinking', 'redacted_thinking']);

/**
 * Os papéis, as ferramentas e os `tool_use_id`: o que o zod sozinho não diz. Devolve
 * `false` ao primeiro problema.
 */
const isCoherent = (messages: MiraiInputMessage[]): boolean => {
	if (messages[0]?.role !== 'user' || messages[messages.length - 1]?.role !== 'user') {
		return false;
	}

	const toolUseIds = new Set<string>();
	for (const { role, content } of messages) {
		if (typeof content === 'string') continue;
		const allowed = role === 'user' ? USER_BLOCKS : ASSISTANT_BLOCKS;
		for (const item of content) {
			if (!allowed.has(item.type)) return false;
			if (item.type === 'tool_use') {
				if (!isMiraiToolName(item.name)) return false;
				toolUseIds.add(item.id);
			}
			if (item.type === 'tool_result' && !toolUseIds.has(item.tool_use_id)) return false;
		}
	}
	return true;
};

/** O corpo validado, ou `null` (400 `bad_request`). Nada do corpo vai para a resposta. */
export const parseTurnRequest = (body: unknown): MiraiTurnInput | null => {
	const parsed = turnRequest.safeParse(body);
	if (!parsed.success || !isCoherent(parsed.data.messages)) return null;
	return parsed.data;
};
