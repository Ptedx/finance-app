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
	nature: z.enum(['essential', 'discretionary', 'passthrough']).nullish(),
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
	/** v13: final do cartão que fez a compra. */
	cardLast4: z.string().max(8).nullish(),
	...syncMeta,
});

export const accountSchema = z.object({
	id: z.string().min(1).max(64),
	name: z.string().min(1).max(100),
	kind: z.enum(['checking', 'savings', 'investment', 'cash', 'credit_card']),
	/** v8. Opcional: um aparelho anterior ao papel não o manda; o servidor resolve pelo tipo. */
	role: z.enum(['main', 'card', 'envelope', 'reserve', 'external']).nullish(),
	envelopeMonthlyCents: amountCents.nullish(),
	/** v9: bandeira do cartão. Opcional para aparelhos anteriores. */
	network: z.enum(['visa', 'mastercard', 'elo', 'amex', 'hipercard']).nullish(),
	bankName: z.string().max(100).nullish(),
	color: z.string().min(1).max(32),
	last4: z.string().max(8).nullish(),
	closingDay: z.number().int().min(1).max(31).nullish(),
	dueDay: z.number().int().min(1).max(31).nullish(),
	/** v10: dias entre fechamento e vencimento. Opcional para aparelhos anteriores. */
	closingDaysBefore: z.number().int().min(1).max(20).nullish(),
	creditLimitCents: amountCents.nullish(),
	/** v13: nomes dos cartões por final, JSON. */
	cardNames: z.string().max(4000).nullish(),
	yieldCdiBp: z.number().int().min(0).max(100_000).nullish(),
	/** v17: numa reserva, "investment" fica fora da cascata da reserva de emergência. */
	reservePurpose: z.enum(['investment']).nullish(),
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

/** Uma dívida (v15 do app): financiamento, consórcio ou empréstimo. */
export const debtSchema = z.object({
	id: z.string().min(1).max(64),
	name: z.string().min(1).max(120),
	kind: z.enum(['financing', 'consortium', 'loan']),
	system: z.enum(['price', 'sac', 'none']),
	openingBalanceCents: amountCents.min(0),
	openingBalanceDate: calendarDate,
	installmentCents: amountCents.min(0),
	remainingAtOpening: z.number().int().min(0).max(600),
	installmentsTotal: z.number().int().min(0).max(600),
	dueDay: z.number().int().min(1).max(31),
	rateBp: z.number().int().min(0).max(100_000),
	feeCents: amountCents.min(0).nullish(),
	adminFeeBp: z.number().int().min(0).max(10_000).nullish(),
	accountId: z.string().min(1).max(64).nullish(),
	category: z.string().min(1).max(64).nullish(),
	archived: z.boolean(),
	sortOrder: z.number().int(),
	...syncMeta,
});

/** Mês de calendário (`YYYY-MM`), sem dia nem fuso. */
const calendarMonth = z
	.string()
	.regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Mês deve estar no formato YYYY-MM');

/**
 * Uma conta a pagar (aluguel, luz, escola…): vence todo mês no `dueDay`.
 *
 * `amountCents` nulo **quer dizer** "o valor varia" — não é um campo esquecido, e não pode
 * virar 0 em lugar nenhum. `paidThrough` é o último mês já pago e `paidByRef` a referência
 * desse pagamento, guardados como chegam. Ids que apontam para outras coleções
 * (`accountId`, `category`, `debtId`) não são verificados, como nas capturas: uma conta
 * que chega antes da dívida ou da categoria continua valendo.
 */
export const billSchema = z.object({
	id: z.string().min(1).max(64),
	name: z.string().min(1).max(120),
	dueDay: z.number().int().min(1).max(31),
	amountCents: amountCents.min(0).nullish(),
	accountId: z.string().min(1).max(64).nullish(),
	category: z.string().min(1).max(64).nullish(),
	matchHint: z.string().max(200).nullish(),
	debtId: z.string().min(1).max(64).nullish(),
	paidThrough: calendarMonth.nullish(),
	paidByRef: z.string().min(1).max(64).nullish(),
	active: z.boolean(),
	sortOrder: z.number().int(),
	...syncMeta,
});

/** A meta de aposentadoria (v14 do app): uma linha por usuário, de id fixo. */
export const retirementGoalSchema = z.object({
	id: z.string().min(1).max(64),
	targetMonthlyCents: amountCents.min(0),
	reinvestBp: z.number().int().min(0).max(10_000),
	expectedYieldBp: z.number().int().min(0).max(10_000),
	outsideCapitalCents: amountCents.min(0),
	...syncMeta,
});

/**
 * Instante ISO 8601 que o servidor **guarda como texto**, sem converter.
 *
 * Diferente de `timestamp`, o fuso é opcional: a importação de extrato gera
 * `2026-10-13T12:00:00.000` sem fuso (`statementPostedAt`), e recusar essas capturas
 * deixaria de fora justamente as linhas de quem importou a fatura. O app ordena e fatia
 * esse texto, então ele viaja e volta igual — ver `postedAt` no schema.prisma.
 */
const instantText = z
	.string()
	.regex(
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})?$/,
		'Instante deve ser ISO 8601 (YYYY-MM-DDTHH:mm:ss[.sss][Z|±hh:mm])'
	);

