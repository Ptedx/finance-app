import type Anthropic from '@anthropic-ai/sdk';
import {
	MIRAI_MAX_TOOL_ROUNDS,
	type MiraiContentBlock,
	type MiraiErrorCode,
	type MiraiStatusResponse,
	type MiraiTurnResponse,
} from './contract.js';
import { costMicros, maxCostMicros, tokensOf } from './pricing.js';
import { buildMiraiRequest, type MiraiEffort, type MiraiRequest } from './prompt.js';
import { parseTurnRequest } from './request.js';
import {
	type MiraiUsageDb,
	miraiDay,
	type QuestionTracker,
	questionsToday,
	recordUsage,
	spentThisMonth,
} from './usage.js';

/**
 * As duas rotas do Mirai (SPD-163), sem Express: `status` e `turn` recebem o usuário do
 * token e devolvem o corpo da resposta, ou lançam `MiraiError` com o status e o código do
 * contrato.
 *
 * Cada `turn` faz **uma** chamada ao Claude; quem conduz o ciclo de rodadas é o app. As
 * recusas vêm nesta ordem, e a primeira que valer responde:
 *
 *  1. fora de `ASSISTANT_USER_IDS`: 403 `not_enabled`;
 *  2. corpo inválido ou ferramenta fora da lista: 400 `bad_request`;
 *  3. pergunta nova com as do dia esgotadas: 429 `daily_limit`;
 *  4. o gasto do mês mais o custo máximo desta chamada passa do teto: 429 `monthly_cap`;
 *  5. a pergunta já fez `MIRAI_MAX_TOOL_ROUNDS + 1` chamadas: 429 `too_many_rounds`;
 *  6. sem a chave: 503 `unavailable`.
 *
 * Nada de conteúdo sai daqui para o log: só contadores (`log`).
 */

/** O pedaço do SDK que o Mirai usa. O `Anthropic` do SDK o satisfaz; os testes passam um falso. */
export interface MiraiClaude {
	messages: {
		create(
			body: MiraiRequest,
			options?: { timeout?: number; maxRetries?: number }
		): PromiseLike<Anthropic.Messages.Message>;
	};
}

export class MiraiError extends Error {
	constructor(
		readonly status: number,
		readonly code: MiraiErrorCode,
		message: string
	) {
		super(message);
		this.name = 'MiraiError';
	}
}

/** As mensagens fixas de cada recusa: o app escolhe o texto da tela pelo `code`. */
const REFUSALS: Record<MiraiErrorCode, { status: number; message: string }> = {
	not_enabled: { status: 403, message: 'O Mirai não está ligado para esta conta.' },
	bad_request: { status: 400, message: 'Pedido inválido.' },
	daily_limit: { status: 429, message: 'As perguntas de hoje acabaram.' },
	monthly_cap: { status: 429, message: 'O Mirai atingiu o teto de uso deste mês.' },
	too_many_rounds: { status: 429, message: 'Esta pergunta já fez buscas demais.' },
	unavailable: { status: 503, message: 'O Mirai está indisponível agora.' },
};

const refuse = (code: MiraiErrorCode): MiraiError =>
	new MiraiError(REFUSALS[code].status, code, REFUSALS[code].message);

export interface MiraiConfig {
	/** Ids internos com o Mirai ligado. */
	userIds: ReadonlySet<string>;
	dailyQuestions: number;
	monthlyCapMicros: number;
	model: string;
	effort: MiraiEffort;
}

export interface MiraiDeps {
	config: MiraiConfig;
	db: MiraiUsageDb;
	/** `null` sem `ANTHROPIC_API_KEY`: as chamadas respondem 503. */
	claude: MiraiClaude | null;
	/** O texto dos guias, já pronto para o prompt (`guidesForPrompt`). */
	guides: string;
	tracker: QuestionTracker;
	now?: () => Date;
	/** Uma linha de contadores por chamada. Nunca recebe conteúdo. */
	log?: (line: string) => void;
}

/** Um bloco da resposta (o contrato já inclui o `redacted_thinking`). */
export type MiraiResponseBlock = MiraiContentBlock;

/**
 * O conteúdo da resposta no formato do contrato, sem os campos que o app não usa
 * (`citations`, `caller`). O `thinking` volta com o texto e a assinatura exatos: o app o
 * devolve no histórico como veio.
 */
