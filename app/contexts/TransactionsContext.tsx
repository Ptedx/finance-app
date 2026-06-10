import type React from 'react';
import { createContext, useContext, useEffect, useState } from 'react';
import { Alert } from 'react-native';
import {
	addTransaction,
	addCategory as dbAddCategory,
	deleteCategory as dbDeleteCategory,
	updateCategory as dbUpdateCategory,
	deleteTransaction,
	getCategories,
	getMonthlyTransactions,
	getTotalByCategory,
	getTransactions,
	getTransactionsByDateRange,
	initDatabase,
	updateTransaction,
} from '../database/database';
import type { Category, Transaction } from '../database/schema';
import { getCurrentYear, getISODate } from '../utils/dateUtils';
import { usePeriod } from './PeriodContext';

interface TransactionsContextType {
	transactions: Transaction[];
	expenses: Transaction[];
	incomes: Transaction[];
	categories: Category[];
	isLoading: boolean;
	monthlyTotal: {
		expenses: number;
		incomes: number;
		net: number;
	};
	currentPeriodTransactions: Transaction[];
	categoryTotals: {
		expenses: { categoryId: string; total: number }[];
		incomes: { categoryId: string; total: number }[];
	};
	monthlyData: {
		expenses: { month: number; total: number }[];
		incomes: { month: number; total: number }[];
	};
	// Transaction Actions
	addNewTransaction: (transaction: Omit<Transaction, 'id'>) => Promise<string>;
	updateExistingTransaction: (transaction: Transaction) => Promise<void>;
	removeTransaction: (id: string) => Promise<void>;
	refreshData: () => Promise<void>;

	// Category Management Actions
	addCategory: (category: Omit<Category, 'id'>) => Promise<string>;
	updateCategory: (category: Category) => Promise<void>;
	deleteCategory: (categoryId: string) => Promise<void>;
}

