import * as SQLite from 'expo-sqlite';
import { generateUniqueId } from '../utils/categoryEditUtils';
import {
	type Category,
	CREATE_CATEGORIES_TABLE,
	CREATE_RECURRING_TRANSACTIONS_TABLE,
	CREATE_TRANSACTIONS_TABLE,
	DATABASE_NAME,
	DEFAULT_CATEGORIES,
	type RecurringTransaction,
	type Transaction,
} from './schema';

const db = SQLite.openDatabaseSync(DATABASE_NAME);

interface TransactionDB {
	id: string;
	amount: number;
	category: string;
	date: string;
	note: string;
	isIncome: number;
}

interface RecurringTransactionDB {
	id: string;
	amount: number;
	isIncome: number;
	note: string;
	category: string;
	recurrenceType: 'weekly' | 'monthly' | 'yearly';
	day: number | null;
	month: number | null;
	weekday: number | null;
	lastProcessed: string | null;
	nextDue: string | null;
	active: number;
}

const convertRecurringTransaction = (
	transaction: RecurringTransactionDB
): RecurringTransaction => ({
	id: transaction.id,
	amount: transaction.amount,
	isIncome: Boolean(transaction.isIncome),
	note: transaction.note,
	category: transaction.category,
	recurrenceType: transaction.recurrenceType,
	day: transaction.day ?? undefined,
	month: transaction.month ?? undefined,
	weekday: transaction.weekday ?? undefined,
	lastProcessed: transaction.lastProcessed ?? undefined,
	nextDue: transaction.nextDue ?? undefined,
	active: Boolean(transaction.active),
});

export const initDatabase = async (): Promise<void> => {
	try {
		await db.execAsync(`
      PRAGMA journal_mode = WAL;
      ${CREATE_CATEGORIES_TABLE}
      ${CREATE_TRANSACTIONS_TABLE}
      ${CREATE_RECURRING_TRANSACTIONS_TABLE}
    `);

		const result = await db.getFirstAsync<{ count: number }>(
			'SELECT COUNT(*) AS count FROM categories'
		);

		if (result?.count === 0) {
			await db.withTransactionAsync(async () => {
				for (const category of DEFAULT_CATEGORIES) {
					await db.runAsync('INSERT INTO categories (id, name, color, icon) VALUES (?, ?, ?, ?)', [
						category.id,
						category.name,
						category.color,
						category.icon,
					]);
				}
			});
		}

		console.log('Database initialized successfully');
	} catch (error) {
		console.error('Error initializing database:', error);
		throw error;
	}
};

export const getCategories = async (): Promise<Category[]> => {
	try {
		const categories = await db.getAllAsync<Category>('SELECT * FROM categories ORDER BY name');

		// Check if uncategorized has any transactions
		const uncategorizedTransactions = await getTransactionsByCategory('uncategorized');

		// If no uncategorized transactions, filter out uncategorized category
		return uncategorizedTransactions.length > 0
			? categories
			: categories.filter((c) => c.id !== 'uncategorized');
	} catch (error) {
		console.error('Error fetching categories:', error);
		throw error;
	}
};

export const getCategoriesByType = async (isIncome: boolean): Promise<Category[]> => {
	const incomeCategories = ['salary', 'freelance', 'investment', 'gift', 'refund', 'other_income'];
	const placeholders = incomeCategories.map(() => '?').join(',');

	try {
		const query = isIncome
			? `SELECT * FROM categories WHERE id IN (${placeholders}) ORDER BY name`
			: `SELECT * FROM categories WHERE id NOT IN (${placeholders}) ORDER BY name`;

		return await db.getAllAsync<Category>(query, incomeCategories);
	} catch (error) {
		console.error('Error fetching categories by type:', error);
		throw error;
	}
};

export const addTransaction = async (transaction: Omit<Transaction, 'id'>): Promise<string> => {
	const id = generateUniqueId();
	try {
		await db.runAsync(
			'INSERT INTO transactions (id, amount, category, date, note, isIncome) VALUES (?, ?, ?, ?, ?, ?)',
			[
				id,
				transaction.amount,
				transaction.category,
				transaction.date,
				transaction.note,
				transaction.isIncome ? 1 : 0,
			]
		);
		return id;
	} catch (error) {
		console.error('Error adding transaction:', error);
		throw error;
	}
};

const convertTransaction = (transaction: TransactionDB): Transaction => ({
	...transaction,
	isIncome: Boolean(transaction.isIncome),
});

export const getTransactions = async (): Promise<Transaction[]> => {
	try {
		const transactions = await db.getAllAsync<TransactionDB>(
			'SELECT * FROM transactions ORDER BY date DESC'
		);
		return transactions.map(convertTransaction);
	} catch (error) {
		console.error('Error fetching transactions:', error);
		throw error;
	}
};

