import i18next from 'i18next';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Alert } from 'react-native';
import {
	getAllCaptures,
	getMerchantRules,
	restoreCapture,
	restoreMerchantRule,
} from '../database/captures';
import {
	getBudgets,
	getCategoriesForBackup,
	resetDatabase,
	restoreBudget,
	restoreCategory,
	setBudget,
} from '../database/database';
import {
	getAccounts,
	getBills,
	getDebts,
	getRecurringTransactions,
	getReserveGoal,
	getRetirementGoal,
	getTransactions,
	getTransfers,
	restoreAccount,
	restoreBill,
	restoreDebt,
	restoreRecurringTransaction,
	restoreTransaction,
	restoreTransfer,
	type ReserveGoalDraft,
	type RetirementGoalDraft,
	setReserveGoal,
	setRetirementGoal,
} from '../database/database';
import type {
	Account,
	Bill,
	Capture,
	Category,
	Debt,
	MerchantRule,
	RecurringTransaction,
	Transaction,
	Transfer,
} from '../database/schema';
import * as syncQueue from '../sync/queue';
import { getMonthName, todayISO } from './dateUtils';
import { centsToMajorUnits, majorUnitsToCents } from './money';
import { exportPreferences, importPreferences } from './storageUtils';

/**
 * Bumped when the backup payload changes shape. 2 = amounts in integer cents; 3 = o id
 * de cada linha viaja no arquivo (lançamentos, recorrências, dívidas e orçamentos),
 * para que importar o mesmo backup em dois aparelhos não duplique o livro; 4 = o backup
 * passa a levar **tudo que é dado do usuário**: a caixa de entrada (`captures`), as
 * regras aprendidas (`merchant_rules`), as preferências do AsyncStorage e as categorias
 * que a tela esconde (a `uncategorized` e as apagadas); 5 = as contas a pagar (`bills`,
 * banco v20).
 *
 * Ninguém decide nada pelo número: a leitura aceita todas as formas campo a campo. Ele
 * fica no arquivo para quem precisar olhar um backup antigo e entender o que falta nele.
 *
 * As coleções do v4 são **acréscimos**: `transactions`, `categories`,
 * `recurringTransactions` e `exportDate` continuam no mesmo lugar e no mesmo formato,
 * que é tudo que a validação de um app antigo exige. Um arquivo v4 entra numa 1.2.7
 * sem explodir — ela simplesmente ignora as chaves que não conhece.
 */
const EXPORT_FORMAT_VERSION = 5;

/** A budget as it travels in a backup file, in either the current or the legacy shape. */
interface ExportedBudget {
	year: number;
	month: number;
	amountCents?: number;
	/** Backups written before budgets moved to integer cents. */
	amount?: number;
	/**
	 * O id da linha. Ausente em backups escritos antes da 1.2.7, que não o levavam: sem
	 * ele, dois aparelhos importando o mesmo arquivo criavam dois orçamentos do mesmo mês.
	 */
	id?: string;
}

export interface DatabaseExportData {
	formatVersion?: number;
	transactions: Transaction[];
	categories: Category[];
	recurringTransactions: RecurringTransaction[];
	budgets?: ExportedBudget[];
	/** Contas, cartões e transferências (v7). Ausentes em backups anteriores. */
	accounts?: Account[];
	transfers?: Transfer[];
	/** Dívidas e as metas (1.1+). Ausentes em backups anteriores. */
	debts?: Debt[];
	/** Contas a pagar (v5). Ausentes em backups anteriores. */
	bills?: Bill[];
	retirementGoal?: RetirementGoalDraft | null;
	reserveGoal?: ReserveGoalDraft | null;
	/**
	 * A caixa de entrada e as regras aprendidas (v4). Ausentes em backups anteriores —
	 * e foi essa ausência que custou duas semanas de compras de outubro de 2026, que
	 * estavam pendentes de revisão quando o app foi reinstalado.
	 */
	captures?: Capture[];
	merchantRules?: MerchantRule[];
	/**
	 * As preferências do AsyncStorage (v4): moeda, idioma, taxa do CDI, avisos
	 * dispensados. Valores crus, como o AsyncStorage os guarda. A lista do que viaja
	 * está em `BACKED_UP_PREFERENCE_KEYS` (`utils/storageUtils.ts`).
	 */
	preferences?: Record<string, string>;
	/**
	 * As coleções que **falharam** ao ser lidas na hora de exportar (v4).
	 *
	 * Um backup incompleto que parece completo é a pior falha possível deste arquivo:
	 * o usuário desinstala o app confiando nele. Quando esta chave existe, o arquivo
	 * não é a foto inteira, e a importação diz isso em voz alta.
	 */
	incomplete?: string[];
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

