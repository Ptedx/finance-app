/**
 * Contas, cartões e o que a tela inicial mostra sobre eles. Puro e testado.
 *
 * O saldo de cada conta vem do banco de dados (`getAccountBalances`); aqui ficam as
 * somas e as datas de ciclo do cartão, que não dependem de SQL.
 *
 * Convenção de sinal: o saldo de um cartão é **negativo** quando há valor a pagar.
 * A mesma fórmula da conta corrente serve, e a tela mostra `-saldo` como "a pagar".
 */

import type { Account } from '../database/schema';
import { addDays, buildClampedDate, parseISODate } from './dateUtils';

export interface CardCycle {
	/** Primeiro dia do ciclo em aberto (o dia seguinte ao último fechamento). */
	cycleStart: string;
	/** Último fechamento, já ocorrido. */
	lastClosing: string;
	/** Próximo fechamento, ainda por vir. */
	nextClosing: string;
	/** Vencimento da fatura que fecha em `nextClosing`. */
	nextDue: string;
	/** Dias até o próximo fechamento (0 = fecha hoje). */
	daysToClosing: number;
}

const dayNumber = (date: string): number => {
	const [year, month, day] = date.split('-').map(Number);
	return Math.round(Date.UTC(year, month - 1, day) / 86_400_000);
};

/**
 * Onde o ciclo do cartão está hoje.
 *
 * O fechamento é "dia N" de cada mês, preso ao tamanho do mês (dia 31 fecha em 28 de
 * fevereiro). Se o dia N deste mês ainda não chegou, o último fechamento foi no mês
 * passado. O vencimento é o dia `dueDay` no primeiro mês em que ele cai depois do
 * fechamento — normalmente o mês seguinte, ou o mesmo mês quando `dueDay > closingDay`.
 */
export const cardCycleOn = (closingDay: number, dueDay: number | null, today: string): CardCycle => {
	const date = parseISODate(today);
	const year = date.getFullYear();
	const month = date.getMonth() + 1;

	// Sempre a partir de (ano, mês, dia preferido), nunca avançando a data já presa:
	// um fechamento no dia 31 preso a 28 de fevereiro tem que voltar ao 31 em março.
	const shift = (y: number, m: number, delta: number): [number, number] => {
		const total = y * 12 + (m - 1) + delta;
		return [Math.floor(total / 12), (total % 12) + 1];
	};

	const thisMonthClosing = buildClampedDate(year, month, closingDay);
	const [ly, lm] = thisMonthClosing <= today ? [year, month] : shift(year, month, -1);
	const lastClosing = buildClampedDate(ly, lm, closingDay);
	const [ny, nm] = shift(ly, lm, 1);
	const nextClosing = buildClampedDate(ny, nm, closingDay);

	const due = dueDay ?? closingDay;
	let nextDue = buildClampedDate(ny, nm, due);
	if (nextDue <= nextClosing) {
		const [dy, dm] = shift(ny, nm, 1);
		nextDue = buildClampedDate(dy, dm, due);
	}

	return {
		cycleStart: addDays(lastClosing, 1),
		lastClosing,
		nextClosing,
		nextDue,
		daysToClosing: dayNumber(nextClosing) - dayNumber(today),
	};
};

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

/** Percentual do limite usado, 0-100+, ou nulo sem limite. */
export const limitUsagePercent = (owed: number, creditLimitCents: number | null): number | null =>
	creditLimitCents && creditLimitCents > 0 ? Math.round((owed / creditLimitCents) * 100) : null;

export default { cardCycleOn, owedCents, summarizeAccounts, limitUsagePercent };
