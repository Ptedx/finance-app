/**
 * Somas das contas para a tela inicial. Puro e testado.
 *
 * O saldo de cada conta vem do banco de dados (`getAccountBalances`). Ciclo, fatura e
 * limite de cartão ficam em `cardMath.ts`: cartão não tem saldo, e as contas nunca
 * olham para eles além de subtrair o que eles devem do patrimônio.
 *
 * Convenção de sinal guardada na âncora de um cartão: **negativo** quando há valor a
 * pagar. `owedCents` lê ao contrário.
 */

import type { Account } from '../database/schema';

/** Quanto o cartão deve: o saldo negativo lido ao contrário; um saldo positivo é crédito. */
/**
 * O lançamento que falta para o gasto do mês numa conta bater com o que o usuário informou.
 *
 * Compras que o app não viu (as do Inter antes de a conta existir, por exemplo) são gasto
 * de verdade e precisam entrar no mês — é isso que move a barra do envelope. Gasto menor
 * do que o app já tinha significa dinheiro voltando, então vira entrada.
 *
 * Nulo quando já está igual.
 */
/**
 * O outro lado do par "já gastei" e "ainda tenho": os dois somam o dinheiro do mês.
 * Nunca negativo — quem gastou mais do que o mês tinha corrige o outro campo, e o app
 * entende a diferença como sobra de antes.
 */
export const counterpartCents = (availableCents: number, typedCents: number): number =>
	Math.max(0, availableCents - typedCents);

export const spendingAdjustment = (
	currentSpentCents: number,
	informedSpentCents: number
): { amountCents: number; isIncome: boolean } | null => {
	const difference = informedSpentCents - currentSpentCents;
	if (difference === 0) return null;
	return { amountCents: Math.abs(difference), isIncome: difference < 0 };
};

export const owedCents = (balanceCents: number): number => Math.max(0, -balanceCents);

export interface AccountsOverview {
	/** Soma do que não é cartão, sem as arquivadas, mais os lançamentos sem conta. */
	cashCents: number;
	/** Soma do que os cartões devem, sem os arquivados. */
	cardsOwedCents: number;
	/** Caixa menos cartões. */
	netCents: number;
}

export const summarizeAccounts = (
	accounts: Account[],
	balances: Map<string, number>,
	unassignedNetCents: number
): AccountsOverview => {
	let cashCents = unassignedNetCents;
	let cardsOwedCents = 0;

	for (const account of accounts) {
		if (account.archived) continue;
		const balance = balances.get(account.id) ?? account.openingBalanceCents;
		if (account.kind === 'credit_card') cardsOwedCents += owedCents(balance);
		else cashCents += balance;
	}

	return { cashCents, cardsOwedCents, netCents: cashCents - cardsOwedCents };
};

export default { owedCents, summarizeAccounts };
