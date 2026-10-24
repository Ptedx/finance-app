/**
 * Exportação: o CSV que sai do app tem que somar o mesmo que a tela, e o backup tem
 * que levar tudo que é dado do usuário.
 *
 * O banco e o compartilhamento de arquivo são substituídos por mocks; o "disco" é o
 * `mockFile` abaixo, que guarda o que foi escrito para a leitura de volta.
 */

/** O arquivo escrito. `truncateTo` simula uma escrita que não cabe inteira no disco. */
const mockFile = { written: '', truncateTo: null as number | null };

jest.mock('i18next', () => ({
	__esModule: true,
	default: {
		t: (key: string, values?: Record<string, unknown>) =>
			values
				? [key, ...Object.entries(values).map(([name, value]) => `${name}=${String(value)}`)].join(' ')
				: key,
	},
}));

jest.mock('../../database/database', () => ({
	addCategory: jest.fn(),
	addRecurringTransaction: jest.fn(),
	addTransaction: jest.fn(),
	getAccounts: jest.fn(async () => [{ id: 'conta-inter', name: 'Inter' }]),
	getBudgets: jest.fn(async () => [
		{ id: 'bud-1', year: 2026, month: 10, amountCents: 500_000, dirty: true, updatedAt: 'x' },
	]),
	getCategories: jest.fn(async () => []),
	getCategoriesForBackup: jest.fn(async () => [
		{ id: 'food', name: 'Food', updatedAt: 'x' },
		{ id: 'uncategorized', name: 'Uncategorized', updatedAt: 'x' },
	]),
	getBills: jest.fn(async () => [
		{
			id: 'bill-celular',
			name: 'Celular',
			dueDay: 10,
			amountCents: null,
			accountId: 'conta-inter',
			category: 'phone',
			matchHint: 'tim,claro',
			debtId: null,
			paidThrough: '2026-09',
			paidByRef: 'tx-1',
			active: true,
			sortOrder: 0,
			updatedAt: '2026-10-01T00:00:00.000Z',
		},
	]),
	getDebts: jest.fn(async () => []),
	getRecurringTransactions: jest.fn(async () => []),
	getReserveGoal: jest.fn(async () => null),
	getRetirementGoal: jest.fn(async () => null),
	getTransactions: jest.fn(async () => [{ id: 'tx-1', amountCents: 100, date: '2026-10-06' }]),
	getTransfers: jest.fn(async () => [{ id: 'tr-1', amountCents: 200, date: '2026-10-09' }]),
	resetDatabase: jest.fn(),
	restoreAccount: jest.fn(async () => undefined),
	restoreBill: jest.fn(async () => undefined),
	restoreBudget: jest.fn(async () => undefined),
	restoreCategory: jest.fn(async () => undefined),
	restoreDebt: jest.fn(async () => undefined),
	restoreRecurringTransaction: jest.fn(async () => undefined),
	restoreTransaction: jest.fn(async () => undefined),
	restoreTransfer: jest.fn(async () => undefined),
	setBudget: jest.fn(),
	setReserveGoal: jest.fn(async () => undefined),
	setRetirementGoal: jest.fn(async () => undefined),
}));

jest.mock('../../database/captures', () => ({
	getAllCaptures: jest.fn(async () => [{ id: 'cap-1', status: 'pending', amountCents: 5_000 }]),
	getMerchantRules: jest.fn(async () => [{ merchantKey: 'padaria', confirmations: 4 }]),
	restoreCapture: jest.fn(async () => undefined),
	restoreMerchantRule: jest.fn(async () => undefined),
}));

jest.mock('../../sync/queue', () => ({ notifyDataChanged: jest.fn(), schedule: jest.fn() }));

jest.mock('@react-native-async-storage/async-storage', () => ({
	getItem: jest.fn(async () => null),
	multiGet: jest.fn(async () => [
		['selectedCurrency', '{"code":"BRL"}'],
		['cdiRate', '{"annualBp":1490}'],
		['captureAccessDismissed', null],
	]),
	multiSet: jest.fn(async () => undefined),
	setItem: jest.fn(async () => undefined),
}));

jest.mock('expo-document-picker', () => ({
	getDocumentAsync: jest.fn(async () => ({ canceled: false, assets: [{ uri: 'file:///tmp/backup.json' }] })),
}));

