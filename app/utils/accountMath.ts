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

/** Quanto o cartão deve: o saldo negativo lido ao contrário; um saldo positivo é crédito. */
export const owedCents = (balanceCents: number): number => Math.max(0, -balanceCents);

export interface AccountsOverview {
	/**
	 * O dinheiro disponível para pagar contas: contas que não são cartão nem reserva, mais
	 * os lançamentos sem conta. A reserva fica de fora de propósito — ela não vai ser usada
	 * para pagar a fatura, e contá-la aqui faria parecer que sim.
	 */
	cashCents: number;
	/** O que está guardado nas reservas. Dinheiro seu, mas fora do caixa. */
	savedCents: number;
	/** Soma do que os cartões devem, sem os arquivados. */
	cardsOwedCents: number;
	/** Caixa menos cartões, sem contar a reserva. */
	netCents: number;
}

export const summarizeAccounts = (
	accounts: Account[],
	balances: Map<string, number>,
	unassignedNetCents: number
): AccountsOverview => {
	let cashCents = unassignedNetCents;
	let savedCents = 0;
	let cardsOwedCents = 0;

	for (const account of accounts) {
		if (account.archived) continue;
		const balance = balances.get(account.id) ?? account.openingBalanceCents;
		if (account.kind === 'credit_card') cardsOwedCents += owedCents(balance);
		else if (account.role === 'reserve') savedCents += balance;
		else cashCents += balance;
	}

	return { cashCents, savedCents, cardsOwedCents, netCents: cashCents - cardsOwedCents };
};

export interface NetWorthInput {
	/** Contas (corrente, carteira, envelope): `overview.cashCents`. */
	cashCents: number;
	/** Reservas e investimentos no app: `overview.savedCents`. */
	savedCents: number;
	/** Investimentos que o app não acompanha (da meta de aposentadoria). */
	outsideCents: number;
	/** Cartões: o que já está nas faturas mais as parcelas que ainda vão cair. */
	cardsCents: number;
	/** Saldo devedor das dívidas de longo prazo. */
	debtsCents: number;
}

export interface NetWorth {
	/** O que se tem: contas, reservas, investimentos. */
	assetsCents: number;
	/** O que se deve: cartões e dívidas. */
	liabilitiesCents: number;
	/** A diferença. Pode ser negativa — e dizer isso é o ponto. */
	netCents: number;
}

/**
 * O patrimônio líquido: o que se tem menos o que se deve. Bens como carro e imóvel ficam
 * de fora — o app não sabe quanto valem —, então para quem financia um bem o número
 * aparece menor do que é, e a tela diz isso. Saldo negativo numa conta desconta dos ativos;
 * crédito num cartão (pagou a mais) não vira ativo.
 */
export const netWorth = (input: NetWorthInput): NetWorth => {
	const assetsCents = input.cashCents + input.savedCents + Math.max(0, input.outsideCents);
	const liabilitiesCents = Math.max(0, input.cardsCents) + Math.max(0, input.debtsCents);
	return { assetsCents, liabilitiesCents, netCents: assetsCents - liabilitiesCents };
};

export default { counterpartCents, owedCents, spendingAdjustment, summarizeAccounts, netWorth };
