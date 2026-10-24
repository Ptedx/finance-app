/**
 * Preferências no sync (v21) e a contagem do primeiro login, lidas pelo SQL que
 * `database.ts` manda para o banco.
 *
 * Mesmo dublê de `billSync.test.ts`: o `expo-sqlite` anota cada comando e responde o que
 * cada teste programar. O AsyncStorage é um Map — é nele que as telas leem a moeda e o
 * idioma, e é ele que o pull tem de atualizar.
 *
 * O pedido por trás disto: "quando eu for logar em outro lugar, quero que o app esteja
 * 100% igual a quando eu deixei de usar". Duas coisas impediam: a moeda, o idioma e os
 * avisos dispensados moravam só no AsyncStorage deste aparelho; e a contagem que decide
 * se o login pergunta antes de juntar ignorava metade das coleções.
 */

interface Statement {
	sql: string;
	params: unknown[];
}

const mockStatements: Statement[] = [];
let mockOnFirst: (sql: string, params: unknown[]) => unknown = () => null;
let mockOnAll: (sql: string, params: unknown[]) => unknown[] = () => [];
const mockStorage = new Map<string, string>();

jest.mock('expo-sqlite', () => ({
	openDatabaseSync: () => ({
		execAsync: jest.fn(async (sql: string) => {
			mockStatements.push({ sql, params: [] });
		}),
		runAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
			mockStatements.push({ sql, params });
			return { changes: 0, lastInsertRowId: 0 };
		}),
		getFirstAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
			mockStatements.push({ sql, params });
			return mockOnFirst(sql, params);
		}),
		getAllAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
			mockStatements.push({ sql, params });
			return mockOnAll(sql, params);
		}),
		withTransactionAsync: jest.fn(async (body: () => Promise<void>) => {
			mockStatements.push({ sql: 'BEGIN', params: [] });
			await body();
			mockStatements.push({ sql: 'COMMIT', params: [] });
		}),
	}),
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
	getItem: jest.fn(async (key: string) => mockStorage.get(key) ?? null),
	setItem: jest.fn(async (key: string, value: string) => {
		mockStorage.set(key, value);
	}),
	removeItem: jest.fn(async (key: string) => {
		mockStorage.delete(key);
	}),
	multiGet: jest.fn(async (keys: string[]) => keys.map((key) => [key, mockStorage.get(key) ?? null])),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SyncChanges, WirePreference } from '../../sync/types';
import { STORAGE_KEYS } from '../../utils/storageUtils';
import {
	applyMigrations,
	applyPulledChanges,
	countLocalData,
	getDirtyChanges,
	markChangesClean,
	migrationLadder,
	reconcilePreferences,
	setPreference,
} from '../database';
import { DEFAULT_CATEGORIES, identityColumnOf, SCHEMA_VERSION, SYNCED_TABLES } from '../schema';

const reset = () => {
	mockStatements.length = 0;
	mockOnFirst = () => null;
	mockOnAll = () => [];
	mockStorage.clear();
	jest.clearAllMocks();
};

beforeEach(reset);

const matching = (...needles: string[]): Statement[] =>
	mockStatements.filter((statement) => needles.every((needle) => statement.sql.includes(needle)));

const flat = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

const CURRENCY = STORAGE_KEYS.selectedCurrency;
const BRL = '{"code":"BRL","symbol":"R$","name":"Brazilian Real"}';
const USD = '{"code":"USD","symbol":"$","name":"US Dollar"}';

const wirePreference = (overrides: Partial<WirePreference> = {}): WirePreference => ({
	id: CURRENCY,
	value: USD,
	updatedAt: '2026-10-20T12:00:00.000Z',
	deletedAt: null,
	...overrides,
});

const emptyChanges = (overrides: Partial<SyncChanges> = {}): SyncChanges => ({
	categories: [],
	transactions: [],
	recurringTransactions: [],
	budgets: [],
	...overrides,
});

/** Uma linha de `preferences` como a tabela a guarda. */
const preferenceRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
	key: CURRENCY,
	value: BRL,
	updatedAt: '2026-10-01T00:00:00.000Z',
	deletedAt: null,
	dirty: 0,
	...overrides,
});

// ---------------------------------------------------------------------------
// A migração v21
// ---------------------------------------------------------------------------

