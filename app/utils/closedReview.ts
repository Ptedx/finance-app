import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Account } from '../database/schema';
import { type NetWorthInput, netWorth, owedCents } from './accountMath';
import { isDebitTarget } from './accountMerging';
import type { Cents } from './money';

/**
 * Encerradas com saldo (SPD-150): a lista para o usuário decidir, conta por conta.
 *
 * Desde o SPD-144, encerrar exige saldo zero (ou a transferência de encerramento), e a conta
 * encerrada fica neutra. Sobram as encerradas **antes** dele com saldo, e as que voltaram do
 * reparo da carga (SPD-149). Hoje elas somem de "Em caixa" e de "Depois das faturas", mas o
 * cartão encerrado devendo ainda conta no Patrimônio — a mesma dívida dentro de um total e
 * fora do outro. A regra dos totais não muda em silêncio: cada uma aparece aqui, e o usuário
 * escolhe, vendo antes o efeito em R$:
 *
 * - **transferir** o saldo para outra conta (o encerramento de verdade, como no SPD-144); no
 *   cartão devendo é **pagar** a fatura com uma conta;
 * - **reabrir**: volta aos totais de hoje;
 * - **zerar**, porque o saldo não existe mais: sem gasto nem receita no histórico.
 *
 * Decidida, a conta fica com saldo zero (ou ativa, de volta aos totais) e a incoerência acaba.
 */

/** Uma encerrada com saldo. */
export interface ClosedReviewItem {
	account: Account;
	/** O saldo de hoje como a tela mostra (num cartão, negativo = deve). */
	balanceCents: Cents;
	/** Num cartão, o que o Patrimônio conta como devido (`CardSummary.owedCents`); senão 0. */
	owedCents: Cents;
}

const isCard = (account: Pick<Account, 'kind'>): boolean => account.kind === 'credit_card';

/**
 * As encerradas (arquivadas) vivas com saldo diferente de zero, na ordem da lista. A externa
 * fica de fora: o saldo dela nunca contou nos totais, e encerrá-la já era direto.
 * `cardOwed` é o devido de cada cartão como o Patrimônio soma.
 */
export const closedReviewItems = (
	accounts: Account[],
	balances: Map<string, number>,
	cardOwed: Map<string, number>
): ClosedReviewItem[] =>
	accounts
		.filter((account) => account.archived && !account.deletedAt && account.role !== 'external')
		.map((account) => {
			const balanceCents = balances.get(account.id) ?? account.openingBalanceCents;
			return {
				account,
				balanceCents,
				owedCents: isCard(account) ? (cardOwed.get(account.id) ?? owedCents(balanceCents)) : 0,
			};
		})
		.filter((item) => item.balanceCents !== 0);

/**
 * Para onde vai o saldo da encerrada ("Transferir o saldo"), de onde vem o que a cobre ("Cobrir
 * com outra conta") ou quem paga a fatura do cartão ("Pagar a fatura"): só conta principal
 * ativa, a mesma regra do levar cartão para o débito (`isDebitTarget`, SPD-152). A Reserva
 * transformaria o acerto de uma conta antiga em poupança (ou resgate) deste mês, e a externa
 * nunca contou nos totais. O encerrar normal e o juntar têm as listas deles (SPD-155).
 */
export const closedReviewTargets = <T extends Account>(accounts: T[], closed: Pick<Account, 'id'>): T[] =>
	accounts.filter((account) => account.id !== closed.id && isDebitTarget(account));

/** O que o usuário escolhe para uma encerrada com saldo. `transfer` no cartão devendo é pagar. */
export type ClosedDecision =
	| { kind: 'transfer'; target: Pick<Account, 'role' | 'kind'> }
	| { kind: 'reopen' }
	| { kind: 'zero' };

/** A decisão como o `AccountsContext` a grava: o destino da transferência pelo id. */
export type ClosedSettlement = { kind: 'transfer'; targetId: string } | { kind: 'reopen' } | { kind: 'zero' };

/** Os totais de hoje: as partes do Patrimônio (`netWorth`) e "Depois das faturas". */
export interface ClosedTotals extends NetWorthInput {
	/** "Depois das faturas" (`overview.netCents`): caixa menos o devido nos cartões ativos. */
	netCents: Cents;
}

export interface ClosedEffect {
	/** O Patrimônio, como a tela soma. */
	worth: { beforeCents: Cents; afterCents: Cents };
	/** "Depois das faturas". */
	net: { beforeCents: Cents; afterCents: Cents };
	/**
	 * O "Guardado" deste mês: a transferência é de hoje, e entrar numa reserva (ou sair de
	 * uma) é poupança do mês, como no encerramento do SPD-144.
	 */
	savedThisMonthCents: Cents;
}