/**
 * Uma notificação capturada (v19 do app).
 *
 * O `id` **é** o fingerprint da notificação: o id local nunca viaja. Ver `WireCapture` em
 * app/sync/types.ts e o comentário do model `Capture` no schema.prisma.
 *
 * Os limites de `title` e `text` são deliberadamente folgados — 500 e 4000 caracteres.
 * É texto cru de notificação, que o app guarda inteiro para poder reprocessar quando o
 * parser erra; apertar aqui transformaria "a captura veio comprida" em perda de dado, que
 * é exatamente o que esta coleção existe para evitar. O teto ainda assim existe porque uma
 * página cheia (`SYNC_PAGE_SIZE`, 500 linhas) precisa caber no corpo de 5 MB que o express
 * aceita: 500 × 4,5 KB ≈ 2,2 MB no pior caso.
 */
export const captureSchema = z.object({
	/** O fingerprint. 17 caracteres hoje; o teto segue o das outras coleções. */
	id: z.string().min(1).max(64),
	packageName: z.string().min(1).max(200),
	appLabel: z.string().max(100),
	title: z.string().max(500),
	text: z.string().max(4000),
	postedAt: instantText,
	/**
	 * O sinal fica em `direction`, então na prática o valor é positivo — mas nada aqui
	 * exige isso: um parser que devolva negativo não pode fazer a linha sumir.
	 */
	amountCents,
	direction: z.enum(['in', 'out']),
	/** O que o parser entendeu (purchase, pix_in, invoice_payment…). Texto livre. */
	kind: z.string().min(1).max(32),
	counterparty: z.string().max(200).nullish(),
	/** Até três palavras do nome normalizado; cabe folgado em 120. */
	merchantKey: z.string().max(120).nullish(),
	cardLast4: z.string().max(8).nullish(),
	status: z.enum(['pending', 'confirmed', 'dismissed', 'duplicate', 'transfer', 'ignored']),
	question: z.enum(['duplicate', 'transfer']).nullish(),
	/** O fingerprint do item relacionado, não o id local dele. */
	relatedFingerprint: z.string().max(64).nullish(),
	suggestedCategory: z.string().max(64).nullish(),
	transactionId: z.string().max(64).nullish(),
	autoConfirmed: z.boolean(),
	reason: z.string().max(64).nullish(),
	accountId: z.string().max(64).nullish(),
	transferId: z.string().max(64).nullish(),
	installments: z.number().int().min(1).max(999).nullish(),
	createdAt: instantText,
	...syncMeta,
});

/**
 * Uma regra aprendida sobre um estabelecimento (v19 do app).
 *
 * O `id` é a própria `merchantKey` — os dois aparelhos a derivam do mesmo texto, então
 * duas aprendizagens do mesmo lugar convergem pelo `updatedAt`, sem conflito de id.
 */
export const merchantRuleSchema = z.object({
	/** A `merchantKey`. 120, e não 64: ela é derivada de texto, não é um uuid. */
	id: z.string().min(1).max(120),
	categoryId: z.string().max(64).nullish(),
	treatAs: z.enum(['transaction', 'transfer', 'ignore']),
	confirmations: z.number().int().min(0).max(1_000_000),
	...syncMeta,
});

/** A meta da reserva de emergência (v17 do app): uma linha por usuário, de id fixo. */
export const reserveGoalSchema = z.object({
	id: z.string().min(1).max(64),
	targetMonths: z.number().int().min(1).max(120),
	customMonthlyCostCents: amountCents.min(0).nullish(),
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
			retirementGoals: rows(),
			debts: rows(),
			reserveGoals: rows(),
			captures: rows(),
			merchantRules: rows(),
			bills: rows(),
		})
		.default({
			categories: [],
			accounts: [],
			transactions: [],
			recurringTransactions: [],
			budgets: [],
			transfers: [],
			retirementGoals: [],
			debts: [],
			reserveGoals: [],
			captures: [],
			merchantRules: [],
			bills: [],
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
	// Coleção do v14, idem.
	retirementGoals: z.number().int().nonnegative().default(0),
	// Coleção do v15, idem.
	debts: z.number().int().nonnegative().default(0),
	// Coleção do v17, idem.
	reserveGoals: z.number().int().nonnegative().default(0),
	// Coleções do v19, idem. É a presença destas duas chaves no cursor devolvido pelo pull
	// que diz ao app que este servidor conhece as capturas — ver `onlyKnownCollections` em
	// app/sync/types.ts. Sem elas, o app guarda as linhas para quando o servidor souber.
	captures: z.number().int().nonnegative().default(0),
	merchantRules: z.number().int().nonnegative().default(0),
	// Contas a pagar, idem: a chave sai no cursor do pull mesmo vazia, e é por ela que o app
	// sabe que este servidor conhece `bills`.
	bills: z.number().int().nonnegative().default(0),
});

const EMPTY_CURSOR = {
	categories: 0,
	transactions: 0,
	recurringTransactions: 0,
	budgets: 0,
	accounts: 0,
	transfers: 0,
	retirementGoals: 0,
	debts: 0,
	reserveGoals: 0,
	captures: 0,
	merchantRules: 0,
	bills: 0,
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
export type RetirementGoalPayload = z.infer<typeof retirementGoalSchema>;
export type DebtPayload = z.infer<typeof debtSchema>;
export type ReserveGoalPayload = z.infer<typeof reserveGoalSchema>;
export type CapturePayload = z.infer<typeof captureSchema>;
export type MerchantRulePayload = z.infer<typeof merchantRuleSchema>;
export type BillPayload = z.infer<typeof billSchema>;
export type PushBody = z.infer<typeof pushBodySchema>;
