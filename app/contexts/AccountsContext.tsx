import type React from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
	addAccount,
	addTransaction,
	addTransfer,
	assignUnassignedTransactions,
	deleteAccount,
	getAccountActivity,
	getAccountBalances,
	getAccounts,
	getAccountTransactions,
	getAccountTransfers,
	getCardPurchasesOriginated,
	getUnassignedNet,
	getUnassignedPeriodSummary,
	moveAccountLedger,
	setAccountBalanceToday,
	updateAccount,
} from '../database/database';
import type { Account, AccountDraft, AccountEdit } from '../database/schema';
import * as syncQueue from '../sync/queue';
import { type AccountsOverview, summarizeAccounts } from '../utils/accountMath';
import {
	buildCardSummary,
	type CardEntry,
	type CardMovement,
	type CardSummary,
	cycleRuleOf,
	existingInstallmentDates,
	invoicesClosingBetween,
} from '../utils/cardMath';
import { generateUniqueId } from '../utils/categoryEditUtils';
import { todayISO } from '../utils/dateUtils';
import { type AccountMonthActivity, buildMonthOverview, type MonthOverview } from '../utils/monthOverview';
import { usePeriod } from './PeriodContext';
import { useTransactions } from './TransactionsContext';

/**
 * Contas e cartões para as telas, **em dois mundos separados**.
 *
 * Contas têm saldo. Cartões têm limite, fatura aberta, fatura fechada e parcelas —
 * calculados por `cardMath.ts` a partir dos lançamentos e pagamentos de cada cartão.
 * As telas de conta nunca veem cartão, e as de cartão nunca veem saldo.
 *
 * Recarrega quando o livro-caixa muda, quando o período muda e quando uma captura vira
 * transferência (o CapturesContext chama `refresh`).
 */

export interface ExistingInstallmentsInput {
	cardId: string;
	note: string;
	category: string;
	parcelCents: number;
	currentIndex: number;
	totalCount: number;
}

interface AccountsContextType {
	/** Tudo, contas e cartões, inclusive arquivados. */
	accounts: Account[];
	/** Contas (não cartões) ativas, na ordem de exibição. */
	bankAccounts: Account[];
	/** Cartões ativos, na ordem de exibição. */
	creditCards: Account[];
	/** Só as não arquivadas, contas e cartões — para seletores de lançamento. */
	activeAccounts: Account[];
	balances: Map<string, number>;
	/** Resumo de cada cartão (ativo ou arquivado). */
	cardSummaries: Map<string, CardSummary>;
	/** Somas de todos os cartões ativos. */
	cardsTotals: { toPayCents: number; openInvoicesCents: number; limitAvailableCents: number | null; limitUsedCents: number };
	overview: AccountsOverview;
	/** O mês selecionado, por papel de conta. Nulo até a primeira carga. */
	month: MonthOverview | null;
	unassignedNetCents: number;
	isLoading: boolean;
	refresh: () => Promise<void>;
	createAccount: (draft: AccountDraft) => Promise<string>;
	saveAccount: (account: AccountEdit) => Promise<void>;
	removeAccount: (id: string) => Promise<void>;
	/** "Meu saldo agora é X". Só contas. */
	setBalanceToday: (id: string, balanceCents: number) => Promise<void>;
	/** "O cartão deve X agora" — fatura atual mais fechadas não pagas. */
	setCardOwedToday: (cardId: string, owedCents: number) => Promise<void>;
	/** Pagamento de fatura: transferência da conta (ou de fora) para o cartão. */
	recordCardPayment: (cardId: string, fromAccountId: string | null, amountCents: number, date: string) => Promise<void>;
	/** Compra parcelada feita antes do app: cria as parcelas restantes. Devolve quantas. */
	addExistingInstallments: (input: ExistingInstallmentsInput) => Promise<number>;
	/**
	 * Cartão de débito cadastrado como cartão: leva os lançamentos para a conta de onde o
	 * dinheiro sai de verdade e apaga o cartão. Débito não tem fatura nem limite.
	 */
	convertCardToDebit: (cardId: string, accountId: string) => Promise<void>;
	/** Move todos os lançamentos sem conta para uma conta. Devolve quantos mudaram. */
	assignUnassigned: (accountId: string) => Promise<number>;
}

const AccountsContext = createContext<AccountsContextType | undefined>(undefined);