export const TransactionsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
	const { startDate, endDate } = usePeriod();
	const [isLoading, setIsLoading] = useState(true);
	const [transactions, setTransactions] = useState<Transaction[]>([]);
	const [expenses, setExpenses] = useState<Transaction[]>([]);
	const [incomes, setIncomes] = useState<Transaction[]>([]);
	const [categories, setCategories] = useState<Category[]>([]);
	const [currentPeriodTransactions, setCurrentPeriodTransactions] = useState<Transaction[]>([]);
	const [monthlyTotal, setMonthlyTotal] = useState({
		expenses: 0,
		incomes: 0,
		net: 0,
	});
	const [categoryTotals, setCategoryTotals] = useState({
		expenses: [] as { categoryId: string; total: number }[],
		incomes: [] as { categoryId: string; total: number }[],
	});
	const [monthlyData, setMonthlyData] = useState({
		expenses: [] as { month: number; total: number }[],
		incomes: [] as { month: number; total: number }[],
	});

	// biome-ignore lint/correctness/useExhaustiveDependencies: loadAllData is defined in the same render scope and initialization only needs to run once on mount
	useEffect(() => {
		const initialize = async () => {
			try {
				await initDatabase();
				await loadAllData();
			} catch (error) {
				console.error('Failed to initialize app:', error);
				Alert.alert('Error', 'Failed to initialize the app. Please restart.');
			} finally {
				setIsLoading(false);
			}
		};

		initialize();
	}, []);

	// Load period-specific data when period changes
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional one-time effect
	useEffect(() => {
		if (!isLoading) {
			loadPeriodData();
		}
	}, [startDate, endDate, isLoading]);

	const loadAllData = async () => {
		try {
			setIsLoading(true);

			// Get all categories and transactions
			const allCategories = await getCategories();
			const allTransactions = await getTransactions();

			// Separate expenses and incomes
			const allExpenses = allTransactions.filter((tx) => !tx.isIncome);
			const allIncomes = allTransactions.filter((tx) => tx.isIncome);

			setCategories(allCategories);
			setTransactions(allTransactions);
			setExpenses(allExpenses);
			setIncomes(allIncomes);

			// Get monthly data for current year (for charts)
			const currentYear = getCurrentYear();
			const monthlyExpenses = await getMonthlyTransactions(currentYear, 'expense');
			const monthlyIncomes = await getMonthlyTransactions(currentYear, 'income');

			setMonthlyData({
				expenses: monthlyExpenses,
				incomes: monthlyIncomes,
			});

			// Load period-specific data
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
			// Get current period transactions
			const periodTransactions = await getTransactionsByDateRange(startDate, endDate);
			const sortedTransactions = [...periodTransactions].sort(
				(a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
			);
			setCurrentPeriodTransactions(sortedTransactions);

			// Calculate monthly totals for the selected period
			const periodExpenses = periodTransactions
				.filter((tx) => !tx.isIncome)
				.reduce((sum, tx) => sum + tx.amount, 0);

			const periodIncomes = periodTransactions
				.filter((tx) => tx.isIncome)
				.reduce((sum, tx) => sum + tx.amount, 0);

			// For cumulative balance, get ALL transactions up to the current date
			const currentDate = new Date();
			const formattedCurrentDate = getISODate(currentDate);

			const allTransactionsToDate = await getTransactionsByDateRange(
				'1970-01-01',
				formattedCurrentDate
			);

			const totalExpenses = allTransactionsToDate
				.filter((tx) => !tx.isIncome)
				.reduce((sum, tx) => sum + tx.amount, 0);

			const totalIncomes = allTransactionsToDate
				.filter((tx) => tx.isIncome)
				.reduce((sum, tx) => sum + tx.amount, 0);

			const cumulativeNet = totalIncomes - totalExpenses;

			// Update states
			setMonthlyTotal({
				expenses: periodExpenses,
				incomes: periodIncomes,
				net: cumulativeNet,
			});

			// Also load category totals for the period
			const expenseTotals = await getTotalByCategory(startDate, endDate, 'expense');
			const incomeTotals = await getTotalByCategory(startDate, endDate, 'income');

			setCategoryTotals({
				expenses: expenseTotals,
				incomes: incomeTotals,
			});

			setIsLoading(false);
		} catch (error) {
			console.error('Error loading period data:', error);
			setIsLoading(false);
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

	const addNewTransaction = async (transaction: Omit<Transaction, 'id'>) => {
		try {
			const id = await addTransaction(transaction);
			await refreshData();
			return id;
		} catch (error) {
			console.error('Error adding transaction:', error);
			Alert.alert('Error', 'Failed to add transaction. Please try again.');
			throw error;
		}
	};

	const updateExistingTransaction = async (transaction: Transaction) => {
		try {
			await updateTransaction(transaction);
			await refreshData();
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
		} catch (error) {
			console.error('Error deleting transaction:', error);
			Alert.alert('Error', 'Failed to delete transaction. Please try again.');
			throw error;
		}
	};

	// Category Management Methods
	const addCategory = async (category: Omit<Category, 'id'>): Promise<string> => {
		try {
			const id = await dbAddCategory(category);

			// Refresh categories after adding
			const updatedCategories = await getCategories();
			setCategories(updatedCategories);

			return id;
		} catch (error) {
			console.error('Error adding category:', error);
			Alert.alert('Error', 'Failed to add category. Please try again.');
			throw error;
		}
	};

	const updateCategory = async (category: Category): Promise<void> => {
		try {
			await dbUpdateCategory(category);

			// Refresh categories after updating
			const updatedCategories = await getCategories();
			setCategories(updatedCategories);
		} catch (error) {
			console.error('Error updating category:', error);
			Alert.alert('Error', 'Failed to update category. Please try again.');
			throw error;
		}
	};

	const deleteCategory = async (categoryId: string): Promise<void> => {
		try {
			await dbDeleteCategory(categoryId);

			// Refresh categories after deleting
			const updatedCategories = await getCategories();
			setCategories(updatedCategories);
		} catch (error) {
			console.error('Error deleting category:', error);
			if (error instanceof Error && error.message.includes('transactions')) {
				Alert.alert(
					'Cannot Delete Category',
					'This category is associated with existing transactions and cannot be deleted.'
				);
			} else {
				Alert.alert('Error', 'Failed to delete category. Please try again.');
			}
			throw error;
		}
	};

	const value = {
		transactions,
		expenses,
		incomes,
		categories,
		isLoading,
		monthlyTotal,
		currentPeriodTransactions,
		categoryTotals,
		monthlyData,
		addNewTransaction,
		updateExistingTransaction,
		removeTransaction,
		refreshData,
		// Category management methods
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
