import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Alert } from 'react-native';
import {
	addRecurringTransaction,
	addTransaction,
	getCategories,
	resetDatabase,
} from '../database/database';
import type { Category, RecurringTransaction, Transaction } from '../database/schema';
import { formatFullDate } from './dateUtils';

export interface DatabaseExportData {
	transactions: Transaction[];
	categories: Category[];
	recurringTransactions: RecurringTransaction[];
	exportDate: string;
}

// Function to convert transactions data to CSV format
export const transactionsToCSV = (transactions: Transaction[], categories: Category[]): string => {
	// Create CSV header
	const header = 'Date,Type,Category,Amount,Note\n';

	// Create CSV rows
	const rows = transactions
		.map((transaction) => {
			// Find category name
			const category = categories.find((c) => c.id === transaction.category);
			const categoryName = category ? category.name : 'Unknown';

			// Format transaction data
			const date = formatFullDate(transaction.date);
			const type = transaction.isIncome ? 'Income' : 'Expense';
			const amount = transaction.amount.toFixed(2);
			// Make sure notes with commas are properly quoted
			const note = transaction.note ? `"${transaction.note.replace(/"/g, '""')}"` : '';

			return `${date},${type},${categoryName},${amount},${note}`;
		})
		.join('\n');

	return header + rows;
};

// Function to export data to a CSV file and share it
// Generate a full financial report as CSV
export const generateFinancialReport = async (
	transactions: Transaction[],
	categories: Category[],
	monthlyData: {
		expenses: { month: number; total: number }[];
		incomes: { month: number; total: number }[];
	},
	categoryTotals: {
		expenses: { categoryId: string; total: number }[];
		incomes: { categoryId: string; total: number }[];
	}
): Promise<string> => {
	const lines: string[] = [];

	// Add header
	lines.push('SPENDR FINANCIAL REPORT');
	lines.push(`Generated on: ${formatFullDate(new Date().toISOString())}`);
	lines.push('');

	// Add monthly summary
	lines.push('MONTHLY SUMMARY');
	lines.push('Month,Income,Expense,Net');

	// Combine income and expense data by month
	const allMonths = new Set<number>();
	monthlyData.expenses.forEach((item) => {
		allMonths.add(item.month);
	});
	monthlyData.incomes.forEach((item) => {
		allMonths.add(item.month);
	});

	const sortedMonths = Array.from(allMonths).sort((a, b) => a - b);

	sortedMonths.forEach((month) => {
		const income = monthlyData.incomes.find((i) => i.month === month)?.total || 0;
		const expense = monthlyData.expenses.find((e) => e.month === month)?.total || 0;
		const net = income - expense;

		const monthName = new Date(2000, month - 1, 1).toLocaleString('en-US', { month: 'long' });
		lines.push(`${monthName},${income.toFixed(2)},${expense.toFixed(2)},${net.toFixed(2)}`);
	});

	lines.push('');

	// Add category breakdown
	lines.push('EXPENSE CATEGORIES');
	lines.push('Category,Amount,Percentage');

	const totalExpenses = categoryTotals.expenses.reduce((sum, item) => sum + item.total, 0);

	categoryTotals.expenses.forEach((item) => {
		const category = categories.find((c) => c.id === item.categoryId);
		const categoryName = category ? category.name : 'Unknown';
		const percentage = totalExpenses > 0 ? (item.total / totalExpenses) * 100 : 0;

		lines.push(`${categoryName},${item.total.toFixed(2)},${percentage.toFixed(2)}%`);
	});

	lines.push('');

	lines.push('INCOME CATEGORIES');
	lines.push('Category,Amount,Percentage');

	const totalIncomes = categoryTotals.incomes.reduce((sum, item) => sum + item.total, 0);

	categoryTotals.incomes.forEach((item) => {
		const category = categories.find((c) => c.id === item.categoryId);
		const categoryName = category ? category.name : 'Unknown';
		const percentage = totalIncomes > 0 ? (item.total / totalIncomes) * 100 : 0;

		lines.push(`${categoryName},${item.total.toFixed(2)},${percentage.toFixed(2)}%`);
	});

	lines.push('');

	// Add transaction list
	lines.push('TRANSACTIONS');
	lines.push('Date,Type,Category,Amount,Note');

	transactions
		.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
		.forEach((transaction) => {
			const category = categories.find((c) => c.id === transaction.category);
			const categoryName = category ? category.name : 'Unknown';

			const date = formatFullDate(transaction.date);
			const type = transaction.isIncome ? 'Income' : 'Expense';
			const amount = transaction.amount.toFixed(2);
			const note = transaction.note ? `"${transaction.note.replace(/"/g, '""')}"` : '';

			lines.push(`${date},${type},${categoryName},${amount},${note}`);
		});

	return lines.join('\n');
};

