/**
 * Juntar sozinho a ficha duplicada vazia (SPD-116, DEC-36 Q4), no SQL **de verdade** e no
 * `AccountsProvider` de verdade. O par é o do aviso "Duas contas do mesmo banco": a ficha que a
 * captura criou (app ligado, nome do banco, saldo 0) e a que o usuário cadastrou à mão com o
 * saldo. Quando a da captura está totalmente vazia, ela vai para a outra uma vez, e a tela de
 * Contas ganha o aviso "Juntamos X em Y". Com qualquer coisa ligada a ela, ou com o par marcado
 * como contas diferentes, nada junta.
 *
 * Como em `accountsCardMergeSql.test.tsx`, o `expo-sqlite` vira o `node:sqlite` em memória e a
 * suíte pede `NODE_OPTIONS=--experimental-sqlite`; sem a flag, é pulada com um aviso.
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

jest.mock('@react-native-async-storage/async-storage', () =>
	require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
const mockSyncState = { status: 'idle' };
jest.mock('../../sync/queue', () => ({ schedule: jest.fn(), getState: () => mockSyncState }));
jest.mock('../../hooks/useAfterPull', () => ({ useAfterPull: jest.fn() }));
jest.mock('../../api/cdi', () => ({
	loadCachedCdi: jest.fn(async () => null),
	refreshCdi: jest.fn(async () => null),
}));

// A mesma lista a cada render: uma nova dispararia a recarga sem parar.
const mockLedger = {
	transactions: [],
	categories: [],
	refreshData: jest.fn(async () => undefined),
};
jest.mock('../TransactionsContext', () => ({ useTransactions: () => mockLedger }));
const mockPeriod = { startDate: '2026-11-01', endDate: '2026-11-30' };
jest.mock('../PeriodContext', () => ({ usePeriod: () => mockPeriod }));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { insertCapture } from '../../database/captures';
import { addAccount, addTransaction, db, getAccount, initDatabase } from '../../database/database';
import type { AccountDraft } from '../../database/schema';
import { attachDiary } from '../../diagnostics/log';
import * as syncQueue from '../../sync/queue';
import { AUTO_MERGE_NOTICES_KEY } from '../../utils/autoMergeNotices';
import { setBusinessFeed } from '../../utils/businessFeedPreference';
import { markAccountsDistinct } from '../../utils/distinctAccounts';
import { AccountsProvider, useAccounts } from '../AccountsContext';

const sqliteAvailable: boolean = jest.requireMock<{ mockSqliteAvailable: boolean }>('expo-sqlite').mockSqliteAvailable;
if (!sqliteAvailable) {
	console.warn('accountsAutoMergeSql.test.tsx pulado: rode com NODE_OPTIONS=--experimental-sqlite (Node 22.12).');
}
const describeSql = sqliteAvailable ? describe : describe.skip;

/** A conta como a captura cria (`newAccountDraft`): nome do banco, app ligado, saldo 0. */
const fromCapture = (overrides: Partial<AccountDraft> = {}): AccountDraft => ({
	name: 'Banco Teste',
	kind: 'checking',
	role: 'main',
	envelopeMonthlyCents: null,
	bankName: 'Banco Teste',
	color: '#4CAF50',
	last4: null,
	network: null,
	closingDay: null,
	dueDay: null,
	closingDaysBefore: null,
	creditLimitCents: null,
	cardNames: null,
	yieldCdiBp: null,
	reservePurpose: null,
	packageName: 'br.com.bancoteste',
	accountKey: null,
	openingBalanceCents: 0,
	openingBalanceDate: '2026-11-05',
	sortOrder: 0,
	archived: false,
	...overrides,
});

/** A cadastrada à mão, com o saldo que o banco mostrava: R$ 1.234,56. */
const byHand = (overrides: Partial<AccountDraft> = {}): AccountDraft =>
	fromCapture({ name: 'Corrente', packageName: null, openingBalanceCents: 123_456, openingBalanceDate: '2026-11-01', sortOrder: 1, ...overrides });

