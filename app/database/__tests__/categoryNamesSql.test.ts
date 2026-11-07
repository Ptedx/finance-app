/**
 * As categorias padrão no idioma do app (SPD-088, E2E-11) no SQL **de verdade** de
 * `database.ts`: o `expo-sqlite` vira um banco em memória do próprio Node (`node:sqlite`),
 * como em `wipeSql.test.ts`. Sem `NODE_OPTIONS=--experimental-sqlite` a suíte é pulada com
 * um aviso.
 *
 * A pergunta é o carimbo de cada renomeação. A padrão recém-semeada (carimbo de 1970, limpa)
 * troca de nome sem deixar de perder para a versão da conta — senão um aparelho novo, no
 * primeiro login, desfaria os nomes que o usuário deu na conta. A que já veio da conta troca
 * como qualquer edição: carimbo de agora e suja, para subir pelo sync.
 */

jest.mock('expo-sqlite', () => {
	const { createRequire } = jest.requireActual('module');
	let DatabaseSync:
		| (new (
				path: string
		  ) => {
				exec: (sql: string) => void;
				prepare: (sql: string) => {
					run: (...params: unknown[]) => {
						changes: number | bigint;
						lastInsertRowid: number | bigint;
					};
					get: (...params: unknown[]) => unknown;
					all: (...params: unknown[]) => unknown[];
				};
		  })
		| null = null;
	try {
		DatabaseSync = createRequire(__filename)('node:sqlite').DatabaseSync;
	} catch {
		DatabaseSync = null;
	}
	const normalise = (params: unknown[] = []) =>
		params.map((value) =>
			typeof value === 'boolean' ? (value ? 1 : 0) : value === undefined ? null : value
		);
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
					return {
						changes: Number(result.changes),
						lastInsertRowId: Number(result.lastInsertRowid),
					};
				},
				getFirstAsync: async (sql: string, params: unknown[] = []) =>
					raw.prepare(sql).get(...normalise(params)) ?? null,
				getAllAsync: async (sql: string, params: unknown[] = []) =>
					raw.prepare(sql).all(...normalise(params)),
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

const mockStorage = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
	getItem: jest.fn(async (key: string) => mockStorage.get(key) ?? null),
	setItem: jest.fn(async (key: string, value: string) => {
		mockStorage.set(key, value);
	}),
	removeItem: jest.fn(async (key: string) => {
		mockStorage.delete(key);
	}),
	multiRemove: jest.fn(async () => undefined),
	multiGet: jest.fn(async (keys: string[]) =>
		keys.map((key) => [key, mockStorage.get(key) ?? null])
	),
}));

jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'pt' }] }));

import { localizeDefaultCategories } from '../../utils/defaultCategoryNames';
import { STORAGE_KEYS } from '../../utils/storageUtils';
import { db, initDatabase } from '../database';
import { DEFAULT_CATEGORIES } from '../schema';

const sqliteAvailable: boolean = jest.requireMock<{ mockSqliteAvailable: boolean }>(
	'expo-sqlite'
).mockSqliteAvailable;
if (!sqliteAvailable) {
	console.warn(
		'categoryNamesSql.test.ts pulado: rode com NODE_OPTIONS=--experimental-sqlite (Node 22.12).'
	);
}
const describeSql = sqliteAvailable ? describe : describe.skip;

const SEED = '1970-01-01T00:00:00.000Z';
const FROM_ACCOUNT = '2026-10-20T12:00:00.000Z';
const DEAD = '2026-10-21T12:00:00.000Z';

type Row = { id: string; name: string; updatedAt: string; deletedAt: string | null; dirty: number };

const row = async (id: string): Promise<Row> =>
	(await db.getFirstAsync<Row>(
		'SELECT id, name, updatedAt, deletedAt, dirty FROM categories WHERE id = ?',
		[id]
	)) as Row;

const chooseLanguage = (code: string) =>
	mockStorage.set(STORAGE_KEYS.language, JSON.stringify({ code }));

