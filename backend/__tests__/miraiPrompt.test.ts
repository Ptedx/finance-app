/**
 * O pedido do Mirai ao Claude (SPD-163a): a instrução fixa, as ferramentas, os guias, a
 * mensagem de contexto e o preço.
 *
 * O que estes testes protegem:
 *
 *  - o prefixo fixo (ferramentas → instrução → guias) sai byte a byte igual, seja qual for a
 *    conversa, a tela ou o idioma, e o `cache_control` fica no fim dele — senão o cache não
 *    lê nada e cada rodada paga o prefixo inteiro;
 *  - as ferramentas são as do contrato, na ordem dele, com `strict: true` e sem as regras de
 *    JSON Schema que o modo estrito não aceita;
 *  - a tela e o idioma vão numa mensagem de sistema depois de cada pergunta, remontada igual a
 *    cada rodada: o histórico da rodada anterior é prefixo do da seguinte;
 *  - os guias saem do i18n do app em ordem fixa, e o arquivo gerado entra no prompt sem o
 *    cabeçalho e sem CRLF;
 *  - o custo de uma chamada sai do `usage`, e o custo máximo do pedido cobre o custo real.
 *
 * Nenhum teste chama a API do Claude.
 *
 * Fora de `src/` de propósito, como os outros testes do servidor (ver `billWire.test.ts`).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIRAI_TONE_PATTERN, MIRAI_TOOLS } from '../src/domain/mirai/contract';
import { GUIDES_FILE_HEADER, guidesForPrompt, renderMiraiGuides } from '../src/domain/mirai/guides';
import {
	costMicros,
	MIRAI_PRICES,
	maxCostMicros,
	tokensOf,
	usdToMicros,
} from '../src/domain/mirai/pricing';
import {
	appContextText,
	buildMiraiRequest,
	MIRAI_API_TOOLS,
	MIRAI_INSTRUCTION,
	MIRAI_MAX_TOKENS,
	withAppContext,
} from '../src/domain/mirai/prompt';
import type { MiraiInputMessage } from '../src/domain/mirai/request';

// Os módulos do Mirai se importam com a extensão `.js` do ESM, que o jest da raiz não resolve
// para o `.ts`: o módulo virtual aponta para o arquivo de verdade (mesmo caso do
// `diagnostics.test.ts`).
jest.mock(
	'../src/domain/mirai/contract.js',
	() => jest.requireActual('../src/domain/mirai/contract'),
	{
		virtual: true,
	}
);
jest.mock(
	'../src/domain/mirai/request.js',
	() => jest.requireActual('../src/domain/mirai/request'),
	{
		virtual: true,
	}
);

const CONFIG = {
	model: 'claude-haiku-5-5',
	effort: 'low' as const,
	guides: '## Guia\n\nTexto do guia.',
};

const question = (text: string): MiraiInputMessage => ({ role: 'user', content: text });
const toolUse = (id: string, name = 'get_month_overview'): MiraiInputMessage => ({
	role: 'assistant',
	content: [
		{ type: 'thinking', thinking: 'pensando', signature: `assinatura-${id}` },
		{ type: 'tool_use', id, name, input: { month: '2026-11' } },
	],
});
const toolResult = (id: string): MiraiInputMessage => ({
	role: 'user',
	content: [{ type: 'tool_result', tool_use_id: id, content: '{"incomeCents":500000}' }],
});
const answer = (text: string): MiraiInputMessage => ({
	role: 'assistant',
	content: [{ type: 'text', text }],
});

/** Toda chave usada em qualquer nível de um valor JSON. */
const keysDeep = (value: unknown): string[] => {
	if (Array.isArray(value)) return value.flatMap(keysDeep);
	if (typeof value !== 'object' || value === null) return [];
	return Object.entries(value).flatMap(([key, inner]) => [key, ...keysDeep(inner)]);
};

/** Todo objeto com `type: 'object'` dentro de um schema. */
const objectSchemas = (value: unknown): Record<string, unknown>[] => {
	if (Array.isArray(value)) return value.flatMap(objectSchemas);
	if (typeof value !== 'object' || value === null) return [];
	const record = value as Record<string, unknown>;
	return [
		...(record['type'] === 'object' ? [record] : []),
		...Object.values(record).flatMap(objectSchemas),
	];
};

