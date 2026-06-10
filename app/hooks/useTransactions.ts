import { useCallback, useState } from 'react';
import { Alert } from 'react-native';
import { useTransactions } from '../contexts/TransactionsContext';
import { getTransactionsByCategory, getTransactionsByDateRange } from '../database/database';
import type { Transaction } from '../database/schema';

export const useTransactionsFilters = () => {
	const { categories } = useTransactions();
	const [filteredTransactions, setFilteredTransactions] = useState<Transaction[]>([]);
	const [isFiltering, setIsFiltering] = useState(false);
	const [activeFilter, setActiveFilter] = useState<'category' | 'date' | 'type' | null>(null);
	const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
	const [selectedType, setSelectedType] = useState<'income' | 'expense' | null>(null);
	const [dateRange, setDateRange] = useState<{ startDate: string; endDate: string } | null>(null);

	const filterByCategory = useCallback(async (categoryId: string) => {
		try {
			setIsFiltering(true);
			const transactions = await getTransactionsByCategory(categoryId);
			setFilteredTransactions(transactions);
			setSelectedCategoryId(categoryId);
			setActiveFilter('category');
		} catch (error) {
			console.error('Error filtering by category:', error);
			Alert.alert('Error', 'Failed to filter transactions by category.');
		} finally {
			setIsFiltering(false);
		}
	}, []);

	const filterByType = useCallback(async (type: 'income' | 'expense') => {
		try {
			setIsFiltering(true);
			// This is handled in the UI now, filtering the existing transactions
			const _isIncome = type === 'income';
			// For a real implementation, you might want to add a database query for this
			// but for now we'll handle it in the UI
			setSelectedType(type);
			setActiveFilter('type');
			setIsFiltering(false);
		} catch (error) {
			console.error('Error filtering by type:', error);
			Alert.alert('Error', 'Failed to filter transactions by type.');
			setIsFiltering(false);
		}
	}, []);

	const filterByDateRange = useCallback(async (startDate: string, endDate: string) => {
		try {
			setIsFiltering(true);
			const transactions = await getTransactionsByDateRange(startDate, endDate);
			setFilteredTransactions(transactions);
			setDateRange({ startDate, endDate });
			setActiveFilter('date');
		} catch (error) {
			console.error('Error filtering by date range:', error);
			Alert.alert('Error', 'Failed to filter transactions by date range.');
		} finally {
			setIsFiltering(false);
		}
	}, []);

	const clearFilters = useCallback(() => {
		setFilteredTransactions([]);
		setSelectedCategoryId(null);
		setSelectedType(null);
		setDateRange(null);
		setActiveFilter(null);
		setIsFiltering(false);
	}, []);

	const getSelectedCategoryName = useCallback(() => {
		if (!selectedCategoryId) return '';
		const category = categories.find((c) => c.id === selectedCategoryId);
		return category ? category.name : '';
	}, [selectedCategoryId, categories]);

	return {
		filteredTransactions,
		isFiltering,
		activeFilter,
		selectedCategoryId,
		selectedType,
		dateRange,
		filterByCategory,
		filterByType,
		filterByDateRange,
		clearFilters,
		getSelectedCategoryName,
	};
};

export const useCategoryStats = (categoryId: string) => {
	const { transactions, categories } = useTransactions();

	const categoryTransactions = transactions.filter(
		(transaction) => transaction.category === categoryId
	);
	const category = categories.find((c) => c.id === categoryId);

	const total = categoryTransactions.reduce((sum, transaction) => sum + transaction.amount, 0);
	const count = categoryTransactions.length;
	const averageAmount = count > 0 ? total / count : 0;

	return {
		category,
		total,
		count,
		averageAmount,
		transactions: categoryTransactions,
	};
};

export default { useTransactionsFilters, useCategoryStats };