// Sem `class` aqui de propósito: o babel compila classe com funções auxiliares que a
// fábrica do `jest.mock` não tem permissão para alcançar.
jest.mock('expo-file-system', () => ({
	File: function MockFile() {
		return {
			uri: 'file:///tmp/backup.json',
			write: (content: string) => {
				mockFile.written =
					mockFile.truncateTo === null ? content : content.slice(0, mockFile.truncateTo);
			},
			text: async () => mockFile.written,
		};
	},
	Paths: { document: '/tmp' },
}));
jest.mock('expo-sharing', () => ({ shareAsync: jest.fn() }));

import * as Sharing from 'expo-sharing';
import { Alert } from 'react-native';
import { getAllCaptures } from '../../database/captures';
import { getBills, getDebts, getTransactions, restoreBill } from '../../database/database';
import type { Category, Transaction } from '../../database/schema';
import {
	type DatabaseExportData,
	exportDatabaseData,
	generateFinancialReport,
	importDatabaseData,
	transactionsToCSV,
} from '../exportUtils';

const category = (id: string, name: string, type: 'expense' | 'income' = 'expense'): Category => ({
	id,
	name,
	color: '#fff',
	icon: 'cart',
	type,
	nature: 'discretionary',
	updatedAt: '2026-01-01T00:00:00.000Z',
});

const transaction = (
	id: string,
	amountCents: number,
	categoryId: string,
	date: string,
	isIncome = false,
	note = ''
): Transaction => ({
	id,
	amountCents,
	category: categoryId,
	date,
	note,
	isIncome,
	accountId: null,
	installmentGroup: null,
	installmentIndex: null,
	installmentCount: null,
	cardLast4: null,
	updatedAt: '2026-01-01T00:00:00.000Z',
});

/** Parser mínimo de CSV com aspas duplas, para ler de volta o que foi escrito. */
const parseCsvLine = (line: string): string[] => {
	const fields: string[] = [];
	let current = '';
	let quoted = false;

	for (let i = 0; i < line.length; i += 1) {
		const char = line[i];
		if (quoted) {
			if (char === '"' && line[i + 1] === '"') {
				current += '"';
				i += 1;
			} else if (char === '"') {
				quoted = false;
			} else {
				current += char;
			}
		} else if (char === '"') {
			quoted = true;
		} else if (char === ',') {
			fields.push(current);
			current = '';
		} else {
			current += char;
		}
	}
	fields.push(current);
	return fields;
};

const CATEGORIES = [
	category('food', 'Food, drinks & "snacks"'),
	category('rent', 'Rent'),
	category('salary', 'Salary', 'income'),
];

