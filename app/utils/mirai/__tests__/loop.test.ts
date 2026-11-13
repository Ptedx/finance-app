/**
 * O ciclo de rodadas do Mirai (SPD-163, §3), contra um servidor falso.
 *
 * O servidor falso responde o que o roteiro manda e guarda uma cópia de cada pedido (o ciclo
 * continua mexendo no histórico depois do POST; o fetch de verdade serializa na hora). As
 * ferramentas também são falsas: `tools.ts` é do SPD-163b, e aqui só importa o que o ciclo faz
 * com o resultado delas. Nada chama servidor de verdade: o `apiRequest` é um mock.
 */

jest.mock('../tools', () => ({
	executeMiraiTool: jest.fn(async (name: string) => JSON.stringify({ tool: name })),
}));

jest.mock('../../../api/client', () => ({
	...jest.requireActual('../../../api/client'),
	apiRequest: jest.fn(async () => ({})),
}));

import { ApiError, apiRequest } from '../../../api/client';
import {
	MIRAI_MAX_TOOL_ROUNDS,
	type MiraiContentBlock,
	type MiraiMessage,
	type MiraiTurnRequest,
	type MiraiTurnResponse,
} from '../contract';
import {
	askMirai,
	failureOf,
	httpTransport,
	MIRAI_FINAL_ROUND_REQUEST,
	MiraiError,
	type MiraiQuestionInput,
	type MiraiTransport,
} from '../loop';
import { executeMiraiTool } from '../tools';

const toolUse = (id: string, name: string, input: unknown = {}): MiraiContentBlock => ({
	type: 'tool_use',
	id,
	name,
	input,
});
const text = (value: string): MiraiContentBlock => ({ type: 'text', text: value });
const thinking: MiraiContentBlock = {
	type: 'thinking',
	thinking: 'Preciso do mês.',
	signature: 'assinatura-1',
};

const reply = (
	content: MiraiContentBlock[],
	stopReason: MiraiTurnResponse['stopReason'],
	remainingToday = 40
): MiraiTurnResponse => ({ content, stopReason, remainingToday });

/** Um servidor falso que responde em ordem e guarda os pedidos como chegaram. */
const fakeServer = (
	script: Array<MiraiTurnResponse | Error | ((n: number) => MiraiTurnResponse)>
) => {
	const requests: MiraiTurnRequest[] = [];
	const transport: MiraiTransport = {
		status: jest.fn(async () => ({ enabled: true, remainingToday: 50 })),
		turn: jest.fn(async (request: MiraiTurnRequest) => {
			requests.push(JSON.parse(JSON.stringify(request)));
			const step = script[Math.min(requests.length - 1, script.length - 1)];
			if (step instanceof Error) throw step;
			return typeof step === 'function' ? step(requests.length) : step;
		}),
	};
	return { transport, requests };
};

let ids = 0;
const newId = () => {
	ids += 1;
	return `id-${ids}`;
};

const input = (
	transport: MiraiTransport,
	extra: Partial<MiraiQuestionInput> = {}
): MiraiQuestionInput => ({
	history: [],
	question: 'Por que sobrou menos este mês?',
	conversationId: 'conversa-1',
	screen: 'home',
	locale: 'pt',
	newId,
	transport,
	...extra,
});

/** Todo `tool_use` do histórico tem o `tool_result` na mensagem seguinte. */
const everyToolUseAnswered = (history: MiraiMessage[]) =>
	history.every((message, index) => {
		if (message.role !== 'assistant' || typeof message.content === 'string') return true;
		const uses = message.content.filter((block) => block.type === 'tool_use');
		if (uses.length === 0) return true;
		const next = history[index + 1];
		if (!next || typeof next.content === 'string') return false;
		const answered = new Set(
			next.content.flatMap((block) => (block.type === 'tool_result' ? [block.tool_use_id] : []))
		);
		return uses.every((use) => use.type === 'tool_use' && answered.has(use.id));
	});

beforeEach(() => {
	ids = 0;
	jest.clearAllMocks();
});