const prefixOf = (request: ReturnType<typeof buildMiraiRequest>) =>
	JSON.stringify({ tools: request.tools, system: request.system });

describe('o prefixo fixo', () => {
	it('sai igual byte a byte com conversa, tela e idioma diferentes', () => {
		const one = buildMiraiRequest(CONFIG, {
			messages: [question('Quanto gastei no mercado?')],
			locale: 'pt',
			screen: 'tela-alfa',
		});
		const two = buildMiraiRequest(CONFIG, {
			messages: [question('How much did I spend?'), toolUse('toolu_1'), toolResult('toolu_1')],
			locale: 'en',
			screen: 'tela-beta',
		});

		expect(prefixOf(one)).toBe(prefixOf(two));
		expect(prefixOf(one)).not.toMatch(/tela-alfa|tela-beta|Quanto gastei|How much/);
	});

	it('é ferramentas → instrução → guias, com o cache_control no fim, nos guias', () => {
		const request = buildMiraiRequest(CONFIG, {
			messages: [question('Oi')],
			locale: 'pt',
			screen: null,
		});
		const system = request.system as { type: string; text: string; cache_control?: unknown }[];

		expect(system).toHaveLength(2);
		expect(system[0]).toEqual({ type: 'text', text: MIRAI_INSTRUCTION });
		expect(system[1]?.text).toContain('Texto do guia.');
		expect(system[1]?.cache_control).toEqual({ type: 'ephemeral' });
		expect(request.tools?.some((tool) => 'cache_control' in tool)).toBe(false);
	});

	it('a instrução não tem data, relógio nem dado do usuário', () => {
		expect(MIRAI_INSTRUCTION).not.toMatch(
			/\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{1,2}:\d{2}/
		);
	});

	it('o resto do pedido: modelo, raciocínio adaptativo, esforço, max_tokens 2000, tool_choice auto, sem streaming', () => {
		const request = buildMiraiRequest(CONFIG, {
			messages: [question('Oi')],
			locale: 'pt',
			screen: null,
		});

		expect(request).toMatchObject({
			model: 'claude-haiku-5-5',
			max_tokens: 2000,
			thinking: { type: 'adaptive' },
			output_config: { effort: 'low' },
			tool_choice: { type: 'auto' },
		});
		expect(MIRAI_MAX_TOKENS).toBe(2000);
		expect(request.stream).toBeUndefined();
	});
});

describe('a instrução fixa', () => {
	it('pede a marca de tom do contrato, nos quatro tons', () => {
		for (const tone of ['feliz', 'neutro', 'preocupado', 'triste']) {
			expect(MIRAI_INSTRUCTION).toContain(`[tom: ${tone}]`);
			expect(`Resposta.\n[tom: ${tone}]`).toMatch(MIRAI_TONE_PATTERN);
		}
	});

	it('traz a regra do valor mobiliário (CVM 19) sem tirar o conselho de finanças pessoais', () => {
		expect(MIRAI_INSTRUCTION).toContain('valor mobiliário específico');
		expect(MIRAI_INSTRUCTION).toContain('CVM 19');
		expect(MIRAI_INSTRUCTION).toMatch(/quitar ou manter/i);
		expect(MIRAI_INSTRUCTION).toContain('get_rates');
		expect(MIRAI_INSTRUCTION).toMatch(/Nunca culpe a pessoa/);
	});
});

describe('as ferramentas', () => {
	it('são as do contrato, na ordem dele, todas com strict', () => {
		expect(MIRAI_API_TOOLS.map((tool) => tool.name)).toEqual(MIRAI_TOOLS.map((tool) => tool.name));
		expect(MIRAI_API_TOOLS.every((tool) => tool.strict === true)).toBe(true);
	});

	it('sem minimum, maximum nem pattern (o modo estrito não aceita); a regra vai para a descrição', () => {
		const keys = keysDeep(MIRAI_API_TOOLS.map((tool) => tool.input_schema));

		expect(keys).not.toContain('minimum');
		expect(keys).not.toContain('maximum');
		expect(keys).not.toContain('pattern');
		const limit = (
			MIRAI_API_TOOLS.find((tool) => tool.name === 'list_transactions')?.input_schema
				.properties as Record<string, { description?: string }>
		)['limit'];
		expect(limit?.description).toMatch(/maximum: 100/);
	});

	it('todo objeto fecha additionalProperties e mantém o required do contrato', () => {
		for (const [index, tool] of MIRAI_API_TOOLS.entries()) {
			for (const schema of objectSchemas(tool.input_schema)) {
				expect(schema['additionalProperties']).toBe(false);
			}
			expect(tool.input_schema.required).toEqual(MIRAI_TOOLS[index]?.input_schema.required);
		}
	});
});