const byOrder = (a: Account, b: Account) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);

export const AccountsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
	const { transactions, refreshData } = useTransactions();
	const { startDate, endDate } = usePeriod();

	const [accounts, setAccounts] = useState<Account[]>([]);
	const [balances, setBalances] = useState<Map<string, number>>(new Map());
	const [cardSummaries, setCardSummaries] = useState<Map<string, CardSummary>>(new Map());
	const [month, setMonth] = useState<MonthOverview | null>(null);
	const [unassignedNetCents, setUnassignedNetCents] = useState(0);
	const [isLoading, setIsLoading] = useState(true);

	const refresh = useCallback(async () => {
		try {
			const today = todayISO();
			const [list, nextBalances, unassigned, unassignedPeriod] = await Promise.all([
				getAccounts(),
				getAccountBalances(today),
				getUnassignedNet(today),
				getUnassignedPeriodSummary(startDate, endDate),
			]);

			const nextSummaries = new Map<string, CardSummary>();
			const activity: AccountMonthActivity[] = [];

			for (const account of list) {
				if (account.deletedAt) continue;

				const period = await getAccountActivity(account.id, startDate, endDate);
				const isCard = account.kind === 'credit_card';
				activity.push({
					accountId: account.id,
					name: account.name,
					kind: account.kind,
					role: account.archived ? 'external' : account.role,
					incomeCents: period.incomeCents,
					expenseCents: period.expenseCents,
					transfersInCents: period.transfersInCents,
					transfersOutCents: period.transfersOutCents,
					purchasesOriginatedCents: isCard ? await getCardPurchasesOriginated(account.id, startDate, endDate) : undefined,
					envelopeMonthlyCents: account.envelopeMonthlyCents,
				});

				if (!isCard) continue;
				const cardActivity = activity[activity.length - 1];

				const [cardTransactions, cardTransfers] = await Promise.all([
					getAccountTransactions(account.id),
					getAccountTransfers(account.id),
				]);
				const entries: CardEntry[] = cardTransactions.map((tx) => ({
					id: tx.id,
					amountCents: tx.amountCents,
					isIncome: tx.isIncome,
					date: tx.date,
					note: tx.note,
					category: tx.category,
					installmentGroup: tx.installmentGroup,
					installmentIndex: tx.installmentIndex,
					installmentCount: tx.installmentCount,
				}));
				const movements: CardMovement[] = cardTransfers.map((transfer) => ({
					amountCents: transfer.amountCents,
					date: transfer.date,
					inbound: transfer.toAccountId === account.id,
				}));
				nextSummaries.set(account.id, buildCardSummary(account, entries, movements, today));
				cardActivity.invoiceCents = invoicesClosingBetween(account, entries, startDate, endDate);
			}

			setAccounts(list);
			setBalances(nextBalances);
			setCardSummaries(nextSummaries);
			setUnassignedNetCents(unassigned);
			setMonth(buildMonthOverview({ accounts: activity, unassigned: unassignedPeriod }));
		} catch (error) {
			console.error('Error loading accounts:', error);
		} finally {
			setIsLoading(false);
		}
	}, [startDate, endDate]);

	// O livro-caixa mudou (o TransactionsContext trocou a lista) ou o período mudou.
	useEffect(() => {
		void refresh();
	}, [refresh, transactions]);

	const createAccount = useCallback(
		async (draft: AccountDraft) => {
			const id = await addAccount(draft);
			syncQueue.schedule();
			await refresh();
			return id;
		},
		[refresh]
	);

	const saveAccount = useCallback(
		async (account: AccountEdit) => {
			await updateAccount(account);
			syncQueue.schedule();
			await refresh();
		},
		[refresh]
	);

	const removeAccount = useCallback(
		async (id: string) => {
			await deleteAccount(id);
			syncQueue.schedule();
			await Promise.all([refresh(), refreshData()]);
		},
		[refresh, refreshData]
	);

	const setBalanceToday = useCallback(
		async (id: string, balanceCents: number) => {
			await setAccountBalanceToday(id, balanceCents);
			syncQueue.schedule();
			await refresh();
		},
		[refresh]
	);

	const setCardOwedToday = useCallback(
		async (cardId: string, owedCents: number) => {
			// Na âncora de um cartão, dever é negativo.
			await setAccountBalanceToday(cardId, 0 - owedCents);
			syncQueue.schedule();
			await refresh();
		},
		[refresh]
	);

	const recordCardPayment = useCallback(
		async (cardId: string, fromAccountId: string | null, amountCents: number, date: string) => {
			await addTransfer({ fromAccountId, toAccountId: cardId, amountCents, date, note: '' });
			syncQueue.schedule();
			await refresh();
		},
		[refresh]
	);

	const addExistingInstallments = useCallback(
		async (input: ExistingInstallmentsInput) => {
			const card = accounts.find((account) => account.id === input.cardId);
			if (!card) return 0;
			const dates = existingInstallmentDates(input.currentIndex, input.totalCount, cycleRuleOf(card), todayISO());
			const group = generateUniqueId();
			for (const { index, date } of dates) {
				await addTransaction({
					amountCents: input.parcelCents,
					category: input.category,
					date,
					note: `${input.note} (${index}/${input.totalCount})`,
					isIncome: false,
					accountId: card.id,
					installmentGroup: group,
					installmentIndex: index,
					installmentCount: input.totalCount,
				});
			}
			syncQueue.schedule();
			await refreshData();
			return dates.length;
		},
		[accounts, refreshData]
	);

	const convertCardToDebit = useCallback(
		async (cardId: string, accountId: string) => {
			await moveAccountLedger(cardId, accountId);
			await deleteAccount(cardId);
			syncQueue.schedule();
			await Promise.all([refresh(), refreshData()]);
		},
		[refresh, refreshData]
	);

	const assignUnassigned = useCallback(
		async (accountId: string) => {
			const changed = await assignUnassignedTransactions(accountId);
			syncQueue.schedule();
			await Promise.all([refresh(), refreshData()]);
			return changed;
		},
		[refresh, refreshData]
	);

	const activeAccounts = useMemo(() => accounts.filter((account) => !account.archived).sort(byOrder), [accounts]);
	const bankAccounts = useMemo(() => activeAccounts.filter((account) => account.kind !== 'credit_card'), [activeAccounts]);
	const creditCards = useMemo(() => activeAccounts.filter((account) => account.kind === 'credit_card'), [activeAccounts]);
	const overview = useMemo(
		() => summarizeAccounts(accounts, balances, unassignedNetCents),
		[accounts, balances, unassignedNetCents]
	);

	const cardsTotals = useMemo(() => {
		let toPayCents = 0;
		let openInvoicesCents = 0;
		let limitUsedCents = 0;
		let limitAvailableCents: number | null = null;
		for (const card of creditCards) {
			const summary = cardSummaries.get(card.id);
			if (!summary) continue;
			toPayCents += summary.toPayCents;
			openInvoicesCents += Math.max(0, summary.openInvoiceCents);
			limitUsedCents += summary.limitUsedCents;
			if (summary.limitAvailableCents !== null) {
				limitAvailableCents = (limitAvailableCents ?? 0) + summary.limitAvailableCents;
			}
		}
		return { toPayCents, openInvoicesCents, limitAvailableCents, limitUsedCents };
	}, [creditCards, cardSummaries]);

	const value = useMemo<AccountsContextType>(
		() => ({
			accounts,
			bankAccounts,
			creditCards,
			activeAccounts,
			balances,
			cardSummaries,
			cardsTotals,
			overview,
			month,
			unassignedNetCents,
			isLoading,
			refresh,
			createAccount,
			saveAccount,
			removeAccount,
			setBalanceToday,
			setCardOwedToday,
			recordCardPayment,
			addExistingInstallments,
			convertCardToDebit,
			assignUnassigned,
		}),
		[
			accounts,
			bankAccounts,
			creditCards,
			activeAccounts,
			balances,
			cardSummaries,
			cardsTotals,
			overview,
			month,
			unassignedNetCents,
			isLoading,
			refresh,
			createAccount,
			saveAccount,
			removeAccount,
			setBalanceToday,
			setCardOwedToday,
			recordCardPayment,
			addExistingInstallments,
			convertCardToDebit,
			assignUnassigned,
		]
	);

	return <AccountsContext.Provider value={value}>{children}</AccountsContext.Provider>;
};

export const useAccounts = (): AccountsContextType => {
	const context = useContext(AccountsContext);
	if (!context) throw new Error('useAccounts must be used within an AccountsProvider');
	return context;
};

export default AccountsProvider;
