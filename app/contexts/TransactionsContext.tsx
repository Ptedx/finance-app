import type React from 'react';
import { createContext, useContext, useEffect, useState } from 'react';
import { Alert } from 'react-native';
import {
	addTransaction,
	addCategory as dbAddCategory,
	deleteCategory as dbDeleteCategory,
	updateCategory as dbUpdateCategory,
	deleteTransaction,
	getBalanceAsOf,
	getCategories,
	getMonthlyTransactions,
	getPeriodSummary,
	getTotalByCategory,
	getTransactions,
	getTransactionsByDateRange,
	initDatabase,
	type PeriodSummary,
	updateTransaction,
} from '../database/database';
import type {
	Category,
	CategoryDraft,
	CategoryEdit,
	Transaction,
	TransactionDraft,
	TransactionEdit,
} from '../database/schema';
import * as syncQueue from '../sync/queue';
import { getCurrentYear, todayISO } from '../utils/dateUtils';
import { usePeriod } from './PeriodContext';

export interface CategoryTotal {
	categoryId: string;
	totalCents: number;
}

export interface MonthlyTotal {
	month: number;
	totalCents: number;
}

interface TransactionsContextType {
	transactions: Transaction[];
	expenses: Transaction[];
	incomes: Transaction[];
	categories: Category[];
	isLoading: boolean;

	/**
	 * Income, expenses and result **for the selected period**.
	 *
	 * Previously the income and expense figures were per-period while `net` held the
	 * all-time balance, so the three numbers shown side by side in Reports did not add up.
	 */
	periodTotals: PeriodSummary;

	/** Cumulative balance of every transaction up to today. Independent of the period. */
	balanceCents: number;

	currentPeriodTransactions: Transaction[];
	categoryTotals: {
		expenses: CategoryTotal[];
		incomes: CategoryTotal[];
	};
	monthlyData: {
		expenses: MonthlyTotal[];
		incomes: MonthlyTotal[];
	};

	// Transaction Actions
	addNewTransaction: (transaction: TransactionDraft) => Promise<string>;
	updateExistingTransaction: (transaction: TransactionEdit) => Promise<void>;
	removeTransaction: (id: string) => Promise<void>;
	refreshData: () => Promise<void>;

	// Category Management Actions
	addCategory: (category: CategoryDraft) => Promise<string>;
	updateCategory: (category: CategoryEdit) => Promise<void>;
	deleteCategory: (categoryId: string) => Promise<void>;
}

const EMPTY_SUMMARY: PeriodSummary = { incomeCents: 0, expenseCents: 0, netCents: 0 };

