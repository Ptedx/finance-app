/**
 * O conserto do livro quando um cartão nasce ou muda (AUTO-06). Puro: recebe contas,
 * capturas e lançamentos, devolve o que mover. `AccountsContext` aplica.
 *
 * A compra que o app do banco avisou antes de o cartão existir caiu na conta corrente —
 * era o melhor destino que havia. Com o cartão cadastrado, as regras de hoje
 * (`planLedgerRepair`, as mesmas da migração v12) já sabem que ela é dele. Aqui o plano é
 * recortado para um cartão só, e sai dele tudo o que o usuário mexeu à mão.
 */

import type { Account, Capture, Transaction } from '../database/schema';
import { normalizeText } from './captureParser';
import { cardInstallmentDates } from './cardMath';
import { getISODate } from './dateUtils';
import { splitInstallments } from './installments';
import { planLedgerRepair } from './notificationTarget';

export interface CardLedgerMove {
	captureId: string;
	/** O da captura, como `reassignCaptureLedger` pede. Nulo numa pendente. */
	transactionId: string | null;
	/** Os lançamentos que vão junto (vazio numa pendente: ela ainda não está no livro). */
	transactionIds: string[];
	toId: string;
}

export interface CardLedgerRepair {
	moves: CardLedgerMove[];
	/** Capturas que iriam para o cartão, mas cujo lançamento o usuário editou: ficam. */
	keptEdited: string[];
}

/** Os lançamentos que uma captura pôs no livro, como `migrateCardPurchasesToRealCard` os acha. */
const ledgerOf = (capture: Capture, transactions: Transaction[]): Transaction[] =>
	transactions.filter(
		(tx) =>
			!tx.deletedAt &&
			((capture.transactionId !== null && tx.id === capture.transactionId) ||
				tx.installmentGroup === capture.id)
	);

/**
 * O lançamento está como a captura o gravou? Compara com o que `postTransaction`
 * (captureActions.ts) escreve: valor, data, nota, categoria, direção, final e conta. Uma
 * diferença em qualquer um é mão do usuário — corrigiu o valor, recategorizou, apagou uma
 * parcela, levou para outra conta — e aí a compra fica onde ele deixou.
 *
 * A conta de origem não é cartão (o plano só move dessas), então as parcelas foram datadas
 * de mês em mês, sem ciclo de fatura.
 */
const isUntouched = (capture: Capture, rows: Transaction[]): boolean => {
	const count = capture.installments && capture.installments > 1 ? capture.installments : 1;
	if (rows.length !== count) return false;
	const date = getISODate(new Date(capture.postedAt));
	const note = capture.counterparty ?? capture.appLabel;
	const parts = splitInstallments(capture.amountCents, count);
	const dates = cardInstallmentDates(date, count, null);
	const byIndex = [...rows].sort((a, b) => (a.installmentIndex ?? 0) - (b.installmentIndex ?? 0));
	return byIndex.every((tx, position) => {
		const index = position + 1;
		const sameShape =
			count === 1
				? tx.id === capture.transactionId && tx.installmentGroup === null
				: tx.installmentGroup === capture.id &&
					tx.installmentIndex === index &&
					tx.installmentCount === count;
		return (
			sameShape &&
			tx.accountId === capture.accountId &&
			tx.amountCents === parts[position] &&
			tx.date === dates[position] &&
			tx.note === (count === 1 ? note : `${note} (${index}/${count})`) &&
			tx.category === capture.suggestedCategory &&
			tx.isIncome === (capture.direction === 'in') &&
			tx.cardLast4 === capture.cardLast4
		);
	});
};

/**
 * O que mover para o cartão `cardId`: as compras que as regras de hoje põem nele e que
 * estão na conta corrente. Fica de fora:
 *
 * - o que o plano geral manda para outro cartão, e a junção de cartões criados por final
 *   virtual (`mergeCards`): apagar um cartão é decisão do usuário, em "juntar";
 * - a compra casada com o extrato (`statement_transaction`): o lançamento é a linha do OFX
 *   daquela conta, e foi o banco quem disse de onde o dinheiro saiu;
 * - a compra cujo lançamento o usuário editou (`isUntouched`).
 *
 * Idempotente, como o plano geral: depois de aplicado, não acha mais nada.
 */
export const planCardLedgerRepair = (
	cardId: string,
	accounts: Account[],
	captures: Capture[],
	transactions: Transaction[]
): CardLedgerRepair => {
	const card = accounts.find((account) => account.id === cardId);
	if (!card || card.kind !== 'credit_card' || card.archived || card.deletedAt)
		return { moves: [], keptEdited: [] };

	const live = captures.filter((capture) => !capture.deletedAt);
	const byId = new Map(live.map((capture) => [capture.id, capture]));
	const moves: CardLedgerMove[] = [];
	const keptEdited: string[] = [];
	for (const planned of planLedgerRepair(accounts, live).moveCaptures) {
		const capture = byId.get(planned.captureId);
		if (!capture || planned.toId !== cardId || capture.reason === 'statement_transaction') continue;
		if (capture.status === 'pending' && capture.transactionId === null) {
			moves.push({ captureId: capture.id, transactionId: null, transactionIds: [], toId: cardId });
			continue;
		}
		const rows = ledgerOf(capture, transactions);
		if (!isUntouched(capture, rows)) {
			keptEdited.push(capture.id);
			continue;
		}
		moves.push({
			captureId: capture.id,
			transactionId: capture.transactionId,
			transactionIds: rows.map((tx) => tx.id),
			toId: cardId,
		});
	}
	return { moves, keptEdited };
};

/** O mesmo teste de `notificationTarget.ts`: "débito" no nome tira o cartão da escolha. */
const DEBIT_NAME = /\bdebito\b/;
const namedDebit = (account: Pick<Account, 'name'>): boolean =>
	DEBIT_NAME.test(normalizeText(account.name));

/**
 * Salvar esta conta muda para onde vão as compras? Só então o conserto roda: renomear,
 * trocar a cor, o limite ou o ciclo não muda o destino de compra nenhuma.
 *
 * Cartão novo, ativo: sim. Editado: o banco, o final, o tipo, o app ligado, os finais
 * nomeados (virtuais), voltar do arquivo e "débito" entrar ou sair do nome — é o que
 * `pickNotificationTarget` olha. Quem deixou de ser cartão de crédito não recebe compra.
 */
export const changesCardRouting = (before: Account | null, after: Account): boolean => {
	if (after.kind !== 'credit_card' || after.archived || after.deletedAt) return false;
	if (!before) return true;
	return (
		before.kind !== after.kind ||
		before.bankName !== after.bankName ||
		before.last4 !== after.last4 ||
		before.packageName !== after.packageName ||
		before.cardNames !== after.cardNames ||
		before.archived !== after.archived ||
		namedDebit(before) !== namedDebit(after)
	);
};
