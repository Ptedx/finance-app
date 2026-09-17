/**
 * Exportação: o CSV que sai do app tem que somar o mesmo que a tela.
 *
 * Só as funções puras são testadas (`transactionsToCSV`, `generateFinancialReport`);
 * o compartilhamento de arquivo e o banco são substituídos por mocks.
 */

jest.mock('../../database/database', () => ({
	addCategory: jest.fn(),
	addRecurringTransaction: jest.fn(),
	addTransaction: jest.fn(),
	getBudgets: jest.fn(async () => []),
	getCategories: jest.fn(async () => []),
	resetDatabase: jest.fn(),
	setBudget: jest.fn(),
}));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('expo-file-system', () => ({ File: jest.fn(), Paths: { document: '/tmp' } }));
jest.mock('expo-sharing', () => ({ shareAsync: jest.fn() }));

import type { Category, Transaction } from '../../database/schema';
import { generateFinancialReport, transactionsToCSV } from '../exportUtils';

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
