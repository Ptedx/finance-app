import type React from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
	addAccount,
	deleteAccount,
	getAccountActivity,
	getAccountBalances,
	getAccounts,
	getUnassignedNet,
	setAccountBalanceToday,
	updateAccount,
} from '../database/database';
import type { Account, AccountDraft, AccountEdit } from '../database/schema';
import { type AccountsOverview, type CardCycle, cardCycleOn, owedCents, summarizeAccounts } from '../utils/accountMath';
import { todayISO } from '../utils/dateUtils';
import { useTransactions } from './TransactionsContext';

/**
 * Contas e cartões para as telas: a lista, o saldo de cada uma hoje, o total em caixa
 * e o que os cartões devem. Recarrega sempre que o livro-caixa muda (o
 * TransactionsContext recarrega os lançamentos) e quando uma captura vira
 * transferência (o CapturesContext chama `refresh`).
 */

export interface CardStatus {
	cycle: CardCycle;
	/** Compras menos estornos desde o último fechamento: a fatura em aberto. */
	openInvoiceCents: number;
	/** Tudo o que o cartão deve hoje, incluindo faturas fechadas e não pagas. */
	owedCents: number;
}

interface AccountsContextType {
	accounts: Account[];
	/** Só as não arquivadas, na ordem de exibição. */
	activeAccounts: Account[];
	balances: Map<string, number>;
	/** Estado do ciclo de cada cartão que tem dia de fechamento. */
	cards: Map<string, CardStatus>;
	overview: AccountsOverview;
	unassignedNetCents: number;
	isLoading: boolean;
	refresh: () => Promise<void>;
	createAccount: (draft: AccountDraft) => Promise<string>;
	saveAccount: (account: AccountEdit) => Promise<void>;
	removeAccount: (id: string) => Promise<void>;
	/** "Meu saldo agora é X" — para cartões, X é o valor a pagar. */
	setBalanceToday: (id: string, balanceCents: number) => Promise<void>;
}

const AccountsContext = createContext<AccountsContextType | undefined>(undefined);

export const AccountsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
	const { transactions } = useTransactions();

	const [accounts, setAccounts] = useState<Account[]>([]);
	const [balances, setBalances] = useState<Map<string, number>>(new Map());
	const [cards, setCards] = useState<Map<string, CardStatus>>(new Map());
	const [unassignedNetCents, setUnassignedNetCents] = useState(0);
	const [isLoading, setIsLoading] = useState(true);

	const refresh = useCallback(async () => {
		try {
			const today = todayISO();
			const [list, nextBalances, unassigned] = await Promise.all([
				getAccounts(),
				getAccountBalances(today),
				getUnassignedNet(today),
			]);

			const nextCards = new Map<string, CardStatus>();
			for (const account of list) {
				if (account.kind !== 'credit_card' || account.closingDay === null) continue;
				const cycle = cardCycleOn(account.closingDay, account.dueDay, today);
				const activity = await getAccountActivity(account.id, cycle.cycleStart, today);
				nextCards.set(account.id, {
					cycle,
					openInvoiceCents: Math.max(0, activity.expenseCents - activity.incomeCents),
					owedCents: owedCents(nextBalances.get(account.id) ?? account.openingBalanceCents),
				});
			}

			setAccounts(list);
			setBalances(nextBalances);
			setCards(nextCards);
			setUnassignedNetCents(unassigned);
		} catch (error) {
			console.error('Error loading accounts:', error);
		} finally {
			setIsLoading(false);
		}
	}, []);

	// O livro-caixa mudou (o TransactionsContext trocou a lista): os saldos também.
	useEffect(() => {
		void refresh();
	}, [refresh, transactions]);

	const createAccount = useCallback(
		async (draft: AccountDraft) => {
			const id = await addAccount(draft);
			await refresh();
			return id;
		},
		[refresh]
	);

	const saveAccount = useCallback(
		async (account: AccountEdit) => {
			await updateAccount(account);
			await refresh();
		},
		[refresh]
	);

	const removeAccount = useCallback(
		async (id: string) => {
			await deleteAccount(id);
			await refresh();
		},
		[refresh]
	);

	const setBalanceToday = useCallback(
		async (id: string, balanceCents: number) => {
			const account = accounts.find((a) => a.id === id);
			// No cartão o usuário pensa em "quanto devo"; o saldo guardado é o negativo disso.
			const signed = account?.kind === 'credit_card' ? -balanceCents : balanceCents;
			await setAccountBalanceToday(id, signed);
			await refresh();
		},
		[accounts, refresh]
	);

	const activeAccounts = useMemo(() => accounts.filter((account) => !account.archived), [accounts]);
	const overview = useMemo(
		() => summarizeAccounts(accounts, balances, unassignedNetCents),
		[accounts, balances, unassignedNetCents]
	);

	const value = useMemo<AccountsContextType>(
		() => ({
			accounts,
			activeAccounts,
			balances,
			cards,
			overview,
			unassignedNetCents,
			isLoading,
			refresh,
			createAccount,
			saveAccount,
			removeAccount,
			setBalanceToday,
		}),
		[
			accounts,
			activeAccounts,
			balances,
			cards,
			overview,
			unassignedNetCents,
			isLoading,
			refresh,
			createAccount,
			saveAccount,
			removeAccount,
			setBalanceToday,
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
