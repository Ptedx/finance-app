import type { Response } from 'express';
import { insertDiagnostics } from '../domain/diagnostics.js';
import { prisma } from '../lib/prisma.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { unauthorized } from '../middleware/error.js';
import { parseDiagnosticBatch } from '../schemas/diagnostics.js';

/**
 * Recebe um lote do diário de diagnóstico do aparelho (DEC-03).
 *
 * Responde `{ accepted, duplicates, rejected }`: os dois primeiros são o
 * `DiagnosticBatchResult` do contrato; `rejected` diz quais eventos ficaram de fora e por
 * quê. Evento recusado não é erro do lote — o aparelho pode descartá-lo, porque reenviar
 * o mesmo evento daria a mesma recusa.
 *
 * Nada do corpo vai para o log: `rawText` é texto de aviso de banco.
 */
export const postDiagnostics = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
	const batch = parseDiagnosticBatch(req.body, new Date());

	try {
		res.json(await insertDiagnostics(prisma, req.userId, batch));
	} catch (error) {
		// A FK para users falhou: o token é válido, mas a conta foi apagada. Mesmo
		// tratamento do `getMe` — 401 para o aparelho derrubar a sessão.
		if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2003') {
			throw unauthorized('Conta não encontrada.', 'account_gone');
		}
		throw error;
	}
};