describe('a mensagem de contexto (tela e idioma)', () => {
	const context = { role: 'system', content: appContextText('pt', 'cards') };

	it('vem depois da pergunta, e não depois de um tool_result', () => {
		const messages = withAppContext(
			[question('Posso pagar a fatura?'), toolUse('toolu_1'), toolResult('toolu_1')],
			'pt',
			'cards'
		);

		expect(messages.map((message) => message.role)).toEqual([
			'user',
			'system',
			'assistant',
			'user',
		]);
		expect(messages[1]).toEqual(context);
	});

	it('cada rodada remonta o histórico da anterior como prefixo, também na pergunta seguinte', () => {
		const round1 = withAppContext([question('Posso pagar a fatura?')], 'pt', 'cards');
		const round2 = withAppContext(
			[question('Posso pagar a fatura?'), toolUse('toolu_1'), toolResult('toolu_1')],
			'pt',
			'cards'
		);
		const next = withAppContext(
			[
				question('Posso pagar a fatura?'),
				toolUse('toolu_1'),
				toolResult('toolu_1'),
				answer('Pode.'),
				question('E a do mês que vem?'),
			],
			'pt',
			'cards'
		);

		expect(round2.slice(0, round1.length)).toEqual(round1);
		expect(next.slice(0, round2.length)).toEqual(round2);
		expect(next[next.length - 1]).toEqual(context);
	});

	it('depois de uma sequência de mensagens do usuário, uma vez só, no fim dela', () => {
		const messages = withAppContext(
			[
				question('Quanto tenho?'),
				toolUse('toolu_1'),
				toolResult('toolu_1'),
				{ role: 'user', content: [{ type: 'text', text: 'Responda com o que já tem.' }] },
			],
			'it',
			null
		);

		expect(messages.map((message) => message.role)).toEqual([
			'user',
			'system',
			'assistant',
			'user',
			'user',
			'system',
		]);
		expect(messages[5]).toEqual({ role: 'system', content: appContextText('it', null) });
	});

	it('leva só o idioma e o nome da tela', () => {
		expect(appContextText('en', 'cards')).toBe(
			'Contexto do app (não é pergunta da pessoa): idioma en; tela cards.'
		);
		expect(appContextText('pt', null)).toBe(
			'Contexto do app (não é pergunta da pessoa): idioma pt; tela não informada.'
		);
	});

	it('os blocos thinking passam como vieram', () => {
		const [, , assistant] = withAppContext(
			[question('Oi'), toolUse('toolu_9'), toolResult('toolu_9')],
			'pt',
			null
		);

		expect(assistant).toEqual({
			role: 'assistant',
			content: [
				{ type: 'thinking', thinking: 'pensando', signature: 'assinatura-toolu_9' },
				{
					type: 'tool_use',
					id: 'toolu_9',
					name: 'get_month_overview',
					input: { month: '2026-11' },
				},
			],
		});
	});
});

