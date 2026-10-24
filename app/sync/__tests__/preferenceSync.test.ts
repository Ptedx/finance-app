/**
 * Preferências (v21) no motor do sync: a coleção `preferences` tem cursor e lugar em toda
 * lista de coleções, o que mudou no AsyncStorage vira linha suja antes de cada push, o
 * pull avisa as telas vivas, e um servidor que ainda não a conhece não a recebe — nem a
 * faz quebrar.
 */

// `sync/preferences.ts` lê a lista de chaves de `utils/storageUtils.ts`, que importa o
// AsyncStorage; o motor não o usa.
jest.mock('@react-native-async-storage/async-storage', () => ({}));

jest.mock('../../api/sync', () => ({
	pull: jest.fn(),
	push: jest.fn(),
	fetchSyncStatus: jest.fn(),
}));

jest.mock('../../database/database', () => ({
	applyPulledChanges: jest.fn(async () => undefined),
	countDirtyRows: jest.fn(async () => 0),
	getDirtyChanges: jest.fn(async () => ({
		categories: [],
		transactions: [],
		recurringTransactions: [],
		budgets: [],
	})),
	getSyncedIds: jest.fn(async () => new Set<string>()),
	getSyncState: jest.fn(async () => null),
	hasCategory: jest.fn(async () => false),
	markCategoryDirty: jest.fn(async () => undefined),
	markChangesClean: jest.fn(async () => undefined),
	reassignToUncategorized: jest.fn(async () => undefined),
	reconcilePreferences: jest.fn(async () => 0),
	repairPhantomAppAccounts: jest.fn(async () => 0),
	setSyncState: jest.fn(async () => undefined),
	stampEverything: jest.fn(async () => undefined),
}));

import * as api from '../../api/sync';
import {
	getDirtyChanges,
	getSyncedIds,
	getSyncState,
	markChangesClean,
	reconcilePreferences,
} from '../../database/database';
import { STORAGE_KEYS } from '../../utils/storageUtils';
import { claimSummaryParams } from '../claim';
import { pullAll, pushAll, replaceAccountWithDevice } from '../engine';
import { onPreferencesChanged } from '../preferenceEvents';
import { planPreferenceReconcile, SEED_PREFERENCE_TIMESTAMP } from '../preferences';
import { COLLECTIONS, TABLE_OF } from '../replace';
import {
	COLLECTION_SINCE_SCHEMA,
	countChanges,
	EMPTY_CHANGES,
	EMPTY_CURSOR,
	inheritCursor,
	onlyKnownCollections,
	type SyncChanges,
	type SyncCursor,
	type WirePreference,
} from '../types';

const emptyChanges = (overrides: Partial<SyncChanges> = {}): SyncChanges => ({
	categories: [],
	transactions: [],
	recurringTransactions: [],
	budgets: [],
	...overrides,
});

const preference = (id: string, value = '1'): WirePreference => ({
	id,
	value,
	updatedAt: '2026-10-20T12:00:00.000Z',
	deletedAt: null,
});

const CURRENCY = STORAGE_KEYS.selectedCurrency;

beforeEach(() => {
	jest.clearAllMocks();
	(api.push as jest.Mock).mockResolvedValue({
		serverTime: '2026-10-24T00:00:00.000Z',
		applied: 1,
		rejected: [],
	});
	(getDirtyChanges as jest.Mock).mockResolvedValue(emptyChanges());
	(getSyncState as jest.Mock).mockResolvedValue(null);
});

describe('o contrato da coleção `preferences`', () => {
	it('tem cursor próprio, desde o schema 21', () => {
		expect(EMPTY_CURSOR.preferences).toBe(0);
		expect(COLLECTION_SINCE_SCHEMA.preferences).toBe(21);
	});

	it('entra na remessa vazia e na contagem', () => {
		expect(EMPTY_CHANGES().preferences).toEqual([]);
		expect(countChanges(emptyChanges({ preferences: [preference('a'), preference('b')] }))).toBe(2);
	});

	it('o cursor herdado do v20 zera `preferences` e mantém o resto', () => {
		const legacy: SyncCursor = { ...EMPTY_CURSOR, transactions: 500, bills: 7, preferences: 9 };
		expect(inheritCursor(legacy, 20)).toEqual({ ...legacy, preferences: 0 });
	});

	it('está na lista da substituição, com a tabela dela', () => {
		expect(COLLECTIONS).toContain('preferences');
		expect(TABLE_OF.preferences).toBe('preferences');
	});

	it('um servidor que não conhece `preferences` não as recebe', () => {
		const known = new Set(Object.keys(EMPTY_CURSOR).filter((key) => key !== 'preferences'));
		const filtered = onlyKnownCollections(emptyChanges({ preferences: [preference(CURRENCY)] }), known);
		expect(filtered.preferences).toEqual([]);
	});
});

