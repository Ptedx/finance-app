import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { Request, Response } from 'express';
import { DEFAULT_CATEGORIES } from '../domain/defaultCategories.js';
import { env } from '../lib/env.js';
import { prisma } from '../lib/prisma.js';
import { signAccessToken } from '../middleware/auth.js';
import { conflict, unauthorized } from '../middleware/error.js';
import { loginSchema, refreshSchema, registerSchema } from '../schemas/auth.js';

const BCRYPT_ROUNDS = 12;

/**
 * Hash de uma senha que ninguém tem, gerado na subida.
 *
 * Serve para o login de um e-mail inexistente custar o mesmo que o de um e-mail real
 * com senha errada. Sem isso, a diferença de tempo entre "nem cheguei a comparar" e
 * "comparei com bcrypt" enumera quais e-mails têm conta no Spendr.
 */
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(randomBytes(32).toString('hex'), BCRYPT_ROUNDS);

/**
 * O refresh token é opaco e aleatório, não um JWT.
 *
 * Um JWT de refresh não pode ser revogado sem uma lista de bloqueio — que é justamente
 * a tabela que teríamos de manter de qualquer forma. Guardar só o hash significa que
 * um vazamento do banco não entrega sessão nenhuma.
 */
const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

const issueRefreshToken = async (userId: string): Promise<string> => {
	const token = randomBytes(48).toString('base64url');
	const expiresAt = new Date(Date.now() + env.refreshTokenDays * 24 * 60 * 60 * 1000);

	await prisma.refreshToken.create({
		data: { userId, tokenHash: hashToken(token), expiresAt },
	});

	return token;
};

const sessionFor = async (userId: string) => ({
	accessToken: signAccessToken(userId),
	refreshToken: await issueRefreshToken(userId),
});

const publicUser = (user: {
	id: string;
	email: string;
	name: string;
	baseCurrency: string;
	language: string;
}) => ({
	id: user.id,
	email: user.email,
	name: user.name,
	baseCurrency: user.baseCurrency,
	language: user.language,
});

export const register = async (req: Request, res: Response): Promise<void> => {
	const body = registerSchema.parse(req.body);

	const existing = await prisma.user.findUnique({ where: { email: body.email } });
	if (existing) {
		throw conflict('Já existe uma conta com este e-mail.', 'email_taken');
	}

	const passwordHash = await bcrypt.hash(body.password, BCRYPT_ROUNDS);
	const now = new Date();

	// Usuário e categorias padrão numa transação só: uma conta sem categorias faria o
	// primeiro pull chegar vazio e o app abriria sem nenhuma opção nos seletores.
	const user = await prisma.$transaction(async (tx) => {
		const created = await tx.user.create({
			data: {
				email: body.email,
				passwordHash,
				name: body.name,
				...(body.baseCurrency ? { baseCurrency: body.baseCurrency } : {}),
				...(body.language ? { language: body.language } : {}),
			},
		});

		await tx.category.createMany({
			data: DEFAULT_CATEGORIES.map((category) => ({
				...category,
				userId: created.id,
				updatedAt: now,
			})),
		});

		return created;
	});

	res.status(201).json({ user: publicUser(user), ...(await sessionFor(user.id)) });
};

export const login = async (req: Request, res: Response): Promise<void> => {
	const body = loginSchema.parse(req.body);

	const user = await prisma.user.findUnique({ where: { email: body.email } });

	// A comparação acontece mesmo quando o e-mail não existe, contra o hash inútil, de
	// modo que os dois casos levem o mesmo tempo e devolvam a mesma mensagem.
	const passwordMatches = await bcrypt.compare(
		body.password,
		user?.passwordHash ?? DUMMY_PASSWORD_HASH
	);

	if (!user || !passwordMatches) {
		throw unauthorized('E-mail ou senha incorretos.', 'invalid_credentials');
	}

	res.json({ user: publicUser(user), ...(await sessionFor(user.id)) });
};

/**
 * Troca um refresh token por uma sessão nova, rotacionando o token usado.
 *
 * A rotação é o que limita o estrago de um token roubado: assim que o legítimo dono
 * renova, o token capturado já foi revogado e não serve mais.
 */
export const refresh = async (req: Request, res: Response): Promise<void> => {
	const body = refreshSchema.parse(req.body);

	const stored = await prisma.refreshToken.findUnique({
		where: { tokenHash: hashToken(body.refreshToken) },
		include: { user: true },
	});

	if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
		throw unauthorized('Sessão expirada. Entre novamente.', 'invalid_refresh_token');
	}

	await prisma.refreshToken.update({
		where: { id: stored.id },
		data: { revokedAt: new Date() },
	});

	res.json({ user: publicUser(stored.user), ...(await sessionFor(stored.userId)) });
};

/**
 * Encerra a sessão revogando o refresh token apresentado.
 *
 * Não falha quando o token é desconhecido: sair tem que funcionar mesmo que a sessão
 * já tenha caído — o cliente vai apagar as credenciais locais de todo jeito.
 */
export const logout = async (req: Request, res: Response): Promise<void> => {
	const body = refreshSchema.parse(req.body);

	await prisma.refreshToken.updateMany({
		where: { tokenHash: hashToken(body.refreshToken), revokedAt: null },
		data: { revokedAt: new Date() },
	});

	res.status(204).send();
};
