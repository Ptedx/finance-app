/**
 * Juntar contas, juntar cartões e levar um cartão para o débito (SPD-152): as regras puras e
 * os valores que a confirmação mostra.
 *
 * As três operações são arrumação, não dinheiro entrando ou saindo: o patrimônio de antes é
 * o de depois, e a confirmação diz em R$ com quanto fica quem recebe.
 *
 * - **Juntar contas** só do mesmo papel. Juntar a reserva na corrente mantinha o total de hoje,
 *   mas o que foi guardado viraria caixa e o "Guardado" de outubro sumiria do histórico (a
 *   transferência corrente → reserva vira uma transferência da conta para ela mesma). A ficha
 *   vazia (sem lançamento, transferência, captura nem saldo) é a exceção: não há histórico a
 *   reclassificar, e é ela que o app junta sozinho (SPD-116).
 * - **Juntar cartões**: a dívida dos dois soma.
 * - **Levar o cartão para o débito**: o saldo do cartão (a dívida) passa a sair da conta, só
 *   para uma conta principal — numa reserva, os pagamentos de fatura virariam "Guardado". Com
 *   parcelas por cair, espera a última.
 */
import type { Account, Transaction } from '../database/schema';
import { type AccountContents, isAccountEmpty } from './accountClosing';

/** Juntar recusado: papéis diferentes reclassificariam o histórico. */
export class MergeRoleError extends Error {
	constructor(message = 'Contas de papéis diferentes: juntar mudaria o histórico') {
		super(message);
		this.name = 'MergeRoleError';
	}
}

/**
 * Pode juntar `from` em `into`? Mesmo papel, sempre; papéis diferentes, só se `from` estiver
 * vazia (`contents`, de `getAccountContents`). Cartão nunca entra aqui: tem o próprio juntar.
 */
export const canMergeAccounts = (
	from: Pick<Account, 'kind' | 'role'>,
	into: Pick<Account, 'kind' | 'role'>,
	contents: AccountContents
): boolean => {
	if (from.kind === 'credit_card' || into.kind === 'credit_card') return false;
	return from.role === into.role || isAccountEmpty(contents);
};

/** Para qual conta um cartão pode ir como débito: conta principal ativa, que não é cartão. */
export const isDebitTarget = (account: Pick<Account, 'kind' | 'role' | 'archived' | 'deletedAt'>): boolean =>
	account.kind !== 'credit_card' && account.role === 'main' && !account.archived && !account.deletedAt;

/**
 * Levar para o débito recusado: o cartão tem parcelas por cair (SPD-152). No débito, cada uma
 * passaria a sair da conta no dia dela, e não da fatura: o caixa e o "Depois das faturas" de
 * hoje mudariam sem o usuário ter feito nada. Leva depois da última, quando não sobra nada por cair.
 */
export class DebitFutureError extends Error {
	constructor(message = 'O cartão tem lançamentos com data futura: levar para o débito mudaria o caixa') {
		super(message);
		this.name = 'DebitFutureError';
	}
}

export interface FutureCardEntries {
	/** Quantos lançamentos do cartão têm data depois de hoje (parcelas por cair, agendados). */
	count: number;
	/** Quanto eles somam (compras menos estornos). */
	amountCents: number;
}

/** As parcelas por cair de um cartão, na lista de lançamentos (`today` em AAAA-MM-DD). */
export const futureCardEntries = (
	transactions: readonly Pick<Transaction, 'accountId' | 'date' | 'amountCents' | 'isIncome'>[],
	cardId: string,
	today: string
): FutureCardEntries => {
	const future = transactions.filter((entry) => entry.accountId === cardId && entry.date > today);
	return {
		count: future.length,
		amountCents: future.reduce((total, entry) => total + (entry.isIncome ? -entry.amountCents : entry.amountCents), 0),
	};
};

/** O que um cartão deve, com sinal: o saldo dele é negativo quando deve. Crédito sai negativo. */
const owedOf = (balanceCents: number): number => 0 - balanceCents;

export interface CardMergeTotals {
	/** O que o cartão que sai deve (negativo: crédito). */
	fromOwedCents: number;
	/** O que o cartão que fica deve (negativo: crédito). */
	intoOwedCents: number;
	/** O que o que fica passa a dever: a soma. */
	totalOwedCents: number;
}

/** "Dívida do cartão: R$ 370 + R$ 500 = R$ 870." A partir dos saldos de hoje dos dois. */
export const cardMergeTotals = (fromBalanceCents: number, intoBalanceCents: number): CardMergeTotals => {
	const fromOwedCents = owedOf(fromBalanceCents);
	const intoOwedCents = owedOf(intoBalanceCents);
	return { fromOwedCents, intoOwedCents, totalOwedCents: fromOwedCents + intoOwedCents };
};

export interface DebitConvertTotals {
	/** O que o cartão deve hoje (negativo: crédito). */
	cardOwedCents: number;
	/** O saldo de hoje da conta que recebe. */
	accountBeforeCents: number;
	/** O saldo dela depois: a dívida do cartão sai dele (o crédito entra). */
	accountAfterCents: number;
}

/** "Corrente: R$ 23.600 → R$ 23.100." A partir dos saldos de hoje do cartão e da conta. */
export const debitConvertTotals = (cardBalanceCents: number, accountBalanceCents: number): DebitConvertTotals => ({
	cardOwedCents: owedOf(cardBalanceCents),
	accountBeforeCents: accountBalanceCents,
	accountAfterCents: accountBalanceCents + cardBalanceCents,
});

export default {
	MergeRoleError,
	DebitFutureError,
	canMergeAccounts,
	isDebitTarget,
	futureCardEntries,
	cardMergeTotals,
	debitConvertTotals,
};
