import type React from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import {
	addAccount,
	addTransaction,
	addTransfer,
	assignUnassignedTransactions,
	deleteAccount,
	deleteTransfersOf,
	findCardPayment,
	getAccountActivity,
	getAccountBalances,
	getAccounts,
	getAccountTransactions,
	getAccountTransfers,
	getCardPurchasesOriginated,
	getUnassignedNet,
	getUnassignedPeriodSummary,
	moveAccountLedger,
	setAccountAnchor,
	setAccountBalanceToday,
	updateAccount,
} from '../database/database';
import { getPendingCaptures } from '../database/captures';
import type { Account, AccountDraft, AccountEdit, Capture } from '../database/schema';
import * as syncQueue from '../sync/queue';
import { type AccountsOverview, summarizeAccounts } from '../utils/accountMath';
import {
	buildCardSummary,
	cardInstallmentDates,
	type CardEntry,
	type CardMovement,
	type CardSummary,
	cycleRuleOf,
	existingInstallmentDates,
	invoicesClosingBetween,
	planCardAdjustment,
} from '../utils/cardMath';
import { resolveCategoryId } from '../utils/captureActions';
import { generateUniqueId } from '../utils/categoryEditUtils';
import { getISODate, todayISO } from '../utils/dateUtils';
import { splitInstallments } from '../utils/installments';
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
	/**
	 * "O banco mostra X na fatura aberta e Y na fechada ainda não paga". As duas ficam
	 * separadas: Y na fatura fechada, X na aberta (`planCardAdjustment`).
	 */
	adjustCardInvoices: (cardId: string, openCents: number, closedCents: number) => Promise<void>;
	/**
	 * Pagamento de fatura: transferência da conta (ou de fora) para o cartão. Devolve falso
	 * quando o mesmo pagamento já estava registrado (pela notificação, por exemplo).
	 */
	recordCardPayment: (cardId: string, fromAccountId: string | null, amountCents: number, date: string) => Promise<boolean>;
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

/** Nota do lançamento de ajuste: o mesmo texto em qualquer idioma, é um marcador. */
const ADJUSTMENT_NOTE = 'Ajuste com a fatura do banco';

const byOrder = (a: Account, b: Account) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);

/**
 * Uma compra pendente na caixa de entrada, como lançamentos provisórios do cartão — com
 * as parcelas, se for parcelada. Só as sem pergunta: uma "é a mesma compra?" em aberto
 * poderia contar a compra duas vezes.
 */
const pendingCardEntries = (capture: Capture, card: Account): CardEntry[] => {
	if (capture.status !== 'pending' || capture.question !== null || capture.accountId !== card.id) return [];
	const count = capture.installments && capture.installments > 1 ? capture.installments : 1;
	const parts = splitInstallments(capture.amountCents, count);
	const dates = cardInstallmentDates(getISODate(new Date(capture.postedAt)), count, cycleRuleOf(card));
	const note = capture.counterparty ?? capture.appLabel;
	return dates.map((date, index) => ({
		id: `capture:${capture.id}:${index + 1}`,
		amountCents: parts[index],
		isIncome: capture.direction === 'in',
		date,
		note: count > 1 ? `${note} (${index + 1}/${count})` : note,
		category: capture.suggestedCategory ?? '',
		installmentGroup: count > 1 ? capture.id : null,
		installmentIndex: count > 1 ? index + 1 : null,
		installmentCount: count > 1 ? count : null,
		pendingReview: true,
	}));
};

export const AccountsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
	const { transactions, categories, refreshData } = useTransactions();
	const { startDate, endDate } = usePeriod();

	const [accounts, setAccounts] = useState<Account[]>([]);
	const [balances, setBalances] = useState<Map<string, number>>(new Map());
	const [cardSummaries, setCardSummaries] = useState<Map<string, CardSummary>>(new Map());
	const [month, setMonth] = useState<MonthOverview | null>(null);
	const [unassignedNetCents, setUnassignedNetCents] = useState(0);
	const [isLoading, setIsLoading] = useState(true);

	// Cada recarga ganha um número; só a mais recente grava. Uma recarga lenta, começada
	// antes de um pagamento ou de trocar o mês, não sobrescreve a que veio depois.
	const generation = useRef(0);

	const refresh = useCallback(async () => {
		const mine = ++generation.current;
		try {
			const today = todayISO();
			const [list, nextBalances, unassigned, unassignedPeriod, pendingCaptures] = await Promise.all([
				getAccounts(),
				getAccountBalances(today),
				getUnassignedNet(today),
				getUnassignedPeriodSummary(startDate, endDate),
				getPendingCaptures(),
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
				for (const capture of pendingCaptures) entries.push(...pendingCardEntries(capture, account));
				const movements: CardMovement[] = cardTransfers.map((transfer) => ({
					amountCents: transfer.amountCents,
					date: transfer.date,
					inbound: transfer.toAccountId === account.id,
				}));
				nextSummaries.set(account.id, buildCardSummary(account, entries, movements, today));
				cardActivity.invoiceCents = invoicesClosingBetween(account, entries, startDate, endDate);
			}

			if (mine !== generation.current) return;
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

	// Voltar ao app recalcula: o dia pode ter virado (fechamento, vencimento) e o sync pode
	// ter trazido pagamentos ou compras de outro aparelho.
	useEffect(() => {
		const subscription = AppState.addEventListener('change', (state) => {
			if (state === 'active') void refresh();
		});
		return () => subscription.remove();
	}, [refresh]);

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

	const adjustCardInvoices = useCallback(
		async (cardId: string, openCents: number, closedCents: number) => {
			const card = (await getAccounts()).find((account) => account.id === cardId);
			if (!card) return;
			const [cardTransactions, cardTransfers] = await Promise.all([getAccountTransactions(card.id), getAccountTransfers(card.id)]);
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
			// Compras ainda na caixa de entrada já estão na fatura do banco: entram na conta.
			for (const capture of await getPendingCaptures()) entries.push(...pendingCardEntries(capture, card));
			const movements: CardMovement[] = cardTransfers.map((transfer) => ({
				amountCents: transfer.amountCents,
				date: transfer.date,
				inbound: transfer.toAccountId === card.id,
			}));

			const today = todayISO();
			const plan = planCardAdjustment(card, entries, movements, today, openCents, closedCents);
			await setAccountAnchor(card.id, plan.anchorCents, plan.anchorDate);
			if (plan.adjustmentCents !== 0) {
				const isIncome = plan.adjustmentCents < 0;
				await addTransaction({
					amountCents: Math.abs(plan.adjustmentCents),
					category: resolveCategoryId(isIncome ? 'other_income' : 'other_expense', isIncome ? 'in' : 'out', categories),
					date: today,
					note: ADJUSTMENT_NOTE,
					isIncome,
					accountId: card.id,
				});
			}
			syncQueue.schedule();
			await Promise.all([refresh(), refreshData()]);
		},
		[refresh, refreshData, categories]
	);

	const recordCardPayment = useCallback(
		async (cardId: string, fromAccountId: string | null, amountCents: number, date: string) => {
			// A notificação do banco pode ter registrado este pagamento antes do toque.
			if (await findCardPayment(cardId, amountCents, date, 5)) {
				await refresh();
				return false;
			}
			await addTransfer({ fromAccountId, toAccountId: cardId, amountCents, date, note: '' });
			syncQueue.schedule();
			await refresh();
			return true;
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
			// "Pagamentos" para um débito não existiram: tirá-los evita debitar a conta duas vezes.
			await deleteTransfersOf(cardId);
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
			adjustCardInvoices,
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
			adjustCardInvoices,
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