type Accounts = ReturnType<typeof useAccounts>;
let current: Accounts | null = null;
const Probe = () => {
	current = useAccounts();
	return null;
};
const ctx = (): Accounts => {
	if (!current) throw new Error('provider não montou');
	return current;
};

let renderer: ReactTestRenderer | null = null;

/** Deixa as recargas do provider (e a junção que vem depois delas) terminarem. */
const settle = async () => {
	for (let i = 0; i < 12; i++) {
		await act(async () => {
			await new Promise((resolve) => setImmediate(resolve));
		});
	}
};

const mount = async () => {
	await act(async () => {
		renderer = create(
			<AccountsProvider>
				<Probe />
			</AccountsProvider>
		);
	});
	await settle();
};

const unmount = () => {
	act(() => renderer?.unmount());
	renderer = null;
	current = null;
};

const liveNames = () => ctx().accounts.filter((account) => !account.deletedAt).map((account) => account.name);

const diary = jest.fn();

describeSql('juntar sozinho a ficha duplicada vazia (SPD-116)', () => {
	let captura: string;
	let mao: string;

	beforeAll(async () => {
		jest.spyOn(console, 'log').mockImplementation(() => undefined);
		await initDatabase();
	});

	beforeEach(async () => {
		// Só o relógio é falso (hoje = 07/11/2026): com os timers falsos o `act` não termina.
		jest.useFakeTimers({
			now: new Date(2026, 10, 7, 12, 0, 0),
			doNotFake: [
				'hrtime',
				'nextTick',
				'performance',
				'queueMicrotask',
				'requestAnimationFrame',
				'cancelAnimationFrame',
				'requestIdleCallback',
				'cancelIdleCallback',
				'setImmediate',
				'clearImmediate',
				'setInterval',
				'clearInterval',
				'setTimeout',
				'clearTimeout',
			],
		});
		jest.clearAllMocks();
		mockSyncState.status = 'idle';
		attachDiary(diary);
		await AsyncStorage.clear();
		await db.execAsync(
			'DELETE FROM transactions; DELETE FROM transfers; DELETE FROM accounts; DELETE FROM captures; DELETE FROM bills; DELETE FROM debts; DELETE FROM preferences;'
		);
		captura = await addAccount(fromCapture());
		mao = await addAccount(byHand());
	});

	afterEach(() => {
		unmount();
		attachDiary(null);
		jest.useRealTimers();
	});

	it('a ficha da captura vazia vai para a cadastrada à mão, que ganha o app e mantém o saldo', async () => {
		await mount();

		expect(liveNames()).toEqual(['Corrente']);
		const kept = ctx().accounts.find((account) => account.id === mao);
		expect(kept?.packageName).toBe('br.com.bancoteste');
		expect(ctx().balances.get(mao)).toBe(123_456);
		// O `mergeAccounts` de sempre: lápide suja na que saiu, e o sync agendado.
		const gone = await getAccount(captura);
		expect(gone?.deletedAt).toBeTruthy();
		const dirty = await db.getFirstAsync<{ dirty: number }>('SELECT dirty FROM accounts WHERE id = ?', [captura]);
		expect(dirty?.dirty).toBe(1);
		expect(syncQueue.schedule).toHaveBeenCalled();
		// O aviso, com os nomes, para a tela de Contas; guardado no aparelho.
		expect(ctx().autoMergeNotices).toEqual([{ from: 'Banco Teste', into: 'Corrente' }]);
		expect(JSON.parse((await AsyncStorage.getItem(AUTO_MERGE_NOTICES_KEY)) ?? '[]')).toEqual([{ from: 'Banco Teste', into: 'Corrente' }]);
		// O diário registra a decisão sem nome nem valor.
		expect(diary).toHaveBeenCalledTimes(1);
		expect(diary).toHaveBeenCalledWith('app', 'account_auto_merged', { data: { reason: 'empty_duplicate' } });
		expect(JSON.stringify(diary.mock.calls)).not.toMatch(/Banco Teste|Corrente|123/);
	});

	it('junta uma vez: recarregar e abrir o app de novo não junta nem avisa outra vez', async () => {
		await mount();
		await act(async () => {
			await ctx().refresh();
		});
		await settle();
		expect(diary).toHaveBeenCalledTimes(1);
		expect(ctx().autoMergeNotices).toHaveLength(1);

		unmount();
		await mount();
		expect(liveNames()).toEqual(['Corrente']);
		expect(diary).toHaveBeenCalledTimes(1);
		// O aviso ainda não visto volta da gravação, um só.
		expect(ctx().autoMergeNotices).toEqual([{ from: 'Banco Teste', into: 'Corrente' }]);
	});

	it('a tela mostrou: o aviso sai, aqui e no aparelho', async () => {
		await mount();
		await act(async () => {
			ctx().dismissAutoMergeNotices();
		});
		await settle();
		expect(ctx().autoMergeNotices).toEqual([]);
		expect(await AsyncStorage.getItem(AUTO_MERGE_NOTICES_KEY)).toBeNull();
	});

	it('com um lançamento na ficha da captura, as duas ficam e o aviso de sempre pergunta', async () => {
		await addTransaction({ accountId: captura, date: '2026-11-06', amountCents: 4_590, isIncome: false, category: 'food', note: 'Padaria' });
		await mount();
		expect(liveNames().sort()).toEqual(['Banco Teste', 'Corrente']);
		expect(ctx().autoMergeNotices).toEqual([]);
		expect(diary).not.toHaveBeenCalled();
	});

	it('com uma captura ligada (mesmo descartada), as duas ficam', async () => {
		await insertCapture({
			fingerprint: 'fp-1',
			packageName: 'br.com.bancoteste',
			appLabel: 'Banco Teste',
			title: 'Compra',
			text: 'Compra aprovada',
			postedAt: '2026-11-06T10:00:00.000Z',
			amountCents: 4_590,
			direction: 'out',
			kind: 'purchase',
			counterparty: null,
			merchantKey: null,
			cardLast4: null,
			status: 'dismissed',
			question: null,
			relatedId: null,
			suggestedCategory: null,
			transactionId: null,
			autoConfirmed: false,
			reason: null,
			accountId: captura,
			transferId: null,
			installments: null,
		});
		await mount();
		expect(liveNames().sort()).toEqual(['Banco Teste', 'Corrente']);
		expect(diary).not.toHaveBeenCalled();
	});

	it('o par marcado como contas diferentes (PF e PJ) nunca junta sozinho', async () => {
		await markAccountsDistinct(captura, mao);
		await mount();
		expect(liveNames().sort()).toEqual(['Banco Teste', 'Corrente']);
		expect(ctx().autoMergeNotices).toEqual([]);
		expect(diary).not.toHaveBeenCalled();
	});

	it('o par com a conta escolhida para os avisos da PJ nunca junta sozinho', async () => {
		await setBusinessFeed('br.com.bancoteste', captura);
		await mount();
		expect(liveNames().sort()).toEqual(['Banco Teste', 'Corrente']);
		expect(diary).not.toHaveBeenCalled();
	});

	it('com o sync no meio espera; terminada a rodada, a recarga junta', async () => {
		mockSyncState.status = 'syncing';
		await mount();
		expect(liveNames().sort()).toEqual(['Banco Teste', 'Corrente']);

		mockSyncState.status = 'idle';
		await act(async () => {
			await ctx().refresh();
		});
		await settle();
		expect(liveNames()).toEqual(['Corrente']);
		expect(diary).toHaveBeenCalledTimes(1);
	});
});
