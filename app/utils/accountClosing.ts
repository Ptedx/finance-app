/**
 * Encerrar, juntar e apagar conta ou cartão (SPD-144): as regras puras.
 *
 * O app não guarda foto do passado — saldo, patrimônio e histórico são recalculados das
 * linhas de hoje —, então qualquer operação que tire linhas de uma conta reescreve os
 * números. Por isso:
 *
 * - **Encerrar** (a flag `archived`) é a saída normal: a conta sai das listas, dos seletores
 *   e dos totais de hoje, e o histórico fica inteiro. Só com saldo zero; com saldo, uma
 *   transferência de hoje leva o saldo para outra conta antes (e o patrimônio não muda).
 * - **Juntar** é arrumação de duplicata: o total fica igual, e só entre contas do mesmo papel
 *   (cartão com cartão) — papéis diferentes reclassificariam o histórico.
 * - **Apagar** só conta vazia: sem lançamento, transferência, captura nem saldo de partida.
 *   Conta a pagar e dívida ligadas não contam: ficam "sem conta".
 */
import type { Account } from '../database/schema';

/** A observação da transferência que leva o saldo de uma conta que vai ser encerrada. */
export const CLOSING_TRANSFER_NOTE = 'Encerramento da conta';

/** O que está ligado a uma conta, contado no banco (`getAccountContents`). */
export interface AccountContents {
	/** Lançamentos vivos da conta, parcelas futuras inclusive. */
	transactions: number;
	/** Transferências vivas com a conta numa das pontas (pagamento de fatura inclusive). */
	transfers: number;
	/** Capturas vivas da caixa de entrada que apontam para a conta, em qualquer status. */
	captures: number;
	/** O saldo de partida (num cartão, a fatura informada, negativa). */
	openingBalanceCents: number;
	/** Contas a pagar vivas ligadas à conta: ficam sem conta se ela for apagada. */
	bills: number;
	/** Dívidas vivas ligadas à conta: ficam sem conta se ela for apagada. */
	debts: number;
}

/**
 * Conta vazia: nada que mexa em saldo ou histórico. Apagá-la não muda nenhum número.
 * Contas a pagar e dívidas ligadas não impedem: elas só perdem a conta.
 */
export const isAccountEmpty = (contents: AccountContents): boolean =>
	contents.transactions === 0 &&
	contents.transfers === 0 &&
	contents.captures === 0 &&
	contents.openingBalanceCents === 0;

/** Por que encerrar não pode agora. */
export type CloseBlocker = 'cardOwes' | 'pendingCaptures' | 'futureEntries';

/** Como encerrar sem mexer no patrimônio. */
export type ClosePlan =
	| { kind: 'direct' }
	/** `out`: o saldo sai da conta para outra; `in`: entra de outra e zera o saldo negativo. */
	| { kind: 'transfer'; direction: 'out' | 'in'; amountCents: number }
	| { kind: 'blocked'; reason: CloseBlocker; amountCents: number; count: number };

export interface ClosePlanInput {
	account: Pick<Account, 'kind' | 'role'>;
	/** O saldo de hoje, como a tela mostra (rendimento estimado e capturas provisórias inclusive). */
	balanceCents: number;
	/** Compras desta conta ainda pendentes na caixa de entrada. */
	pendingCaptures: number;
	/** Lançamentos com data depois de hoje (parcelas por cair, agendados). */
	futureEntries: number;
}

/**
 * O plano para encerrar.
 *
 * - Conta externa (PJ, a conta de outra pessoa): direto. O saldo dela nunca contou nos
 *   totais, e o que ela mandou continua sendo renda no histórico.
 * - Compra pendente na caixa de entrada: espera. Confirmada depois, ela mudaria o saldo de
 *   uma conta já encerrada, fora dos totais.
 * - Lançamento com data futura: espera. Ao cair, ele mudaria o saldo da encerrada.
 * - Saldo zero: direto.
 * - Cartão devendo: espera o pagamento da fatura. Uma transferência "de encerramento" para o
 *   cartão seria um pagamento de fatura que não aconteceu.
 * - O resto: uma transferência de hoje zera o saldo (para fora se positivo, para dentro se
 *   negativo). O dinheiro muda de conta; o patrimônio, não.
 */
export const planAccountClose = (input: ClosePlanInput): ClosePlan => {
	const { account, balanceCents, pendingCaptures, futureEntries } = input;
	if (account.role === 'external') return { kind: 'direct' };
	if (pendingCaptures > 0)
		return { kind: 'blocked', reason: 'pendingCaptures', amountCents: 0, count: pendingCaptures };
	if (futureEntries > 0)
		return { kind: 'blocked', reason: 'futureEntries', amountCents: 0, count: futureEntries };
	if (balanceCents === 0) return { kind: 'direct' };
	if (account.kind === 'credit_card' && balanceCents < 0) {
		return { kind: 'blocked', reason: 'cardOwes', amountCents: -balanceCents, count: 0 };
	}
	return balanceCents > 0
		? { kind: 'transfer', direction: 'out', amountCents: balanceCents }
		: { kind: 'transfer', direction: 'in', amountCents: -balanceCents };
};

const isLive = (account: Pick<Account, 'archived' | 'deletedAt'>): boolean =>
	!account.archived && !account.deletedAt;
const isCard = (account: Pick<Account, 'kind' | 'role'>): boolean =>
	account.kind === 'credit_card' || account.role === 'card';

/**
 * Para onde pode ir (ou de onde pode vir) o saldo de quem encerra: conta ativa que conta no
 * caixa ou na reserva. Cartão não (seria pagamento de fatura), externa não (o dinheiro
 * sairia do patrimônio), encerrada não (ficaria fora dos totais). Na ordem da lista.
 */
export const closeTargets = <T extends Account>(accounts: T[], closing: Pick<Account, 'id'>): T[] =>
	accounts.filter(
		(account) =>
			account.id !== closing.id &&
			isLive(account) &&
			!isCard(account) &&
			account.role !== 'external'
	);

/**
 * Com quem juntar: conta ativa do mesmo papel — principal com principal, reserva com
 * reserva, cartão com cartão. Juntar papéis diferentes mudaria o histórico (o que era
 * guardado viraria caixa, a renda da PJ viraria transferência interna).
 */
export const mergeTargets = <T extends Account>(
	accounts: T[],
	from: Pick<Account, 'id' | 'kind' | 'role'>
): T[] =>
	accounts.filter(
		(account) =>
			account.id !== from.id &&
			isLive(account) &&
			from.role !== 'external' &&
			(from.kind === 'credit_card'
				? account.kind === 'credit_card'
				: account.kind !== 'credit_card' && account.role === from.role)
	);

/** O banco recusou apagar: a conta tem lançamento, transferência, captura ou saldo de partida. */
export class AccountInUseError extends Error {
	constructor(message = 'A conta tem conteúdo: encerre ou junte com outra') {
		super(message);
		this.name = 'AccountInUseError';
	}
}

export default {
	CLOSING_TRANSFER_NOTE,
	isAccountEmpty,
	planAccountClose,
	closeTargets,
	mergeTargets,
	AccountInUseError,
};
