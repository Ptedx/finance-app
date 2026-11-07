/**
 * Exportar e importar o próprio backup no SQL **de verdade** de `database.ts` (E2E-35).
 *
 * O achado: importar o backup de 07/11/2026 (12 lançamentos, 5 contas, 4 transferências,
 * 1 orçamento de nov/2026 de R$ 5.000) devolveu tudo menos o orçamento, com o log
 * `cannot start a transaction within a transaction`. A importação corria junto de uma
 * rodada de sync — a que a volta ao app dispara quando o seletor de arquivo fecha — e
 * `restoreBudget` abria uma transação própria enquanto a do sync estava aberta.
 *
 * O `expo-sqlite` vira um banco em memória do próprio Node (`node:sqlite`), como em
 * `accountSql.test.ts`: é ele que recusa o BEGIN dentro de outro, igual ao aparelho. Sem
 * `NODE_OPTIONS=--experimental-sqlite` a suíte é pulada com um aviso. Os textos vêm da
 * i18n de verdade, em português.
 */

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
	multiRemove: jest.fn(async () => undefined),
	multiGet: jest.fn(async (keys: string[]) => keys.map((key) => [key, null])),
	multiSet: jest.fn(async () => undefined),
}));

/** O "disco": o backup escrito dentro do app e o que foi gravado na pasta escolhida. */
const mockDisk = { content: '', saved: '' };

// Sem `class` aqui de propósito: o babel compila classe com funções auxiliares que a
// fábrica do `jest.mock` não tem permissão para alcançar.
jest.mock('expo-file-system', () => ({
	File: function MockFile() {
		return {
			uri: 'file:///data/files/spendr_backup.json',
			name: 'spendr_backup.json',
			write: (content: string) => {
				mockDisk.content = content;
			},
			text: async () => mockDisk.content,
		};
	},
	Directory: {
		pickDirectoryAsync: jest.fn(async () => ({
			createFile: (name: string) => ({
				uri: `content://downloads/${name}`,
				name,
				write: (content: string) => {
					mockDisk.saved = content;
				},
				text: async () => mockDisk.saved,
			}),
		})),
	},
	Paths: { document: '/data/files' },
}));

jest.mock('expo-sharing', () => ({ shareAsync: jest.fn(async () => undefined) }));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));

// A rodada de sync é o motor de mentira abaixo; a fila é a de verdade.
jest.mock('../../sync/engine', () => ({ syncNow: jest.fn() }));
jest.mock('../../api/client', () => ({ ApiError: class ApiError extends Error {} }));

import * as DocumentPicker from 'expo-document-picker';
import { Directory } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Alert, type AlertButton } from 'react-native';
import * as database from '../../database/database';
import {
	addAccount,
	addTransaction,
	addTransfer,
	db,
	getBudgets,
	initDatabase,
	restoreBudget,
	setBudget,
} from '../../database/database';
import type { AccountDraft } from '../../database/schema';
import i18n from '../../i18n';
import { syncNow } from '../../sync/engine';
import * as syncQueue from '../../sync/queue';
import { exportDatabaseData, importDatabaseData } from '../exportUtils';

const sqliteAvailable: boolean = jest.requireMock<{ mockSqliteAvailable: boolean }>('expo-sqlite').mockSqliteAvailable;
if (!sqliteAvailable) {
	console.warn('backupSql.test.ts pulado: rode com NODE_OPTIONS=--experimental-sqlite (Node 22.12).');
}
const describeSql = sqliteAvailable ? describe : describe.skip;

const draft = (overrides: Partial<AccountDraft> = {}): AccountDraft => ({
	name: 'Conta',
	kind: 'checking',
	role: 'main',
	envelopeMonthlyCents: null,
	bankName: null,
	color: '#000000',
	last4: null,
	network: null,
	closingDay: null,
	dueDay: null,
	closingDaysBefore: null,
	creditLimitCents: null,
	cardNames: null,
	yieldCdiBp: null,
	reservePurpose: null,
	packageName: null,
	accountKey: null,
	openingBalanceCents: 0,
	openingBalanceDate: '2026-01-01',
	sortOrder: 0,
	archived: false,
	...overrides,
});

const NOV_2026_CENTS = 500_000;

const novemberBudget = async () => (await getBudgets()).find((b) => b.year === 2026 && b.month === 11);

/** O aviso na tela, com o botão tocado pelo "usuário" quando há um com este texto. */
let alerts: Array<{ title: string; message: string; buttons: AlertButton[] }> = [];
let pressOnAlert: string | null = null;
const spies: jest.SpyInstance[] = [];

