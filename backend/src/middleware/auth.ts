import type { NextFunction, Request, Response } from 'express';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { env } from '../lib/env.js';
import { prisma } from '../lib/prisma.js';
import { asyncHandler, unauthorized } from './error.js';

export interface AuthenticatedRequest extends Request {
	/** Preenchido pelo `requireAuth`. Única fonte de identidade das rotas protegidas. */
	userId: string;
}

interface AccessTokenPayload {
	sub: string;
}

/**
 * `expiresIn` do jsonwebtoken é um literal como '15m', tipado por uma união fechada que
 * uma string de ambiente não satisfaz sozinha. O valor é validado na prática pela
 * própria biblioteca, que lança se o formato não for reconhecido.
 */
type ExpiresIn = NonNullable<jwt.SignOptions['expiresIn']>;

export const signAccessToken = (userId: string): string =>
	jwt.sign({ sub: userId } satisfies AccessTokenPayload, env.jwtSecret, {
		expiresIn: env.accessTokenTtl as ExpiresIn,
	});

/**
 * O `sub` de um access token assinado por nós, ou o 401 que o cliente sabe tratar.
 *
 * Token vencido mas com a nossa assinatura volta com `expired`, e não como erro: quem
 * decide entre `token_expired` e `account_gone` é o `requireAuth`, depois de olhar a conta.
 */
const verifiedToken = (header: string | undefined): { userId: string; expired: boolean } => {
	if (!header?.startsWith('Bearer ')) {
		throw unauthorized('Token de acesso ausente.', 'missing_token');
	}
	const token = header.slice('Bearer '.length);

	let payload: string | JwtPayload;
	let expired = false;
	try {
		payload = jwt.verify(token, env.jwtSecret);
	} catch (error) {
		// Um token inválido derruba a sessão no app; o vencido, se a assinatura confere,
		// segue para a conferência da conta (a assinatura é verificada de novo aqui).
		if (!(error instanceof jwt.TokenExpiredError)) {
			throw unauthorized('Token de acesso inválido.', 'invalid_token');
		}
		payload = jwt.verify(token, env.jwtSecret, { ignoreExpiration: true });
		expired = true;
	}

	// Todo token que assinamos tem `sub`. Sem ele não há de quem é a requisição — e um
	// `undefined` chegaria ao Prisma como "sem filtro".
	if (typeof payload !== 'object' || typeof payload.sub !== 'string' || payload.sub === '') {
		throw unauthorized('Token de acesso inválido.', 'invalid_token');
	}

	return { userId: payload.sub, expired };
};

/**
 * Exige um access token válido de uma conta que ainda existe, e anexa o `userId` à
 * requisição.
 *
 * Nenhum handler abaixo daqui aceita userId vindo do corpo ou da query: o dono do dado
 * é sempre o do token. Do contrário, trocar um id no JSON leria o perfil de outra pessoa.
 *
 * A conta é conferida no banco a cada requisição, uma busca pela chave primária. O access
 * token continua válido por até 15 minutos depois de a conta ser apagada (`DELETE /me`,
 * noutro aparelho, por exemplo); sem a conferência, o push tentaria gravar linhas de um
 * usuário que não existe — erro de FK, 500, e a fila reenviando a mesma remessa — e o pull
 * devolveria uma conta vazia como se fosse de verdade. Aqui, e não rota a rota, para que
 * nenhuma rota nova esqueça. O 401 `account_gone` (o mesmo do `getMe`) faz o app sair.
 *
 * O token vencido também passa pela conferência. Sem isso, o aparelho que só volta a
 * falar com o servidor depois dos 15 minutos recebe `token_expired`, tenta renovar com um
 * refresh token que a cascata já apagou e apenas sai — com os dados da conta apagada.
 * Com o `account_gone` ele apaga os dados e sai, como o usuário decidiu (DEC-35).
 *
 * Um erro do banco segue como erro (500), não como 401: um soluço do Postgres não pode
 * deslogar todo mundo.
 */
export const requireAuth = asyncHandler(
	async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
		const { userId, expired } = verifiedToken(req.header('authorization'));

		const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
		if (user === null) {
			throw unauthorized('Conta não encontrada.', 'account_gone');
		}
		// O cliente renova sozinho ao ver este código.
		if (expired) {
			throw unauthorized('Token de acesso expirado.', 'token_expired');
		}

		(req as AuthenticatedRequest).userId = userId;
		next();
	}
);