export const getTransactionsByType = async (isIncome: boolean): Promise<Transaction[]> => {
	try {
		const transactions = await db.getAllAsync<TransactionDB>(
			'SELECT * FROM transactions WHERE isIncome = ? ORDER BY date DESC',
			[isIncome ? 1 : 0]
		);
		return transactions.map(convertTransaction);
	} catch (error) {
		console.error('Error fetching transactions by type:', error);
		throw error;
	}
};

export const getTransactionsByCategory = async (categoryId: string): Promise<Transaction[]> => {
	try {
		const transactions = await db.getAllAsync<TransactionDB>(
			'SELECT * FROM transactions WHERE category = ? ORDER BY date DESC',
			[categoryId]
		);
		return transactions.map(convertTransaction);
	} catch (error) {
		console.error('Error fetching transactions by category:', error);
		throw error;
	}
};

export const getTransactionsByDateRange = async (
	startDate: string,
	endDate: string,
	transactionType?: 'income' | 'expense'
): Promise<Transaction[]> => {
	try {
		let query = 'SELECT * FROM transactions WHERE date BETWEEN ? AND ?';
		const params: string[] = [startDate, endDate];

		if (transactionType === 'income') {
			query += ' AND isIncome = 1';
		} else if (transactionType === 'expense') {
			query += ' AND isIncome = 0';
		}

		query += ' ORDER BY date DESC';

		const transactions = await db.getAllAsync<TransactionDB>(query, params);
		return transactions.map(convertTransaction);
	} catch (error) {
		console.error('Error fetching transactions by date range:', error);
		throw error;
	}
};

export const updateTransaction = async (transaction: Transaction): Promise<void> => {
	try {
		await db.runAsync(
			'UPDATE transactions SET amount = ?, category = ?, date = ?, note = ?, isIncome = ? WHERE id = ?',
			[
				transaction.amount,
				transaction.category,
				transaction.date,
				transaction.note,
				transaction.isIncome ? 1 : 0,
				transaction.id,
			]
		);
	} catch (error) {
		console.error('Error updating transaction:', error);
		throw error;
	}
};

export const deleteTransaction = async (id: string): Promise<void> => {
	try {
		await db.runAsync('DELETE FROM transactions WHERE id = ?', [id]);
	} catch (error) {
		console.error('Error deleting transaction:', error);
		throw error;
	}
};

export const getTotalByCategory = async (
	startDate?: string,
	endDate?: string,
	transactionType?: 'income' | 'expense'
): Promise<{ categoryId: string; total: number }[]> => {
	try {
		let query = `
      SELECT category AS categoryId, SUM(amount) AS total
      FROM transactions
      WHERE 1=1`;

		const params: string[] = [];

		if (startDate && endDate) {
			query += ' AND date BETWEEN ? AND ?';
			params.push(startDate, endDate);
		}

		if (transactionType === 'income') {
			query += ' AND isIncome = 1';
		} else if (transactionType === 'expense') {
			query += ' AND isIncome = 0';
		}

		query += ' GROUP BY category';

		return await db.getAllAsync<{ categoryId: string; total: number }>(query, params);
	} catch (error) {
		console.error('Error fetching total by category:', error);
		throw error;
	}
};

export const getMonthlyTransactions = async (
	year: number,
	transactionType?: 'income' | 'expense'
): Promise<{ month: number; total: number }[]> => {
	try {
		let query = `
      SELECT CAST(strftime('%m', date) AS INTEGER) AS month,
             SUM(amount) AS total
      FROM transactions
      WHERE strftime('%Y', date) = ?`;

		const params: string[] = [year.toString()];

		if (transactionType === 'income') {
			query += ' AND isIncome = 1';
		} else if (transactionType === 'expense') {
			query += ' AND isIncome = 0';
		}

		query += ' GROUP BY month ORDER BY month';

		return await db.getAllAsync<{ month: number; total: number }>(query, params);
	} catch (error) {
		console.error('Error fetching monthly transactions:', error);
		throw error;
	}
};

export const getIncomeSummary = async (startDate?: string, endDate?: string): Promise<number> => {
	try {
		let query = 'SELECT SUM(amount) as total FROM transactions WHERE isIncome = 1';
		const params: string[] = [];

		if (startDate && endDate) {
			query += ' AND date BETWEEN ? AND ?';
			params.push(startDate, endDate);
		}

		const result = await db.getFirstAsync<{ total: number }>(query, params);
		return result?.total || 0;
	} catch (error) {
		console.error('Error fetching income summary:', error);
		throw error;
	}
};