describeSql('backup no SQL de verdade (E2E-35)', () => {
	beforeAll(async () => {
		jest.spyOn(console, 'log').mockImplementation(() => undefined);
		await initDatabase();
		await i18n.changeLanguage('pt');
	});

	beforeEach(async () => {
		jest.clearAllMocks();
		syncQueue.stop();
		mockDisk.content = '';
		mockDisk.saved = '';
		alerts = [];
		pressOnAlert = i18n.t('settings.exportShareAction');
		spies.push(jest.spyOn(Alert, 'alert').mockImplementation((title, message, buttons) => {
			alerts.push({ title, message: message ?? '', buttons: buttons ?? [] });
			const button = (buttons ?? []).find((b) => b.text === pressOnAlert);
			button?.onPress?.();
		}));
		(syncNow as jest.Mock).mockResolvedValue({ pulled: 0, pushed: 0, pendingAfter: 0 });
		await db.execAsync(
			'DELETE FROM budgets; DELETE FROM transfers; DELETE FROM transactions; DELETE FROM accounts; DELETE FROM debts; DELETE FROM bills;'
		);
	});

	afterEach(() => {
		syncQueue.stop();
		for (const spy of spies.splice(0)) spy.mockRestore();
	});

	it('restoreBudget chamado com outra transação aberta grava o orçamento, sem abrir uma segunda', async () => {
		await db.withTransactionAsync(async () => {
			await restoreBudget(2026, 11, NOV_2026_CENTS, 'orc-nov-2026');
		});

		expect(await novemberBudget()).toMatchObject({ id: 'orc-nov-2026', amountCents: NOV_2026_CENTS });
	});

	it('exporta com orçamento de nov/2026 de R$ 5.000 e importa com uma rodada de sync no ar: o orçamento volta', async () => {
		const inter = await addAccount(draft({ name: 'Inter' }));
		const nubank = await addAccount(draft({ name: 'Nubank', kind: 'credit_card', role: 'card', last4: '1234' }));
		await addTransaction({ accountId: inter, date: '2026-11-05', amountCents: 12_345, isIncome: false, category: 'food', note: '' });
		await addTransfer({ fromAccountId: inter, toAccountId: nubank, amountCents: 30_000, date: '2026-11-06', note: '' });
		await setBudget(2026, 11, NOV_2026_CENTS);

		await exportDatabaseData();
		expect(mockDisk.content).toContain('"budgets"');

		// A volta do seletor de arquivo é a volta ao primeiro plano: o AuthContext pede um
		// sync na hora, e a rodada abre a transação dela (o `markChangesClean` depois do
		// push, o `applyPulledChanges` depois do pull) enquanto a importação começa.
		(syncNow as jest.Mock).mockImplementationOnce(() =>
			db.withTransactionAsync(async () => {
				await new Promise((resolve) => setTimeout(resolve, 30));
			}).then(() => ({ pulled: 0, pushed: 0, pendingAfter: 0 }))
		);
		(DocumentPicker.getDocumentAsync as jest.Mock).mockImplementationOnce(async () => {
			syncQueue.start();
			return { canceled: false, assets: [{ uri: 'file:///data/files/spendr_backup.json' }] };
		});

		const result = await importDatabaseData();

		expect(result.warnings).toEqual([]);
		expect(result.success).toBe(true);
		expect(await novemberBudget()).toMatchObject({ amountCents: NOV_2026_CENTS });
		// O resumo cita o que voltou, no singular quando é um, e não fala de recorrência.
		expect(result.message).toContain('1 lançamento');
		expect(result.message).toContain('1 conta');
		expect(result.message).toContain('1 cartão');
		expect(result.message).toContain('1 transferência');
		expect(result.message).toContain('1 orçamento');
		expect(result.message).not.toMatch(/recorr|dívida|Could not|budgets/);
	});

	describe('para onde vai o arquivo exportado', () => {
		const lastAlert = () => alerts[alerts.length - 1];

		it('compartilhar não afirma que o backup foi salvo: o Android não diz se o usuário cancelou', async () => {
			await setBudget(2026, 11, NOV_2026_CENTS);

			await exportDatabaseData();

			expect(Sharing.shareAsync).toHaveBeenCalledTimes(1);
			const text = alerts.map((a) => `${a.title} ${a.message}`).join(' ');
			expect(text).not.toMatch(/Backup salvo|Foi salvo/);
			// O resumo continua dizendo o que o arquivo tem, no singular quando é um.
			expect(text).toContain('1 orçamento');
			expect(text).not.toContain('1 orçamentos');
		});

		it('"Salvar em Arquivos" grava o arquivo inteiro na pasta escolhida, e só então diz salvo', async () => {
			pressOnAlert = i18n.t('settings.exportSaveToFiles');
			await setBudget(2026, 11, NOV_2026_CENTS);

			await exportDatabaseData();

			expect(Sharing.shareAsync).not.toHaveBeenCalled();
			expect(mockDisk.saved).toBe(mockDisk.content);
			expect(JSON.parse(mockDisk.saved).budgets).toEqual([
				expect.objectContaining({ year: 2026, month: 11, amountCents: NOV_2026_CENTS }),
			]);
			expect(lastAlert().title).toBe(i18n.t('settings.exportSuccess'));
		});

		it('fechar o seletor de pasta sem escolher: diz que o arquivo não foi guardado', async () => {
			pressOnAlert = i18n.t('settings.exportSaveToFiles');
			(Directory.pickDirectoryAsync as jest.Mock).mockRejectedValueOnce(
				new Error('The file picker was cancelled by the user')
			);

			await exportDatabaseData();

			expect(mockDisk.saved).toBe('');
			expect(lastAlert().title).toBe(i18n.t('settings.exportNotSavedTitle'));
		});
	});

	it('uma linha que não volta é dita em português, com o plural certo', async () => {
		await setBudget(2026, 11, NOV_2026_CENTS);
		await exportDatabaseData();
		spies.push(jest.spyOn(console, 'error').mockImplementation(() => undefined));
		spies.push(jest.spyOn(database, 'restoreBudget').mockRejectedValueOnce(new Error('disco cheio')));
		(DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValueOnce({
			canceled: false,
			assets: [{ uri: 'file:///data/files/spendr_backup.json' }],
		});

		const result = await importDatabaseData();

		expect(result.success).toBe(true);
		const warnings = (result.warnings ?? []).join(' ');
		expect(warnings).toContain('1 orçamento');
		expect(warnings).not.toMatch(/Could not|budgets|orçamentos/);
		expect(result.message).toContain(warnings);
	});
});