describe('transactionsToCSV', () => {
	it('escreve valores com duas casas e sem separador de milhar, legíveis de volta ao centavo', () => {
		const rows = [
			transaction('1', 123456789, 'food', '2026-09-01'),
			transaction('2', 5, 'rent', '2026-09-02'),
			transaction('3', 100, 'salary', '2026-09-03', true),
			transaction('4', 99999999, 'rent', '2026-09-04', false, 'note, with "quotes"\nand newline'),
		];
		const csv = transactionsToCSV(rows, CATEGORIES);
		const [header, ...lines] = csv.split('\n');

		expect(parseCsvLine(header)).toEqual(['Date', 'Type', 'Category', 'Amount', 'Note']);

		// A nota com quebra de linha ocupa duas linhas físicas; juntamos de volta.
		const joined = lines.join('\n');
		const records = joined.match(/(?:[^\n"]|"(?:[^"]|"")*")+/g) ?? [];
		expect(records).toHaveLength(4);

		const parsed = records.map(parseCsvLine);
		expect(parsed[0]).toEqual(['2026-09-01', 'Expense', 'Food, drinks & "snacks"', '1234567.89', '']);
		expect(parsed[1][3]).toBe('0.05');
		expect(parsed[2]).toEqual(['2026-09-03', 'Income', 'Salary', '1.00', '']);
		expect(parsed[3][4]).toBe('note, with "quotes"\nand newline');
		expect(parsed[3][3]).toBe('999999.99');

		// Cada valor lido de volta multiplica por 100 para o centavo original.
		for (let i = 0; i < rows.length; i += 1) {
			expect(Math.round(Number(parsed[i][3]) * 100)).toBe(rows[i].amountCents);
		}
	});

	it('categoria apagada aparece como Unknown em vez de quebrar a linha', () => {
		const csv = transactionsToCSV([transaction('1', 100, 'ghost', '2026-01-01')], CATEGORIES);
		expect(csv.split('\n')[1]).toBe('2026-01-01,Expense,Unknown,1.00,');
	});

	it('todo valor de 0 a 99.999 centavos escreve exatamente duas casas decimais', () => {
		const rows = Array.from({ length: 100_000 }, (_, cents) =>
			transaction(String(cents), cents, 'rent', '2026-01-01')
		);
		const lines = transactionsToCSV(rows, CATEGORIES).split('\n').slice(1);

		for (let cents = 0; cents < rows.length; cents += 1) {
			const amount = lines[cents].split(',')[3];
			expect(amount).toMatch(/^\d+\.\d{2}$/);
			expect(Math.round(Number(amount) * 100)).toBe(cents);
		}
	});
});

describe('generateFinancialReport', () => {
	const monthlyData = {
		incomes: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, totalCents: (i + 1) * 100_000 })),
		expenses: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, totalCents: (i + 1) * 70_001 })),
	};
	const categoryTotals = {
		expenses: [
			{ categoryId: 'food', totalCents: 33_333 },
			{ categoryId: 'rent', totalCents: 66_667 },
		],
		incomes: [{ categoryId: 'salary', totalCents: 250_000 }],
	};
	const transactions = [
		transaction('a', 33_333, 'food', '2026-09-20'),
		transaction('b', 66_667, 'rent', '2026-09-05'),
		transaction('c', 250_000, 'salary', '2026-09-01', true),
	];

	it('o resumo mensal fecha: Net = Income − Expense para os doze meses', async () => {
		const report = await generateFinancialReport(
			transactions,
			CATEGORIES,
			monthlyData,
			categoryTotals,
			'SEPTEMBER_2026',
			2026
		);
		const lines = report.split('\n');
		const start = lines.findIndex((l) => l.startsWith('Month,Income,Expense,Net')) + 1;
		const monthLines = lines.slice(start, start + 12);

		expect(monthLines).toHaveLength(12);
		for (let i = 0; i < 12; i += 1) {
			const [, income, expense, net] = parseCsvLine(monthLines[i]);
			const incomeCents = Math.round(Number(income) * 100);
			const expenseCents = Math.round(Number(expense) * 100);
			const netCents = Math.round(Number(net) * 100);

			expect(incomeCents).toBe((i + 1) * 100_000);
			expect(expenseCents).toBe((i + 1) * 70_001);
			expect(netCents).toBe(incomeCents - expenseCents);
		}
	});

	it('as porcentagens por categoria somam 100% (± arredondamento de exibição)', async () => {
		const report = await generateFinancialReport(
			transactions,
			CATEGORIES,
			monthlyData,
			categoryTotals,
			'SEPTEMBER_2026',
			2026
		);
		const lines = report.split('\n');
		const start = lines.findIndex((l) => l.startsWith('EXPENSE CATEGORIES')) + 2;
		const rows = lines.slice(start, start + 2).map(parseCsvLine);

		expect(rows[0]).toEqual(['Food, drinks & "snacks"', '333.33', '33.33%']);
		expect(rows[1]).toEqual(['Rent', '666.67', '66.67%']);

		const total = rows.reduce((sum, row) => sum + Number(row[2].replace('%', '')), 0);
		expect(Math.abs(total - 100)).toBeLessThan(0.01 * rows.length);
	});

	it('a seção de lançamentos vem em ordem cronológica e com os valores exatos', async () => {
		const report = await generateFinancialReport(
			transactions,
			CATEGORIES,
			monthlyData,
			categoryTotals,
			'SEPTEMBER_2026',
			2026
		);
		const lines = report.split('\n');
		const start = lines.findIndex((l) => l.startsWith('TRANSACTIONS')) + 2;
		const rows = lines.slice(start, start + 3).map(parseCsvLine);

		expect(rows.map((r) => r[0])).toEqual(['2026-09-01', '2026-09-05', '2026-09-20']);
		expect(rows.map((r) => r[3])).toEqual(['2500.00', '666.67', '333.33']);
	});

	it('categoria sem total não divide por zero', async () => {
		const report = await generateFinancialReport(
			[],
			CATEGORIES,
			monthlyData,
			{ expenses: [{ categoryId: 'food', totalCents: 0 }], incomes: [] },
			'X',
			2026
		);
		expect(report).toContain('"Food, drinks & ""snacks""",0.00,0.00%');
		expect(report).not.toContain('NaN');
		expect(report).not.toContain('Infinity');
	});
});

