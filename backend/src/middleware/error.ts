import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { isProduction } from '../lib/env.js';

/** Erro que o handler pode devolver ao cliente tal como veio. */
export class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly code = 'error'
	) {
		super(message);
		this.name = 'HttpError';
	}
}

export const badRequest = (message: string, code = 'bad_request') =>
	new HttpError(400, message, code);
export const unauthorized = (message = 'Não autenticado.', code = 'unauthorized') =>
	new HttpError(401, message, code);
export const conflict = (message: string, code = 'conflict') => new HttpError(409, message, code);

/**
 * Envolve um handler async para que uma promise rejeitada chegue ao middleware de erro.
 *
 * O Express 5 já encaminha rejeições, mas isso só vale para o handler mais externo —
 * embrulhar explicitamente deixa a garantia visível em cada rota.
 */
export const asyncHandler =
	<T extends Request>(handler: (req: T, res: Response, next: NextFunction) => Promise<unknown>) =>
	(req: Request, res: Response, next: NextFunction): void => {
		handler(req as T, res, next).catch(next);
	};

/**
 * Handler central de erros.
 *
 * Em produção nada além da mensagem sai daqui: stack traces e erros do Prisma revelam
 * nomes de tabela, caminhos e às vezes trechos de dados. Fora de produção o stack vai
 * junto, porque debugar sem ele é adivinhação.
 */
export const errorHandler = (
	error: unknown,
	_req: Request,
	res: Response,
	_next: NextFunction
): void => {
	if (error instanceof ZodError) {
		res.status(400).json({
			error: 'Dados inválidos.',
			code: 'validation_error',
			issues: error.issues.map((issue) => ({
				path: issue.path.join('.'),
				message: issue.message,
			})),
		});
		return;
	}

	if (error instanceof HttpError) {
		res.status(error.status).json({ error: error.message, code: error.code });
		return;
	}

	console.error('Erro não tratado:', error);

	res.status(500).json({
		error: 'Erro interno do servidor.',
		code: 'internal_error',
		...(isProduction ? {} : { detail: error instanceof Error ? error.stack : String(error) }),
	});
};

export const notFoundHandler = (_req: Request, res: Response): void => {
	res.status(404).json({ error: 'Rota não encontrada.', code: 'not_found' });
};
