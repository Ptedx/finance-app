import AsyncStorage from '@react-native-async-storage/async-storage';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Alert } from 'react-native';
import {
	addCategory,
	addRecurringTransaction,
	addTransaction,
	getCategories,
	resetDatabase,
} from '../database/database';
import type { Category, RecurringTransaction, Transaction } from '../database/schema';
import { getMonthName, todayISO } from './dateUtils';
import { centsToMajorUnits, majorUnitsToCents } from './money';
import { STORAGE_KEYS } from './storageUtils';

/** Bumped when the backup payload changes shape. 2 = amounts in integer cents. */
const EXPORT_FORMAT_VERSION = 2;

const BUDGETS_STORAGE_KEY = STORAGE_KEYS.budgets;

export interface DatabaseExportData {
	formatVersion?: number;
	transactions: Transaction[];
	categories: Category[];
	recurringTransactions: RecurringTransaction[];
	/** Monthly budgets, which live in AsyncStorage rather than SQLite. */
	budgets?: unknown[];
	exportDate: string;
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

/**
 * Quotes a CSV field whenever it could otherwise break the row.
 *
 * The previous exporter interpolated values raw, and wrote dates as "July 22, 2026" —
 * a value containing a comma. Every row shifted a column when opened in a spreadsheet.
 */
const csvField = (value: string | number): string => {
	const text = String(value ?? '');
	return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const csvRow = (fields: Array<string | number>): string => fields.map(csvField).join(',');

/** Amounts are written as plain decimals so spreadsheets can compute on them. */
const csvAmount = (amountCents: number): string => centsToMajorUnits(amountCents).toFixed(2);

const categoryNameOf = (categories: Category[], id: string): string =>
	categories.find((c) => c.id === id)?.name ?? 'Unknown';

export const transactionsToCSV = (transactions: Transaction[], categories: Category[]): string => {
	const lines = [csvRow(['Date', 'Type', 'Category', 'Amount', 'Note'])];

	for (const transaction of transactions) {
		lines.push(
			csvRow([
				// ISO dates sort correctly and never contain a separator.
				transaction.date,
				transaction.isIncome ? 'Income' : 'Expense',
				categoryNameOf(categories, transaction.category),
				csvAmount(transaction.amountCents),
				transaction.note ?? '',
			])
		);
	}

	return lines.join('\n');
};

/**
 * Builds the full report.
 *
 * Each section states its own scope. The monthly summary covers the whole year while
 * the category and transaction sections cover the selected period — the previous
 * version mixed the two under one period-named file with no indication of which was which.
 */
export const generateFinancialReport = async (
	transactions: Transaction[],
	categories: Category[],
	monthlyData: {
		expenses: { month: number; totalCents: number }[];
		incomes: { month: number; totalCents: number }[];
	},
	categoryTotals: {
		expenses: { categoryId: string; totalCents: number }[];
		incomes: { categoryId: string; totalCents: number }[];
	},
	periodName: string,
	year: number
): Promise<string> => {
	const lines: string[] = [];

	lines.push('SPENDR FINANCIAL REPORT');
	lines.push(csvRow(['Generated on', todayISO()]));
	lines.push(csvRow(['Period', periodName]));
	lines.push('');

	lines.push(`MONTHLY SUMMARY — full year ${year}`);
	lines.push(csvRow(['Month', 'Income', 'Expense', 'Net']));

	const months = new Set<number>([
		...monthlyData.expenses.map((e) => e.month),
		...monthlyData.incomes.map((i) => i.month),
	]);

	for (const month of Array.from(months).sort((a, b) => a - b)) {
		const income = monthlyData.incomes.find((i) => i.month === month)?.totalCents ?? 0;
		const expense = monthlyData.expenses.find((e) => e.month === month)?.totalCents ?? 0;

		lines.push(
			csvRow([
				getMonthName(month),
				csvAmount(income),
				csvAmount(expense),
				csvAmount(income - expense),
			])
		);
	}

	lines.push('');

	const appendCategorySection = (
		heading: string,
		totals: { categoryId: string; totalCents: number }[]
	) => {
		lines.push(`${heading} — ${periodName}`);
		lines.push(csvRow(['Category', 'Amount', 'Percentage']));

		const sectionTotal = totals.reduce((sum, item) => sum + item.totalCents, 0);

		for (const item of totals) {
			const percentage = sectionTotal > 0 ? (item.totalCents / sectionTotal) * 100 : 0;
			lines.push(
				csvRow([
					categoryNameOf(categories, item.categoryId),
					csvAmount(item.totalCents),
					`${percentage.toFixed(2)}%`,
				])
			);
		}

		lines.push('');
	};

	appendCategorySection('EXPENSE CATEGORIES', categoryTotals.expenses);
	appendCategorySection('INCOME CATEGORIES', categoryTotals.incomes);

	lines.push(`TRANSACTIONS — ${periodName}`);
	lines.push(csvRow(['Date', 'Type', 'Category', 'Amount', 'Note']));

	for (const transaction of [...transactions].sort((a, b) => a.date.localeCompare(b.date))) {
		lines.push(
			csvRow([
				transaction.date,
				transaction.isIncome ? 'Income' : 'Expense',
				categoryNameOf(categories, transaction.category),
				csvAmount(transaction.amountCents),
				transaction.note ?? '',
			])
		);
	}

	return lines.join('\n');
};

// ---------------------------------------------------------------------------
// File output
// ---------------------------------------------------------------------------

const shareFile = async (fileName: string, content: string, mimeType: string, title: string) => {
	const file = new File(Paths.document, fileName);
	file.write(content);

	await Sharing.shareAsync(file.uri, {
		mimeType,
		dialogTitle: title,
		UTI: mimeType === 'application/json' ? 'public.json' : 'public.comma-separated-values-text',
	});
};

const timestamp = (): string => todayISO().replace(/-/g, '');

export const exportToCSV = async (
	transactions: Transaction[],
	categories: Category[],
	fileName = 'spendr_export'
): Promise<void> => {
	try {
		const finalFileName = fileName.endsWith('.csv') ? fileName : `${fileName}.csv`;
		await shareFile(
			finalFileName,
			transactionsToCSV(transactions, categories),
			'text/csv',
			'Export Transactions'
		);
	} catch (error) {
		console.error('Error exporting to CSV:', error);
		Alert.alert('Export Failed', 'There was an error exporting your data. Please try again.');
		throw error;
	}
};

export const exportPeriodData = async (
	transactions: Transaction[],
	categories: Category[],
	periodName: string
): Promise<void> => {
	const fileName = `spendr_${periodName.toLowerCase().replace(/\s+/g, '_')}_${timestamp()}.csv`;
	await exportToCSV(transactions, categories, fileName);
};

export const exportFinancialReport = async (
	transactions: Transaction[],
	categories: Category[],
	monthlyData: {
		expenses: { month: number; totalCents: number }[];
		incomes: { month: number; totalCents: number }[];
	},
	categoryTotals: {
		expenses: { categoryId: string; totalCents: number }[];
		incomes: { categoryId: string; totalCents: number }[];
	},
	periodName: string,
	year: number
): Promise<void> => {
	try {
		const fileName = `spendr_report_${periodName.toLowerCase().replace(/\s+/g, '_')}_${timestamp()}.csv`;
		const reportContent = await generateFinancialReport(
			transactions,
			categories,
			monthlyData,
			categoryTotals,
			periodName,
			year
		);

		await shareFile(fileName, reportContent, 'text/csv', 'Share Financial Report');
	} catch (error) {
		console.error('Error exporting financial report:', error);
		Alert.alert(
			'Export Failed',
			'There was an error exporting your financial report. Please try again.'
		);
		throw error;
	}
};

// ---------------------------------------------------------------------------
// Backup and restore
// ---------------------------------------------------------------------------

/**
 * Writes a complete backup.
 *
 * Budgets are included: they live in AsyncStorage rather than SQLite, and were
 * previously left out entirely — restoring a backup silently discarded them.
 */
export const exportDatabaseData = async (
	transactions: Transaction[],
	categories: Category[],
	recurringTransactions: RecurringTransaction[]
): Promise<void> => {
	try {
		const storedBudgets = await AsyncStorage.getItem(BUDGETS_STORAGE_KEY);

		const exportData: DatabaseExportData = {
			formatVersion: EXPORT_FORMAT_VERSION,
			transactions,
			categories,
			recurringTransactions,
			budgets: storedBudgets ? JSON.parse(storedBudgets) : [],
			exportDate: new Date().toISOString(),
		};

		const fileName = `spendr_backup_${timestamp()}.json`;
		await shareFile(
			fileName,
			JSON.stringify(exportData, null, 2),
			'application/json',
			'Share app data backup'
		);

		Alert.alert(
			'Export Successful',
			'Your data has been exported successfully. You can save this file for backup purposes.'
		);
	} catch (error) {
		console.error('Error exporting database data:', error);
		Alert.alert('Export Failed', 'There was an error exporting your data. Please try again.');
		throw error;
	}
};

/** Reads an amount from a backup entry, accepting both cents and legacy float formats. */
const readAmountCents = (entry: { amountCents?: number; amount?: number }): number => {
	if (typeof entry.amountCents === 'number') return entry.amountCents;
	if (typeof entry.amount === 'number') return majorUnitsToCents(entry.amount);
	return 0;
};

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
		const result = await DocumentPicker.getDocumentAsync({
			type: 'application/json',
			copyToCacheDirectory: true,
		});

		if (result.canceled) {
			return { success: false, message: 'Import canceled.' };
		}

		const fileUri = result.assets?.[0]?.uri;
		if (!fileUri) {
			return { success: false, message: 'Could not access the selected file.' };
		}

		const importData = JSON.parse(await new File(fileUri).text()) as DatabaseExportData;

		if (!validateImportData(importData)) {
			return {
				success: false,
				message: 'The selected file does not contain valid Spendr backup data.',
			};
		}

		await resetDatabase();

		// Categories first: transactions reference them, and a restore that skipped them
		// left every imported transaction pointing at an id that no longer existed.
		const existingIds = new Set((await getCategories()).map((c) => c.id));

		for (const category of importData.categories) {
			if (existingIds.has(category.id)) continue;
			await addCategory(category);
			existingIds.add(category.id);
		}

		for (const transaction of importData.transactions) {
			await addTransaction({
				amountCents: readAmountCents(transaction),
				category: existingIds.has(transaction.category) ? transaction.category : 'uncategorized',
				date: transaction.date,
				note: transaction.note,
				isIncome: transaction.isIncome,
			});
		}

		for (const recurring of importData.recurringTransactions) {
			const { id: _id, lastProcessed: _lp, nextDue: _nd, ...rule } = recurring;
			await addRecurringTransaction({
				...rule,
				amountCents: readAmountCents(recurring),
				category: existingIds.has(recurring.category) ? recurring.category : 'uncategorized',
			});
		}

		if (Array.isArray(importData.budgets)) {
			await AsyncStorage.setItem(BUDGETS_STORAGE_KEY, JSON.stringify(importData.budgets));
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

// biome-ignore lint/suspicious/noExplicitAny: validating untrusted JSON from disk
const validateImportData = (data: any): data is DatabaseExportData => {
	if (!data || typeof data !== 'object') return false;

	if (
		!Array.isArray(data.transactions) ||
		!Array.isArray(data.categories) ||
		!Array.isArray(data.recurringTransactions) ||
		typeof data.exportDate !== 'string'
	) {
		return false;
	}

	if (data.transactions.length > 0) {
		const sample = data.transactions[0];
		const hasAmount = typeof sample.amountCents === 'number' || typeof sample.amount === 'number';

		if (
			typeof sample.id !== 'string' ||
			!hasAmount ||
			typeof sample.category !== 'string' ||
			typeof sample.date !== 'string' ||
			typeof sample.isIncome !== 'boolean'
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