describe('askMirai: o ciclo', () => {
	it('tool_use → tool_result → end_turn, com o histórico como veio (inclusive thinking)', async () => {
		const first = reply(
			[thinking, toolUse('tu-1', 'get_month_overview', { month: '2026-11' })],
			'tool_use',
			41
		);
		const { transport, requests } = fakeServer([
			first,
			reply(
				[text('Sobrou menos porque o mercado subiu R$ 300,00.\n[tom: preocupado]')],
				'end_turn',
				41
			),
		]);
		const runTool = jest.fn(async () => '{"incomeCents":500000}');

		const result = await askMirai(input(transport, { runTool }));

		expect(requests).toHaveLength(2);
		expect(requests[0]).toEqual({
			conversationId: 'conversa-1',
			questionId: 'id-1',
			messages: [{ role: 'user', content: 'Por que sobrou menos este mês?' }],
			screen: 'home',
			locale: 'pt',
		});
		expect(runTool).toHaveBeenCalledWith('get_month_overview', { month: '2026-11' });
		expect(requests[1].questionId).toBe('id-1');
		expect(requests[1].messages).toEqual([
			{ role: 'user', content: 'Por que sobrou menos este mês?' },
			{ role: 'assistant', content: first.content },
			{
				role: 'user',
				content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: '{"incomeCents":500000}' }],
			},
		]);
		expect(result.answer).toEqual({
			text: 'Sobrou menos porque o mercado subiu R$ 300,00.',
			expression: 'worried',
			refused: false,
			incomplete: false,
		});
		expect(result.remainingToday).toBe(41);
		// A resposta final entra no histórico como veio, com a marca: é o que o modelo escreveu.
		expect(result.history).toEqual([
			...requests[1].messages,
			{
				role: 'assistant',
				content: [text('Sobrou menos porque o mercado subiu R$ 300,00.\n[tom: preocupado]')],
			},
		]);
	});

	it('redacted_thinking volta no histórico exatamente como veio, e nada dele vai para a resposta', async () => {
		const redacted: MiraiContentBlock = { type: 'redacted_thinking', data: 'Q2lmcmFkbw==' };
		const first = reply([redacted, thinking, toolUse('tu-1', 'get_accounts')], 'tool_use');
		const last = reply(
			[redacted, text('Você tem R$ 1.000,00 em conta. [tom: neutro]')],
			'end_turn'
		);
		const { transport, requests } = fakeServer([first, last]);

		const result = await askMirai(input(transport));

		expect(requests[1].messages[1]).toEqual({
			role: 'assistant',
			content: [redacted, thinking, first.content[2]],
		});
		expect(result.history[result.history.length - 1]).toEqual({
			role: 'assistant',
			content: last.content,
		});
		expect(result.answer.text).toBe('Você tem R$ 1.000,00 em conta.');
		expect(JSON.stringify(result.answer)).not.toContain('Q2lmcmFkbw');
	});

	it('várias ferramentas numa rodada: todas executadas, e todos os tool_result juntos numa mensagem user', async () => {
		const { transport, requests } = fakeServer([
			reply(
				[
					toolUse('a', 'get_accounts'),
					toolUse('b', 'get_cards'),
					toolUse('c', 'get_bills', { from: '2026-11-10', to: '2026-11-16' }),
				],
				'tool_use'
			),
			reply([text('Dá, com folga de R$ 80,00. [tom: feliz]')], 'end_turn'),
		]);
		const onTool = jest.fn();

		const result = await askMirai(input(transport, { onTool }));

		expect(executeMiraiTool).toHaveBeenCalledTimes(3);
		expect(onTool.mock.calls.map(([name]) => name)).toEqual([
			'get_accounts',
			'get_cards',
			'get_bills',
		]);
		expect(requests).toHaveLength(2);
		const results = requests[1].messages[2];
		expect(results.role).toBe('user');
		expect(results.content).toEqual([
			{ type: 'tool_result', tool_use_id: 'a', content: '{"tool":"get_accounts"}' },
			{ type: 'tool_result', tool_use_id: 'b', content: '{"tool":"get_cards"}' },
			{ type: 'tool_result', tool_use_id: 'c', content: '{"tool":"get_bills"}' },
		]);
		expect(result.answer.expression).toBe('happy');
	});

	it('ferramenta que falha e ferramenta fora da lista voltam como erro, sem a mensagem do erro', async () => {
		const { transport, requests } = fakeServer([
			reply([toolUse('a', 'get_debts'), toolUse('b', 'delete_everything')], 'tool_use'),
			reply([text('Não consegui ver as dívidas.')], 'end_turn'),
		]);
		const runTool = jest.fn(async () => {
			throw new Error('SQLITE: conta 0001-2 de Fulano');
		});

		await askMirai(input(transport, { runTool }));

		expect(runTool).toHaveBeenCalledTimes(1);
		expect(requests[1].messages[2].content).toEqual([
			{ type: 'tool_result', tool_use_id: 'a', content: '{"error":"tool_failed"}', is_error: true },
			{
				type: 'tool_result',
				tool_use_id: 'b',
				content: '{"error":"unknown_tool"}',
				is_error: true,
			},
		]);
		expect(JSON.stringify(requests)).not.toContain('Fulano');
	});

	it(`teto de ${MIRAI_MAX_TOOL_ROUNDS} rodadas: a última leva o "responda com o que já tem", e não há POST além do permitido`, async () => {
		const { transport, requests } = fakeServer([
			(n) => reply([toolUse(`tu-${n}`, 'list_transactions')], 'tool_use'),
		]);

		const result = await askMirai(input(transport));

		// A primeira chamada e uma por rodada: o máximo que o servidor aceita por pergunta.
		expect(requests).toHaveLength(MIRAI_MAX_TOOL_ROUNDS + 1);
		expect(executeMiraiTool).toHaveBeenCalledTimes(MIRAI_MAX_TOOL_ROUNDS);
		const lastOf = (request: MiraiTurnRequest) => request.messages[request.messages.length - 1];
		for (const request of requests.slice(1, -1))
			expect(JSON.stringify(lastOf(request))).not.toContain(MIRAI_FINAL_ROUND_REQUEST);
		const last = lastOf(requests[requests.length - 1]);
		expect(last.role).toBe('user');
		expect(last.content).toEqual([
			{
				type: 'tool_result',
				tool_use_id: `tu-${MIRAI_MAX_TOOL_ROUNDS}`,
				content: '{"tool":"list_transactions"}',
			},
			{ type: 'text', text: MIRAI_FINAL_ROUND_REQUEST },
		]);
		expect(new Set(requests.map((request) => request.questionId))).toEqual(new Set(['id-1']));
		expect(result.answer.incomplete).toBe(true);
		// Sem tool_use pendurado: a próxima pergunta não seria aceita pela API.
		expect(everyToolUseAnswered(result.history)).toBe(true);
		expect(result.history[result.history.length - 1].role).toBe('assistant');
	});

	it('no teto, se a última chamada responde, a resposta vale normalmente', async () => {
		const { transport, requests } = fakeServer([
			(n) =>
				n <= MIRAI_MAX_TOOL_ROUNDS
					? reply([toolUse(`tu-${n}`, 'get_health')], 'tool_use')
					: reply([text('Sua nota é 72. [tom: neutro]')], 'end_turn'),
		]);

		const result = await askMirai(input(transport));

		expect(requests).toHaveLength(MIRAI_MAX_TOOL_ROUNDS + 1);
		expect(result.answer).toEqual({
			text: 'Sua nota é 72.',
			expression: 'normal',
			refused: false,
			incomplete: false,
		});
		expect(everyToolUseAnswered(result.history)).toBe(true);
	});

	it('cada pergunta tem questionId novo; a conversa mantém o conversationId e o histórico', async () => {
		const { transport, requests } = fakeServer([reply([text('Oi. [tom: neutro]')], 'end_turn')]);

		const first = await askMirai(input(transport, { question: 'Primeira' }));
		await askMirai(input(transport, { question: 'Segunda', history: first.history }));

		expect(requests.map((request) => request.questionId)).toEqual(['id-1', 'id-2']);
		expect(requests.map((request) => request.conversationId)).toEqual(['conversa-1', 'conversa-1']);
		expect(requests[1].messages).toEqual([
			{ role: 'user', content: 'Primeira' },
			{ role: 'assistant', content: [text('Oi. [tom: neutro]')] },
			{ role: 'user', content: 'Segunda' },
		]);
	});

	it('refusal vira resposta recusada, e a pergunta recusada não fica no histórico', async () => {
		const history: MiraiMessage[] = [
			{ role: 'user', content: 'Antes' },
			{ role: 'assistant', content: [text('Ok.')] },
		];
		const { transport } = fakeServer([reply([], 'refusal', 12)]);

		const result = await askMirai(input(transport, { history, question: 'Compro a ação X?' }));

		expect(result.answer).toEqual({
			text: '',
			expression: 'normal',
			refused: true,
			incomplete: false,
		});
		expect(result.history).toEqual(history);
		expect(result.remainingToday).toBe(12);
	});

	it('não mexe no histórico de quem chamou', async () => {
		const history: MiraiMessage[] = [
			{ role: 'user', content: 'Antes' },
			{ role: 'assistant', content: [text('Ok.')] },
		];
		const snapshot = JSON.parse(JSON.stringify(history));
		const { transport } = fakeServer([
			reply([toolUse('a', 'get_rates')], 'tool_use'),
			new ApiError(503, 'Indisponível.', 'unavailable'),
		]);

		await expect(askMirai(input(transport, { history }))).rejects.toEqual(
			new MiraiError('unavailable')
		);
		expect(history).toEqual(snapshot);
	});

	it('pergunta abandonada (a conversa fechou) não faz o próximo POST', async () => {
		let cancelled = false;
		const { transport, requests } = fakeServer([
			reply([toolUse('a', 'get_rates')], 'tool_use'),
			reply([text('Nunca chega.')], 'end_turn'),
		]);
		const runTool = jest.fn(async () => {
			cancelled = true;
			return '{}';
		});

		await expect(
			askMirai(input(transport, { runTool, isCancelled: () => cancelled }))
		).rejects.toBeInstanceOf(MiraiError);
		expect(requests).toHaveLength(1);
	});
});

