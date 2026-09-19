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
	getTransfersByDateRange,
	moveAccountLedger,
	setAccountCardNames,
	setAccountAnchor,
	setAccountBalanceToday,
	updateAccount,
} from '../database/database';
import { getPendingCaptures } from '../database/captures';
import type { Account, AccountDraft, AccountEdit, Capture, Transfer } from '../database/schema';
import { useAfterPull } from '../hooks/useAfterPull';
import * as syncQueue from '../sync/queue';
import { type AccountsOverview, spendingAdjustment, summarizeAccounts } from '../utils/accountMath';
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
import { parseCardNames, withCardName } from '../utils/cardNames';
import { addDays, getISODate, todayISO } from '../utils/dateUtils';
import { splitInstallments } from '../utils/installments';
import { type AccountMonthActivity, buildMonthOverview, type MonthOverview } from '../utils/monthOverview';
import { type CdiRate, loadCachedCdi, refreshCdi } from '../api/cdi';
import { accruedYieldCents, type YieldFlow } from '../utils/yield';
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

/**
 * Um cartão de débito: não tem fatura nem limite, é um cartão da conta corrente. Existe
 * quando a conta tem compras com aquele final ou quando o usuário deu nome a ele.
 */
export interface DebitCard {
	/** `contaId:final`. */
	key: string;
	account: Account;
	last4: string;
	name: string | null;
	/** Compras menos estornos no período selecionado. */
	periodSpentCents: number;
	/** Data da compra mais recente, para ordenar. */
	lastUsed: string | null;
}

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
	/** Cartões de débito das contas ativas, os mais usados primeiro. */
	debitCards: DebitCard[];
	/** Só as não arquivadas, contas e cartões — para seletores de lançamento. */
	activeAccounts: Account[];
	/** Saldo de hoje por conta — nas contas que rendem, já com o rendimento estimado. */
	balances: Map<string, number>;
	/** Rendimento estimado desde a última âncora, por conta que rende (ver utils/yield.ts). */
	accruedYield: Map<string, number>;
	/** A taxa CDI em uso, do Banco Central; nula enquanto nenhuma foi obtida. */
	cdi: CdiRate | null;
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
	/**
	 * Acerta uma conta com o que o banco mostra: quanto já saiu neste mês e quanto ainda há
	 * na conta. A diferença de gasto entra como lançamento de hoje (aparece no mês e na
	 * barra do envelope); o que sobrar de diferença no saldo é sobra de antes do app e move
	 * só o ponto de partida. Serve para a primeira vez — depois as notificações cobrem.
	 */
	adjustAccountMonth: (id: string, input: { spentCents: number; balanceCents: number }) => Promise<void>;
	/** Gasto do período em cada conta (despesas menos receitas), para preencher o acerto. */
	periodSpentByAccount: Map<string, number>;
	/** Transferências do período: dinheiro trocando de bolso, que a lista de lançamentos mostra. */
	periodTransfers: Transfer[];
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
	/** Dá nome a um cartão (físico, virtual ou de débito) pelo final; nome vazio tira. */
	renameCard: (accountId: string, last4: string, name: string | null) => Promise<void>;
	/** Move todos os lançamentos sem conta para uma conta. Devolve quantos mudaram. */
	assignUnassigned: (accountId: string) => Promise<number>;
}

const AccountsContext = createContext<AccountsContextType | undefined>(undefined);

/** Nota do lançamento de ajuste: o mesmo texto em qualquer idioma, é um marcador. */
const ADJUSTMENT_NOTE = 'Ajuste com a fatura do banco';

/** Nota do lançamento que acerta o saldo de uma conta. */
const BALANCE_ADJUSTMENT_NOTE = 'Ajuste com o saldo do banco';

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
		cardLast4: capture.cardLast4,
		pendingReview: true,
	}));
};