/**
 * O backup: o caso real de 12/10/2026, em que o arquivo saiu com 34 lançamentos de
 * setembro, nenhum de outubro e nenhum aviso — porque as compras de outubro estavam na
 * caixa de entrada, que não viajava, e porque nada no arquivo dizia o que faltava.
 */
describe('exportDatabaseData', () => {
	let alert: jest.SpyInstance;

	beforeEach(() => {
		jest.clearAllMocks();
		mockFile.written = '';
		mockFile.truncateTo = null;
		alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
	});

	afterEach(() => alert.mockRestore());

	const written = (): DatabaseExportData => JSON.parse(mockFile.written) as DatabaseExportData;

	it('leva a caixa de entrada, as regras aprendidas e as preferências', async () => {
		await exportDatabaseData();
		const backup = written();

		expect(backup.formatVersion).toBe(5);
		expect(backup.captures).toHaveLength(1);
		expect(backup.captures?.[0]).toMatchObject({ id: 'cap-1', status: 'pending' });
		expect(backup.merchantRules).toEqual([{ merchantKey: 'padaria', confirmations: 4 }]);
		// Chave sem valor não entra: `null` seria indistinguível de uma escolha.
		expect(backup.preferences).toEqual({
			selectedCurrency: '{"code":"BRL"}',
			cdiRate: '{"annualBp":1490}',
		});
		expect(backup.incomplete).toBeUndefined();
	});

	it('leva a `uncategorized`, que a lista da tela esconde — a diferença 15 x 16', async () => {
		await exportDatabaseData();

		expect(written().categories.map((c) => c.id)).toEqual(['food', 'uncategorized']);
	});

	it('o aviso de sucesso diz quantas linhas entraram', async () => {
		await exportDatabaseData();

		const [title, body] = alert.mock.calls[0] as [string, string];
		expect(title).toBe('settings.exportSuccess');
		expect(body).toContain('transactions=1');
		expect(body).toContain('captures=1');
		expect(body).toContain('rules=1');
	});

	it('uma coleção que não abre é nomeada no arquivo e no aviso', async () => {
		(getAllCaptures as jest.Mock).mockImplementationOnce(async () => {
			throw new Error('tabela corrompida');
		});

		await exportDatabaseData();

		expect(written().incomplete).toEqual(['captures']);
		const [title, body] = alert.mock.calls[0] as [string, string];
		expect(title).toBe('settings.exportIncompleteTitle');
		expect(body).toContain('captures');
		// O resto do backup foi salvo: perder tudo por causa de uma parte é pior.
		expect(written().transactions).toHaveLength(1);
	});

	it('se o livro-caixa não abre, nenhum arquivo é compartilhado', async () => {
		(getTransactions as jest.Mock).mockImplementationOnce(async () => {
			throw new Error('banco travado');
		});

		await expect(exportDatabaseData()).rejects.toThrow('banco travado');
		expect(Sharing.shareAsync).not.toHaveBeenCalled();
		expect(alert.mock.calls[0][0]).toBe('settings.exportFailed');
	});

	it('arquivo truncado não é compartilhado como se estivesse bom', async () => {
		mockFile.truncateTo = 50;

		await expect(exportDatabaseData()).rejects.toThrow(/incompleto/);
		expect(Sharing.shareAsync).not.toHaveBeenCalled();
		expect(alert.mock.calls[0][0]).toBe('settings.exportFailed');
	});

	it('o que um app antigo exige continua no mesmo lugar: v4 entra na 1.2.7', async () => {
		await exportDatabaseData();
		const backup = written();

		// É exatamente o que `validateImportData` de uma versão anterior checa. As
		// coleções novas são acréscimos, e um app antigo ignora chave que não conhece.
		expect(Array.isArray(backup.transactions)).toBe(true);
		expect(Array.isArray(backup.categories)).toBe(true);
		expect(Array.isArray(backup.recurringTransactions)).toBe(true);
		expect(typeof backup.exportDate).toBe('string');
	});
});

/**
 * Contas a pagar (v20) no backup: o arquivo leva `bills`, a importação as devolve com o
 * id do arquivo, e um arquivo anterior a elas continua entrando.
 */