describe('os guias', () => {
	// i18n inventado, com a forma do `pt.ts` do app.
	const i18n = {
		tabs: { home: 'Início' },
		tutorial: {
			howTo: { title: 'Como usar' },
			topics: {
				add: { title: 'Lançar', body: 'Toque no "+".' },
				broken: { title: 'Sem corpo' },
			},
		},
		trails: {
			help: 'Guia passo a passo',
			sample: { tag: 'Exemplo' },
			capture: {
				title: 'Captura',
				steps: {
					ios: { title: 'Só no Android.', body: 'No iPhone, importe o extrato.' },
					'10': { title: 'Décimo', body: 'Corpo dez.' },
					'2': { title: 'Segundo:', body: 'Corpo dois.', missing: 'Cadastre uma conta.' },
					'1': { title: 'Tem algo?', body: 'Corpo um.' },
				},
			},
		},
	};

	it('saem em ordem fixa: Como usar e depois as trilhas, os passos em ordem numérica', () => {
		expect(renderMiraiGuides(i18n)).toBe(
			[
				'## Como usar (Configurações › Como usar)',
				'',
				'### Lançar',
				'',
				'Toque no "+".',
				'',
				'## Guias passo a passo (o "?" de cada tela)',
				'',
				'### Captura',
				'',
				'1. **Tem algo?** Corpo um.',
				'2. **Segundo.** Corpo dois.',
				'   Quando ainda não há nada: Cadastre uma conta.',
				'10. **Décimo.** Corpo dez.',
				'- No iPhone: **Só no Android.** No iPhone, importe o extrato.',
				'',
			].join('\n')
		);
		expect(renderMiraiGuides(i18n)).toBe(renderMiraiGuides(JSON.parse(JSON.stringify(i18n))));
	});

	it('um i18n sem tutorial.topics ou trails não gera arquivo', () => {
		expect(() => renderMiraiGuides({ trails: {} })).toThrow();
		expect(() => renderMiraiGuides(null)).toThrow();
	});

	it('o arquivo entra no prompt sem o cabeçalho e sem CRLF', () => {
		const file = `${GUIDES_FILE_HEADER}\r\n\r\n## Como usar\r\n\r\nTexto.\r\n`;

		expect(guidesForPrompt(file)).toBe('## Como usar\n\nTexto.');
	});

	it('o guides.pt.md gerado está no lugar, com as duas partes', () => {
		const file = readFileSync(
			join(__dirname, '..', 'src', 'domain', 'mirai', 'guides.pt.md'),
			'utf8'
		);
		const prompt = guidesForPrompt(file);

		expect(file.startsWith(GUIDES_FILE_HEADER)).toBe(true);
		expect(prompt).toContain('## Como usar (Configurações › Como usar)');
		expect(prompt).toContain('## Guias passo a passo');
		expect(prompt).not.toContain('\r');
		expect(prompt).not.toContain('{{');
	});
});

describe('o preço', () => {
	it('é o do Haiku 5.5, com a data, em micro-US$ por milhão de tokens', () => {
		expect(MIRAI_PRICES).toEqual({
			model: 'claude-haiku-5-5',
			checkedOn: '2026-11-12',
			inputPerMTok: 100_000,
			outputPerMTok: 500_000,
			cacheWritePerMTok: 125_000,
			cacheReadPerMTok: 10_000,
		});
		expect(usdToMicros(20)).toBe(20_000_000);
	});

	it('uma chamada custa entrada + saída + escrita e leitura de cache, cada um ao seu preço', () => {
		const tokens = tokensOf({
			input_tokens: 1000,
			output_tokens: 500,
			cache_creation_input_tokens: 12_000,
			cache_read_input_tokens: null,
		});

		// 1000 × 0,10 + 500 × 0,50 + 12000 × 0,125 = 100 + 250 + 1500 micro-US$.
		expect(tokens).toEqual({
			inputTokens: 1000,
			outputTokens: 500,
			cacheReadTokens: 0,
			cacheWriteTokens: 12_000,
		});
		expect(costMicros(tokens)).toBe(1850);
		// 300 × 0,10 + 200 × 0,50 + 12000 × 0,01 = 30 + 100 + 120.
		expect(
			costMicros(
				tokensOf({ input_tokens: 300, output_tokens: 200, cache_read_input_tokens: 12_000 })
			)
		).toBe(250);
		// Fração de micro-US$ arredonda para cima.
		expect(costMicros(tokensOf({ input_tokens: 1, output_tokens: 0 }))).toBe(1);
	});

	it('o custo máximo do pedido cobre o pior caso: cada byte um token a preço de escrita, e a saída inteira', () => {
		const request = buildMiraiRequest(CONFIG, {
			messages: [question('Quanto gastei?')],
			locale: 'pt',
			screen: null,
		});
		const bytes = Buffer.byteLength(JSON.stringify(request), 'utf8');
		const worst = costMicros({
			inputTokens: 0,
			outputTokens: MIRAI_MAX_TOKENS,
			cacheReadTokens: 0,
			cacheWriteTokens: bytes,
		});

		expect(maxCostMicros(request)).toBeGreaterThanOrEqual(worst);
		// E não é absurdo: abaixo de US$ 0,05 para uma pergunta curta.
		expect(maxCostMicros(request)).toBeLessThan(50_000);
	});
});