describe('migração v21', () => {
	it('a escada chega ao v21 e o passo 21 cria `preferences` com as colunas de sync', async () => {
		expect(SCHEMA_VERSION).toBe(21);
		const ladder = migrationLadder();
		expect(ladder.map(([version]) => version)).toEqual(
			Array.from({ length: SCHEMA_VERSION }, (_, index) => index + 1)
		);

		const [version, run] = ladder[20];
		expect(version).toBe(21);
		await run();

		const created = matching('CREATE TABLE IF NOT EXISTS preferences');
		expect(created).toHaveLength(1);
		const sql = flat(created[0].sql);
		expect(sql).toContain('key TEXT PRIMARY KEY NOT NULL');
		expect(sql).toContain('value TEXT NOT NULL');
		expect(sql).toContain('updatedAt TEXT NOT NULL');
		expect(sql).toContain('deletedAt TEXT');
		expect(sql).toContain('dirty INTEGER NOT NULL DEFAULT 1');
		// Aditiva: nada é reconstruído, alterado nem apagado.
		expect(matching('DROP')).toEqual([]);
		expect(matching('ALTER TABLE')).toEqual([]);
		expect(matching('DELETE FROM')).toEqual([]);
	});

	it('um banco v20 roda só o passo 21 e grava a versão nele', async () => {
		const versions: number[] = [];
		const reached = await applyMigrations(20, migrationLadder(), async (target) => {
			versions.push(target);
		});

		expect(reached).toBe(21);
		expect(versions).toEqual([21]);
		expect(mockStatements.map((statement) => flat(statement.sql).slice(0, 40))).toEqual([
			'CREATE TABLE IF NOT EXISTS preferences (',
		]);
	});

	it('`preferences` entra no sync, identificada pela chave', () => {
		expect(SYNCED_TABLES).toContain('preferences');
		expect(identityColumnOf('preferences')).toBe('key');
	});
});

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

describe('o push das preferências', () => {
	it('as sujas sobem com a chave como id, sem a marca local', async () => {
		mockOnAll = (sql) =>
			sql.includes('FROM preferences') ? [preferenceRow({ dirty: 1 }), preferenceRow({ key: STORAGE_KEYS.language, value: '{"code":"pt"}', deletedAt: '2026-10-02T00:00:00.000Z', dirty: 1 })] : [];

		const changes = await getDirtyChanges(500);

		expect(flat(matching('FROM preferences')[0].sql)).toBe(
			'SELECT * FROM preferences WHERE dirty = 1 ORDER BY updatedAt ASC LIMIT ?'
		);
		expect(changes.preferences).toEqual([
			{ id: CURRENCY, value: BRL, updatedAt: '2026-10-01T00:00:00.000Z', deletedAt: null },
			{ id: STORAGE_KEYS.language, value: '{"code":"pt"}', updatedAt: '2026-10-01T00:00:00.000Z', deletedAt: '2026-10-02T00:00:00.000Z' },
		]);
	});

	it('o aceito fica limpo pela chave e pelo updatedAt que subiu', async () => {
		await markChangesClean(emptyChanges({ preferences: [wirePreference()] }));

		const cleaned = matching('UPDATE preferences SET dirty = 0');
		expect(cleaned).toHaveLength(1);
		expect(flat(cleaned[0].sql)).toBe('UPDATE preferences SET dirty = 0 WHERE key = ? AND updatedAt = ?');
		expect(cleaned[0].params).toEqual([CURRENCY, '2026-10-20T12:00:00.000Z']);
	});
});

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

