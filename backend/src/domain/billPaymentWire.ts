/**
 * A tradução dos meses das contas a pagar (`billPayments`, SPD-146) entre a linha do
 * Postgres e o formato do fio.
 *
 * Fora do controller, em funções puras, pelo mesmo motivo de `billWire.ts`:
 *
 *  1. `amountCents` é `bigint | null` na coluna e `number | null` no fio. O nulo quer dizer
 *     "não se sabe o valor" (o mês pulado não tem pagamento) e tem de voltar nulo; e a
 *     conversão tem de existir, porque `JSON.stringify` não serializa bigint;
 *  2. todo campo opcional ausente na chegada vira `null` na coluna, nunca `undefined`:
 *     `undefined` faria o Prisma manter o valor antigo no update, e o desfazer (a lápide que
 *     sai) ou o mês que perdeu o lançamento nunca se propagaria;
 *  3. `month` é mês de calendário (`YYYY-MM`) e viaja como texto, sem virar Date.
 *
 * Nada neste arquivo importa Prisma nem a configuração do servidor — é o que permite
 * testá-lo sem banco e sem variáveis de ambiente.
 */

/** O que o `nullish()` do zod produz: ausente ou nulo são a mesma coisa. */
type Optional<T> = T | null | undefined;

/** O mês como ele chega no push, já validado (espelha `BillPaymentPayload`). */
export interface IncomingBillPayment {
	id: string;
	billId: string;
	month: string;
	/** `paid` ou `skipped`: o resto o zod já recusou. Texto, como a coluna. */
	status: string;
	transactionId?: Optional<string>;
	amountCents?: Optional<number>;
	updatedAt: string;
	deletedAt?: Optional<string>;
}

/** As colunas do mês, sem `id` e `userId`: o upsert os põe no `create`. */
export interface BillPaymentColumns {
	billId: string;
	month: string;
	status: string;
	transactionId: string | null;
	amountCents: bigint | null;
	updatedAt: Date;
	deletedAt: Date | null;
}

/** A linha como o Postgres a devolve, no que o fio precisa dela. */
export interface StoredBillPayment extends BillPaymentColumns {
	id: string;
}

export const billPaymentColumns = (row: IncomingBillPayment): BillPaymentColumns => ({
	billId: row.billId,
	month: row.month,
	status: row.status,
	transactionId: row.transactionId ?? null,
	amountCents: row.amountCents == null ? null : BigInt(row.amountCents),
	updatedAt: new Date(row.updatedAt),
	deletedAt: row.deletedAt ? new Date(row.deletedAt) : null,
});

export const billPaymentToWire = (row: StoredBillPayment) => ({
	id: row.id,
	billId: row.billId,
	month: row.month,
	status: row.status,
	transactionId: row.transactionId,
	amountCents: row.amountCents === null ? null : Number(row.amountCents),
	updatedAt: row.updatedAt.toISOString(),
	deletedAt: row.deletedAt === null ? null : row.deletedAt.toISOString(),
});
