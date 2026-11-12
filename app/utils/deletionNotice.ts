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
import { cardMergeTotals, debitConvertTotals } from './accountMerging';
import { formatShortDate } from './dateUtils';
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

/** Juntar recusado (SPD-152): papéis diferentes mudariam o histórico; encerrar leva o saldo. */
export const mergeRoleBlockedMessage = (from: string, into: string, t: Translate): string =>
	t('accounts.edit.mergeRoleBlocked', { from, into });

/** O que a confirmação de juntar cartões precisa de cada um. */
export interface CardMergeSide {
	name: string;
	/** O saldo de hoje (negativo: deve). */
	balanceCents: number;
	/** A fatura informada (âncora, negativa quando deve) e o dia dela. */
	openingBalanceCents: number;
	openingBalanceDate: string;
}

/**
 * Juntar cartões (SPD-152): "Dívida do cartão: R$ 370 + R$ 500 = R$ 870; o patrimônio não
 * muda." Com as faturas informadas em dias diferentes, a mais nova passa a contar a partir do
 * dia da outra (`mergeCardInto`): os relatórios mudam esse valor de mês, e a frase diz quanto.
 */
export const cardMergeConfirmMessage = (from: CardMergeSide, into: CardMergeSide, t: Translate): string => {
	const totals = cardMergeTotals(from.balanceCents, into.balanceCents);
	const parts = [
		t('cards.edit.mergeConfirmTotal', {
			from: from.name,
			into: into.name,
			fromOwed: formatCents(totals.fromOwedCents),
			intoOwed: formatCents(totals.intoOwedCents),
			total: formatCents(totals.totalOwedCents),
		}),
	];
	if (from.openingBalanceDate !== into.openingBalanceDate) {
		const [earlier, later] = from.openingBalanceDate < into.openingBalanceDate ? [from, into] : [into, from];
		if (later.openingBalanceCents !== 0) {
			parts.push(
				t('cards.edit.mergeAnchorShift', {
					later: later.name,
					earlier: earlier.name,
					amount: formatCents(Math.abs(later.openingBalanceCents)),
					laterDate: formatShortDate(later.openingBalanceDate),
					earlierDate: formatShortDate(earlier.openingBalanceDate),
				})
			);
		}
	}
	parts.push(t('cards.edit.mergeSameCard'));
	return parts.join(' ');
};

export interface DebitConvertInput {
	/** A conta que recebe as compras. */
	account: string;
	/** O saldo de hoje do cartão (negativo: deve) e o da conta. */
	cardBalanceCents: number;
	accountBalanceCents: number;
	/** A fatura informada do cartão (âncora; negativa quando era dívida). */
	cardOpeningBalanceCents: number;
	/** As compras lançadas no cartão (sem estornos), que passam a contar no dia de cada uma. */
	purchasesCents: number;
}

/**
 * Levar o cartão para o débito (SPD-152): o saldo da conta antes → depois, o patrimônio igual
 * e, quando há o que mudar, o efeito nos relatórios em R$ — no débito a compra conta no dia
 * dela, e não no mês da fatura, e a fatura informada deixa de ser gasto do cartão.
 */
export const debitConvertConfirmMessage = (input: DebitConvertInput, t: Translate): string => {
	const totals = debitConvertTotals(input.cardBalanceCents, input.accountBalanceCents);
	const parts = [t('cards.edit.debitConfirmMoves', { account: input.account })];
	const balances = { account: input.account, before: formatCents(totals.accountBeforeCents), after: formatCents(totals.accountAfterCents) };
	if (totals.cardOwedCents > 0) parts.push(t('cards.edit.debitConfirmOwed', { ...balances, amount: formatCents(totals.cardOwedCents) }));
	else if (totals.cardOwedCents < 0) parts.push(t('cards.edit.debitConfirmCredit', { ...balances, amount: formatCents(-totals.cardOwedCents) }));
	else parts.push(t('cards.edit.debitConfirmEven', { account: input.account }));
	if (input.purchasesCents > 0) parts.push(t('cards.edit.debitReportsPurchases', { amount: formatCents(input.purchasesCents) }));
	const informedCents = Math.max(0, 0 - input.cardOpeningBalanceCents);
	if (informedCents > 0) parts.push(t('cards.edit.debitReportsInformed', { amount: formatCents(informedCents), account: input.account }));
	parts.push(t('cards.edit.debitConfirmContinue'));
	return parts.join(' ');
};

/**
 * Levar para o débito recusado (SPD-152): o cartão tem parcelas por cair. Quantas, quanto
 * (o que o patrimônio de hoje subiria sem nada ter sido pago) e quando dá.
 */
export const debitBlockedFutureMessage = (name: string, count: number, amountCents: number, t: Translate): string =>
	t('cards.edit.debitBlockedFuture', { name, count, amount: formatCents(Math.abs(amountCents)) });

/**
 * Reabrir com saldo: ele volta aos totais de hoje (negativo — o cartão devendo —, como
 * dívida). Sem saldo, nada a perguntar (`null`).
 */
export const reopenMessage = (scope: NoticeScope, name: string, balanceCents: number, t: Translate): string | null => {
	if (balanceCents === 0) return null;
	const amount = formatCents(Math.abs(balanceCents));
	return balanceCents > 0 ? t(`${scope}.reopenBalance`, { name, amount }) : t(`${scope}.reopenOwing`, { name, amount });
};

export default {
	deleteConfirmMessage,
	deleteRefusedMessage,
	closeConfirmMessage,
	closeBlockedMessage,
	mergeConfirmMessage,
	mergeRoleBlockedMessage,
	cardMergeConfirmMessage,
	debitConvertConfirmMessage,
	debitBlockedFutureMessage,
	reopenMessage,
};
