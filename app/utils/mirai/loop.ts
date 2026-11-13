import { ApiError, apiRequest } from '../../api/client';
import { todayISO } from '../dateUtils';
import {
	isMiraiToolName,
	MIRAI_MAX_TOOL_ROUNDS,
	type MiraiContentBlock,
	type MiraiErrorCode,
	type MiraiExpression,
	type MiraiLocale,
	type MiraiMessage,
	type MiraiQuestionContext,
	type MiraiStatusResponse,
	type MiraiToolName,
	type MiraiTurnRequest,
	type MiraiTurnResponse,
} from './contract';
import { readTone } from './tone';
import { executeMiraiTool } from './tools';

/**
 * O ciclo de uma pergunta ao Mirai (SPD-163, §3).
 *
 * O backend é um intermediário fino: cada POST faz uma chamada ao Claude e devolve o que veio.
 * Quem conduz é o app. Se a resposta pede ferramentas (`tool_use`), o app executa cada uma no
 * aparelho (`executeMiraiTool`, SQLite + as funções das telas) e manda **todos** os
 * `tool_result` juntos, numa mensagem `user` só, como a API exige. Repete até `end_turn`.
 *
 * O teto: `MIRAI_MAX_TOOL_ROUNDS` rodadas de ferramenta por pergunta. Na última rodada, junto
 * com os resultados, vai o pedido "responda com o que já tem". O servidor aceita no máximo
 * `MIRAI_MAX_TOOL_ROUNDS + 1` POSTs com o mesmo `questionId` — a primeira chamada e uma por
 * rodada —, então não sobra POST para mais nada: se a resposta ainda pedir ferramenta, o
 * ciclo para ali.
 *
 * O histórico guarda o `content` de cada resposta como veio, inclusive os blocos `thinking` e
 * `redacted_thinking` (o raciocínio cifrado): a API confere esses blocos na rodada seguinte. Da
 * resposta, a tela só vê os blocos `text`.
 */

/** O pedido que vai junto com os resultados da última rodada permitida. Vai para o modelo, não para a tela. */
export const MIRAI_FINAL_ROUND_REQUEST =
	'Limite de consultas desta pergunta atingido. Responda com o que já tem, sem pedir mais ferramentas.';

/** Quem fala com as rotas. O de verdade usa o cliente HTTP autenticado do app; os testes passam um falso. */
export interface MiraiTransport {
	status: () => Promise<MiraiStatusResponse>;
	turn: (request: MiraiTurnRequest) => Promise<MiraiTurnResponse>;
}

export const httpTransport: MiraiTransport = {
	status: () => apiRequest<MiraiStatusResponse>('/api/assistant/status', { authenticated: true }),
	turn: (request) =>
		apiRequest<MiraiTurnResponse>('/api/assistant/turn', {
			method: 'POST',
			body: request,
			authenticated: true,
		}),
};

/** O que deu errado, do ponto de vista da tela: cada um tem o seu texto (`mirai.errors.*`). */
export type MiraiFailure = MiraiErrorCode | 'offline' | 'unknown';

const MIRAI_CODES: ReadonlySet<string> = new Set<MiraiErrorCode>([
	'not_enabled',
	'daily_limit',
	'monthly_cap',
	'too_many_rounds',
	'unavailable',
	'bad_request',
]);

export class MiraiError extends Error {
	constructor(readonly failure: MiraiFailure) {
		super(`mirai: ${failure}`);
		this.name = 'MiraiError';
	}
}

/**
 * Traduz a falha de um pedido. O código da API vem antes do "sem rede": o 503 `unavailable` do
 * Mirai (sem chave, a API do Claude falhou) é um 503 com corpo JSON, e o `ApiError` conta todo
 * 503 como gateway fora do ar. Um 503 sem código do Mirai veio do proxy: é rede.
 */