export const exportToCSV = async (
	transactions: Transaction[],
	categories: Category[],
	fileName = 'spendr_export' as string // Type assertion for default value
): Promise<void> => {
	try {
		const csvContent = transactionsToCSV(transactions, categories);
		const finalFileName = fileName.endsWith('.csv') ? fileName : `${fileName}.csv`;
		const file = new File(Paths.document, finalFileName);
		file.write(csvContent);

		await Sharing.shareAsync(file.uri, {
			mimeType: 'text/csv',
			dialogTitle: 'Export Transactions',
			UTI: 'public.comma-separated-values-text',
		});
	} catch (error) {
		console.error('Error exporting to CSV:', error);
		Alert.alert('Export Failed', 'There was an error exporting your data. Please try again.');
		throw error;
	}
};

// Function to export specific period data
export const exportPeriodData = async (
	transactions: Transaction[],
	categories: Category[],
	periodName: string
): Promise<void> => {
	try {
		const date = new Date();
		const timestamp = `${date.getFullYear()}${(date.getMonth() + 1)
			.toString()
			.padStart(2, '0')}${date.getDate().toString().padStart(2, '0')}`;

		const fileName = `spendr_${periodName.toLowerCase().replace(/\s+/g, '_')}_${timestamp}.csv`;

		await exportToCSV(transactions, categories, fileName);
	} catch (error) {
		console.error('Error exporting period data:', error);
		Alert.alert('Export Failed', 'There was an error exporting your data. Please try again.');
		throw error;
	}
};

// Export comprehensive financial report
export const exportFinancialReport = async (
	transactions: Transaction[],
	categories: Category[],
	monthlyData: {
		expenses: { month: number; total: number }[];
		incomes: { month: number; total: number }[];
	},
	categoryTotals: {
		expenses: { categoryId: string; total: number }[];
		incomes: { categoryId: string; total: number }[];
	},
	periodName: string
): Promise<void> => {
	try {
		const date = new Date();
		const timestamp = `${date.getFullYear()}${(date.getMonth() + 1).toString().padStart(2, '0')}${date.getDate().toString().padStart(2, '0')}`;
		const fileName = `spendr_report_${periodName.toLowerCase().replace(/\s+/g, '_')}_${timestamp}.csv`;

		// Generate report content
		const reportContent = await generateFinancialReport(
			transactions,
			categories,
			monthlyData,
			categoryTotals
		);

		// Create file in app's document directory
		const file = new File(Paths.document, fileName);
		file.write(reportContent);

		// Share the file
		await Sharing.shareAsync(file.uri, {
			mimeType: 'text/csv',
			dialogTitle: 'Share Financial Report',
			UTI: 'public.comma-separated-values-text',
		});

		return;
	} catch (error) {
		console.error('Error exporting financial report:', error);
		Alert.alert(
			'Export Failed',
			'There was an error exporting your financial report. Please try again.'
		);
		throw error;
	}
};

/**
 * Export complete database data to a JSON file
 */