describe('contas a pagar no backup', () => {
	let alert: jest.SpyInstance;

	beforeEach(() => {
		jest.clearAllMocks();
		mockFile.written = '';
		mockFile.truncateTo = null;
		alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
	});

	afterEach(() => alert.mockRestore());

	const written = (): DatabaseExportData => JSON.parse(mockFile.written) as DatabaseExportData;

	it('o arquivo leva `bills`, no formato 5', async () => {
		await exportDatabaseData();
		const backup = written();

		expect(backup.formatVersion).toBe(5);
		expect(backup.bills).toHaveLength(1);
		expect(backup.bills?.[0]).toMatchObject({
			id: 'bill-celular',
			amountCents: null,
			paidThrough: '2026-09',
		});
		expect(backup.incomplete).toBeUndefined();
	});

	it('ida e volta: a importação regrava cada conta a pagar com o id do arquivo', async () => {
		(getTransactions as jest.Mock).mockResolvedValueOnce([]);
		(getDebts as jest.Mock).mockResolvedValueOnce([
			{ id: 'debt-carro', name: 'Carro', feeCents: 0, accountId: null },
		]);
		(getBills as jest.Mock).mockResolvedValueOnce([
			{
				id: 'bill-celular',
				name: 'Celular',
				dueDay: 10,
				amountCents: null,
				accountId: 'conta-inter',
				category: 'phone',
				matchHint: 'tim,claro',
				debtId: null,
				paidThrough: '2026-09',
				paidByRef: 'tx-1',
				active: true,
				sortOrder: 0,
				updatedAt: '2026-10-01T00:00:00.000Z',
			},
			{
				id: 'debt-carro',
				name: 'Carro',
				dueDay: 15,
				amountCents: 150_000,
				accountId: 'conta-que-nao-veio',
				category: null,
				matchHint: null,
				debtId: 'debt-carro',
				paidThrough: null,
				paidByRef: null,
				active: false,
				sortOrder: 1,
				updatedAt: '2026-10-01T00:00:00.000Z',
				deletedAt: '2026-10-02T00:00:00.000Z',
			},
		]);
		await exportDatabaseData();

		const result = await importDatabaseData();

		expect(result.success).toBe(true);
		expect(result.warnings).toEqual([]);
		expect(restoreBill).toHaveBeenCalledTimes(2);
		// Sem os carimbos do sync: a linha volta suja e com o relógio de agora.
		expect(restoreBill).toHaveBeenNthCalledWith(
			1,
			{
				name: 'Celular',
				dueDay: 10,
				amountCents: null,
				accountId: 'conta-inter',
				category: 'phone',
				matchHint: 'tim,claro',
				debtId: null,
				paidThrough: '2026-09',
				paidByRef: 'tx-1',
				active: true,
				sortOrder: 0,
			},
			'bill-celular'
		);
		// A conta de onde sai e a dívida de origem só valem se vieram no mesmo arquivo.
		expect(restoreBill).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				accountId: null,
				debtId: 'debt-carro',
				amountCents: 150_000,
				active: false,
			}),
			'debt-carro'
		);
	});

	it('a dívida de origem que não veio no arquivo vira conta avulsa', async () => {
		(getTransactions as jest.Mock).mockResolvedValueOnce([]);
		(getBills as jest.Mock).mockResolvedValueOnce([
			{
				id: 'bill-orfa',
				name: 'Consórcio',
				dueDay: 5,
				amountCents: 80_000,
				accountId: null,
				category: null,
				matchHint: null,
				debtId: 'debt-que-nao-veio',
				paidThrough: null,
				paidByRef: null,
				active: true,
				sortOrder: 0,
				updatedAt: '2026-10-01T00:00:00.000Z',
			},
		]);
		await exportDatabaseData();

		await importDatabaseData();

		expect(restoreBill).toHaveBeenCalledWith(expect.objectContaining({ debtId: null }), 'bill-orfa');
	});

	it('arquivo antigo, sem `bills`, continua importando', async () => {
		mockFile.written = JSON.stringify({
			formatVersion: 4,
			exportDate: '2026-10-11T12:00:00.000Z',
			transactions: [],
			categories: [],
			recurringTransactions: [],
		});

		const result = await importDatabaseData();

		expect(result.success).toBe(true);
		expect(result.warnings).toEqual([]);
		expect(restoreBill).not.toHaveBeenCalled();
	});
});
