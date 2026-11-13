import type { Response } from 'express';
import { type Mirai, MiraiError } from '../domain/mirai/service.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';

/**
 * As rotas do Mirai (SPD-163): `GET /api/assistant/status` e `POST /api/assistant/turn`,
 * as duas atrás do `requireAuth`.
 *
 * As recusas saem como `{ error, code }` (`MiraiErrorResponse` do contrato), com o status
 * de cada uma. Nada do corpo — pergunta, resultado de ferramenta, resposta — vai para o
 * log nem para o banco.
 *
 * Recebe o Mirai pronto, em vez de montá-lo aqui: os testes passam um com banco e Claude
 * falsos, e esta camada fica só com o HTTP.
 */
export const createAssistantController = (mirai: Mirai) => {
	const refused = (res: Response, error: unknown): boolean => {
		if (!(error instanceof MiraiError)) return false;
		res.status(error.status).json({ error: error.message, code: error.code });
		return true;
	};

	const getStatus = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
		res.json(await mirai.status(req.userId));
	};

	const postTurn = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
		try {
			res.json(await mirai.turn(req.userId, req.body));
		} catch (error) {
			if (!refused(res, error)) throw error;
		}
	};

	return { getStatus, postTurn };
};
