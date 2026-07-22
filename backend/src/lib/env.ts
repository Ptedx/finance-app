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
} as const;

export const isProduction = env.nodeEnv === 'production';