export const exportDatabaseData = async (
	transactions: Transaction[],
	categories: Category[],
	recurringTransactions: RecurringTransaction[]
): Promise<void> => {
	try {
		// Create the export data structure
		const exportData: DatabaseExportData = {
			transactions,
			categories,
			recurringTransactions,
			exportDate: new Date().toISOString(),
		};

		// Convert to JSON string
		const jsonData = JSON.stringify(exportData, null, 2);

		// Generate a filename with timestamp
		const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
		const fileName = `spendr_backup_${timestamp}.json`;

		// Create the file in app's document directory
		const file = new File(Paths.document, fileName);
		file.write(jsonData);

		// Share the file
		await Sharing.shareAsync(file.uri, {
			mimeType: 'application/json',
			dialogTitle: 'Share app data backup',
			UTI: 'public.json',
		});

		Alert.alert(
			'Export Successful',
			'Your data has been exported successfully. You can save this file for backup purposes.'
		);

		return;
	} catch (error) {
		console.error('Error exporting database data:', error);
		Alert.alert('Export Failed', 'There was an error exporting your data. Please try again.');
		throw error;
	}
};

/**
 * Import database data from a JSON file
 */
export const importDatabaseData = async (): Promise<{
	success: boolean;
	message: string;
	stats?: {
		transactions: number;
		categories: number;
		recurringTransactions: number;
	};
}> => {
	try {
		// Use document picker to select a file
		const result = await DocumentPicker.getDocumentAsync({
			type: 'application/json',
			copyToCacheDirectory: true,
		});

		if (result.canceled) {
			return {
				success: false,
				message: 'Import canceled.',
			};
		}

		// Check if we have the file URI
		if (!result.assets || !result.assets[0] || !result.assets[0].uri) {
			return {
				success: false,
				message: 'Could not access the selected file.',
			};
		}

		const fileUri = result.assets[0].uri;

		// Read the file content
		const fileContent = await new File(fileUri).text();

		// Parse the JSON data
		const importData = JSON.parse(fileContent) as DatabaseExportData;

		// Validate the data structure
		if (!validateImportData(importData)) {
			return {
				success: false,
				message: 'The selected file does not contain valid Spendr backup data.',
			};
		}

		// Get existing categories to check if we need to add them
		const existingCategories = await getCategories();
		const existingCategoryIds = new Set(existingCategories.map((c) => c.id));

		// Reset the database first
		await resetDatabase();

		// Import transactions
		for (const transaction of importData.transactions) {
			await addTransaction({
				amount: transaction.amount,
				category: transaction.category,
				date: transaction.date,
				note: transaction.note,
				isIncome: transaction.isIncome,
			});
		}

		// Import recurring transactions
		for (const recurringTx of importData.recurringTransactions) {
			// We need to format the data to match what addRecurringTransaction expects
			const { id, lastProcessed, nextDue, ...txData } = recurringTx;
			await addRecurringTransaction(txData);
		}

		return {
			success: true,
			message: 'Data imported successfully.',
			stats: {
				transactions: importData.transactions.length,
				categories: importData.categories.length,
				recurringTransactions: importData.recurringTransactions.length,
			},
		};
	} catch (error) {
		console.error('Error importing database data:', error);
		return {
			success: false,
			message: `Import failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
		};
	}
};

/**
 * Validate the imported data structure
 */

// biome-ignore lint/suspicious/noExplicitAny: <explanation>
const validateImportData = (data: any): data is DatabaseExportData => {
	// Basic structure validation
	if (!data || typeof data !== 'object') return false;

	// Check required properties
	if (
		!Array.isArray(data.transactions) ||
		!Array.isArray(data.categories) ||
		!Array.isArray(data.recurringTransactions) ||
		typeof data.exportDate !== 'string'
	) {
		return false;
	}

	// Check a sample transaction for structure
	if (data.transactions.length > 0) {
		const sampleTx = data.transactions[0];
		if (
			typeof sampleTx.id !== 'string' ||
			typeof sampleTx.amount !== 'number' ||
			typeof sampleTx.category !== 'string' ||
			typeof sampleTx.date !== 'string' ||
			typeof sampleTx.isIncome !== 'boolean'
		) {
			return false;
		}
	}

	return true;
};

export default {
	transactionsToCSV,
	exportToCSV,
	exportPeriodData,
	exportFinancialReport,
	generateFinancialReport,
	exportDatabaseData,
	importDatabaseData,
};