export const AccountsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
	const { transactions, categories, refreshData } = useTransactions();
	const { startDate, endDate } = usePeriod();

	const [accounts, setAccounts] = useState<Account[]>([]);
	// Saldo registrado (âncora + movimentos). O exposto soma o rendimento estimado.
	const [rawBalances, setBalances] = useState<Map<string, number>>(new Map());
	const [yieldInputs, setYieldInputs] = useState<Map<string, { anchorCents: number; anchorDate: string; flows: YieldFlow[]; percentOfCdiBp: number }>>(new Map());
	const [cdi, setCdi] = useState<CdiRate | null>(null);
	const [cardSummaries, setCardSummaries] = useState<Map<string, CardSummary>>(new Map());
	const [month, setMonth] = useState<MonthOverview | null>(null);
	const [unassignedNetCents, setUnassignedNetCents] = useState(0);
	const [periodSpentByAccount, setPeriodSpentByAccount] = useState<Map<string, number>>(new Map());
	const [periodTransfers, setPeriodTransfers] = useState<Transfer[]>([]);
	// Lido dentro do acerto sem virar dependência dele.
	const periodSpentRef = useRef(periodSpentByAccount);
	periodSpentRef.current = periodSpentByAccount;
	const [isLoading, setIsLoading] = useState(true);

	// Cada recarga ganha um número; só a mais recente grava. Uma recarga lenta, começada
	// antes de um pagamento ou de trocar o mês, não sobrescreve a que veio depois.
	const generation = useRef(0);

	const refresh = useCallback(async () => {
		const mine = ++generation.current;
		try {
			const today = todayISO();
			// Saldo na véspera do período e no fim dele (ou hoje, se ainda está correndo): é o que
			// diz quanto sobrou do mês anterior e quanto ainda há na conta.
			const periodEnd = endDate < today ? endDate : today;
			const [list, nextBalances, unassigned, unassignedPeriod, pendingCaptures, startBalances, endBalances, transfersInPeriod] =
				await Promise.all([
				getAccounts(),
				getAccountBalances(today),
				getUnassignedNet(today),
				getUnassignedPeriodSummary(startDate, endDate),
				getPendingCaptures(),
				getAccountBalances(addDays(startDate, -1)),
				getAccountBalances(periodEnd),
				getTransfersByDateRange(startDate, endDate),
			]);

			const nextSummaries = new Map<string, CardSummary>();
			const nextYieldInputs = new Map<string, { anchorCents: number; anchorDate: string; flows: YieldFlow[]; percentOfCdiBp: number }>();
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
					passThroughCents: period.passThroughCents,
					transfersInCents: period.transfersInCents,
					transfersOutCents: period.transfersOutCents,
					purchasesOriginatedCents: isCard ? await getCardPurchasesOriginated(account.id, startDate, endDate) : undefined,
					envelopeMonthlyCents: account.envelopeMonthlyCents,
					startBalanceCents: startBalances.get(account.id) ?? 0,
					endBalanceCents: endBalances.get(account.id) ?? 0,
				});

				// Conta que rende: a âncora e o que entrou e saiu depois dela, para estimar o
				// rendimento até hoje.
				if (!isCard && (account.yieldCdiBp ?? 0) > 0) {
					const [ownTransactions, ownTransfers] = await Promise.all([getAccountTransactions(account.id), getAccountTransfers(account.id)]);
					const flows: YieldFlow[] = [
						...ownTransactions.map((tx) => ({ date: tx.date, cents: tx.isIncome ? tx.amountCents : -tx.amountCents })),
						...ownTransfers.map((transfer) => ({
							date: transfer.date,
							cents: transfer.toAccountId === account.id ? transfer.amountCents : -transfer.amountCents,
						})),
					].filter((flow) => flow.date > account.openingBalanceDate);
					nextYieldInputs.set(account.id, {
						anchorCents: account.openingBalanceCents,
						anchorDate: account.openingBalanceDate,
						flows,
						percentOfCdiBp: account.yieldCdiBp ?? 0,
					});
				}

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
				cardLast4: tx.cardLast4,
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
			setYieldInputs(nextYieldInputs);
			setCardSummaries(nextSummaries);
			setUnassignedNetCents(unassigned);
			setPeriodTransfers(transfersInPeriod);
			setPeriodSpentByAccount(
				new Map(activity.map((item) => [item.accountId, Math.max(0, item.expenseCents - item.incomeCents)]))
			);
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
	// ter trazido pagamentos ou compras de outro aparelho. O CDI também é conferido.
	useEffect(() => {
		const subscription = AppState.addEventListener('change', (state) => {
			if (state !== 'active') return;
			void refresh();
			void refreshCdi().then((next) => next && setCdi(next));
		});
		return () => subscription.remove();
	}, [refresh]);

	// O CDI guardado vale na hora; o do Banco Central chega em seguida, se for mais novo.
	useEffect(() => {
		void loadCachedCdi().then((cached) => cached && setCdi((current) => current ?? cached));
		void refreshCdi().then((next) => next && setCdi(next));
	}, []);

	/** O rendimento estimado de cada conta que rende, até ontem, no CDI em uso. */
	const accruedYield = useMemo(() => {
		const result = new Map<string, number>();
		if (!cdi) return result;
		const today = todayISO();
		for (const [accountId, input] of yieldInputs) {
			result.set(accountId, accruedYieldCents({ ...input, today, cdiAnnualBp: cdi.annualBp }));
		}
		return result;
	}, [yieldInputs, cdi]);

	const balances = useMemo(() => {
		if (accruedYield.size === 0) return rawBalances;
		const next = new Map(rawBalances);
		for (const [accountId, cents] of accruedYield) next.set(accountId, (next.get(accountId) ?? 0) + cents);
		return next;
	}, [rawBalances, accruedYield]);

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

	const adjustAccountMonth = useCallback(
		async (id: string, input: { spentCents: number; balanceCents: number }) => {
			const today = todayISO();
			const spentNow = periodSpentRef.current.get(id) ?? 0;
			// O gasto que o app não viu é lançamento de verdade: é ele que mexe na barra.
			const spend = spendingAdjustment(spentNow, input.spentCents);
			if (spend) {
				await addTransaction({
					amountCents: spend.amountCents,
					category: resolveCategoryId(
						spend.isIncome ? 'other_income' : 'other_expense',
						spend.isIncome ? 'in' : 'out',
						categories
					),
					date: today,
					note: BALANCE_ADJUSTMENT_NOTE,
					isIncome: spend.isIncome,
					accountId: id,
				});
			}
			// O que ainda não bate é dinheiro de antes do app (a sobra do mês passado, por
			// exemplo): move o ponto de partida, sem entrar no mês.
			const balanceNow = (await getAccountBalances(today)).get(id) ?? 0;
			if (balanceNow !== input.balanceCents) await setAccountBalanceToday(id, input.balanceCents);
			syncQueue.schedule();
			await Promise.all([refresh(), refreshData()]);
		},
		[refresh, refreshData, categories]
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
				cardLast4: tx.cardLast4,
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
			const card = accounts.find((account) => account.id === cardId);
			const checking = accounts.find((account) => account.id === accountId);
			// O nome do "cartão" vira o nome do cartão de débito da conta.
			if (card?.last4 && checking) {
				await setAccountCardNames(checking.id, withCardName(checking.cardNames, card.last4, card.name));
			}
			await moveAccountLedger(cardId, accountId, card?.last4 ?? null);
			// "Pagamentos" para um débito não existiram: tirá-los evita debitar a conta duas vezes.
			await deleteTransfersOf(cardId);
			await deleteAccount(cardId);
			syncQueue.schedule();
			await Promise.all([refresh(), refreshData()]);
		},
		[accounts, refresh, refreshData]
	);

	const renameCard = useCallback(
		async (accountId: string, last4: string, name: string | null) => {
			const account = accounts.find((candidate) => candidate.id === accountId);
			if (!account) return;
			await setAccountCardNames(accountId, withCardName(account.cardNames, last4, name));
			syncQueue.schedule();
			await refresh();
		},
		[accounts, refresh]
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

	const debitCards = useMemo<DebitCard[]>(() => {
		const byKey = new Map<string, DebitCard>();
		for (const account of bankAccounts) {
			for (const [last4, name] of Object.entries(parseCardNames(account.cardNames))) {
				byKey.set(`${account.id}:${last4}`, { key: `${account.id}:${last4}`, account, last4, name, periodSpentCents: 0, lastUsed: null });
			}
		}
		const accountById = new Map(bankAccounts.map((account) => [account.id, account]));
		for (const tx of transactions) {
			if (!tx.cardLast4 || !tx.accountId) continue;
			const account = accountById.get(tx.accountId);
			if (!account) continue;
			const key = `${account.id}:${tx.cardLast4}`;
			let card = byKey.get(key);
			if (!card) {
				card = { key, account, last4: tx.cardLast4, name: null, periodSpentCents: 0, lastUsed: null };
				byKey.set(key, card);
			}
			if (tx.date >= startDate && tx.date <= endDate) card.periodSpentCents += tx.isIncome ? -tx.amountCents : tx.amountCents;
			if (!card.lastUsed || tx.date > card.lastUsed) card.lastUsed = tx.date;
		}
		return [...byKey.values()].sort(
			(a, b) => (b.lastUsed ?? '').localeCompare(a.lastUsed ?? '') || a.last4.localeCompare(b.last4)
		);
	}, [bankAccounts, transactions, startDate, endDate]);

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
			debitCards,
			activeAccounts,
			balances,
			accruedYield,
			cdi,
			cardSummaries,
			cardsTotals,
			overview,
			month,
			unassignedNetCents,
			periodSpentByAccount,
			periodTransfers,
			isLoading,
			refresh,
			createAccount,
			saveAccount,
			removeAccount,
			adjustAccountMonth,
			adjustCardInvoices,
			recordCardPayment,
			addExistingInstallments,
			convertCardToDebit,
			renameCard,
			assignUnassigned,
		}),
		[
			accounts,
			bankAccounts,
			creditCards,
			debitCards,
			activeAccounts,
			balances,
			accruedYield,
			cdi,
			cardSummaries,
			cardsTotals,
			overview,
			month,
			unassignedNetCents,
			periodSpentByAccount,
			periodTransfers,
			isLoading,
			refresh,
			createAccount,
			saveAccount,
			removeAccount,
			adjustAccountMonth,
			adjustCardInvoices,
			recordCardPayment,
			addExistingInstallments,
			convertCardToDebit,
			renameCard,
			assignUnassigned,
		]
	);

	// Transferências e âncoras de saldo baixadas pelo sync não passam pelos lançamentos.
	useAfterPull(refresh);

	return <AccountsContext.Provider value={value}>{children}</AccountsContext.Provider>;
};

export const useAccounts = (): AccountsContextType => {
	const context = useContext(AccountsContext);
	if (!context) throw new Error('useAccounts must be used within an AccountsProvider');
	return context;
};

export default AccountsProvider;
