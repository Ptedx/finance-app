/**
 * A tradução das contas a pagar (`bills`) entre a linha do Postgres e o formato do fio.
 *
 * Fora do controller, em funções puras, pelo mesmo motivo de `captureWire.ts`: é aqui que
 * ficam as coisas que quebram em silêncio e que nenhum teste de integração pegaria depressa:
 *
 *  1. `amountCents` é `bigint | null` na coluna e `number | null` no fio. O nulo **quer
 *     dizer** "o valor varia" (luz, água, cartão) e tem de voltar nulo — virar 0 faria o
 *     app tratar a conta como gratuita. E a conversão tem de existir: `JSON.stringify` não
 *     serializa bigint, e um esquecimento aqui derrubaria o pull inteiro com um TypeError;
 *  2. todo campo opcional ausente na chegada vira `null` na coluna, nunca `undefined`:
 *     `undefined` faria o Prisma manter o valor antigo no update, e a edição que limpou o
 *     campo nunca se propagaria;
 *  3. `paidThrough` é um mês de calendário (`YYYY-MM`) e viaja como texto, sem virar Date.
 *
 * Nada neste arquivo importa Prisma nem a configuração do servidor — é o que permite
 * testá-lo sem banco e sem variáveis de ambiente.
 */

/** O que o `nullish()` do zod produz: ausente ou nulo são a mesma coisa. */
type Optional<T> = T | null | undefined;

/** A conta como ela chega no push, já validada (espelha `BillPayload`). */
export interface IncomingBill {
	id: string;
	name: string;
	dueDay: number;
	amountCents?: Optional<number>;
	accountId?: Optional<string>;
	category?: Optional<string>;
	matchHint?: Optional<string>;
	debtId?: Optional<string>;
	paidThrough?: Optional<string>;
	paidByRef?: Optional<string>;
	active: boolean;
	sortOrder: number;
	updatedAt: string;
	deletedAt?: Optional<string>;
}

/** As colunas da conta, sem `id` e `userId`: o upsert os põe no `create`. */
export interface BillColumns {
	name: string;
	dueDay: number;
	amountCents: bigint | null;
	accountId: string | null;
	category: string | null;
	matchHint: string | null;
	debtId: string | null;
	paidThrough: string | null;
	paidByRef: string | null;
	active: boolean;
	sortOrder: number;
	updatedAt: Date;
	deletedAt: Date | null;
}

/** A linha como o Postgres a devolve, no que o fio precisa dela. */
export interface StoredBill extends BillColumns {
	id: string;
}

export const billColumns = (row: IncomingBill): BillColumns => ({
	name: row.name,
	dueDay: row.dueDay,
	amountCents: row.amountCents == null ? null : BigInt(row.amountCents),
	accountId: row.accountId ?? null,
	category: row.category ?? null,
	matchHint: row.matchHint ?? null,
	debtId: row.debtId ?? null,
	paidThrough: row.paidThrough ?? null,
	paidByRef: row.paidByRef ?? null,
	active: row.active,
	sortOrder: row.sortOrder,
	updatedAt: new Date(row.updatedAt),
	deletedAt: row.deletedAt ? new Date(row.deletedAt) : null,
});

export const billToWire = (row: StoredBill) => ({
	id: row.id,
	name: row.name,
	dueDay: row.dueDay,
	amountCents: row.amountCents === null ? null : Number(row.amountCents),
	accountId: row.accountId,
	category: row.category,
	matchHint: row.matchHint,
	debtId: row.debtId,
	paidThrough: row.paidThrough,
	paidByRef: row.paidByRef,
	active: row.active,
	sortOrder: row.sortOrder,
	updatedAt: row.updatedAt.toISOString(),
	deletedAt: row.deletedAt === null ? null : row.deletedAt.toISOString(),
});
