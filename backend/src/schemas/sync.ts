import { z } from 'zod';
import { env } from '../lib/env.js';

/**
 * Contrato do sync.
 *
 * O mesmo formato vale nas duas direções: o que o pull devolve é exatamente o que o
 * push aceita. Isso não é elegância — é o que permite ao aparelho reenviar sem
 * tradução aquilo que acabou de receber, no caso de uma mesclagem.
 */

/** Dia de calendário local. Nunca um timestamp: ver o comentário no schema.prisma. */
const calendarDate = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, 'Data deve estar no formato YYYY-MM-DD');

/** Instante ISO 8601. É o que ordena as edições entre aparelhos. */
const timestamp = z.iso.datetime({ offset: true });

/**
 * Dinheiro em centavos inteiros, do lado do app até a coluna do Postgres.
 *
 * O limite não é burocracia: `amountCents` é `Int` no Postgres, e um valor acima de
 * 2^31 seria recusado pelo banco no meio de uma transação de sync já em andamento.
 */
const amountCents = z.number().int().min(-2_147_483_648).max(2_147_483_647);

const syncMeta = {
	updatedAt: timestamp,
	deletedAt: timestamp.nullish(),
};

export const categorySchema = z.object({
	id: z.string().min(1).max(64),
	name: z.string().min(1).max(100),
	color: z.string().min(1).max(32),
	icon: z.string().min(1).max(64),
	type: z.enum(['expense', 'income']),
	...syncMeta,
});

export const transactionSchema = z.object({
	id: z.string().min(1).max(64),
	amountCents,
	category: z.string().min(1).max(64),
	date: calendarDate,
	note: z.string().max(2000).nullish(),
	isIncome: z.boolean(),
	...syncMeta,
});

export const recurringTransactionSchema = z.object({
	id: z.string().min(1).max(64),
	amountCents,
	isIncome: z.boolean(),
	note: z.string().max(2000).nullish(),
	category: z.string().min(1).max(64),
	recurrenceType: z.enum(['weekly', 'monthly', 'yearly']),
	day: z.number().int().min(1).max(31).nullish(),
	month: z.number().int().min(1).max(12).nullish(),
	weekday: z.number().int().min(1).max(7).nullish(),
	lastProcessed: calendarDate.nullish(),
	nextDue: calendarDate.nullish(),
	active: z.boolean(),
	...syncMeta,
});

export const budgetSchema = z.object({
	id: z.string().min(1).max(64),
	year: z.number().int().min(1970).max(9999),
	month: z.number().int().min(1).max(12),
	amountCents,
	...syncMeta,
});

/**
 * Corpo do push.
 *
 * Toda coleção é opcional: um aparelho que só mexeu em orçamentos manda apenas eles.
 * O teto por coleção é o mesmo `SYNC_PAGE_SIZE` do pull, então o cliente pode reenviar
 * uma página recebida sem risco de ela ser grande demais na volta.
 */
export const pushBodySchema = z.object({
	changes: z
		.object({
			categories: z.array(categorySchema).max(env.syncPageSize).default([]),
			transactions: z.array(transactionSchema).max(env.syncPageSize).default([]),
			recurringTransactions: z
				.array(recurringTransactionSchema)
				.max(env.syncPageSize)
				.default([]),
			budgets: z.array(budgetSchema).max(env.syncPageSize).default([]),
		})
		.default({ categories: [], transactions: [], recurringTransactions: [], budgets: [] }),
});

/**
 * Cursor do pull: a última `serverSeq` já recebida, por coleção.
 *
 * Não é um timestamp de propósito. `updatedAt` vem do relógio de quem editou, e um
 * aparelho que passou dias offline envia linhas datadas no passado — um cursor por
 * tempo passaria por cima delas e os outros aparelhos nunca as veriam. `serverSeq` é
 * atribuída pelo Postgres na ordem de gravação, então nada escapa entre duas páginas.
 *
 * Chega como JSON na query string; ausente ou vazio = sync completo, que é o caso do
 * primeiro login e da mesclagem.
 */
export const cursorSchema = z.object({
	categories: z.number().int().nonnegative().default(0),
	transactions: z.number().int().nonnegative().default(0),
	recurringTransactions: z.number().int().nonnegative().default(0),
	budgets: z.number().int().nonnegative().default(0),
});

const EMPTY_CURSOR = {
	categories: 0,
	transactions: 0,
	recurringTransactions: 0,
	budgets: 0,
};

export const pullQuerySchema = z.object({
	cursor: z
		.string()
		.optional()
		.transform((raw, ctx) => {
			if (!raw) return EMPTY_CURSOR;

			try {
				return cursorSchema.parse(JSON.parse(raw));
			} catch {
				ctx.addIssue({ code: 'custom', message: 'Cursor inválido.' });
				return z.NEVER;
			}
		}),
});

export type SyncCursor = z.infer<typeof cursorSchema>;

export type CategoryPayload = z.infer<typeof categorySchema>;
export type TransactionPayload = z.infer<typeof transactionSchema>;
export type RecurringTransactionPayload = z.infer<typeof recurringTransactionSchema>;
export type BudgetPayload = z.infer<typeof budgetSchema>;
export type PushBody = z.infer<typeof pushBodySchema>;