export const getExpenseSummary = async (startDate?: string, endDate?: string): Promise<number> => {
	try {
		let query = 'SELECT SUM(amount) as total FROM transactions WHERE isIncome = 0';
		const params: string[] = [];

		if (startDate && endDate) {
			query += ' AND date BETWEEN ? AND ?';
			params.push(startDate, endDate);
		}

		const result = await db.getFirstAsync<{ total: number }>(query, params);
		return result?.total || 0;
	} catch (error) {
		console.error('Error fetching expense summary:', error);
		throw error;
	}
};

export const getNetIncome = async (startDate?: string, endDate?: string): Promise<number> => {
	try {
		let query = `
      SELECT
        COALESCE(SUM(CASE WHEN isIncome = 1 THEN amount ELSE 0 END), 0) -
        COALESCE(SUM(CASE WHEN isIncome = 0 THEN amount ELSE 0 END), 0) as netIncome
      FROM transactions`;

		const params: string[] = [];

		if (startDate && endDate) {
			query += ' WHERE date BETWEEN ? AND ?';
			params.push(startDate, endDate);
		}

		const result = await db.getFirstAsync<{ netIncome: number }>(query, params);
		return result?.netIncome || 0;
	} catch (error) {
		console.error('Error calculating net income:', error);
		throw error;
	}
};

export const calculateNextDueDate = (
	transaction: Pick<RecurringTransaction, 'recurrenceType'> & Partial<RecurringTransaction>
): string => {
	const today = new Date();
	// Make a copy of today's date to avoid modifying it
	const nextDue = new Date(today);

	// Reset time components to ensure consistent date comparisons
	nextDue.setHours(0, 0, 0, 0);

	if (transaction.recurrenceType === 'monthly') {
		// Set to the specified day of current month
		nextDue.setDate(transaction.day || 1);

		// If the calculated date is in the past, move to next month
		if (nextDue < today) {
			nextDue.setMonth(nextDue.getMonth() + 1);
		}
	} else if (transaction.recurrenceType === 'yearly') {
		// Set to the specified month and day
		nextDue.setMonth((transaction.month || 1) - 1);
		nextDue.setDate(transaction.day || 1);

		// If the calculated date is in the past, move to next year
		if (nextDue < today) {
			nextDue.setFullYear(nextDue.getFullYear() + 1);
		}
	} else if (transaction.recurrenceType === 'weekly') {
		// Handle weekly recurrence
		// In JavaScript: 0 = Sunday, 1 = Monday, ..., 6 = Saturday
		// But in our app: 1 = Monday, ..., 7 = Sunday
		// So we need to convert our weekday to JavaScript's weekday
		const jsWeekday = transaction.weekday === 7 ? 0 : transaction.weekday || 1;
		const currentJsWeekday = today.getDay(); // 0-6 where 0 is Sunday

		let daysToAdd = jsWeekday - currentJsWeekday;

		// If the calculated day is today or in the past, move to next week
		if (daysToAdd <= 0) {
			daysToAdd += 7;
		}

		nextDue.setDate(today.getDate() + daysToAdd);
	}

	// Return ISO format date string (YYYY-MM-DD)
	return nextDue.toISOString().split('T')[0];
};

