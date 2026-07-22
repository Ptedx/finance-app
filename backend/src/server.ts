import cors from 'cors';
import express, { type Request, type Response } from 'express';
import helmet from 'helmet';
import { env } from './lib/env.js';
import { disconnectPrisma, prisma } from './lib/prisma.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import routes from './routes/index.js';

const app = express();

// A API roda atrás do nginx da VM. Sem isto, `req.ip` é sempre o do proxy e o
// rate-limit trataria todos os usuários como um só cliente.
app.set('trust proxy', 1);

app.use(helmet());
app.use(cors(env.corsOrigins.length > 0 ? { origin: env.corsOrigins } : {}));

// Uma remessa de sync cheia passa bem do 100kb padrão do Express.
app.use(express.json({ limit: '5mb' }));

app.use('/api', routes);

/**
 * Health check do container e do nginx.
 *
 * Consulta o banco de propósito: um processo que responde mas perdeu o Postgres está
 * fora do ar para todo efeito prático, e um "ok" nesse estado esconde a falha.
 */
app.get('/health', async (_req: Request, res: Response) => {
	try {
		await prisma.$queryRaw`SELECT 1`;
		res.status(200).json({ status: 'ok', message: 'Spendr API is running!' });
	} catch (error) {
		console.error('Health check falhou:', error);
		res.status(503).json({ status: 'degraded', message: 'Banco de dados indisponível.' });
	}
});

app.use(notFoundHandler);
app.use(errorHandler);

const server = app.listen(env.port, () => {
	console.log(`🚀 Spendr API ouvindo na porta ${env.port} (${env.nodeEnv})`);
});

// Docker manda SIGTERM ao parar: fechar o servidor e o pool antes de sair evita
// derrubar requisições em andamento a cada deploy.
const shutdown = (signal: string) => {
	console.log(`${signal} recebido, encerrando...`);
	server.close(() => {
		disconnectPrisma()
			.catch((error) => console.error('Erro ao desconectar do banco:', error))
			.finally(() => process.exit(0));
	});
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
