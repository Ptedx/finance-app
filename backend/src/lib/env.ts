import 'dotenv/config';

/**
 * Configuração lida uma vez, na subida.
 *
 * Um segredo ausente derruba o processo aqui em vez de virar um `undefined` que o
 * `jsonwebtoken` aceita silenciosamente — o pior desfecho possível seria a API subir
 * em produção assinando tokens com uma chave vazia.
 */
const required = (name: string): string => {
	const value = process.env[name];

	if (!value) {
		throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
	}

	return value;
};

const optionalNumber = (name: string, fallback: number): number => {
	const raw = process.env[name];
	if (!raw) return fallback;

	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) {
		throw new Error(`Variável de ambiente ${name} não é um número: ${raw}`);
	}

	return parsed;
};

/** Lista separada por vírgula, sem vazios nem espaços nas pontas. */
const list = (name: string): string[] =>
	(process.env[name] ?? '')
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean);

const ASSISTANT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type AssistantEffort = (typeof ASSISTANT_EFFORTS)[number];

/** O esforço do Mirai: um valor fora da lista derruba a subida, como um número inválido. */
const assistantEffort = (): AssistantEffort => {
	const raw = process.env['ASSISTANT_EFFORT'];
	if (!raw) return 'low';
	const effort = ASSISTANT_EFFORTS.find((value) => value === raw);
	if (!effort) {
		throw new Error(`Variável de ambiente ASSISTANT_EFFORT inválida: ${raw}`);
	}
	return effort;
};

export const env = {
	nodeEnv: process.env['NODE_ENV'] ?? 'development',
	port: optionalNumber('PORT', 3009),
	databaseUrl: required('DATABASE_URL'),
	jwtSecret: required('JWT_SECRET'),

	/** Access token curto: o refresh é que carrega a sessão longa. */
	accessTokenTtl: process.env['ACCESS_TOKEN_TTL'] ?? '15m',
	refreshTokenDays: optionalNumber('REFRESH_TOKEN_DAYS', 30),

	/**
	 * Origens aceitas pelo CORS. Vazio = qualquer uma, que é o certo para um app
	 * nativo: o React Native não manda `Origin` e não existe navegador para proteger.
	 * Preencher só quando existir um front web.
	 */
	corsOrigins: (process.env['CORS_ORIGINS'] ?? '')
		.split(',')
		.map((origin) => origin.trim())
		.filter(Boolean),

	/**
	 * Teto de linhas por requisição de sync, nas duas direções.
	 *
	 * Segura tanto a memória do servidor quanto o tamanho do corpo: um usuário com anos
	 * de lançamentos faz o primeiro sync em várias páginas em vez de num payload único
	 * que o proxy recusaria.
	 */
	syncPageSize: optionalNumber('SYNC_PAGE_SIZE', 500),

	/**
	 * Mirai, o assistente (SPD-163). Sem a chave a API sobe igual e as rotas do assistente
	 * respondem 503 `unavailable`: a chave é posta à mão no `.env` da VM.
	 */
	anthropicApiKey: process.env['ANTHROPIC_API_KEY'] ?? '',
	/** Ids internos (`users.id`) com o Mirai ligado. Vazio = ninguém (D1). */
	assistantUserIds: list('ASSISTANT_USER_IDS'),
	/** Teto mensal geral, de todos os usuários juntos, em US$ (D7). */
	assistantMonthlyUsd: optionalNumber('ASSISTANT_MONTHLY_USD', 20),
	/** Perguntas por dia por usuário (D7). Uma pergunta conta uma vez, com quantas buscas tiver. */
	assistantDailyQuestions: optionalNumber('ASSISTANT_DAILY_QUESTIONS', 50),
	assistantModel: process.env['ASSISTANT_MODEL'] || 'claude-haiku-5-5',
	assistantEffort: assistantEffort(),
} as const;

export const isProduction = env.nodeEnv === 'production';
