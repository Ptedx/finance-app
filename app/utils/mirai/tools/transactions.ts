import i18next from 'i18next';
import { getAllCaptures } from '../../../database/captures';
import { getAccounts, getCategories, getTransactionsByDateRange, getTransfersByDateRange } from '../../../database/database';
import type { Account, Capture } from '../../../database/schema';
import { normalizeText } from '../../captureParser';
import { cardChargesCategory, rankCategories, separateCardBookkeeping } from '../../reportSeries';
import { loadReportsRaw } from '../../reportsModel';
import { type CaptureHint, merchantOf, type PrivacyContext } from '../privacy';
import { assertPeriod } from './validate';

export interface ListTransactionsInput {
	from: string;
	to: string;
	category: string | null;
	accountId: string | null;
	text: string | null;
	kind: 'expense' | 'income' | 'transfer' | null;
	limit: number;
}

/** Uma linha da lista: lançamento ou transferência, já com o estabelecimento filtrado. */
type Row =
	| {
			kind: 'expense' | 'income';
			id: string;
			date: string;
			amountCents: number;
			merchant: string;
			categoryId: string;
			category: string | null;
			accountId: string | null;
			account: string | null;
			installment: string | null;
			cardLast4: string | null;
	  }
	| {
			kind: 'transfer';
			id: string;
			date: string;
			amountCents: number;
			merchant: string;
			fromAccountId: string | null;
			from: string | null;
			toAccountId: string | null;
			to: string | null;
	  };

const hintOf = (capture: Capture | undefined): CaptureHint | null =>
	capture ? { kind: capture.kind, direction: capture.direction, counterparty: capture.counterparty } : null;

/**
 * `list_transactions`: o livro do período — lançamentos e transferências, do mais novo para o
 * mais antigo, como a lista de lançamentos os guarda (o valor é o do lançamento, positivo; o
 * `kind` diz o lado).
 *
 * O estabelecimento sai por `merchantOf`: Pix e transferência com pessoa viram "Pix para
 * pessoa". Por isso o filtro de texto procura no estabelecimento já filtrado, nunca no texto
 * cru: procurar pelo nome de uma pessoa não acha nada, e não confirma que ela está lá.
 *
 * `matched` e `totals` são de tudo o que passou nos filtros; `transactions` corta em `limit`.
 */
export const listTransactions = async (input: ListTransactionsInput, privacy: PrivacyContext) => {
	assertPeriod(input.from, input.to);
	const [transactions, transfers, accounts, categories, captures] = await Promise.all([
		input.kind === 'transfer' ? Promise.resolve([]) : getTransactionsByDateRange(input.from, input.to),
		input.kind === 'expense' || input.kind === 'income' || input.category !== null
			? Promise.resolve([])
			: getTransfersByDateRange(input.from, input.to),
		getAccounts(),
		getCategories(),
		getAllCaptures(),
	]);
	const accountName = new Map(accounts.map((account: Account) => [account.id, account.name]));
	const categoryName = new Map(categories.map((category) => [category.id, category.name]));
	const byTransaction = new Map<string, Capture>();
	const byTransfer = new Map<string, Capture>();
	for (const capture of captures) {
		if (capture.deletedAt) continue;
		if (capture.transactionId) byTransaction.set(capture.transactionId, capture);
		if (capture.transferId) byTransfer.set(capture.transferId, capture);
	}

	const rows: Row[] = [];
	for (const transaction of transactions) {
		const kind = transaction.isIncome ? 'income' : 'expense';
		if (input.kind !== null && input.kind !== kind) continue;
		if (input.category !== null && transaction.category !== input.category) continue;
		if (input.accountId !== null && transaction.accountId !== input.accountId) continue;
		rows.push({
			kind,
			id: transaction.id,
			date: transaction.date,
			amountCents: transaction.amountCents,
			merchant: merchantOf(transaction.note, transaction.isIncome, hintOf(byTransaction.get(transaction.id)), privacy),
			categoryId: transaction.category,
			category: categoryName.get(transaction.category) ?? null,
			accountId: transaction.accountId,
			account: transaction.accountId ? (accountName.get(transaction.accountId) ?? null) : null,
			installment:
				transaction.installmentIndex !== null && transaction.installmentCount !== null
					? `${transaction.installmentIndex}/${transaction.installmentCount}`
					: null,
			cardLast4: transaction.cardLast4,
		});
	}
	for (const transfer of transfers) {
		if (
			input.accountId !== null &&
			transfer.fromAccountId !== input.accountId &&
			transfer.toAccountId !== input.accountId
		) {
			continue;
		}
		// Sem conta de origem, o dinheiro veio de fora: para o filtro, entrada.
		const incoming = transfer.fromAccountId === null;
		rows.push({
			kind: 'transfer',
			id: transfer.id,
			date: transfer.date,
			amountCents: transfer.amountCents,
			merchant: merchantOf(transfer.note, incoming, hintOf(byTransfer.get(transfer.id)), privacy),
			fromAccountId: transfer.fromAccountId,
			from: transfer.fromAccountId ? (accountName.get(transfer.fromAccountId) ?? null) : null,
			toAccountId: transfer.toAccountId,
			to: transfer.toAccountId ? (accountName.get(transfer.toAccountId) ?? null) : null,
		});
	}

	const needle = input.text === null ? '' : normalizeText(input.text).trim();
	const matched = needle.length === 0 ? rows : rows.filter((row) => normalizeText(row.merchant).includes(needle));
	matched.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));

	const totals = { expenseCents: 0, incomeCents: 0, transferCents: 0 };
	for (const row of matched) {
		if (row.kind === 'expense') totals.expenseCents += row.amountCents;
		else if (row.kind === 'income') totals.incomeCents += row.amountCents;
		else totals.transferCents += row.amountCents;
	}
	return {
		from: input.from,
		to: input.to,
		matched: matched.length,
		returned: Math.min(matched.length, input.limit),
		totals,
		transactions: matched.slice(0, input.limit),
	};
};

