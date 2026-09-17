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
 * Teto de um valor em centavos: 10¹⁵, cerca de 10 trilhões de unidades.
 *
 * É o mesmo `MAX_CENTS` de `app/utils/money.ts`, e isso é o que importa: o app não
 * deixa digitar acima dele, então o servidor nunca recusa um valor que o app aceitou.
 * Antes a coluna era `Int` e o teto daqui (21 milhões) ficava abaixo do teto do app —
 * um valor entre os dois era gravado no aparelho e recusado no sync, sem aviso.
 * A coluna hoje é `BigInt` justamente para caber. Mudou lá, muda aqui.
 */
export const MAX_AMOUNT_CENTS = 1_000_000_000_000_000;

/** Dinheiro em centavos inteiros, do lado do app até a coluna do Postgres. */
const amountCents = z.number().int().min(-MAX_AMOUNT_CENTS).max(MAX_AMOUNT_CENTS);

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
	/**
	 * Necessidade ou desejo — a base do 50/30/20 no app.
	 *
	 * Opcional de propósito: um aparelho numa versão anterior à coluna continua
	 * sincronizando normalmente, e o controller resolve a ausência para 'discretionary'.
	 * Recusar a remessa inteira por um campo que o servidor sabe preencher deixaria esse
	 * aparelho preso, sem caminho de saída a não ser atualizar o app.
	 */
	nature: z.enum(['essential', 'discretionary']).nullish(),
	...syncMeta,
});

export const transactionSchema = z.object({
	id: z.string().min(1).max(64),
	amountCents,
	category: z.string().min(1).max(64),
	date: calendarDate,
	note: z.string().max(2000).nullish(),
	isIncome: z.boolean(),
	/**
	 * Campos do v7 (conta de origem e parcelamento). Opcionais pelo mesmo motivo de
	 * `nature`: um aparelho anterior a eles continua sincronizando.
	 */
	accountId: z.string().min(1).max(64).nullish(),
	installmentGroup: z.string().min(1).max(64).nullish(),
	installmentIndex: z.number().int().min(1).max(999).nullish(),
	installmentCount: z.number().int().min(1).max(999).nullish(),
	...syncMeta,
});

export const accountSchema = z.object({
	id: z.string().min(1).max(64),
	name: z.string().min(1).max(100),
	kind: z.enum(['checking', 'savings', 'investment', 'cash', 'credit_card']),
	/** v8. Opcional: um aparelho anterior ao papel não o manda; o servidor resolve pelo tipo. */
	role: z.enum(['main', 'card', 'envelope', 'reserve', 'external']).nullish(),
	envelopeMonthlyCents: amountCents.nullish(),
	bankName: z.string().max(100).nullish(),
	color: z.string().min(1).max(32),
	last4: z.string().max(8).nullish(),
	closingDay: z.number().int().min(1).max(31).nullish(),
	dueDay: z.number().int().min(1).max(31).nullish(),
	creditLimitCents: amountCents.nullish(),
	packageName: z.string().max(200).nullish(),
	accountKey: z.string().max(200).nullish(),
	openingBalanceCents: amountCents,
	openingBalanceDate: calendarDate,
	sortOrder: z.number().int().min(0).max(100000),
	archived: z.boolean(),
	...syncMeta,
});

export const transferSchema = z.object({
	id: z.string().min(1).max(64),
	fromAccountId: z.string().min(1).max(64).nullish(),
	toAccountId: z.string().min(1).max(64).nullish(),
	amountCents,
	date: calendarDate,
	note: z.string().max(2000).nullish(),
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
 * Corpo do push — só o envelope.
 *
 * As linhas chegam como `unknown` de propósito: cada uma é validada sozinha no
 * controller, com o schema da sua coleção, e a que falha volta em `rejected` com o
 * motivo enquanto as outras seguem. Validar a remessa inteira aqui, como era feito,
 * fazia um único valor fora do teto responder 400 para a página toda — e como a linha
 * ruim continuava suja no aparelho, ela entrava em toda página seguinte e o sync
 * daquele aparelho parava para sempre, sem que nada mais dele subisse.
 *
 * Toda coleção é opcional: um aparelho que só mexeu em orçamentos manda apenas eles.
 * O teto por coleção é o mesmo `SYNC_PAGE_SIZE` do pull, então o cliente pode reenviar
 * uma página recebida sem risco de ela ser grande demais na volta.
 */
const rows = () => z.array(z.unknown()).max(env.syncPageSize).default([]);

export const pushBodySchema = z.object({
	changes: z
		.object({
			categories: rows(),
			accounts: rows(),
			transactions: rows(),
			recurringTransactions: rows(),
			budgets: rows(),
			transfers: rows(),
		})
		.default({
			categories: [],
			accounts: [],
			transactions: [],
			recurringTransactions: [],
			budgets: [],
			transfers: [],
		}),
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
	// Coleções do v7: um cursor guardado antes delas chega sem os campos e parte do zero.
	accounts: z.number().int().nonnegative().default(0),
	transfers: z.number().int().nonnegative().default(0),
});

const EMPTY_CURSOR = {
	categories: 0,
	transactions: 0,
	recurringTransactions: 0,
	budgets: 0,
	accounts: 0,
	transfers: 0,
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
export type AccountPayload = z.infer<typeof accountSchema>;
export type TransferPayload = z.infer<typeof transferSchema>;
export type TransactionPayload = z.infer<typeof transactionSchema>;
export type RecurringTransactionPayload = z.infer<typeof recurringTransactionSchema>;
export type BudgetPayload = z.infer<typeof budgetSchema>;
export type PushBody = z.infer<typeof pushBodySchema>;