/** Quanto muda o bolso de hoje (caixa ou guardado) de uma conta ativa que recebe `cents`. */
const credit = (parts: ClosedTotals, account: Pick<Account, 'role'>, cents: number): ClosedTotals =>
	account.role === 'reserve'
		? { ...parts, savedCents: parts.savedCents + cents }
		: { ...parts, cashCents: parts.cashCents + cents, netCents: parts.netCents + cents };

/**
 * O efeito de uma decisão nos totais de hoje, antes de tomá-la. A conta encerrada não está em
 * "Em caixa" nem em "Depois das faturas"; o cartão encerrado está no Patrimônio pelo devido.
 *
 * - Transferir: o saldo vai para (ou vem de) a conta escolhida, e ela conta. No cartão
 *   devendo, a conta escolhida paga a fatura: sai dela, e o devido sai do Patrimônio.
 * - Reabrir: a conta volta a "Em caixa" (ou ao guardado); o cartão volta a "Depois das faturas"
 *   pelo devido, e crédito de cartão não vira ativo.
 * - Zerar: só o devido do cartão sai do Patrimônio (pago fora do app); a conta já estava fora.
 */
export const closedDecisionEffect = (item: ClosedReviewItem, decision: ClosedDecision, totals: ClosedTotals): ClosedEffect => {
	const { account, balanceCents } = item;
	let after: ClosedTotals = totals;
	let savedThisMonthCents = 0;

	if (decision.kind === 'transfer') {
		const moved = Math.abs(balanceCents);
		if (isCard(account) && balanceCents < 0) {
			after = credit(after, decision.target, -moved);
			after = { ...after, cardsCents: after.cardsCents - item.owedCents };
			if (decision.target.role === 'reserve') savedThisMonthCents = -moved;
		} else {
			// Positivo sai da encerrada para o destino; negativo vem do destino e zera a encerrada.
			const toTarget = balanceCents > 0 ? moved : -moved;
			after = credit(after, decision.target, toTarget);
			if (decision.target.role === 'reserve') savedThisMonthCents += toTarget;
			if (account.role === 'reserve') savedThisMonthCents -= toTarget;
		}
	} else if (decision.kind === 'reopen') {
		if (isCard(account)) {
			const owed = owedCents(balanceCents);
			after = { ...after, netCents: after.netCents - owed };
		} else {
			after = credit(after, account, balanceCents);
		}
	} else if (isCard(account) && balanceCents < 0) {
		after = { ...after, cardsCents: after.cardsCents - item.owedCents };
	}

	return {
		worth: { beforeCents: netWorth(totals).netCents, afterCents: netWorth(after).netCents },
		net: { beforeCents: totals.netCents, afterCents: after.netCents },
		savedThisMonthCents: savedThisMonthCents + 0,
	};
};

// ---------------------------------------------------------------------------
// "Já mostrada"
// ---------------------------------------------------------------------------

/**
 * As encerradas com saldo que a lista já mostrou. A lista aparece sozinha uma vez (o aviso
 * curto da tela inicial leva até ela); depois fica na tela de Contas enquanto houver item. Uma
 * conta nova na lista — a que voltou do reparo, por exemplo — faz o aviso aparecer de novo.
 *
 * Fica **só neste aparelho**, como o "Saldo não informado" dispensado
 * (`balanceUnsetDismissals`): a decisão em si (transferir, reabrir, zerar) é que sobe no sync.
 */
export const CLOSED_REVIEW_SEEN_KEY = '@spendr_closed_review_seen';

export const getClosedReviewSeen = async (): Promise<Set<string>> => {
	try {
		const stored = await AsyncStorage.getItem(CLOSED_REVIEW_SEEN_KEY);
		const parsed: unknown = stored ? JSON.parse(stored) : [];
		return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []);
	} catch {
		return new Set();
	}
};

/** A lista foi mostrada com estas contas. Devolve o conjunto guardado. */
export const markClosedReviewSeen = async (ids: Iterable<string>): Promise<Set<string>> => {
	const next = await getClosedReviewSeen();
	for (const id of ids) next.add(id);
	try {
		await AsyncStorage.setItem(CLOSED_REVIEW_SEEN_KEY, JSON.stringify([...next]));
	} catch (error) {
		console.warn('Não foi possível guardar a lista de encerradas já mostrada:', error);
	}
	return next;
};

/** Alguma encerrada com saldo que a lista ainda não mostrou. */
export const unseenClosedReview = (items: ClosedReviewItem[], seen: Set<string>): boolean =>
	items.some((item) => !seen.has(item.account.id));

export default {
	CLOSED_REVIEW_SEEN_KEY,
	closedReviewItems,
	closedReviewTargets,
	closedDecisionEffect,
	getClosedReviewSeen,
	markClosedReviewSeen,
	unseenClosedReview,
};