export const failureOf = (error: unknown): MiraiFailure => {
	if (error instanceof MiraiError) return error.failure;
	if (!(error instanceof ApiError)) return 'unknown';
	if (MIRAI_CODES.has(error.code)) return error.code as MiraiErrorCode;
	if (error.isOffline) return 'offline';
	return 'unknown';
};

/** A resposta final de uma pergunta, pronta para a tela. */
export interface MiraiAnswer {
	text: string;
	expression: MiraiExpression;
	/** O modelo recusou (`stop_reason: refusal`): a tela mostra o texto amigável dela. */
	refused: boolean;
	/** O ciclo bateu no teto e a última resposta ainda pedia ferramenta. */
	incomplete: boolean;
	/** A resposta bateu no teto de saída e saiu cortada (SPD-169): a tela avisa no fim. */
	cut: boolean;
}

export interface MiraiQuestionInput {
	/** O histórico da conversa até aqui, no formato da API. */
	history: MiraiMessage[];
	question: string;
	conversationId: string;
	screen: string | null;
	locale: MiraiLocale;
	newId: () => string;
	transport?: MiraiTransport;
	/** Para os testes; o padrão é o `executeMiraiTool` do aparelho. */
	runTool?: (name: MiraiToolName, input: unknown) => Promise<string>;
	/** Avisa a tela de qual ferramenta está rodando agora ("consultando seus lançamentos…"). */
	onTool?: (name: MiraiToolName) => void;
	/** A pergunta foi abandonada ("Parar" ou "Nova conversa"): para antes do próximo POST. */
	isCancelled?: () => boolean;
	/**
	 * Os contextos das perguntas anteriores, como o resultado da última devolveu (SPD-171). O desta
	 * pergunta entra no fim, com a tela, o idioma, a data de agora e o apelido.
	 */
	contexts?: MiraiQuestionContext[];
	/** Como a pessoa quer ser chamada (SPD-163e), ou nulo. */
	name?: string | null;
}

export interface MiraiQuestionResult {
	/** O histórico novo, com a pergunta, as rodadas e a resposta. */
	history: MiraiMessage[];
	/** Os contextos que acompanham `history`: um por pergunta que ficou nele. */
	contexts: MiraiQuestionContext[];
	answer: MiraiAnswer;
	remainingToday: number;
}

const toolUsesOf = (content: MiraiContentBlock[]) =>
	content.filter(
		(block): block is Extract<MiraiContentBlock, { type: 'tool_use' }> => block.type === 'tool_use'
	);

const textOf = (content: MiraiContentBlock[]): string =>
	content
		.filter((block): block is Extract<MiraiContentBlock, { type: 'text' }> => block.type === 'text')
		.map((block) => block.text)
		.join('\n\n')
		.trim();

/** Uma ferramenta que falhou volta como erro para o modelo, sem derrubar a pergunta. */
const errorResult = (id: string, error: string): MiraiContentBlock => ({
	type: 'tool_result',
	tool_use_id: id,
	content: JSON.stringify({ error }),
	is_error: true,
});

/**
 * Executa as ferramentas de uma rodada, uma de cada vez (o SQLite é um só, e a tela mostra uma
 * consulta por vez), e devolve os resultados na ordem dos pedidos.
 */
const runRound = async (
	uses: ReturnType<typeof toolUsesOf>,
	runTool: (name: MiraiToolName, input: unknown) => Promise<string>,
	onTool?: (name: MiraiToolName) => void
): Promise<MiraiContentBlock[]> => {
	const results: MiraiContentBlock[] = [];
	for (const use of uses) {
		if (!isMiraiToolName(use.name)) {
			results.push(errorResult(use.id, 'unknown_tool'));
			continue;
		}
		onTool?.(use.name);
		try {
			results.push({
				type: 'tool_result',
				tool_use_id: use.id,
				content: await runTool(use.name, use.input),
			});
		} catch {
			// A mensagem do erro pode carregar dado do aparelho: para o modelo vai só que falhou.
			results.push(errorResult(use.id, 'tool_failed'));
		}
	}
	return results;
};