describe('o que o AsyncStorage tem e a tabela não', () => {
	const NOW = '2026-10-24T10:00:00.000Z';
	const row = (key: string, value: string, extra: Partial<{ updatedAt: string; deletedAt: string | null }> = {}) => ({
		key,
		value,
		updatedAt: '2026-10-01T00:00:00.000Z',
		deletedAt: null,
		...extra,
	});

	it('descoberta entra com o carimbo de semente; mudança e remoção, com o de agora', () => {
		const writes = planPreferenceReconcile(
			[row(STORAGE_KEYS.language, '{"code":"pt"}'), row(STORAGE_KEYS.cdiRate, '{"annualBp":1490}')],
			{ [CURRENCY]: '{"code":"BRL"}', [STORAGE_KEYS.language]: '{"code":"it"}', [STORAGE_KEYS.cdiRate]: null },
			NOW
		);

		expect(writes).toEqual([
			{ key: CURRENCY, value: '{"code":"BRL"}', updatedAt: SEED_PREFERENCE_TIMESTAMP, deletedAt: null },
			{ key: STORAGE_KEYS.cdiRate, value: '{"annualBp":1490}', updatedAt: NOW, deletedAt: NOW },
			{ key: STORAGE_KEYS.language, value: '{"code":"it"}', updatedAt: NOW, deletedAt: null },
		]);
	});

	it('a lápide que volta a ter valor revive com o carimbo de agora', () => {
		const writes = planPreferenceReconcile(
			[row(CURRENCY, 'x', { deletedAt: '2026-10-02T00:00:00.000Z' })],
			{ [CURRENCY]: 'x' },
			NOW
		);
		expect(writes).toEqual([{ key: CURRENCY, value: 'x', updatedAt: NOW, deletedAt: null }]);
	});

	it('nada mudou, nada a gravar; e o que não é sincronizado é ignorado', () => {
		expect(
			planPreferenceReconcile([row(CURRENCY, 'x')], { [CURRENCY]: 'x', [STORAGE_KEYS.captureAccessDismissed]: '1' }, NOW)
		).toEqual([]);
	});
});

describe('o push de preferências', () => {
	it('o AsyncStorage é conferido antes de ler o que está sujo', async () => {
		const order: string[] = [];
		(reconcilePreferences as jest.Mock).mockImplementationOnce(async () => {
			order.push('reconcile');
			return 1;
		});
		(getDirtyChanges as jest.Mock).mockImplementationOnce(async () => {
			order.push('dirty');
			return emptyChanges({ preferences: [preference(CURRENCY)] });
		});

		await pushAll();

		expect(order.slice(0, 2)).toEqual(['reconcile', 'dirty']);
		const sent = (api.push as jest.Mock).mock.calls[0][0] as SyncChanges;
		expect(sent.preferences).toEqual([preference(CURRENCY)]);
	});

	it('o aceito fica limpo; o recusado continua', async () => {
		(getDirtyChanges as jest.Mock)
			.mockResolvedValueOnce(emptyChanges({ preferences: [preference(CURRENCY), preference(STORAGE_KEYS.language)] }))
			.mockResolvedValue(emptyChanges());
		(api.push as jest.Mock).mockResolvedValue({
			serverTime: '2026-10-24T00:00:00.000Z',
			applied: 1,
			rejected: [{ collection: 'preferences', id: STORAGE_KEYS.language, reason: 'stale' }],
		});

		await pushAll();

		const cleaned = (markChangesClean as jest.Mock).mock.calls[0][0] as SyncChanges;
		expect(cleaned.preferences?.map((row) => row.id)).toEqual([CURRENCY]);
	});

	it('uma falha ao ler o AsyncStorage não impede o resto de subir', async () => {
		(reconcilePreferences as jest.Mock).mockRejectedValueOnce(new Error('AsyncStorage indisponível'));
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
		(getDirtyChanges as jest.Mock)
			.mockResolvedValueOnce(emptyChanges({ preferences: [preference(CURRENCY)] }))
			.mockResolvedValue(emptyChanges());

		await expect(pushAll()).resolves.toBe(1);
		warn.mockRestore();
	});

	it('servidor antigo (sem `preferences` no cursor): nada sobe, nada é limpo, e o push não quebra', async () => {
		const known = Object.keys(EMPTY_CURSOR).filter((key) => key !== 'preferences');
		(getSyncState as jest.Mock).mockImplementation(async (key: string) =>
			key === 'serverCollections' ? JSON.stringify(known) : null
		);
		(getDirtyChanges as jest.Mock).mockResolvedValue(emptyChanges({ preferences: [preference(CURRENCY)] }));

		await expect(pushAll()).resolves.toBe(0);

		expect(api.push).not.toHaveBeenCalled();
		expect(markChangesClean).not.toHaveBeenCalled();
	});
});

