/**
 * O que a confirmação de "Excluir conta" e "Excluir cartão" diz que vai acontecer (SPD-141).
 *
 * `deleteAccount` (`database/database.ts`) deixa os lançamentos da conta "Sem conta" e põe
 * lápide em todas as transferências que entram ou saem dela — inclusive os pagamentos de
 * fatura, que são transferências para o cartão. A confirmação antiga só falava dos
 * lançamentos. Aqui se conta, com as mesmas regras do SQL da exclusão, quanto de cada coisa
 * está ligado à conta, e se monta a frase com esses números.
 */
import { getAccountTransactions, getAccountTransfers } from '../database/database';
import type { Account, Transaction, Transfer } from '../database/schema';

/** Quanto a exclusão alcança. */
export interface DeletionImpact {
	/** Lançamentos vivos da conta (parcelas futuras inclusive): ficam "Sem conta". */
	entries: number;
	/** Transferências vivas para um cartão (pagamentos de fatura): são apagadas. */
	invoicePayments: number;
	/** As demais transferências vivas que entram ou saem da conta: são apagadas. */
	transfers: number;
}

/**
 * Conta, nos lançamentos e transferências dados, o que a exclusão de `accountId` alcança.
 * Os filtros são os do `deleteAccount`: `accountId` igual e vivo; transferência viva com a
 * conta numa das pontas. Pagamento de fatura é a transferência cujo destino é um cartão.
 */
export const deletionImpact = (
	accountId: string,
	transactions: Pick<Transaction, 'accountId' | 'deletedAt'>[],
	transfers: Pick<Transfer, 'fromAccountId' | 'toAccountId' | 'deletedAt'>[],
	accounts: Pick<Account, 'id' | 'kind'>[]
): DeletionImpact => {
	const cards = new Set(accounts.filter((account) => account.kind === 'credit_card').map((account) => account.id));
	const entries = transactions.filter((transaction) => transaction.accountId === accountId && !transaction.deletedAt).length;
	const touched = transfers.filter(
		(transfer) => !transfer.deletedAt && (transfer.fromAccountId === accountId || transfer.toAccountId === accountId)
	);
	const invoicePayments = touched.filter((transfer) => transfer.toAccountId !== null && cards.has(transfer.toAccountId)).length;
	return { entries, invoicePayments, transfers: touched.length - invoicePayments };
};

/** Lê do banco o que a exclusão de `accountId` alcança. */
export const loadDeletionImpact = async (accountId: string, accounts: Pick<Account, 'id' | 'kind'>[]): Promise<DeletionImpact> => {
	const [transactions, transfers] = await Promise.all([getAccountTransactions(accountId), getAccountTransfers(accountId)]);
	return deletionImpact(accountId, transactions, transfers, accounts);
};

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * A frase da confirmação: "12 lançamentos continuam no histórico, mas ficam "Sem conta". 3
 * pagamentos de fatura serão apagados. Continuar?". Só entra o que existe; sem nada ligado,
 * diz isso. `scope` é o bloco do i18n: `accounts.edit` (conta) ou `cards.edit` (cartão).
 */
export const deletionMessage = (scope: 'accounts.edit' | 'cards.edit', impact: DeletionImpact, t: Translate): string => {
	const parts: string[] = [];
	if (impact.entries > 0) parts.push(t(`${scope}.deleteEntries`, { count: impact.entries }));
	if (impact.invoicePayments > 0) parts.push(t(`${scope}.deletePayments`, { count: impact.invoicePayments }));
	if (impact.transfers > 0) parts.push(t(`${scope}.deleteTransfers`, { count: impact.transfers }));
	if (parts.length === 0) parts.push(t(`${scope}.deleteEmpty`));
	parts.push(t(`${scope}.deleteContinue`));
	return parts.join(' ');
};

/**
 * A frase para a confirmação, com os números; sem eles (a leitura falhou), a frase geral
 * `deleteConfirm`, que diz o mesmo sem contar.
 */
export const loadDeletionMessage = async (
	scope: 'accounts.edit' | 'cards.edit',
	accountId: string,
	accounts: Pick<Account, 'id' | 'kind'>[],
	t: Translate
): Promise<string> => {
	try {
		return deletionMessage(scope, await loadDeletionImpact(accountId, accounts), t);
	} catch (error) {
		console.error('Error counting what the deletion reaches:', error);
		return t(`${scope}.deleteConfirm`);
	}
};