export const askMirai = async (input: MiraiQuestionInput): Promise<MiraiQuestionResult> => {
	const transport = input.transport ?? httpTransport;
	const runTool = input.runTool ?? executeMiraiTool;
	const questionId = input.newId();
	const messages: MiraiMessage[] = [...input.history, { role: 'user', content: input.question }];
	const previousContexts = input.contexts ?? [];
	const today = todayISO();
	const context: MiraiQuestionContext = {
		at: input.history.length,
		screen: input.screen,
		locale: input.locale,
		today,
		...(input.name ? { name: input.name } : {}),
	};
	const contexts = [...previousContexts, context];

	const post = async (): Promise<MiraiTurnResponse> => {
		if (input.isCancelled?.()) throw new MiraiError('unknown');
		try {
			return await transport.turn({
				conversationId: input.conversationId,
				questionId,
				messages,
				screen: input.screen,
				locale: input.locale,
				today,
				contexts,
			});
		} catch (error) {
			throw new MiraiError(failureOf(error));
		}
	};

	let rounds = 0;
	let response = await post();

	while (true) {
		messages.push({ role: 'assistant', content: response.content });
		const uses = response.stopReason === 'tool_use' ? toolUsesOf(response.content) : [];
		if (uses.length === 0) break;

		if (rounds >= MIRAI_MAX_TOOL_ROUNDS) {
			// Sem POST sobrando: a pergunta para aqui. O `tool_use` sem resposta não pode ficar no
			// histórico (a próxima pergunta seria recusada pela API), então ele vira o aviso.
			messages.pop();
			const partial = textOf(response.content);
			const tone = readTone(partial);
			messages.push({ role: 'assistant', content: [{ type: 'text', text: partial || '…' }] });
			return {
				history: messages,
				contexts,
				answer: {
					text: tone.text,
					expression: tone.expression,
					refused: false,
					incomplete: true,
					cut: false,
				},
				remainingToday: response.remainingToday,
			};
		}

		const results = await runRound(uses, runTool, input.onTool);
		rounds += 1;
		const content: MiraiContentBlock[] =
			rounds >= MIRAI_MAX_TOOL_ROUNDS
				? [...results, { type: 'text', text: MIRAI_FINAL_ROUND_REQUEST }]
				: results;
		messages.push({ role: 'user', content });
		response = await post();
	}

	if (response.stopReason === 'refusal') {
		// A recusa não fica na conversa: a pergunta seguinte começa do histórico de antes, sem
		// arrastar o pedido recusado para as próximas chamadas.
		return {
			history: [...input.history],
			contexts: previousContexts,
			answer: { text: '', expression: 'normal', refused: true, incomplete: false, cut: false },
			remainingToday: response.remainingToday,
		};
	}

	if (response.stopReason === 'max_tokens') {
		// Cortada pelo teto de saída (SPD-169): fica só o texto que saiu, sem a marca de tom, que
		// faltou. Um bloco cortado no meio (um `tool_use` sem resultado) faria a próxima pergunta ser
		// recusada pela API.
		messages.pop();
		const partial = readTone(textOf(response.content)).text;
		messages.push({ role: 'assistant', content: [{ type: 'text', text: partial || '…' }] });
		return {
			history: messages,
			contexts,
			answer: { text: partial, expression: 'normal', refused: false, incomplete: false, cut: true },
			remainingToday: response.remainingToday,
		};
	}

	const tone = readTone(textOf(response.content));
	return {
		history: messages,
		contexts,
		answer: {
			text: tone.text,
			expression: tone.expression,
			refused: false,
			incomplete: false,
			cut: false,
		},
		remainingToday: response.remainingToday,
	};
};

/**
 * Todo arquivo sob app/ é tratado como rota pelo expo-router, e uma rota sem export
 * default é um módulo quebrado do ponto de vista dele. Este export existe só para
 * satisfazer essa exigência — nada navega para cá.
 */
export default { askMirai, failureOf, httpTransport };