describeSql('categorias padrão no idioma do app, SQL de verdade (SPD-088)', () => {
	beforeAll(async () => {
		jest.spyOn(console, 'log').mockImplementation(() => undefined);
		await initDatabase();
	});

	beforeEach(async () => {
		mockStorage.clear();
		// Volta à semente: as 16 em inglês, carimbo de 1970, limpas.
		await db.execAsync('DELETE FROM categories;');
		for (const category of DEFAULT_CATEGORIES) {
			await db.runAsync(
				`INSERT INTO categories (id, name, color, icon, type, nature, updatedAt, deletedAt, dirty)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0)`,
				[
					category.id,
					category.name,
					category.color,
					category.icon,
					category.type,
					category.nature,
					SEED,
				]
			);
		}
	});

	it('a semente nasce em inglês (o que o aparelho mostrava com o app em português)', async () => {
		expect((await row('other_expense')).name).toBe('Other Expense');
	});

	it('recém-semeada: troca o nome e continua perdendo para a conta (1970, limpa)', async () => {
		await localizeDefaultCategories();

		expect(await row('other_expense')).toEqual({
			id: 'other_expense',
			name: 'Outras despesas',
			updatedAt: SEED,
			deletedAt: null,
			dirty: 0,
		});
		expect((await row('shopping')).name).toBe('Compras');
		expect((await row('passthrough')).name).toBe('Repasse');
	});

	it('vinda da conta em inglês: troca como uma edição, com carimbo novo e suja para subir', async () => {
		await db.runAsync("UPDATE categories SET updatedAt = ? WHERE id = 'food'", [FROM_ACCOUNT]);

		const changed = await localizeDefaultCategories();

		const food = await row('food');
		expect(food.name).toBe('Alimentação');
		expect(food.dirty).toBe(1);
		expect(food.updatedAt > FROM_ACCOUNT).toBe(true);
		expect(changed).toBe(DEFAULT_CATEGORIES.length - 1);
	});

	it('renomeada pelo usuário ou apagada: não é tocada', async () => {
		await db.runAsync(
			"UPDATE categories SET name = 'Mercado', updatedAt = ?, dirty = 1 WHERE id = 'food'",
			[FROM_ACCOUNT]
		);
		await db.runAsync(
			"UPDATE categories SET deletedAt = ?, updatedAt = ?, dirty = 1 WHERE id = 'gift'",
			[DEAD, DEAD]
		);

		await localizeDefaultCategories();

		expect(await row('food')).toEqual({
			id: 'food',
			name: 'Mercado',
			updatedAt: FROM_ACCOUNT,
			deletedAt: null,
			dirty: 1,
		});
		expect((await row('gift')).name).toBe('Gift');
	});

	it('trocar o idioma em Ajustes leva as padrão junto, e voltar desfaz', async () => {
		chooseLanguage('it');
		await localizeDefaultCategories();
		expect((await row('other_expense')).name).toBe('Altre spese');

		chooseLanguage('en');
		await localizeDefaultCategories();
		const names = await db.getAllAsync<{ id: string; name: string }>(
			'SELECT id, name FROM categories'
		);
		for (const category of DEFAULT_CATEGORIES) {
			expect(names).toContainEqual({ id: category.id, name: category.name });
		}
	});

	it('idioma só detectado: não desfaz o português que outro aparelho deu', async () => {
		await db.runAsync(
			"UPDATE categories SET name = 'Outras despesas', updatedAt = ? WHERE id = 'other_expense'",
			[FROM_ACCOUNT]
		);
		jest.requireMock<{ getLocales: () => unknown }>('expo-localization').getLocales = () => [
			{ languageCode: 'it' },
		];
		try {
			await localizeDefaultCategories();
		} finally {
			jest.requireMock<{ getLocales: () => unknown }>('expo-localization').getLocales = () => [
				{ languageCode: 'pt' },
			];
		}

		expect(await row('other_expense')).toMatchObject({ name: 'Outras despesas', dirty: 0 });
		// O que ainda estava no inglês da semente vai para o italiano do aparelho.
		expect((await row('shopping')).name).toBe('Acquisti');
	});

	it('rodando de novo, nada muda: nem carimbo, nem sujeira', async () => {
		await db.runAsync('UPDATE categories SET updatedAt = ?', [FROM_ACCOUNT]);
		await localizeDefaultCategories();
		await db.runAsync('UPDATE categories SET dirty = 0');
		const before = await db.getAllAsync<Row>(
			'SELECT id, name, updatedAt, deletedAt, dirty FROM categories ORDER BY id'
		);

		await expect(localizeDefaultCategories()).resolves.toBe(0);

		expect(
			await db.getAllAsync<Row>(
				'SELECT id, name, updatedAt, deletedAt, dirty FROM categories ORDER BY id'
			)
		).toEqual(before);
	});
});
