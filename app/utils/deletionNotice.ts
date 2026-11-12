/**
 * As frases das confirmações de encerrar, apagar, juntar e reabrir conta ou cartão (SPD-144).
 *
 * Cada uma diz o efeito em R$. Antes (SPD-141), "Excluir" contava quantos lançamentos
 * ficavam "Sem conta" e quantas transferências eram apagadas, sem dizer um real do que mudava
 * — e mudava: apagar a PJ que mandou 2 × R$ 12.000 derrubava o patrimônio em R$ 24.000.
 * Agora apagar só vale para conta vazia (`isAccountEmpty`, em `accountClosing.ts`); conta com
 * conteúdo é encerrada ou juntada, e a frase diz para onde vai o dinheiro e o que acontece
 * com o patrimônio.
 *
 * `scope` é o bloco do i18n: `accounts.edit` (conta) ou `cards.edit` (cartão).
 */
import type { AccountContents, ClosePlan } from './accountClosing';
import { formatCents } from './money';

type Translate = (key: string, options?: Record<string, unknown>) => string;
export type NoticeScope = 'accounts.edit' | 'cards.edit';

/** Conta vazia: "apagar não muda nada nos seus números", e o que fica sem conta. */
export const deleteConfirmMessage = (scope: NoticeScope, name: string, contents: AccountContents, t: Translate): string => {
	const parts = [t(`${scope}.deleteEmptyConfirm`, { name })];
	const linked = contents.bills + contents.debts;
	if (linked > 0) parts.push(t(`${scope}.deleteLinked`, { count: linked }));
	parts.push(t(`${scope}.deleteContinue`));
	return parts.join(' ');
};

/**
 * Conta com conteúdo: o primeiro motivo (lançamentos, transferências, capturas, saldo de
 * partida) e o que fazer no lugar — encerrar ou juntar.
 */
export const deleteRefusedMessage = (scope: NoticeScope, name: string, contents: AccountContents, t: Translate): string => {
	let reason: string;
	if (contents.transactions > 0) reason = t(`${scope}.deleteRefusedEntries`, { count: contents.transactions, name });
	else if (contents.transfers > 0) reason = t(`${scope}.deleteRefusedTransfers`, { count: contents.transfers, name });
	else if (contents.captures > 0) reason = t(`${scope}.deleteRefusedCaptures`, { count: contents.captures, name });
	else reason = t(`${scope}.deleteRefusedOpening`, { amount: formatCents(Math.abs(contents.openingBalanceCents)), name });
	return `${reason} ${t(`${scope}.deleteRefusedWhy`)}`;
};

export interface CloseConfirmInput {
	name: string;
	/** A conta do outro lado da transferência de encerramento. */
	target?: string;
	plan: ClosePlan;
	/** A conta já estava encerrada (com saldo, fora dos totais): acertar faz o patrimônio de hoje mudar. */
	alreadyClosed: boolean;
	/** Papéis diferentes (reserva → principal): a transferência entra no quadro do mês. */
	roleChange: boolean;
}

/** A confirmação de encerrar (ou de acertar o saldo de uma já encerrada), com o valor. */
export const closeConfirmMessage = (scope: NoticeScope, input: CloseConfirmInput, t: Translate): string => {
	const { name, target, plan, alreadyClosed, roleChange } = input;
	if (plan.kind !== 'transfer') return t(`${scope}.closeDirect`, { name });
	const amount = formatCents(plan.amountCents);
	if (alreadyClosed) {
		return t(plan.direction === 'out' ? `${scope}.settleOut` : `${scope}.settleIn`, { amount, name, target });
	}
	const message = t(plan.direction === 'out' ? `${scope}.closeTransferOut` : `${scope}.closeTransferIn`, { amount, name, target });
	return roleChange ? `${message} ${t(`${scope}.closeRoleNote`)}` : message;
};

/** Por que não dá para encerrar agora, e o que fazer antes. */
export const closeBlockedMessage = (
	scope: NoticeScope,
	name: string,
	plan: Extract<ClosePlan, { kind: 'blocked' }>,
	t: Translate
): string => {
	switch (plan.reason) {
		case 'cardOwes':
			return t(`${scope}.closeBlockedOwes`, { amount: formatCents(plan.amountCents), name });
		case 'pendingCaptures':
			return t(`${scope}.closeBlockedPending`, { count: plan.count, name });
		case 'futureEntries':
			return t(`${scope}.closeBlockedFuture`, { count: plan.count, name });
	}
};

/** Juntar: o que passa para a outra e com quanto ela fica — o total das contas não muda. */
export const mergeConfirmMessage = (scope: NoticeScope, from: string, into: string, totalCents: number, t: Translate): string =>
	t(`${scope}.mergeConfirm`, { from, into, total: formatCents(totalCents) });

/**
 * Reabrir com saldo: ele volta aos totais de hoje (negativo — o cartão devendo —, como
 * dívida). Sem saldo, nada a perguntar (`null`).
 */
export const reopenMessage = (scope: NoticeScope, name: string, balanceCents: number, t: Translate): string | null => {
	if (balanceCents === 0) return null;
	const amount = formatCents(Math.abs(balanceCents));
	return balanceCents > 0 ? t(`${scope}.reopenBalance`, { name, amount }) : t(`${scope}.reopenOwing`, { name, amount });
};

export default { deleteConfirmMessage, deleteRefusedMessage, closeConfirmMessage, closeBlockedMessage, mergeConfirmMessage, reopenMessage };
