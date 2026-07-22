import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../lib/env.js';
import { unauthorized } from './error.js';

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
 * Exige um access token válido e anexa o `userId` à requisição.
 *
 * Nenhum handler abaixo daqui aceita userId vindo do corpo ou da query: o dono do dado
 * é sempre o do token. Do contrário, trocar um id no JSON leria o perfil de outra pessoa.
 */
export const requireAuth = (req: Request, _res: Response, next: NextFunction): void => {
	const header = req.header('authorization');

	if (!header?.startsWith('Bearer ')) {
		next(unauthorized('Token de acesso ausente.', 'missing_token'));
		return;
	}

	try {
		const payload = jwt.verify(header.slice('Bearer '.length), env.jwtSecret) as AccessTokenPayload;
		(req as AuthenticatedRequest).userId = payload.sub;
		next();
	} catch (error) {
		// O cliente distingue os dois casos: um token expirado dispara o refresh
		// automático, um token inválido derruba a sessão.
		const expired = error instanceof jwt.TokenExpiredError;
		next(
			unauthorized(
				expired ? 'Token de acesso expirado.' : 'Token de acesso inválido.',
				expired ? 'token_expired' : 'invalid_token'
			)
		);
	}
};
