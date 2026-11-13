/**
 * O CSV dos Relatórios com um mês de um ano anterior selecionado (SPD-141).
 *
 * O resumo mensal saía com o título do ano escolhido e os números do ano corrente: o
 * `monthlyData` do contexto é sempre o deste ano. Aqui o SQL é o **de verdade** de
 * `database.ts` (`node:sqlite` em memória, como em `database/__tests__/accountSql.test.ts`),
 * com lançamentos em 2025 e em 2026: o arquivo de 2025 só pode trazer os de 2025.
 * Sem `NODE_OPTIONS=--experimental-sqlite` a suíte é pulada com um aviso.
 */

/** O que foi escrito no "disco": o conteúdo do CSV compartilhado. */
const mockFile = { written: '' };

jest.mock('expo-sqlite', () => {
	const { createRequire } = jest.requireActual('module');
	let DatabaseSync: (new (path: string) => {
		exec: (sql: string) => void;
		prepare: (sql: string) => {
			run: (...params: unknown[]) => { changes: number | bigint; lastInsertRowid: number | bigint };
			get: (...params: unknown[]) => unknown;
			all: (...params: unknown[]) => unknown[];
		};
	}) | null = null;
	try {
		DatabaseSync = createRequire(__filename)('node:sqlite').DatabaseSync;
	} catch {
		DatabaseSync = null;
	}
	const normalise = (params: unknown[] = []) =>
		params.map((value) => (typeof value === 'boolean' ? (value ? 1 : 0) : value === undefined ? null : value));
	return {
		mockSqliteAvailable: DatabaseSync !== null,
		openDatabaseSync: () => {
			if (!DatabaseSync) return {};
			const raw = new DatabaseSync(':memory:');
			return {
				execAsync: async (sql: string) => {
					raw.exec(sql);
				},
				runAsync: async (sql: string, params: unknown[] = []) => {
					const result = raw.prepare(sql).run(...normalise(params));
					return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
				},
				getFirstAsync: async (sql: string, params: unknown[] = []) => raw.prepare(sql).get(...normalise(params)) ?? null,
				getAllAsync: async (sql: string, params: unknown[] = []) => raw.prepare(sql).all(...normalise(params)),
				withTransactionAsync: async (body: () => Promise<void>) => {
					raw.exec('BEGIN');
					try {
						await body();
						raw.exec('COMMIT');
					} catch (error) {
						raw.exec('ROLLBACK');
						throw error;
					}
				},
			};
		},
	};
});

jest.mock('@react-native-async-storage/async-storage', () => ({
	getItem: jest.fn(async () => null),
	setItem: jest.fn(async () => undefined),
	removeItem: jest.fn(async () => undefined),
	multiGet: jest.fn(async () => []),
	multiSet: jest.fn(async () => undefined),
	multiRemove: jest.fn(async () => undefined),
}));

jest.mock('../../sync/queue', () => ({
	notifyDataChanged: jest.fn(),
	schedule: jest.fn(),
	runExclusive: (work: () => Promise<unknown>) => work(),
}));

jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));

// Sem `class` de propósito: a fábrica do `jest.mock` não alcança as funções auxiliares do babel.
jest.mock('expo-file-system', () => ({
	File: function MockFile() {
		return {
			uri: 'file:///tmp/report.csv',
			write: (content: string) => {
				mockFile.written = content;
			},
			text: async () => mockFile.written,
		};
	},
	Paths: { document: '/tmp' },
}));
jest.mock('expo-sharing', () => ({ shareAsync: jest.fn(async () => undefined) }));

import { addTransaction, db, initDatabase } from '../../database/database';
import { exportFinancialReport } from '../exportUtils';

const sqliteAvailable: boolean = jest.requireMock<{ mockSqliteAvailable: boolean }>('expo-sqlite').mockSqliteAvailable;
if (!sqliteAvailable) {
	console.warn('reportYearSql.test.ts pulado: rode com NODE_OPTIONS=--experimental-sqlite (Node 22.12).');
}
const describeSql = sqliteAvailable ? describe : describe.skip;

const post = (date: string, amountCents: number, isIncome: boolean) =>
	addTransaction({ accountId: null, date, amountCents, isIncome, category: isIncome ? 'salary' : 'food', note: '' });

/** As doze linhas do resumo mensal, em centavos, na ordem dos meses. */
const monthlySummary = (csv: string): Array<{ income: number; expense: number; net: number }> => {
	const lines = csv.split('\n');
	const start = lines.indexOf('Month,Income,Expense,Net') + 1;
	const cents = (value: string) => Math.round(Number(value) * 100);
	return lines.slice(start, start + 12).map((line) => {
		const [, income, expense, net] = line.split(',');
		return { income: cents(income), expense: cents(expense), net: cents(net) };
	});
};

describeSql('CSV dos Relatórios de um ano anterior (SQL de verdade)', () => {
	beforeAll(async () => {
		jest.spyOn(console, 'log').mockImplementation(() => undefined);
		await initDatabase();
	});
	beforeEach(async () => {
		mockFile.written = '';
		await db.execAsync('DELETE FROM transactions;');
	});

	it('março de 2025 com lançamentos em 2025 e 2026: o resumo do ano é o de 2025', async () => {
		await post('2025-03-10', 10_000, false);
		await post('2025-03-05', 50_000, true);
		await post('2025-11-20', 2_550, false);
		await post('2026-03-10', 99_900, false);
		await post('2026-05-01', 77_700, true);

		await exportFinancialReport([], [], { expenses: [], incomes: [] }, 'March', 2025);

		const csv = mockFile.written;
		expect(csv).toContain('MONTHLY SUMMARY — full year 2025');
		const months = monthlySummary(csv);
		expect(months).toHaveLength(12);
		// Março: R$ 500 de receita, R$ 100 de despesa, R$ 400 de saldo.
		expect(months[2]).toEqual({ income: 50_000, expense: 10_000, net: 40_000 });
		// Novembro: R$ 25,50 de despesa.
		expect(months[10]).toEqual({ income: 0, expense: 2_550, net: -2_550 });
		// Nada de 2026: maio de 2025 vazio, e os R$ 999 de março de 2026 não aparecem.
		expect(months[4]).toEqual({ income: 0, expense: 0, net: 0 });
		expect(months.reduce((sum, month) => sum + month.expense, 0)).toBe(12_550);
		expect(months.reduce((sum, month) => sum + month.income, 0)).toBe(50_000);
		expect(csv).not.toContain('999.00');
		expect(csv).not.toContain('777.00');
	});

	it('o mesmo banco exportado em 2026 traz só 2026', async () => {
		await post('2025-03-10', 10_000, false);
		await post('2026-03-10', 99_900, false);
		await post('2026-05-01', 77_700, true);

		await exportFinancialReport([], [], { expenses: [], incomes: [] }, 'May', 2026);

		const months = monthlySummary(mockFile.written);
		expect(mockFile.written).toContain('MONTHLY SUMMARY — full year 2026');
		expect(months[2]).toEqual({ income: 0, expense: 99_900, net: -99_900 });
		expect(months[4]).toEqual({ income: 77_700, expense: 0, net: 77_700 });
		expect(months.reduce((sum, month) => sum + month.expense, 0)).toBe(99_900);
	});
});
