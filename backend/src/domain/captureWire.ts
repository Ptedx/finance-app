/**
 * A tradução das duas coleções do v19 — capturas e regras aprendidas — entre a linha do
 * Postgres e o formato do fio.
 *
 * Está fora do controller, em funções puras, porque é aqui que ficam as três coisas que
 * podem quebrar em silêncio e que nenhum teste de integração pegaria depressa:
 *
 *  1. o `id` da linha **é** o fingerprint da notificação (e a `merchantKey` da regra). O
 *     id local do aparelho nunca viaja: o mesmo aviso capturado em dois aparelhos tem dois
 *     ids aleatórios e um único fingerprint;
 *  2. `postedAt` e `createdAt` vão e voltam **verbatim**. São texto no banco justamente
 *     para isso — a importação de extrato gera instante sem fuso, e o app ordena e fatia
 *     esse texto. Qualquer reformatação faria as duas cópias deixarem de casar;
 *  3. `amountCents` é `bigint` na coluna e `number` no fio. O teto do app (10¹⁵) cabe num
 *     double sem perda, mas a conversão tem de existir: `JSON.stringify` não serializa
 *     bigint, e um esquecimento aqui derrubaria o pull inteiro com um TypeError.
 *
 * Nada neste arquivo importa Prisma nem a configuração do servidor — é o que permite
 * testá-lo sem banco e sem variáveis de ambiente.
 */

/** O que o `nullish()` do zod produz: ausente ou nulo são a mesma coisa. */
type Optional<T> = T | null | undefined;

// ---------------------------------------------------------------------------
// Capturas
// ---------------------------------------------------------------------------

/** A captura como ela chega no push, já validada (espelha `CapturePayload`). */
export interface IncomingCapture {
	id: string;
	packageName: string;
	appLabel: string;
	title: string;
	text: string;
	postedAt: string;
	amountCents: number;
	direction: string;
	kind: string;
	counterparty?: Optional<string>;
	merchantKey?: Optional<string>;
	cardLast4?: Optional<string>;
	status: string;
	question?: Optional<string>;
	relatedFingerprint?: Optional<string>;
	suggestedCategory?: Optional<string>;
	transactionId?: Optional<string>;
	autoConfirmed: boolean;
	reason?: Optional<string>;
	accountId?: Optional<string>;
	transferId?: Optional<string>;
	installments?: Optional<number>;
	createdAt: string;
	updatedAt: string;
	deletedAt?: Optional<string>;
}

/** A linha como o Postgres a devolve, no que o fio precisa dela. */
export interface StoredCapture extends Omit<IncomingCapture, 'amountCents' | 'updatedAt' | 'deletedAt'> {
	amountCents: bigint;
	updatedAt: Date;
	deletedAt: Date | null;
}

/** As colunas da captura, sem `id` e `userId`: o upsert os põe no `create`. */
export interface CaptureColumns extends Omit<IncomingCapture, 'id' | 'amountCents' | 'updatedAt' | 'deletedAt'> {
	counterparty: string | null;
	merchantKey: string | null;
	cardLast4: string | null;
	question: string | null;
	relatedFingerprint: string | null;
	suggestedCategory: string | null;
	transactionId: string | null;
	reason: string | null;
	accountId: string | null;
	transferId: string | null;
	installments: number | null;
	amountCents: bigint;
	updatedAt: Date;
	deletedAt: Date | null;
}

export const captureColumns = (row: IncomingCapture): CaptureColumns => ({
	packageName: row.packageName,
	appLabel: row.appLabel,
	title: row.title,
	text: row.text,
	postedAt: row.postedAt,
	amountCents: BigInt(row.amountCents),
	direction: row.direction,
	kind: row.kind,
	counterparty: row.counterparty ?? null,
	merchantKey: row.merchantKey ?? null,
	cardLast4: row.cardLast4 ?? null,
	status: row.status,
	question: row.question ?? null,
	relatedFingerprint: row.relatedFingerprint ?? null,
	suggestedCategory: row.suggestedCategory ?? null,
	transactionId: row.transactionId ?? null,
	autoConfirmed: row.autoConfirmed,
	reason: row.reason ?? null,
	accountId: row.accountId ?? null,
	transferId: row.transferId ?? null,
	installments: row.installments ?? null,
	createdAt: row.createdAt,
	updatedAt: new Date(row.updatedAt),
	deletedAt: row.deletedAt ? new Date(row.deletedAt) : null,
});

export const captureToWire = (row: StoredCapture) => ({
	id: row.id,
	packageName: row.packageName,
	appLabel: row.appLabel,
	title: row.title,
	text: row.text,
	postedAt: row.postedAt,
	amountCents: Number(row.amountCents),
	direction: row.direction,
	kind: row.kind,
	counterparty: row.counterparty ?? null,
	merchantKey: row.merchantKey ?? null,
	cardLast4: row.cardLast4 ?? null,
	status: row.status,
	question: row.question ?? null,
	relatedFingerprint: row.relatedFingerprint ?? null,
	suggestedCategory: row.suggestedCategory ?? null,
	transactionId: row.transactionId ?? null,
	autoConfirmed: row.autoConfirmed,
	reason: row.reason ?? null,
	accountId: row.accountId ?? null,
	transferId: row.transferId ?? null,
	installments: row.installments ?? null,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt.toISOString(),
	deletedAt: row.deletedAt === null ? null : row.deletedAt.toISOString(),
});

// ---------------------------------------------------------------------------
// Regras aprendidas
// ---------------------------------------------------------------------------

/** A regra como ela chega no push (espelha `MerchantRulePayload`). */
export interface IncomingMerchantRule {
	/** A `merchantKey`: é ela a identidade da linha. */
	id: string;
	categoryId?: Optional<string>;
	treatAs: string;
	confirmations: number;
	updatedAt: string;
	deletedAt?: Optional<string>;
}

export interface StoredMerchantRule extends Omit<IncomingMerchantRule, 'updatedAt' | 'deletedAt'> {
	updatedAt: Date;
	deletedAt: Date | null;
}

export interface MerchantRuleColumns {
	categoryId: string | null;
	treatAs: string;
	confirmations: number;
	updatedAt: Date;
	deletedAt: Date | null;
}

export const merchantRuleColumns = (row: IncomingMerchantRule): MerchantRuleColumns => ({
	categoryId: row.categoryId ?? null,
	treatAs: row.treatAs,
	/**
	 * A contagem vem como ela é, sem somar nem tomar o máximo das duas.
	 *
	 * Tentador fazer `max(local, recebida)` — duas aprendizagens do mesmo lugar em dois
	 * aparelhos somam experiência de verdade. Mas o app aplica o pull por last-write-wins,
	 * e um servidor que inventasse outra regra aqui faria as duas cópias nunca convergirem.
	 * Quem decide é o `updatedAt`, como em todo o resto do sync.
	 */
	confirmations: row.confirmations,
	updatedAt: new Date(row.updatedAt),
	deletedAt: row.deletedAt ? new Date(row.deletedAt) : null,
});

export const merchantRuleToWire = (row: StoredMerchantRule) => ({
	id: row.id,
	categoryId: row.categoryId ?? null,
	treatAs: row.treatAs,
	confirmations: row.confirmations,
	updatedAt: row.updatedAt.toISOString(),
	deletedAt: row.deletedAt === null ? null : row.deletedAt.toISOString(),
});