describe('askMirai: erros', () => {
	it.each([
		[new ApiError(429, 'Limite do dia.', 'daily_limit'), 'daily_limit'],
		[new ApiError(429, 'Teto do mês.', 'monthly_cap'), 'monthly_cap'],
		[new ApiError(429, 'Rodadas demais.', 'too_many_rounds'), 'too_many_rounds'],
		[new ApiError(403, 'Fora da lista.', 'not_enabled'), 'not_enabled'],
		[new ApiError(400, 'Corpo inválido.', 'bad_request'), 'bad_request'],
		// O 503 do Mirai tem código e não é "sem rede", embora o ApiError conte 503 como gateway.
		[new ApiError(503, 'Indisponível.', 'unavailable'), 'unavailable'],
		[new ApiError(503, 'O servidor não está respondendo.', 'gateway_unreachable'), 'offline'],
		[new ApiError(0, 'Sem conexão com o servidor.', 'offline'), 'offline'],
		[new ApiError(500, 'Erro no servidor.', 'error'), 'unknown'],
		[new Error('qualquer coisa'), 'unknown'],
	] as const)('%p vira %s', async (error, failure) => {
		const { transport } = fakeServer([error]);
		await expect(askMirai(input(transport))).rejects.toEqual(new MiraiError(failure));
		expect(failureOf(error)).toBe(failure);
	});

	it('erro no meio do ciclo também sobe como falha da pergunta', async () => {
		const { transport, requests } = fakeServer([
			reply([toolUse('a', 'get_cards')], 'tool_use'),
			new ApiError(429, 'Limite do dia.', 'daily_limit'),
		]);
		await expect(askMirai(input(transport))).rejects.toEqual(new MiraiError('daily_limit'));
		expect(requests).toHaveLength(2);
	});
});

describe('httpTransport', () => {
	it('fala com as rotas do contrato pelo cliente autenticado do app', async () => {
		const request: MiraiTurnRequest = {
			conversationId: 'c',
			questionId: 'q',
			messages: [{ role: 'user', content: 'Oi' }],
			screen: null,
			locale: 'en',
		};
		await httpTransport.status();
		await httpTransport.turn(request);
		expect(apiRequest).toHaveBeenNthCalledWith(1, '/api/assistant/status', { authenticated: true });
		expect(apiRequest).toHaveBeenNthCalledWith(2, '/api/assistant/turn', {
			method: 'POST',
			body: request,
			authenticated: true,
		});
	});
});
