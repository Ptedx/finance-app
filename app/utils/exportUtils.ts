import i18next from 'i18next';
import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
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

/**
 * Escreve e lê de volta. Uma escrita truncada (disco cheio, processo morto no meio)
 * produz um arquivo que abre, tem JSON válido até onde foi e parece um backup — e o
 * usuário só descobre o que falta depois de reinstalar o app. Vale a releitura: um
 * backup de anos de uso tem alguns megabytes.
 */
const writeVerified = async (file: File, content: string): Promise<void> => {
	file.write(content);
	const written = await file.text();
	if (written.length !== content.length) {
		throw new Error(
			`O arquivo saiu incompleto: ${written.length} de ${content.length} caracteres gravados.`
		);
	}
};

/** Grava dentro do app (`files/`), confere e devolve o arquivo. */
const writeAppFile = async (fileName: string, content: string): Promise<File> => {
	const file = new File(Paths.document, fileName);
	await writeVerified(file, content);
	return file;
};

const shareAppFile = (file: File, mimeType: string, title: string): Promise<void> =>
	Sharing.shareAsync(file.uri, {
		mimeType,
		dialogTitle: title,
		UTI: mimeType === 'application/json' ? 'public.json' : 'public.comma-separated-values-text',
	});

const shareFile = async (fileName: string, content: string, mimeType: string, title: string) => {
	await shareAppFile(await writeAppFile(fileName, content), mimeType, title);
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

/** O que um resumo de backup conta, na ordem em que aparece (`settings.backupItem`). */
type BackupItem =
	| 'transactions'
	| 'categories'
	| 'accounts'
	| 'cards'
	| 'transfers'
	| 'debts'
	| 'bills'
	| 'budgets'
	| 'captures'
	| 'rules'
	| 'recurring';

/**
 * "1 lançamento, 5 contas, 1 cartão, 1 orçamento": o que entrou ou voltou, com o plural de
 * cada idioma (`_one`/`_other`). O que tem zero fica de fora — "0 recorrências" falava de
 * uma tela que nem existe mais (SPD-079), e "1 orçamentos" era o plural de antes.
 */
const backupSummary = (counts: Partial<Record<BackupItem, number>>): string => {
	const parts = (Object.entries(counts) as Array<[BackupItem, number]>)
		.filter(([, count]) => count > 0)
		.map(([item, count]) => i18next.t(`settings.backupItem.${item}`, { count }));
	return parts.length > 0 ? parts.join(', ') : i18next.t('settings.backupItemNone');
};

/** Contas e cartões contados à parte, como o app os mostra. */
const isCard = (account: Pick<Account, 'kind'>): boolean => account.kind === 'credit_card';

/**
 * O nome de uma coleção que não foi lida inteira (`incomplete`), na língua do usuário. Um
 * arquivo de outra versão pode trazer um nome que esta não conhece: aí vai como veio.
 */
const backupPartNames = (names: string[]): string =>
	names.map((name) => i18next.t(`settings.backupPart.${name}`, { defaultValue: name })).join(', ');

type BackupDestination = 'files' | 'share' | 'cancel';

/**
 * Pergunta para onde vai o backup (E2E-35).
 *
 * Só compartilhar não basta: no Android o `shareAsync` resolve igual quando o usuário
 * escolhe um destino e quando fecha a folha sem escolher (o `expo-sharing` devolve `null`
 * no `onActivityResult`, sem olhar o resultado). O app dizia "Backup salvo" nos dois
 * casos, e no segundo o arquivo só existia dentro do app — some com ele. "Salvar em
 * Arquivos" usa o seletor de pasta do sistema (`Directory.pickDirectoryAsync`, do
 * `expo-file-system` que o app já tem), que diz quando o usuário desistiu.
 */
const askBackupDestination = (title: string, message: string): Promise<BackupDestination> =>
	new Promise((resolve) => {
		Alert.alert(
			title,
			message,
			[
				{ text: i18next.t('settings.cancel'), style: 'cancel', onPress: () => resolve('cancel') },
				{ text: i18next.t('settings.exportShareAction'), onPress: () => resolve('share') },
				{ text: i18next.t('settings.exportSaveToFiles'), onPress: () => resolve('files') },
			],
			{ cancelable: true, onDismiss: () => resolve('cancel') }
		);
	});

/**
 * Grava o backup numa pasta que o usuário escolhe, conferindo como o arquivo de dentro do
 * app. Devolve o nome gravado, ou `null` se ele fechou o seletor sem escolher — o sistema
 * recusa a promessa nesse caso, e qualquer recusa do seletor quer dizer o mesmo para o
 * usuário: nada foi guardado fora do app. Já uma falha ao gravar na pasta escolhida sobe,
 * e vira "falha ao exportar".
 */
const saveToPickedFolder = async (fileName: string, content: string, mimeType: string): Promise<string | null> => {
	let folder: Directory;
	try {
		folder = await Directory.pickDirectoryAsync();
	} catch (error) {
		console.warn('Backup: nenhuma pasta escolhida:', error);
		return null;
	}
	const file = folder.createFile(fileName, mimeType);
	await writeVerified(file, content);
	return file.name || fileName;
};

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
		const content = JSON.stringify(exportData, null, 2);
		// Primeiro dentro do app, conferido: é dele que sai o compartilhar, e um arquivo
		// truncado não chega a ser oferecido.
		const appFile = await writeAppFile(fileName, content);

		// O aviso diz o que entrou, linha por linha. É a única chance do usuário de
		// perceber que o arquivo está menor do que a vida dele antes de desinstalar o app.
		const summary = backupSummary({
			transactions: transactions.length,
			categories: categories.length,
			accounts: accounts.filter((account) => !isCard(account)).length,
			cards: accounts.filter(isCard).length,
			transfers: transfers.length,
			debts: debts.length,
			bills: bills.length,
			budgets: budgets.length,
			captures: captures.length,
			rules: merchantRules.length,
		});

		// Nada aqui diz "salvo" antes de ser verdade: o arquivo dentro do app some com ele.
		const destination =
			incomplete.length > 0
				? await askBackupDestination(
						i18next.t('settings.exportIncompleteTitle'),
						i18next.t('settings.exportIncompleteMsg', { missing: backupPartNames(incomplete), summary })
					)
				: await askBackupDestination(
						i18next.t('settings.exportChooseTitle'),
						i18next.t('settings.exportChooseMsg', { summary })
					);

		if (destination === 'cancel') return;

		if (destination === 'share') {
			await shareAppFile(appFile, 'application/json', i18next.t('settings.exportChooseTitle'));
			// O Android não diz se o usuário escolheu um destino ou fechou a folha.
			Alert.alert(i18next.t('settings.exportSharedTitle'), i18next.t('settings.exportSharedMsg'));
			return;
		}

		const savedAs = await saveToPickedFolder(fileName, content, 'application/json');
		if (savedAs === null) {
			Alert.alert(i18next.t('settings.exportNotSavedTitle'), i18next.t('settings.exportNotSavedMsg'));
			return;
		}
		Alert.alert(i18next.t('settings.exportSuccess'), i18next.t('settings.exportSavedMsg', { name: savedAs, summary }));
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

/** O que a restauração deixou para a tela dizer. */
interface RestoreOutcome {
	/** O que voltou, por item do resumo. */
	restored: Partial<Record<BackupItem, number>>;
	/** Linhas que não entraram, por item do resumo. */
	failed: Partial<Record<BackupItem, number>>;
	preferencesFailed: boolean;
	stats: { transactions: number; categories: number; recurringTransactions: number; captures: number };
}

/**
 * Apaga o livro (lápides) e regrava o backup, coleção por coleção.
 *
 * Roda com a fila de sync parada (`importDatabaseData`): ver lá.
 */
const restoreBackup = async (importData: DatabaseExportData): Promise<RestoreOutcome> => {
	await resetDatabase();

	/**
	 * O que não entrou. A importação começa apagando o banco, então desistir na
	 * primeira linha problemática deixaria o usuário sem o backup **e** sem o que
	 * ele tinha. Cada linha que falha é contada e nomeada no fim; o resto entra.
	 */
	const failed: Partial<Record<BackupItem, number>> = {};
	let preferencesFailed = false;
	const restoreEach = async <T>(
		label: string,
		item: BackupItem,
		rows: T[],
		write: (row: T) => Promise<unknown>
	): Promise<number> => {
		let failedHere = 0;
		for (const row of rows) {
			try {
				await write(row);
			} catch (error) {
				failedHere += 1;
				console.error(`Error importing ${label}:`, error);
			}
		}
		if (failedHere > 0) failed[item] = (failed[item] ?? 0) + failedHere;
		return rows.length - failedHere;
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
	let importedCards = 0;
	const importedAccounts = await restoreEach('accounts', 'accounts', asArray(importData.accounts), async (account) => {
		const { id, updatedAt: _updatedAt, deletedAt: _deletedAt, ...draft } = account;
		await restoreAccount(draft, id);
		accountIds.add(id);
		if (isCard(account)) importedCards += 1;
	});

	// Com o id do arquivo, e não um novo. Importar o mesmo backup em dois aparelhos
	// deixava duas gerações do mesmo lançamento vivas na mesma conta — o livro-caixa
	// dobrava, e nada no sync tinha como perceber que era a mesma compra. `cardLast4`
	// vai junto: sem ele, a importação perdia de qual cartão saiu cada compra.
	const importedTransactions = await restoreEach(
		'transactions',
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

	const importedTransfers = await restoreEach('transfers', 'transfers', asArray(importData.transfers), (transfer) => {
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
		'recurring',
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
	const importedDebts = await restoreEach('debts', 'debts', asArray(importData.debts), async (debt) => {
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
	const importedBills = await restoreEach('bills', 'bills', asArray(importData.bills), (bill) => {
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

	// Um orçamento sem ano ou mês não tem onde entrar: fica de fora, e fora da contagem.
	const budgets = asArray(importData.budgets).filter(
		(budget) => Number.isFinite(budget?.year) && Number.isFinite(budget?.month)
	);
	const importedBudgets = await restoreEach('budgets', 'budgets', budgets, async (budget) => {
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
		'captures',
		asArray(importData.captures),
		restoreCapture
	);
	await restoreEach('merchantRules', 'rules', asArray(importData.merchantRules), restoreMerchantRule);

	// Moeda, idioma, taxa do CDI, avisos dispensados. Só as chaves conhecidas entram
	// (ver `importPreferences`).
	try {
		await importPreferences(importData.preferences);
	} catch (error) {
		console.error('Error importing preferences:', error);
		preferencesFailed = true;
	}

	// As telas releem o banco: contas, orçamento e metas também mudaram.
	syncQueue.notifyDataChanged();

	return {
		restored: {
			transactions: importedTransactions,
			accounts: importedAccounts - importedCards,
			cards: importedCards,
			transfers: importedTransfers,
			debts: importedDebts,
			bills: importedBills,
			budgets: importedBudgets,
		},
		failed,
		preferencesFailed,
		stats: {
			transactions: importedTransactions,
			categories: importedCategories,
			recurringTransactions: importedRecurring,
			captures: importedCaptures,
		},
	};
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
			return { success: false, message: i18next.t('settings.importCanceled') };
		}

		const fileUri = result.assets?.[0]?.uri;
		if (!fileUri) {
			return { success: false, message: i18next.t('settings.importNoAccess') };
		}

		const importData = JSON.parse(await new File(fileUri).text()) as DatabaseExportData;

		if (!validateImportData(importData)) {
			return {
				success: false,
				message: i18next.t('settings.importInvalid'),
			};
		}

		// A fila de sync fica parada enquanto o backup é regravado (E2E-35). A volta do
		// seletor de arquivo é a volta ao primeiro plano, e o `AuthContext` pede um sync
		// na hora: a rodada abria a transação dela (`markChangesClean` depois do push,
		// `applyPulledChanges` depois do pull) no meio da importação, e o `BEGIN` de quem
		// viesse depois falhava — no aparelho, o do `restoreBudget`, e o orçamento de
		// novembro não voltou. Pior que isso, cada gravação da importação feita com a
		// transação do sync aberta ia parar dentro dela, e um ROLLBACK do sync a levaria
		// junto. `runExclusive` espera a rodada em curso, não deixa outra começar e, no fim,
		// roda uma — a que sobe o que acabou de ser importado.
		const outcome = await syncQueue.runExclusive(() => restoreBackup(importData));

		// O que o arquivo já avisava que não tinha, mais o que não entrou agora. O
		// usuário precisa ouvir os dois: "importado com sucesso" sobre um arquivo
		// incompleto é a mesma mentira que custou outubro de 2026.
		const failedRows = Object.values(outcome.failed).some((count) => (count ?? 0) > 0);
		const notes = [
			...(Array.isArray(importData.incomplete) && importData.incomplete.length > 0
				? [i18next.t('settings.importFileIncomplete', { missing: backupPartNames(importData.incomplete) })]
				: []),
			...(failedRows ? [i18next.t('settings.importNotRestored', { list: backupSummary(outcome.failed) })] : []),
			...(outcome.preferencesFailed ? [i18next.t('settings.importPreferencesFailed')] : []),
		];

		const done = i18next.t('settings.importDoneMsg', { summary: backupSummary(outcome.restored) });
		return {
			success: true,
			message: notes.length > 0 ? `${done}\n\n${notes.join(' ')}` : done,
			warnings: notes,
			stats: outcome.stats,
		};
	} catch (error) {
		console.error('Error importing database data:', error);
		return {
			success: false,
			message: i18next.t('settings.importFailedDetail', {
				reason: error instanceof Error ? error.message : i18next.t('settings.exportErrorUnknown'),
			}),
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
