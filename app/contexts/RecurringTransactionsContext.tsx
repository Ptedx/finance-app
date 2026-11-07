import type React from 'react';
import { createContext, useContext, useEffect, useState } from 'react';
import { Alert } from 'react-native';
import {
	addRecurringTransaction,
	deleteRecurringTransaction,
	getRecurringTransactions,
	initDatabase,
	updateRecurringTransaction,
} from '../database/database';
import type {
	RecurringTransaction,
	RecurringTransactionDraft,
	RecurringTransactionEdit,
} from '../database/schema';
import { useAfterPull } from '../hooks/useAfterPull';
import * as syncQueue from '../sync/queue';
import * as notificationUtils from '../utils/notificationUtils';

interface RecurringTransactionsContextType {
	transactions: RecurringTransaction[];
	isLoading: boolean;
	addTransaction: (
		transaction: RecurringTransactionDraft
	) => Promise<string>;
	updateTransaction: (transaction: RecurringTransactionEdit) => Promise<void>;
	removeTransaction: (id: string) => Promise<void>;
	refreshTransactions: () => Promise<void>;
}

const RecurringTransactionsContext = createContext<RecurringTransactionsContextType | undefined>(
	undefined
);

/**
 * As recorrências antigas: a lista segue lida e sincronizada (Ajustes as leva no backup), mas
 * as regras não lançam mais nada — o `processTransactions` que a Início chamava ao abrir saiu
 * no SPD-113 (ver o comentário em `database.ts`, onde ficava `processRecurringTransactions`).
 * Também não lembram mais nada nem contam como custo fixo (SPD-122, DEC-37).
 */
export const RecurringTransactionsProvider: React.FC<{ children: React.ReactNode }> = ({
	children,
}) => {
	const [isLoading, setIsLoading] = useState(true);
	const [transactions, setTransactions] = useState<RecurringTransaction[]>([]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: refreshTransactions is defined in the same render scope and only needs to run once on mount
	useEffect(() => {
		const loadTransactions = async () => {
			try {
				await refreshTransactions();
			} catch (error) {
				console.error('Failed to load recurring transactions:', error);
			}
		};

		loadTransactions();
		// As regras não agendam mais lembrete (SPD-122): na abertura, sai o "X vence amanhã"
		// que versões anteriores deixaram agendado. Os das contas e das faturas ficam.
		notificationUtils.cancelRecurringReminders();
	}, []);

	const refreshTransactions = async () => {
		try {
			setIsLoading(true);
			// Este provider é filho do `TransactionsProvider`, e efeitos de filho rodam
			// antes dos do pai — então esta é uma das primeiras consultas do app, podendo
			// cair no meio de uma migração. `initDatabase` é single-flight: aqui ela só
			// espera a inicialização que já está em curso.
			await initDatabase();
			const allTransactions = await getRecurringTransactions();
			setTransactions(allTransactions);
		} catch (error) {
			console.error('Error refreshing transactions:', error);
			Alert.alert('Error', 'Failed to refresh recurring transactions.');
		} finally {
			setIsLoading(false);
		}
	};

	const addTransaction = async (transaction: RecurringTransactionDraft) => {
		try {
			const id = await addRecurringTransaction(transaction);
			await refreshTransactions();
			syncQueue.schedule();
			return id;
		} catch (error) {
			console.error('Error adding recurring transaction:', error);
			Alert.alert('Error', 'Failed to add recurring transaction.');
			throw error;
		}
	};

	const updateTransaction = async (transaction: RecurringTransactionEdit) => {
		try {
			// The next due date is derived from the rule inside updateRecurringTransaction,
			// so editing the day of the month takes effect immediately rather than a cycle late.
			await updateRecurringTransaction(transaction);
			await refreshTransactions();
			syncQueue.schedule();
		} catch (error) {
			console.error('Error updating recurring transaction:', error);
			Alert.alert('Error', 'Failed to update recurring transaction.');
			throw error;
		}
	};

	const removeTransaction = async (id: string) => {
		try {
			await deleteRecurringTransaction(id);
			await refreshTransactions();
			syncQueue.schedule();
		} catch (error) {
			console.error('Error deleting recurring transaction:', error);
			Alert.alert('Error', 'Failed to delete recurring transaction.');
			throw error;
		}
	};

	const value = {
		transactions,
		isLoading,
		addTransaction,
		updateTransaction,
		removeTransaction,
		refreshTransactions,
	};

	// O que o sync baixou da conta só aparece se a tela reler o banco.
	useAfterPull(refreshTransactions);

	return (
		<RecurringTransactionsContext.Provider value={value}>
			{children}
		</RecurringTransactionsContext.Provider>
	);
};

export const useRecurringTransactions = () => {
	const context = useContext(RecurringTransactionsContext);
	if (context === undefined) {
		throw new Error('useRecurringTransactions must be used within a RecurringTransactionsProvider');
	}
	return context;
};

export default RecurringTransactionsContext;