export const addRecurringTransaction = async (
	transaction: Omit<RecurringTransaction, 'id' | 'lastProcessed' | 'nextDue'>
): Promise<string> => {
	const id = generateUniqueId();
	const nextDue = calculateNextDueDate(transaction);

	try {
		await db.runAsync(
			`INSERT INTO recurring_transactions
       (id, amount, isIncome, note, category, recurrenceType, day, month, weekday, lastProcessed, nextDue, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				transaction.amount,
				transaction.isIncome ? 1 : 0,
				transaction.note,
				transaction.category,
				transaction.recurrenceType,
				transaction.day ?? null,
				transaction.month ?? null,
				transaction.weekday ?? null,
				null,
				nextDue,
				transaction.active ? 1 : 0,
			]
		);
		return id;
	} catch (error) {
		console.error('Error adding recurring transaction:', error);
		throw error;
	}
};

export const getRecurringTransactions = async (): Promise<RecurringTransaction[]> => {
	try {
		const transactions = await db.getAllAsync<RecurringTransactionDB>(
			'SELECT * FROM recurring_transactions ORDER BY nextDue ASC'
		);
		return transactions.map(convertRecurringTransaction);
	} catch (error) {
		console.error('Error fetching recurring transactions:', error);
		throw error;
	}
};

export const getRecurringTransactionById = async (
	id: string
): Promise<RecurringTransaction | null> => {
	try {
		const transaction = await db.getFirstAsync<RecurringTransactionDB>(
			'SELECT * FROM recurring_transactions WHERE id = ?',
			[id]
		);
		return transaction ? convertRecurringTransaction(transaction) : null;
	} catch (error) {
		console.error('Error fetching recurring transaction:', error);
		throw error;
	}
};

export const updateRecurringTransaction = async (
	transaction: RecurringTransaction
): Promise<void> => {
	const nextDue = transaction.nextDue ?? calculateNextDueDate(transaction);

	try {
		await db.runAsync(
			`UPDATE recurring_transactions
       SET amount = ?, isIncome = ?, note = ?, category = ?,
           recurrenceType = ?, day = ?, month = ?, weekday = ?,
           lastProcessed = ?, nextDue = ?, active = ?
       WHERE id = ?`,
			[
				transaction.amount,
				transaction.isIncome ? 1 : 0,
				transaction.note,
				transaction.category,
				transaction.recurrenceType,
				transaction.day ?? null,
				transaction.month ?? null,
				transaction.weekday ?? null,
				transaction.lastProcessed ?? null,
				nextDue,
				transaction.active ? 1 : 0,
				transaction.id,
			]
		);
	} catch (error) {
		console.error('Error updating recurring transaction:', error);
		throw error;
	}
};

export const deleteRecurringTransaction = async (id: string): Promise<void> => {
	try {
		await db.runAsync('DELETE FROM recurring_transactions WHERE id = ?', [id]);
	} catch (error) {
		console.error('Error deleting recurring transaction:', error);
		throw error;
	}
};

export const processRecurringTransactions = async (): Promise<void> => {
	try {
		const today = new Date().toISOString().split('T')[0];
		const dueTransactions = await db.getAllAsync<RecurringTransactionDB>(
			`SELECT * FROM recurring_transactions
       WHERE active = 1 AND nextDue <= ?
       ORDER BY nextDue ASC`,
			[today]
		);

		if (dueTransactions.length === 0) return;

		await db.withTransactionAsync(async () => {
			for (const dbTransaction of dueTransactions) {
				const transaction = convertRecurringTransaction(dbTransaction);

				await addTransaction({
					amount: transaction.amount,
					category: transaction.category,
					date: today,
					note: `[Auto] ${transaction.note}`,
					isIncome: transaction.isIncome,
				});

				await updateRecurringTransaction({
					...transaction,
					lastProcessed: today,
					nextDue: calculateNextDueDate(transaction),
				});
			}
		});
	} catch (error) {
		console.error('Error processing recurring transactions:', error);
		throw error;
	}
};

export const resetDatabase = async (): Promise<void> => {
	try {
		await db.withTransactionAsync(async () => {
			// Delete all transactions
			await db.runAsync('DELETE FROM transactions');

			// Delete all recurring transactions
			await db.runAsync('DELETE FROM recurring_transactions');

			// Keep default categories, but we could reset them here if needed
			// To reset categories to defaults:
			// await db.runAsync('DELETE FROM categories');
			// For now we'll keep the categories
		});

		console.log('Database reset successfully');
	} catch (error) {
		console.error('Error resetting database:', error);
		throw error;
	}
};

export const addCategory = async (category: Omit<Category, 'id'>): Promise<string> => {
	const id = generateUniqueId();
	await db.runAsync('INSERT INTO categories (id, name, color, icon) VALUES (?, ?, ?, ?)', [
		id,
		category.name,
		category.color,
		category.icon,
	]);
	return id;
};

export const updateCategory = async (category: Category): Promise<void> => {
	await db.runAsync('UPDATE categories SET name = ?, color = ?, icon = ? WHERE id = ?', [
		category.name,
		category.color,
		category.icon,
		category.id,
	]);
};

export const deleteCategory = async (categoryId: string): Promise<void> => {
	// Prevent deletion of uncategorized category
	if (categoryId === 'uncategorized') {
		throw new Error('Uncategorized category cannot be deleted');
	}

	// Get transactions in this category
	const transactions = await getTransactionsByCategory(categoryId);

	// If transactions exist, move them to uncategorized
	if (transactions.length > 0) {
		await db.withTransactionAsync(async () => {
			for (const transaction of transactions) {
				await updateTransaction({
					...transaction,
					category: 'uncategorized',
				});
			}
		});
	}

	// Delete the category
	await db.runAsync('DELETE FROM categories WHERE id = ?', [categoryId]);
};

export default {
	initDatabase,
	getCategories,
	getCategoriesByType,
	addTransaction,
	getTransactions,
	getTransactionsByType,
	getTransactionsByCategory,
	getTransactionsByDateRange,
	updateTransaction,
	deleteTransaction,
	getTotalByCategory,
	getMonthlyTransactions,
	getIncomeSummary,
	getExpenseSummary,
	getNetIncome,
	addRecurringTransaction,
	getRecurringTransactions,
	getRecurringTransactionById,
	updateRecurringTransaction,
	deleteRecurringTransaction,
	processRecurringTransactions,
	resetDatabase,
	addCategory,
	updateCategory,
	deleteCategory,
};
