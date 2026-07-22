import { z } from 'zod';

/**
 * O mínimo de senha é 8 e não 6: a única barreira contra força bruta offline, caso o
 * banco vaze, é o custo do bcrypt somado ao tamanho da senha.
 */
const password = z.string().min(8, 'A senha deve ter ao menos 8 caracteres').max(200);

/** Normalizado no schema para que `a@B.com` e `a@b.com` não virem duas contas. */
const email = z.string().email().max(254).toLowerCase().trim();

export const registerSchema = z.object({
	email,
	password,
	name: z.string().min(1).max(100).trim(),
	baseCurrency: z.string().length(3).optional(),
	language: z.string().min(2).max(10).optional(),
});

export const loginSchema = z.object({
	email,
	password: z.string().min(1).max(200),
});

export const refreshSchema = z.object({
	refreshToken: z.string().min(1),
});

export const updateProfileSchema = z
	.object({
		name: z.string().min(1).max(100).trim().optional(),
		baseCurrency: z.string().length(3).optional(),
		language: z.string().min(2).max(10).optional(),
	})
	.refine((data) => Object.keys(data).length > 0, {
		message: 'Informe ao menos um campo para atualizar.',
	});

export type RegisterBody = z.infer<typeof registerSchema>;
export type LoginBody = z.infer<typeof loginSchema>;
