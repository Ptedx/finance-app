import type React from 'react';
import { createContext, useContext, useEffect, useState } from 'react';
import { Alert } from 'react-native';
import {
	addRecurringTransaction,
	deleteRecurringTransaction,
	getRecurringTransactions,
	processRecurringTransactions,
	updateRecurringTransaction,
} from '../database/database';
import type {
	RecurringTransaction,
	RecurringTransactionDraft,
	RecurringTransactionEdit,
} from '../database/schema';
import * as syncQueue from '../sync/queue';
import { parseISODate, todayISO } from '../utils/dateUtils';
import * as notificationUtils from '../utils/notificationUtils';

interface RecurringTransactionsContextType {
	transactions: RecurringTransaction[];
	isLoading: boolean;
	addTransaction: (
		transaction: RecurringTransactionDraft
	) => Promise<string>;
	updateTransaction: (transaction: RecurringTransactionEdit) => Promise<void>;
	removeTransaction: (id: string) => Promise<void>;
	processTransactions: () => Promise<void>;
	refreshTransactions: () => Promise<void>;
}

const RecurringTransactionsContext = createContext<RecurringTransactionsContextType | undefined>(
	undefined
);

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

				// After loading transactions, check and schedule notifications
				const allTransactions = await getRecurringTransactions();
				await notificationUtils.checkAndScheduleNotifications(allTransactions);
			} catch (error) {
				console.error('Failed to load recurring transactions:', error);
			}
		};

		loadTransactions();
	}, []);

	const refreshTransactions = async () => {
		try {
			setIsLoading(true);
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

			// Get the complete transaction with the calculated nextDue date
			const addedTransaction = (await getRecurringTransactions()).find((t) => t.id === id);

			// Notify a day ahead, but only for due dates that are actually in the future
			// and near enough to be worth a reminder. Comparisons are on calendar dates,
			// parsed locally — `new Date('2026-07-22')` would be a UTC instant.
			if (addedTransaction?.nextDue) {
				const today = todayISO();
				const dueDate = parseISODate(addedTransaction.nextDue);
				const daysUntilDue = Math.round(
					(dueDate.getTime() - parseISODate(today).getTime()) / 86_400_000
				);

				if (daysUntilDue >= 2 && daysUntilDue <= 30) {
					await notificationUtils.scheduleTransactionNotification(addedTransaction, dueDate);
				}
			}

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

			await notificationUtils.cancelTransactionNotification(transaction.id);

			const stored = (await getRecurringTransactions()).find((t) => t.id === transaction.id);

			if (stored?.active && stored.nextDue) {
				await notificationUtils.scheduleTransactionNotification(
					stored,
					parseISODate(stored.nextDue)
				);
			}

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
			// Cancel any scheduled notification for this transaction
			await notificationUtils.cancelTransactionNotification(id);

			await deleteRecurringTransaction(id);
			await refreshTransactions();
			syncQueue.schedule();
		} catch (error) {
			console.error('Error deleting recurring transaction:', error);
			Alert.alert('Error', 'Failed to delete recurring transaction.');
			throw error;
		}
	};

	const processTransactions = async () => {
		try {
			await processRecurringTransactions();

			// After processing, get the updated transactions
			const updatedTransactions = await getRecurringTransactions();

			// Clear notification markers for processed transactions
			// (we can identify them by having a lastProcessed date that's the current date)
			const today = todayISO();
			for (const transaction of updatedTransactions) {
				if (transaction.lastProcessed === today) {
					await notificationUtils.cancelTransactionNotification(transaction.id);
				}
			}

			// Refresh notifications for all active transactions
			await notificationUtils.checkAndScheduleNotifications(updatedTransactions);

			await refreshTransactions();
			// As ocorrências lançadas têm id determinístico, então subir aqui é seguro
			// mesmo que outro aparelho tenha lançado as mesmas: o upsert as funde.
			syncQueue.schedule();
		} catch (error) {
			console.error('Error processing recurring transactions:', error);
			Alert.alert('Error', 'Failed to process recurring transactions.');
			throw error;
		}
	};

	const value = {
		transactions,
		isLoading,
		addTransaction,
		updateTransaction,
		removeTransaction,
		processTransactions,
		refreshTransactions,
	};

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
