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