describe('o pull das preferências', () => {
	it('a preferência nova entra na tabela, limpa, e no AsyncStorage que as telas leem', async () => {
		await applyPulledChanges(emptyChanges({ preferences: [wirePreference()] }));

		const written = matching('INSERT INTO preferences');
		expect(written).toHaveLength(1);
		expect(flat(written[0].sql)).toContain('ON CONFLICT (key) DO UPDATE SET');
		expect(written[0].params).toEqual([CURRENCY, USD, '2026-10-20T12:00:00.000Z', null]);
		expect(flat(written[0].sql)).toContain(', 0)');
		expect(mockStorage.get(CURRENCY)).toBe(USD);
	});

	it('a daqui mais nova vence: nada é gravado, nem no AsyncStorage', async () => {
		mockStorage.set(CURRENCY, BRL);
		mockOnFirst = (sql) =>
			sql.includes('FROM preferences') ? { updatedAt: '2026-10-21T00:00:00.000Z', dirty: 1 } : null;

		await applyPulledChanges(emptyChanges({ preferences: [wirePreference()] }));

		expect(matching('INSERT INTO preferences')).toEqual([]);
		expect(mockStorage.get(CURRENCY)).toBe(BRL);
	});

	it('empate com a daqui ainda por subir: fica a daqui', async () => {
		mockStorage.set(CURRENCY, BRL);
		mockOnFirst = (sql) =>
			sql.includes('FROM preferences') ? { updatedAt: '2026-10-20T12:00:00.000Z', dirty: 1 } : null;

		await applyPulledChanges(emptyChanges({ preferences: [wirePreference()] }));

		expect(matching('INSERT INTO preferences')).toEqual([]);
		expect(mockStorage.get(CURRENCY)).toBe(BRL);
	});

	it('empate com a daqui já enviada: vence o servidor, e os aparelhos convergem', async () => {
		// Dois aparelhos que descobriram a mesma chave com o carimbo de semente: o servidor
		// aceitou o último a enviar (o empate é de quem envia), e o outro precisa adotar a
		// versão de lá — senão cada um fica com a sua para sempre.
		mockStorage.set(CURRENCY, BRL);
		mockOnFirst = (sql) =>
			sql.includes('FROM preferences') ? { updatedAt: '2026-10-20T12:00:00.000Z', dirty: 0 } : null;

		await applyPulledChanges(emptyChanges({ preferences: [wirePreference()] }));

		expect(matching('INSERT INTO preferences')).toHaveLength(1);
		expect(mockStorage.get(CURRENCY)).toBe(USD);
	});

	it('a lápide tira a chave do AsyncStorage e fica guardada como lápide', async () => {
		mockStorage.set(CURRENCY, BRL);

		await applyPulledChanges(
			emptyChanges({ preferences: [wirePreference({ deletedAt: '2026-10-20T12:00:00.000Z' })] })
		);

		expect(mockStorage.has(CURRENCY)).toBe(false);
		expect(matching('INSERT INTO preferences')[0].params).toEqual([
			CURRENCY,
			USD,
			'2026-10-20T12:00:00.000Z',
			'2026-10-20T12:00:00.000Z',
		]);
	});

	it('chave fora da lista nunca chega ao AsyncStorage — nem a da biometria, nem o aviso de captura', async () => {
		await applyPulledChanges(
			emptyChanges({
				preferences: [
					wirePreference({ id: '@spendr_biometric_enabled', value: 'false' }),
					wirePreference({ id: STORAGE_KEYS.captureAccessDismissed, value: '1' }),
				],
			})
		);

		expect(AsyncStorage.setItem).not.toHaveBeenCalled();
		expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
		// A linha fica guardada: "subir deste aparelho" não pode apagar da conta o que uma
		// versão mais nova do app gravou lá.
		expect(matching('INSERT INTO preferences')).toHaveLength(2);
	});

	it('remessa sem preferências não mexe no AsyncStorage', async () => {
		await applyPulledChanges(emptyChanges());
		expect(AsyncStorage.setItem).not.toHaveBeenCalled();
		expect(matching('preferences')).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// O que muda no AsyncStorage vira linha suja
// ---------------------------------------------------------------------------

describe('reconciliar o AsyncStorage com a tabela', () => {
	it('valor que só o AsyncStorage tem entra com o carimbo de semente — a versão da conta vence', async () => {
		mockStorage.set(CURRENCY, BRL);
		mockOnAll = () => [];

		expect(await reconcilePreferences()).toBe(1);

		const written = matching('INSERT INTO preferences');
		expect(written).toHaveLength(1);
		expect(written[0].params).toEqual([CURRENCY, BRL, '1970-01-01T00:00:00.000Z', null]);
		expect(flat(written[0].sql)).toContain(', 1)');
	});

	it('valor que mudou por fora (o liga/desliga dos lembretes, o backup) sobe com carimbo novo', async () => {
		mockStorage.set(STORAGE_KEYS.notificationsEnabled, 'false');
		mockOnAll = () => [preferenceRow({ key: STORAGE_KEYS.notificationsEnabled, value: 'true' })];

		expect(await reconcilePreferences()).toBe(1);

		const [written] = matching('INSERT INTO preferences');
		expect(written.params[0]).toBe(STORAGE_KEYS.notificationsEnabled);
		expect(written.params[1]).toBe('false');
		expect(String(written.params[2]) > '2026-10-01T00:00:00.000Z').toBe(true);
		expect(written.params[3]).toBeNull();
	});

	it('chave que sumiu do AsyncStorage vira lápide', async () => {
		mockOnAll = () => [preferenceRow()];

		expect(await reconcilePreferences()).toBe(1);

		const [written] = matching('INSERT INTO preferences');
		expect(written.params[0]).toBe(CURRENCY);
		// O valor fica o último conhecido: a lápide também precisa passar na validação.
		expect(written.params[1]).toBe(BRL);
		expect(written.params[3]).toBe(written.params[2]);
	});

	it('relógio atrasado não perde a escolha: o carimbo passa da linha que já existe', async () => {
		mockStorage.set(CURRENCY, USD);
		mockOnAll = () => [preferenceRow({ updatedAt: '2999-01-01T00:00:00.000Z' })];

		await reconcilePreferences();

		expect(matching('INSERT INTO preferences')[0].params[2]).toBe('2999-01-01T00:00:00.001Z');
	});

	it('tudo igual: nada é gravado', async () => {
		mockStorage.set(CURRENCY, BRL);
		mockOnAll = () => [preferenceRow()];

		expect(await reconcilePreferences()).toBe(0);
		expect(matching('INSERT INTO preferences')).toEqual([]);
	});

	it('o aviso de captura dispensado não entra: o acesso que ele avisa é de cada aparelho', async () => {
		mockStorage.set(STORAGE_KEYS.captureAccessDismissed, '1');

		expect(await reconcilePreferences()).toBe(0);
		expect(matching('INSERT INTO preferences')).toEqual([]);
	});
});

describe('gravar uma preferência', () => {
	it('vai para o AsyncStorage e para a tabela, suja', async () => {
		await setPreference(CURRENCY, USD);

		expect(mockStorage.get(CURRENCY)).toBe(USD);
		const [written] = matching('INSERT INTO preferences');
		expect(written.params[0]).toBe(CURRENCY);
		expect(written.params[1]).toBe(USD);
		expect(written.params[3]).toBeNull();
		expect(flat(written.sql)).toContain(', 1)');
	});

	it('nulo apaga: sai do AsyncStorage e vira lápide', async () => {
		mockStorage.set(CURRENCY, USD);
		mockOnFirst = (sql) => (sql.includes('FROM preferences') ? { value: USD, updatedAt: '2026-10-01T00:00:00.000Z' } : null);

		await setPreference(CURRENCY, null);

		expect(mockStorage.has(CURRENCY)).toBe(false);
		const [written] = matching('INSERT INTO preferences');
		expect(written.params[1]).toBe(USD);
		expect(written.params[3]).not.toBeNull();
	});
});

// ---------------------------------------------------------------------------
// A contagem do primeiro login
// ---------------------------------------------------------------------------

describe('o que o aparelho tem', () => {
	const ZERO = {
		transactions: 0,
		recurringTransactions: 0,
		budgets: 0,
		accounts: 0,
		transfers: 0,
		debts: 0,
		customCategories: 0,
		captures: 0,
		merchantRules: 0,
		retirementGoals: 0,
		reserveGoals: 0,
		bills: 0,
	};

	it('conta todas as coleções do sync, só as linhas vivas', async () => {
		mockOnFirst = () => ZERO;
		await countLocalData();

		const [query] = matching('SELECT');
		const sql = flat(query.sql);
		for (const table of [
			'transactions',
			'recurring_transactions',
			'budgets',
			'accounts',
			'transfers',
			'debts',
			'categories',
			'captures',
			'merchant_rules',
			'retirement_goals',
			'reserve_goals',
			'bills',
		]) {
			expect(sql).toContain(`FROM ${table} WHERE deletedAt IS NULL`);
		}
	});

	it('só a caixa de entrada já é dado a proteger', async () => {
		mockOnFirst = () => ({ ...ZERO, captures: 14 });
		expect(await countLocalData()).toEqual({ ...ZERO, captures: 14, total: 14 });
	});

	it.each([
		['regras aprendidas', 'merchantRules'],
		['a meta de aposentadoria', 'retirementGoals'],
		['a reserva de emergência', 'reserveGoals'],
		['contas a pagar', 'bills'],
	])('só %s também', async (_label, field) => {
		mockOnFirst = () => ({ ...ZERO, [field]: 1 });
		expect((await countLocalData()).total).toBe(1);
	});

	it('aparelho novo não conta como dados: as categorias padrão e as preferências ficam de fora', async () => {
		mockOnFirst = () => ZERO;
		expect((await countLocalData()).total).toBe(0);

		const [query] = matching('SELECT');
		// As padrão saem pelo id — todo aparelho nasce com elas.
		expect(query.params).toEqual(DEFAULT_CATEGORIES.map((category) => category.id));
		// Moeda e idioma não são "dados da conta": juntam linha a linha pelo carimbo, e um
		// aparelho que só escolheu o idioma não pode fazer todo login perguntar.
		expect(query.sql).not.toContain('preferences');
	});
});