	// Lê de volta antes de compartilhar. Uma escrita truncada (disco cheio, processo
	// morto no meio) produz um arquivo que abre, tem JSON válido até onde foi e parece
	// um backup — e o usuário só descobre o que falta depois de reinstalar o app. Vale
	// a releitura: um backup de anos de uso tem alguns megabytes.
	const written = await file.text();
	if (written.length !== content.length) {
		throw new Error(
			`O arquivo saiu incompleto: ${written.length} de ${content.length} caracteres gravados.`
		);
	}

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
		Alert.alert(i18next.t('settings.exportFailed'), i18next.t('settings.exportError'));
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
		Alert.alert(i18next.t('settings.exportFailed'), i18next.t('settings.exportErrorReport'));
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
 *
 * **Lê o banco aqui dentro, e não o que a tela tem na mão.** A versão anterior recebia
 * `transactions`, `categories` e `recurringTransactions` do estado do
 * `SettingsScreen`: se a carga do contexto tivesse falhado, ou se o usuário tocasse em
 * "exportar" antes dela terminar, o arquivo saía com as listas vazias — um backup
 * perfeitamente válido e sem nada dentro, com o aviso de sucesso na tela.
 */
export const exportDatabaseData = async (): Promise<void> => {
	try {
		// O que falhou ao ser lido. Uma coleção que não abre não pode cancelar o backup
		// das outras (seria perder tudo por causa de uma parte), mas também não pode
		// passar calada: ela vai nomeada no arquivo e no aviso da tela.
		const incomplete: string[] = [];
		const safely = async <T>(name: string, read: () => Promise<T>, fallback: T): Promise<T> => {
			try {
				return await read();
			} catch (error) {
				console.error(`Error exporting ${name}:`, error);
				incomplete.push(name);
				return fallback;
			}
		};

		// O livro-caixa e as categorias não têm plano B: sem eles não existe backup, e
		// um arquivo vazio é pior que nenhum arquivo. Falhar aqui aborta a exportação.
		const [transactions, categories] = await Promise.all([
			getTransactions(),
			getCategoriesForBackup(),
		]);

		// Budgets moved from AsyncStorage into SQLite in schema v4; só o id, o ano, o mês
		// e o valor vão no backup — o resto (`dirty`, carimbos) é de cada aparelho.
		const budgets = (
			await safely('budgets', getBudgets, [] as Awaited<ReturnType<typeof getBudgets>>)
		).map(({ id, year, month, amountCents }) => ({ id, year, month, amountCents }));

		const [recurringTransactions, accounts, transfers, debts, bills, retirement, reserve] =
			await Promise.all([
				safely('recurringTransactions', getRecurringTransactions, [] as RecurringTransaction[]),
				safely('accounts', getAccounts, [] as Account[]),
				safely('transfers', getTransfers, [] as Transfer[]),
				safely('debts', getDebts, [] as Debt[]),
				safely('bills', getBills, [] as Bill[]),
				safely('retirementGoal', getRetirementGoal, null),
				safely('reserveGoal', getReserveGoal, null),
			]);

		// A caixa de entrada, as regras aprendidas e as preferências: o que a 1.2.7 ainda
		// deixava no aparelho. Ver o comentário em `getAllCaptures`.
		const [captures, merchantRules, preferences] = await Promise.all([
			safely('captures', getAllCaptures, [] as Capture[]),
			safely('merchantRules', getMerchantRules, [] as MerchantRule[]),
			safely('preferences', exportPreferences, {} as Record<string, string>),
		]);

		const exportData: DatabaseExportData = {
			formatVersion: EXPORT_FORMAT_VERSION,
			transactions,
			categories,
			recurringTransactions,
			budgets,
			accounts,
			transfers,
			debts,
			bills,
			// As metas vão sem o id fixo e sem a contabilidade do sync: só o que o usuário escolheu.
			retirementGoal: retirement
				? {
						targetMonthlyCents: retirement.targetMonthlyCents,
						reinvestBp: retirement.reinvestBp,
						expectedYieldBp: retirement.expectedYieldBp,
						outsideCapitalCents: retirement.outsideCapitalCents,
					}
				: null,
			reserveGoal: reserve ? { targetMonths: reserve.targetMonths, customMonthlyCostCents: reserve.customMonthlyCostCents } : null,
			captures,
			merchantRules,
			preferences,
			...(incomplete.length > 0 ? { incomplete } : {}),
			exportDate: new Date().toISOString(),
		};

		const fileName = `spendr_backup_${timestamp()}.json`;
		await shareFile(
			fileName,
			JSON.stringify(exportData, null, 2),
			'application/json',
			'Share app data backup'
		);

		// O aviso diz o que entrou, linha por linha. É a única chance do usuário de
		// perceber que o arquivo está menor do que a vida dele antes de desinstalar o app.
		const summary = i18next.t('settings.exportSummary', {
			transactions: transactions.length,
			categories: categories.length,
			accounts: accounts.length,
			transfers: transfers.length,
			recurring: recurringTransactions.length,
			budgets: budgets.length,
			debts: debts.length,
			captures: captures.length,
			rules: merchantRules.length,
		});

		if (incomplete.length > 0) {
			Alert.alert(
				i18next.t('settings.exportIncompleteTitle'),
				i18next.t('settings.exportIncompleteMsg', { missing: incomplete.join(', '), summary })
			);
			return;
		}

		Alert.alert(i18next.t('settings.exportSuccess'), i18next.t('settings.exportSuccessMsg', { summary }));
	} catch (error) {
		console.error('Error exporting database data:', error);
		Alert.alert(
			i18next.t('settings.exportFailed'),
			i18next.t('settings.exportErrorDetail', {
				reason: error instanceof Error ? error.message : i18next.t('settings.exportErrorUnknown'),
			})
		);
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
	/**
	 * O que não voltou inteiro: coleções que o próprio arquivo já marcava como
	 * incompletas e linhas que não entraram. Vazio quando a restauração foi limpa — e é
	 * só nesse caso que a tela pode dizer "importado com sucesso" e ponto.
	 */
	warnings?: string[];
	stats?: {
		transactions: number;
		categories: number;
		recurringTransactions: number;
		captures: number;
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

		/**
		 * O que não entrou. A importação começa apagando o banco, então desistir na
		 * primeira linha problemática deixaria o usuário sem o backup **e** sem o que
		 * ele tinha. Cada linha que falha é contada e nomeada no fim; o resto entra.
		 */
		const failures: string[] = [];
		const restoreEach = async <T>(
			label: string,
			rows: T[],
			write: (row: T) => Promise<unknown>
		): Promise<number> => {
			let failed = 0;
			for (const row of rows) {
				try {
					await write(row);
				} catch (error) {
					failed += 1;
					console.error(`Error importing ${label}:`, error);
				}
			}
			if (failed > 0) failures.push(`${failed} ${label}`);
			return rows.length - failed;
		};

		const asArray = <T>(value: T[] | undefined): T[] => (Array.isArray(value) ? value : []);

		// Categories first: transactions reference them, and a restore that skipped them
		// left every imported transaction pointing at an id that no longer existed. A
		// leitura é a do backup (`getCategoriesForBackup`) e não a da tela: a lista da
		// tela esconde a `uncategorized`, que é justamente o destino de todo lançamento
		// cuja categoria não veio no arquivo — e a lápide também conta como linha
		// existente, porque é dela que a chave estrangeira depende.
		const existingIds = new Set((await getCategoriesForBackup()).map((c) => c.id));

		// Uma categoria que já existe aqui (as padrão, num app novo) recebe o que o backup
		// diz: nome, cor e, principalmente, a natureza que o usuário ajustou. Antes ela era
		// pulada, e o essencial/repasse de uma categoria padrão se perdia na restauração.
		//
		// Backups escritos antes da tag necessidade/desejo não trazem `nature`, e a coluna
		// é NOT NULL. O padrão é o mesmo da migração: supérfluo até que o usuário diga o
		// contrário.
		//
		// O id original é preservado de propósito: os lançamentos e recorrências do backup
		// referenciam esse id. Antes, `addCategory` gerava um id novo e toda transação numa
		// categoria criada pelo usuário ficava apontando para o vazio — aparecia como
		// "Unknown" nos relatórios e sumia dos totais por categoria.
		const importedCategories = await restoreEach(
			'categories',
			importData.categories,
			async (category) => {
				const { id, updatedAt: _updatedAt, deletedAt, ...draft } = category;
				await restoreCategory(
					{ ...draft, nature: category.nature ?? 'discretionary', deletedAt },
					id
				);
				existingIds.add(id);
			}
		);

		// Contas antes dos lançamentos, com o id original: é por ele que `accountId` e as
		// transferências do backup as encontram. Backups anteriores ao v7 não as trazem.
		const accountIds = new Set<string>();
		await restoreEach('accounts', asArray(importData.accounts), async (account) => {
			const { id, updatedAt: _updatedAt, deletedAt: _deletedAt, ...draft } = account;
			await restoreAccount(draft, id);
			accountIds.add(id);
		});

		// Com o id do arquivo, e não um novo. Importar o mesmo backup em dois aparelhos
		// deixava duas gerações do mesmo lançamento vivas na mesma conta — o livro-caixa
		// dobrava, e nada no sync tinha como perceber que era a mesma compra. `cardLast4`
		// vai junto: sem ele, a importação perdia de qual cartão saiu cada compra.
		const importedTransactions = await restoreEach(
			'transactions',
			importData.transactions,
			(transaction) =>
				restoreTransaction(
					{
						amountCents: readAmountCents(transaction),
						category: existingIds.has(transaction.category) ? transaction.category : 'uncategorized',
						date: transaction.date,
						note: transaction.note,
						isIncome: transaction.isIncome,
						accountId: transaction.accountId && accountIds.has(transaction.accountId) ? transaction.accountId : null,
						installmentGroup: transaction.installmentGroup ?? null,
						installmentIndex: transaction.installmentIndex ?? null,
						installmentCount: transaction.installmentCount ?? null,
						cardLast4: transaction.cardLast4 ?? null,
					},
					transaction.id
				)
		);

		await restoreEach('transfers', asArray(importData.transfers), (transfer) => {
			const { id, updatedAt: _updatedAt, deletedAt: _deletedAt, ...draft } = transfer;
			return restoreTransfer(
				{
					...draft,
					fromAccountId: draft.fromAccountId && accountIds.has(draft.fromAccountId) ? draft.fromAccountId : null,
					toAccountId: draft.toAccountId && accountIds.has(draft.toAccountId) ? draft.toAccountId : null,
				},
				id
			);
		});

		// Id, `lastProcessed` e `nextDue` do arquivo. Sem eles a regra renascia como nova:
		// id diferente em cada aparelho, e o relógio recomeçando — a assinatura que já
		// tinha sido lançada no mês vinha outra vez.
		const importedRecurring = await restoreEach(
			'recurringTransactions',
			importData.recurringTransactions,
			(recurring) =>
				restoreRecurringTransaction(
					{
						...recurring,
						amountCents: readAmountCents(recurring),
						category: existingIds.has(recurring.category) ? recurring.category : 'uncategorized',
					},
					recurring.id
				)
		);

		// Dívidas e metas: backups anteriores à 1.1 não as trazem. O id também é o do
		// arquivo. A conta de onde a parcela sai só vale se veio no mesmo backup.
		const debtIds = new Set<string>();
		await restoreEach('debts', asArray(importData.debts), async (debt) => {
			const { id, updatedAt: _updatedAt, deletedAt: _deletedAt, ...draft } = debt;
			await restoreDebt(
				{
					...draft,
					feeCents: draft.feeCents ?? 0,
					accountId: draft.accountId && accountIds.has(draft.accountId) ? draft.accountId : null,
				},
				id
			);
			debtIds.add(id);
		});

		// Contas a pagar depois das dívidas, com o id do arquivo e o mês pago intacto.
		// Backups anteriores ao v5 não as trazem. A conta de onde sai e a dívida de origem,
		// como nas dívidas, só valem se vieram no mesmo arquivo.
		await restoreEach('bills', asArray(importData.bills), (bill) => {
			const { id, updatedAt: _updatedAt, deletedAt: _deletedAt, ...draft } = bill;
			return restoreBill(
				{
					...draft,
					amountCents: typeof draft.amountCents === 'number' ? draft.amountCents : null,
					accountId: draft.accountId && accountIds.has(draft.accountId) ? draft.accountId : null,
					debtId: draft.debtId && debtIds.has(draft.debtId) ? draft.debtId : null,
				},
				id
			);
		});
		if (importData.retirementGoal) await setRetirementGoal(importData.retirementGoal);
		if (importData.reserveGoal) await setReserveGoal(importData.reserveGoal);

		await restoreEach('budgets', asArray(importData.budgets), async (budget) => {
			if (!Number.isFinite(budget?.year) || !Number.isFinite(budget?.month)) return;
			// Backup anterior à 1.2.7 não trazia o id; aí o mês recebe uma linha nova,
			// como antes.
			if (typeof budget.id === 'string' && budget.id.length > 0) {
				await restoreBudget(budget.year, budget.month, readAmountCents(budget), budget.id);
			} else {
				await setBudget(budget.year, budget.month, readAmountCents(budget));
			}
		});

		// A caixa de entrada depois do livro: uma captura confirmada guarda o
		// `transactionId` que ela criou, e a de troca de bolso o `transferId` — os dois
		// voltaram acima com o id do arquivo, então os ponteiros continuam válidos.
		// Backups anteriores ao v4 não trazem nada disto.
		const importedCaptures = await restoreEach(
			'captures',
			asArray(importData.captures),
			restoreCapture
		);
		await restoreEach('merchantRules', asArray(importData.merchantRules), restoreMerchantRule);

		// Moeda, idioma, taxa do CDI, avisos dispensados. Só as chaves conhecidas entram
		// (ver `importPreferences`).
		try {
			await importPreferences(importData.preferences);
		} catch (error) {
			console.error('Error importing preferences:', error);
			failures.push('preferences');
		}

		// As telas releem o banco: contas, orçamento e metas também mudaram.
		syncQueue.notifyDataChanged();

		// O que o arquivo já avisava que não tinha, mais o que não entrou agora. O
		// usuário precisa ouvir os dois: "importado com sucesso" sobre um arquivo
		// incompleto é a mesma mentira que custou outubro de 2026.
		const notes = [
			...(Array.isArray(importData.incomplete) && importData.incomplete.length > 0
				? [`The backup file itself was incomplete: ${importData.incomplete.join(', ')}.`]
				: []),
			...(failures.length > 0 ? [`Could not restore: ${failures.join(', ')}.`] : []),
		];

		return {
			success: true,
			message:
				notes.length > 0
					? `Data imported with warnings. ${notes.join(' ')}`
					: 'Data imported successfully.',
			warnings: notes,
			stats: {
				transactions: importedTransactions,
				categories: importedCategories,
				recurringTransactions: importedRecurring,
				captures: importedCaptures,
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