describe('o pull de preferências', () => {
	it('avisa as telas vivas de quais chaves chegaram', async () => {
		const heard: string[][] = [];
		const unsubscribe = onPreferencesChanged((keys) => heard.push(keys));
		(api.pull as jest.Mock).mockResolvedValue({
			serverTime: '2026-10-24T00:00:00.000Z',
			cursor: { ...EMPTY_CURSOR, preferences: 2 },
			hasMore: false,
			changes: emptyChanges({ preferences: [preference(CURRENCY), preference(STORAGE_KEYS.language)] }),
		});

		expect(await pullAll()).toBe(2);
		unsubscribe();

		expect(heard).toEqual([[CURRENCY, STORAGE_KEYS.language]]);
	});

	it('sem preferência na página, ninguém é acordado', async () => {
		const listener = jest.fn();
		const unsubscribe = onPreferencesChanged(listener);
		(api.pull as jest.Mock).mockResolvedValue({
			serverTime: '2026-10-24T00:00:00.000Z',
			cursor: EMPTY_CURSOR,
			hasMore: false,
			changes: emptyChanges(),
		});

		await pullAll();
		unsubscribe();

		expect(listener).not.toHaveBeenCalled();
	});

	it('servidor antigo: resposta sem `preferences` nem cursor dela não quebra o pull', async () => {
		const { preferences: _preferences, ...oldCursor } = EMPTY_CURSOR;
		(api.pull as jest.Mock).mockResolvedValue({
			serverTime: '2026-10-24T00:00:00.000Z',
			cursor: oldCursor,
			hasMore: false,
			changes: emptyChanges(),
		});

		await expect(pullAll()).resolves.toBe(0);
	});
});

describe('subir deste aparelho', () => {
	it('confere o AsyncStorage antes de decidir o que da conta vira lápide', async () => {
		// Sem isso, um aparelho que nunca sincronizou não tem linha de preferência nenhuma,
		// a moeda da conta vira lápide, e o pull seguinte apaga a moeda daqui também.
		const order: string[] = [];
		(reconcilePreferences as jest.Mock).mockImplementation(async () => {
			order.push('reconcile');
			return 0;
		});
		(getSyncedIds as jest.Mock).mockImplementation(async (table: string) => {
			order.push(`ids:${table}`);
			return new Set<string>();
		});
		(api.pull as jest.Mock).mockResolvedValue({
			serverTime: '2026-10-24T00:00:00.000Z',
			cursor: EMPTY_CURSOR,
			hasMore: false,
			changes: emptyChanges(),
		});

		await replaceAccountWithDevice();

		expect(order[0]).toBe('reconcile');
		expect(order).toContain('ids:preferences');
	});
});

describe('o resumo da pergunta do login', () => {
	it('um servidor antigo manda só quatro contagens: o resto vira zero, nunca `undefined`', () => {
		expect(
			claimSummaryParams({ transactions: 3, recurringTransactions: 1, budgets: 2, customCategories: 4 })
		).toEqual({
			transactions: 3,
			categories: 4,
			accounts: 0,
			transfers: 0,
			recurring: 1,
			budgets: 2,
			debts: 0,
			captures: 0,
			rules: 0,
		});
	});

	it('a caixa de entrada e as regras aparecem, dos dois lados', () => {
		expect(
			claimSummaryParams({
				transactions: 0,
				recurringTransactions: 0,
				budgets: 0,
				customCategories: 0,
				accounts: 2,
				transfers: 1,
				debts: 1,
				captures: 14,
				merchantRules: 6,
			})
		).toMatchObject({ accounts: 2, transfers: 1, debts: 1, captures: 14, rules: 6 });
	});
});