/** O nome da linha dos encargos do cartão no idioma do app (o mesmo texto dos Relatórios). */
const cardChargesName = (): string => {
	const key = 'cards.charges.reportLine';
	if (i18next.isInitialized && i18next.exists(key)) return i18next.t(key);
	return 'Encargos do cartão';
};

/**
 * `get_category_totals`: o ranking de categorias dos Relatórios (`rankedCategories` de
 * `useReportsData`): as linhas do mês sem os acertos de fatura e com os encargos do cartão
 * numa linha própria (`separateCardBookkeeping`), ordenadas por `rankCategories`.
 *
 * Cada mês é carregado como os Relatórios o carregam com ele selecionado; as linhas de um mês
 * não dependem do mês selecionado enquanto ele estiver na janela, então o mês anterior sai
 * igual ao da tela. Com `compareWith` nulo, não há comparação.
 */
export const getCategoryTotals = async (input: { month: string; compareWith: string | null }, accounts: Account[], today: string) => {
	const rowsOf = async (month: string) => {
		const raw = await loadReportsRaw(month, accounts, today);
		return separateCardBookkeeping(raw.categoryRows, raw.cardEntries.values()).filter((row) => row.month === month);
	};
	const [categories, current, previous] = await Promise.all([
		getCategories(),
		rowsOf(input.month),
		input.compareWith === null ? Promise.resolve([]) : rowsOf(input.compareWith),
	]);
	const ranked = rankCategories(current, previous, [...categories, cardChargesCategory(cardChargesName())]);
	const totalCents = ranked.reduce((sum, row) => sum + row.currentCents, 0);
	return {
		month: input.month,
		compareWith: input.compareWith,
		totalCents,
		categories: ranked.map((row) =>
			input.compareWith === null
				? { categoryId: row.categoryId, name: row.name, totalCents: row.currentCents, shareBp: row.shareBp }
				: {
						categoryId: row.categoryId,
						name: row.name,
						totalCents: row.currentCents,
						shareBp: row.shareBp,
						compareCents: row.previousCents,
						deltaCents: row.deltaCents,
						// Fração (0,25 = 25% a mais); nula quando a categoria não existia no outro mês.
						deltaRatio: row.pct,
					}
		),
	};
};

/** Todo arquivo sob app/ é rota para o expo-router; o export default só satisfaz essa exigência. */
export default { listTransactions, getCategoryTotals };