const toContract = (block: Anthropic.Messages.ContentBlock): MiraiResponseBlock | null => {
	switch (block.type) {
		case 'text':
			return { type: 'text', text: block.text };
		case 'thinking':
			return { type: 'thinking', thinking: block.thinking, signature: block.signature };
		case 'redacted_thinking':
			return { type: 'redacted_thinking', data: block.data };
		case 'tool_use':
			return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
		default:
			// O Mirai não usa ferramentas do servidor: nenhum outro bloco é esperado.
			return null;
	}
};

/**
 * O `stop_reason` da API no vocabulário do contrato. `refusal` volta como veio: o app o
 * trata. O Mirai não usa `stop_sequences`; estourar o contexto é, para o app, o mesmo que
 * estourar o `max_tokens`.
 */
const toStopReason = (
	reason: Anthropic.Messages.StopReason | null
): MiraiTurnResponse['stopReason'] => {
	switch (reason) {
		case 'tool_use':
		case 'max_tokens':
		case 'refusal':
		case 'pause_turn':
			return reason;
		case 'model_context_window_exceeded':
			return 'max_tokens';
		default:
			return 'end_turn';
	}
};

const writeStdout = (line: string): void => {
	process.stdout.write(`${line}\n`);
};

/** O status HTTP de um erro do SDK, se houver. Nunca a mensagem: ela pode citar o pedido. */
const statusOf = (error: unknown): number | null => {
	const status =
		typeof error === 'object' && error !== null ? (error as { status?: unknown }).status : null;
	return typeof status === 'number' ? status : null;
};

export interface MiraiTurnResult extends Omit<MiraiTurnResponse, 'content'> {
	content: MiraiResponseBlock[];
}

export const createMirai = (deps: MiraiDeps) => {
	const { config, db, claude, guides, tracker } = deps;
	const now = deps.now ?? (() => new Date());
	const log = deps.log ?? writeStdout;
	const remaining = (used: number): number => Math.max(0, config.dailyQuestions - used);

	const status = async (userId: string): Promise<MiraiStatusResponse> => {
		if (!config.userIds.has(userId)) return { enabled: false, remainingToday: 0 };
		return {
			enabled: true,
			remainingToday: remaining(await questionsToday(db, userId, miraiDay(now()))),
		};
	};

	const turn = async (userId: string, body: unknown): Promise<MiraiTurnResult> => {
		if (!config.userIds.has(userId)) throw refuse('not_enabled');

		const input = parseTurnRequest(body);
		if (!input) throw refuse('bad_request');

		const day = miraiDay(now());
		const request = buildMiraiRequest(
			{ model: config.model, effort: config.effort, guides },
			{ messages: input.messages, locale: input.locale, screen: input.screen }
		);
		const [asked, spent] = await Promise.all([
			questionsToday(db, userId, day),
			spentThisMonth(db, day),
		]);

		// Daqui até o `start` não há `await`: a conferência e a contagem da rodada não se
		// intercalam com outra requisição da mesma pergunta.
		const rounds = tracker.rounds(userId, input.questionId);
		const newQuestion = rounds === 0;
		if (newQuestion && asked >= config.dailyQuestions) throw refuse('daily_limit');
		if (spent + maxCostMicros(request) > config.monthlyCapMicros) throw refuse('monthly_cap');
		if (rounds >= MIRAI_MAX_TOOL_ROUNDS + 1) throw refuse('too_many_rounds');
		if (!claude) throw refuse('unavailable');
		tracker.start(userId, input.questionId);

		let message: Anthropic.Messages.Message;
		try {
			message = await claude.messages.create(request);
		} catch (error) {
			tracker.undo(userId, input.questionId);
			log(JSON.stringify({ event: 'mirai_api_error', userId, status: statusOf(error) }));
			throw refuse('unavailable');
		}

		const tokens = tokensOf(message.usage);
		const cost = costMicros(tokens);
		const stopReason = toStopReason(message.stop_reason);
		try {
			await recordUsage(db, { userId, day, newQuestion, tokens, costMicros: cost });
		} catch (error) {
			// A resposta já foi paga: perdê-la por um erro na soma seria pagar duas vezes.
			log(JSON.stringify({ event: 'mirai_usage_error', userId, status: statusOf(error) }));
		}
		log(
			JSON.stringify({
				event: 'mirai_turn',
				userId,
				round: rounds + 1,
				newQuestion,
				stopReason,
				...tokens,
				costMicros: cost,
			})
		);

		return {
			content: message.content
				.map(toContract)
				.filter((block): block is MiraiResponseBlock => block !== null),
			stopReason,
			remainingToday: remaining(asked + (newQuestion ? 1 : 0)),
		};
	};

	return { status, turn };
};

export type Mirai = ReturnType<typeof createMirai>;