export const TransactionsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
	const { startDate, endDate } = usePeriod();
	const [isLoading, setIsLoading] = useState(true);
	const [isReady, setIsReady] = useState(false);
	const [transactions, setTransactions] = useState<Transaction[]>([]);
	const [expenses, setExpenses] = useState<Transaction[]>([]);
	const [incomes, setIncomes] = useState<Transaction[]>([]);
	const [categories, setCategories] = useState<Category[]>([]);
	const [currentPeriodTransactions, setCurrentPeriodTransactions] = useState<Transaction[]>([]);
	const [periodTotals, setPeriodTotals] = useState<PeriodSummary>(EMPTY_SUMMARY);
	const [balanceCents, setBalanceCents] = useState(0);
	const [categoryTotals, setCategoryTotals] = useState({
		expenses: [] as CategoryTotal[],
		incomes: [] as CategoryTotal[],
	});
	const [monthlyData, setMonthlyData] = useState({
		expenses: [] as MonthlyTotal[],
		incomes: [] as MonthlyTotal[],
	});

	// biome-ignore lint/correctness/useExhaustiveDependencies: loadAllData is defined in the same render scope and initialization only needs to run once on mount
	useEffect(() => {
		const initialize = async () => {
			try {
				await initDatabase();
				setIsReady(true);
				await loadAllData();
			} catch (error) {
				console.error('Failed to initialize app:', error);
				Alert.alert('Error', 'Failed to initialize the app. Please restart.');
				setIsLoading(false);
			}
		};

		initialize();
	}, []);

	// Reload period-scoped data whenever the selected month changes.
	// biome-ignore lint/correctness/useExhaustiveDependencies: loadPeriodData is defined in the same render scope
	useEffect(() => {
		if (isReady) loadPeriodData();
	}, [startDate, endDate, isReady]);

	const loadAllData = async () => {
		try {
			setIsLoading(true);

			const [allCategories, allTransactions] = await Promise.all([
				getCategories(),
				getTransactions(),
			]);

			setCategories(allCategories);
			setTransactions(allTransactions);
			setExpenses(allTransactions.filter((tx) => !tx.isIncome));
			setIncomes(allTransactions.filter((tx) => tx.isIncome));

			const currentYear = getCurrentYear();
			const [monthlyExpenses, monthlyIncomes] = await Promise.all([
				getMonthlyTransactions(currentYear, 'expense'),
				getMonthlyTransactions(currentYear, 'income'),
			]);

			setMonthlyData({ expenses: monthlyExpenses, incomes: monthlyIncomes });

			await loadPeriodData();
		} catch (error) {
			console.error('Error loading data:', error);
			Alert.alert('Error', 'Failed to load transaction data. Please try again.');
		} finally {
			setIsLoading(false);
		}
	};

	const loadPeriodData = async () => {
		try {
			const [periodTransactions, summary, balance, expenseTotals, incomeTotals] = await Promise.all(
				[
					getTransactionsByDateRange(startDate, endDate),
					getPeriodSummary(startDate, endDate),
					getBalanceAsOf(todayISO()),
					getTotalByCategory(startDate, endDate, 'expense'),
					getTotalByCategory(startDate, endDate, 'income'),
				]
			);

			setCurrentPeriodTransactions(periodTransactions);
			setPeriodTotals(summary);
			setBalanceCents(balance);
			setCategoryTotals({ expenses: expenseTotals, incomes: incomeTotals });
		} catch (error) {
			console.error('Error loading period data:', error);
		}
	};

	const refreshData = async () => {
		try {
			await loadAllData();
		} catch (error) {
			console.error('Error refreshing data:', error);
			Alert.alert('Error', 'Failed to refresh data. Please try again.');
		}
	};

	const addNewTransaction = async (transaction: TransactionDraft) => {
		try {
			const id = await addTransaction(transaction);
			await refreshData();
			syncQueue.schedule();
			return id;
		} catch (error) {
			console.error('Error adding transaction:', error);
			Alert.alert('Error', 'Failed to add transaction. Please try again.');
			throw error;
		}
	};

	const updateExistingTransaction = async (transaction: TransactionEdit) => {
		try {
			await updateTransaction(transaction);
			await refreshData();
			syncQueue.schedule();
		} catch (error) {
			console.error('Error updating transaction:', error);
			Alert.alert('Error', 'Failed to update transaction. Please try again.');
			throw error;
		}
	};

	const removeTransaction = async (id: string) => {
		try {
			await deleteTransaction(id);
			await refreshData();
			syncQueue.schedule();
		} catch (error) {
			console.error('Error deleting transaction:', error);
			Alert.alert('Error', 'Failed to delete transaction. Please try again.');
			throw error;
		}
	};

	const addCategory = async (category: CategoryDraft): Promise<string> => {
		try {
			const id = await dbAddCategory(category);
			setCategories(await getCategories());
			syncQueue.schedule();
			return id;
		} catch (error) {
			console.error('Error adding category:', error);
			Alert.alert('Error', 'Failed to add category. Please try again.');
			throw error;
		}
	};

	const updateCategory = async (category: CategoryEdit): Promise<void> => {
		try {
			await dbUpdateCategory(category);
			setCategories(await getCategories());
			syncQueue.schedule();
		} catch (error) {
			console.error('Error updating category:', error);
			Alert.alert('Error', 'Failed to update category. Please try again.');
			throw error;
		}
	};

	const deleteCategory = async (categoryId: string): Promise<void> => {
		try {
			await dbDeleteCategory(categoryId);
			syncQueue.schedule();
			// Transactions were reassigned to "uncategorized", so totals change too.
			await refreshData();
		} catch (error) {
			console.error('Error deleting category:', error);
			Alert.alert('Error', 'Failed to delete category. Please try again.');
			throw error;
		}
	};

	const value = {
		transactions,
		expenses,
		incomes,
		categories,
		isLoading,
		periodTotals,
		balanceCents,
		currentPeriodTransactions,
		categoryTotals,
		monthlyData,
		addNewTransaction,
		updateExistingTransaction,
		removeTransaction,
		refreshData,
		addCategory,
		updateCategory,
		deleteCategory,
	};

	return <TransactionsContext.Provider value={value}>{children}</TransactionsContext.Provider>;
};

export const useTransactions = () => {
	const context = useContext(TransactionsContext);
	if (context === undefined) {
		throw new Error('useTransactions must be used within a TransactionsProvider');
	}
	return context;
};

const TransactionsContext = createContext<TransactionsContextType | undefined>(undefined);

export default TransactionsContext;
