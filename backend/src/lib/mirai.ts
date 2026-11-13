import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { guidesForPrompt } from '../domain/mirai/guides.js';
import { usdToMicros } from '../domain/mirai/pricing.js';
import { createMirai, type MiraiClaude } from '../domain/mirai/service.js';
import { createQuestionTracker } from '../domain/mirai/usage.js';
import { env } from './env.js';
import { prisma } from './prisma.js';

/**
 * O Mirai do processo (SPD-163): a configuração do `env`, o Prisma, o cliente do SDK e os
 * guias. É o único arquivo que cria o `Anthropic`; o domínio e os testes recebem o cliente
 * por parâmetro, e nenhum teste chega até aqui.
 */

/** Tempo máximo de uma chamada inteira (sem streaming na v1, D4). */
const CLAUDE_TIMEOUT_MS = 60_000;
/** Uma nova tentativa do SDK (conexão, 429, 5xx): o app espera, mas não para sempre. */
const CLAUDE_MAX_RETRIES = 1;

/**
 * Os guias gerados por `scripts/gen-mirai-guides.ts`. Lidos pelo caminho a partir da raiz do
 * backend, que é o diretório de trabalho tanto no `npm run dev` quanto no container (o
 * Dockerfile copia o arquivo para o mesmo caminho). Sem o arquivo, o Mirai responde sem os
 * guias, e a subida avisa.
 */
const GUIDES_PATH = join(process.cwd(), 'src', 'domain', 'mirai', 'guides.pt.md');

const loadGuides = (): string => {
	try {
		return guidesForPrompt(readFileSync(GUIDES_PATH, 'utf8'));
	} catch {
		console.error(
			`Mirai: guias não encontrados em ${GUIDES_PATH}; o assistente responde sem eles.`
		);
		return '(Os guias do app não estão disponíveis.)';
	}
};

const createClaude = (): MiraiClaude | null =>
	env.anthropicApiKey
		? new Anthropic({
				apiKey: env.anthropicApiKey,
				timeout: CLAUDE_TIMEOUT_MS,
				maxRetries: CLAUDE_MAX_RETRIES,
			})
		: null;

export const mirai = createMirai({
	config: {
		userIds: new Set(env.assistantUserIds),
		dailyQuestions: env.assistantDailyQuestions,
		monthlyCapMicros: usdToMicros(env.assistantMonthlyUsd),
		model: env.assistantModel,
		effort: env.assistantEffort,
	},
	db: prisma,
	claude: createClaude(),
	guides: loadGuides(),
	tracker: createQuestionTracker(),
});
