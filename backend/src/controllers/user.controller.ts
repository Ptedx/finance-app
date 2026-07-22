import type { Response } from 'express';
import { prisma } from '../lib/prisma.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { unauthorized } from '../middleware/error.js';
import { updateProfileSchema } from '../schemas/auth.js';

const SELECT_PUBLIC = {
	id: true,
	email: true,
	name: true,
	baseCurrency: true,
	language: true,
	createdAt: true,
} as const;

export const getMe = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
	const user = await prisma.user.findUnique({
		where: { id: req.userId },
		select: SELECT_PUBLIC,
	});

	// O token é válido mas a conta sumiu (apagada em outro aparelho, por exemplo).
	// 401 e não 404: o cliente precisa derrubar a sessão, não mostrar "não encontrado".
	if (!user) {
		throw unauthorized('Conta não encontrada.', 'account_gone');
	}

	res.json({ user });
};

/**
 * Atualiza moeda, idioma e nome do perfil.
 *
 * Essas três não passam pelo delta sync das tabelas: são campos únicos do usuário, sem
 * histórico nem conflito de linha, e o último a escrever ganha por definição.
 */
export const updateMe = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
	const body = updateProfileSchema.parse(req.body);

	// Só as chaves realmente enviadas chegam ao update: passar `name: undefined` seria
	// interpretado pelo Prisma como "não mexa", mas o tipo o rejeita, e montar o objeto
	// explicitamente deixa a intenção — atualização parcial — visível.
	const user = await prisma.user.update({
		where: { id: req.userId },
		data: {
			...(body.name !== undefined ? { name: body.name } : {}),
			...(body.baseCurrency !== undefined ? { baseCurrency: body.baseCurrency } : {}),
			...(body.language !== undefined ? { language: body.language } : {}),
		},
		select: SELECT_PUBLIC,
	});

	res.json({ user });
};
