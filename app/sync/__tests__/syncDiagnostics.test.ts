/**
 * O sync no diário (SPD-014): um evento por metade do ciclo, com as contas por coleção,
 * as recusas agregadas e a falha com a fase e o status HTTP — nunca um por linha, e nunca
 * o id nem o conteúdo de uma linha.
 */

jest.mock('../../diagnostics/log', () => ({ ...jest.requireActual('../../diagnostics/log'), log: jest.fn() }));

jest.mock('../../api/sync', () => ({
	pull: jest.fn(),
	push: jest.fn(),
	fetchSyncStatus: jest.fn(),
}));

jest.mock('../../database/database', () => ({
	applyPulledChanges: jest.fn(async () => undefined),
	countDirtyRows: jest.fn(async () => 0),
	getDirtyChanges: jest.fn(),
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
import { getDirtyChanges, getSyncState, setSyncState } from '../../database/database';
import { log } from '../../diagnostics/log';
import { refusalCode } from '../../diagnostics/sync';
import { pullAll, pushAll, syncNow } from '../engine';
import { EMPTY_CHANGES, EMPTY_CURSOR, type SyncChanges } from '../types';

const logMock = log as jest.Mock;

const events = () =>
	logMock.mock.calls.map(([area, event, options]) => ({ area, event, level: options?.level, data: options?.data ?? {} }));

/** Linhas com id e conteúdo que não podem aparecer no diário. */
const row = (id: string) => ({ id, note: 'PADARIA ESTRELA', amountCents: 3590, updatedAt: '2026-10-24T00:00:00.000Z' }) as never;

const changes = (overrides: Partial<SyncChanges>): SyncChanges => ({ ...EMPTY_CHANGES(), ...overrides });

/** Um erro do cliente HTTP, pela forma (o `ApiError` de verdade puxa os tokens). */
const httpError = (status: number, code: string): Error =>
	Object.assign(new Error(`falhou com PADARIA ${status}`), { name: 'ApiError', status, code });

let warnSpy: jest.SpyInstance;

beforeEach(() => {
	jest.clearAllMocks();
	// O motor avisa no console as linhas recusadas; aqui o que se confere é o diário.
	warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
	(getSyncState as jest.Mock).mockResolvedValue(null);
	(getDirtyChanges as jest.Mock).mockResolvedValue(changes({}));
	(api.push as jest.Mock).mockResolvedValue({ serverTime: '', applied: 0, rejected: [] });
	(api.pull as jest.Mock).mockResolvedValue({ serverTime: '', changes: changes({}), cursor: EMPTY_CURSOR, hasMore: false });
});

afterEach(() => warnSpy.mockRestore());

describe('push', () => {
	it('um evento por ciclo: linhas por coleção, aceitas, recusadas e duração', async () => {
		(getDirtyChanges as jest.Mock)
			.mockResolvedValueOnce(changes({ transactions: [row('tx-secreto-1'), row('tx-secreto-2')], captures: [row('fp-secreto')] }))
			.mockResolvedValue(changes({}));
		(api.push as jest.Mock).mockResolvedValueOnce({
			serverTime: '',
			applied: 2,
			rejected: [{ collection: 'captures', id: 'fp-secreto', reason: 'invalid', message: 'o banco recusou a linha (P2003)' }],
		});

		await pushAll();

		const done = events().filter((entry) => entry.event === 'sync_push_done');
		expect(done).toHaveLength(1);
		expect(done[0]).toMatchObject({
			area: 'sync',
			data: {
				pages: 1,
				rows: 'transactions:2,captures:1',
				applied: 2,
				rejected: 1,
				stale: 0,
				unknownCategory: 0,
				invalid: 1,
				repaired: 0,
				heldBack: null,
			},
		});
		expect(typeof done[0].data.durationMs).toBe('number');
	});

	it('as linhas que o servidor não gravou: coleção e código, agregadas, sem id nem mensagem', async () => {
		(getDirtyChanges as jest.Mock)
			.mockResolvedValueOnce(changes({ transactions: [row('tx-secreto-1'), row('tx-secreto-2'), row('tx-secreto-3')] }))
			.mockResolvedValue(changes({}));
		(api.push as jest.Mock).mockResolvedValueOnce({
			serverTime: '',
			applied: 0,
			rejected: [
				{ collection: 'transactions', id: 'tx-secreto-1', reason: 'invalid', message: 'o banco recusou a linha (P2003)' },
				{ collection: 'transactions', id: 'tx-secreto-2', reason: 'invalid', message: 'o banco recusou a linha (P2003)' },
				{
					collection: 'transactions',
					id: 'tx-secreto-3',
					reason: 'invalid',
					message: "kind: Invalid enum value. Expected 'in' | 'out', received 'PADARIA ESTRELA'",
				},
			],
		});

		await pushAll();

		const refused = events().find((entry) => entry.event === 'sync_rows_refused');
		expect(refused).toMatchObject({
			level: 'warn',
			data: { count: 3, refused: 'transactions/P2003=2,transactions/validation:kind=1' },
		});
		const text = JSON.stringify(logMock.mock.calls);
		expect(text).not.toMatch(/secreto|PADARIA|3590/);
	});

	it('nada a subir: sem evento (o do pull marca o ciclo)', async () => {
		await pushAll();

		expect(events()).toEqual([]);
	});

	it('coleção que o servidor ainda não conhece fica para depois, e o diário diz quantas', async () => {
		(getSyncState as jest.Mock).mockImplementation(async (key: string) =>
			key === 'serverCollections' ? JSON.stringify(['categories', 'transactions']) : null
		);
		(getDirtyChanges as jest.Mock).mockResolvedValue(changes({ bills: [row('conta-secreta')] }));

		await pushAll();

		expect(events()).toEqual([
			expect.objectContaining({ event: 'sync_push_done', data: expect.objectContaining({ pages: 0, heldBack: 'bills:1' }) }),
		]);
	});

	it('o motivo de uma recusa, sem o dado', () => {
		expect(refusalCode({ reason: 'stale' })).toBe('stale');
		expect(refusalCode({ reason: 'invalid', message: 'o banco recusou a linha (P2002)' })).toBe('P2002');
		expect(refusalCode({ reason: 'invalid', message: 'o banco recusou a linha' })).toBe('db');
		expect(refusalCode({ reason: 'invalid', message: 'note: String must contain at most 500 character(s)' })).toBe(
			'validation:note'
		);
		expect(refusalCode({ reason: 'invalid', message: 'texto livre PADARIA: R$ 35,90' })).toBe('validation');
		expect(refusalCode({ reason: 'invalid' })).toBe('validation');
	});
});

describe('pull', () => {
	it('linhas recebidas, cursor que andou e coleções desconhecidas puladas', async () => {
		(api.pull as jest.Mock).mockResolvedValueOnce({
			serverTime: '',
			changes: { ...changes({ transactions: [row('tx-secreto-1'), row('tx-secreto-2')] }), goals: [row('meta-secreta')] },
			cursor: { ...EMPTY_CURSOR, transactions: 7 },
			hasMore: false,
		});

		await pullAll();

		expect(events()).toEqual([
			{
				area: 'sync',
				event: 'sync_pull_done',
				level: undefined,
				data: expect.objectContaining({
					pages: 1,
					received: 3,
					rows: 'transactions:2,goals:1',
					cursorMoved: true,
					complete: true,
					unknownCollections: 'goals:1',
					phantomAccountsRemoved: 0,
				}),
			},
		]);
		expect(JSON.stringify(logMock.mock.calls)).not.toMatch(/secreto|secreta|PADARIA/);
	});

	it('nada novo: o cursor não anda', async () => {
		await pullAll();

		expect(events()[0].data).toMatchObject({ pages: 1, received: 0, rows: '', cursorMoved: false });
	});

	it('o teto de páginas: incompleto', async () => {
		(api.pull as jest.Mock).mockImplementation(async (cursor: typeof EMPTY_CURSOR) => ({
			serverTime: '',
			changes: changes({ transactions: [row('tx')] }),
			cursor: { ...cursor, transactions: cursor.transactions + 1 },
			hasMore: true,
		}));

		await pullAll();

		expect(events()[0].data).toMatchObject({ pages: 40, received: 40, complete: false, cursorMoved: true });
	});
});

describe('falha do ciclo', () => {
	it('pull sem rede: fase, status e código, em warn; o erro segue para quem chamou', async () => {
		const error = httpError(503, 'gateway_unreachable');
		(api.pull as jest.Mock).mockRejectedValueOnce(error);

		await expect(pullAll()).rejects.toBe(error);

		expect(events()).toEqual([
			{
				area: 'sync',
				event: 'sync_failed',
				level: 'warn',
				data: {
					phase: 'pull',
					error: 'ApiError',
					status: 503,
					offline: true,
					code: 'gateway_unreachable',
					pages: 0,
					cursorMoved: false,
				},
			},
		]);
	});

	it('push com erro do servidor: em error; a mensagem não entra', async () => {
		(getDirtyChanges as jest.Mock).mockResolvedValue(changes({ transactions: [row('tx-secreto-1')] }));
		(api.push as jest.Mock).mockRejectedValueOnce(httpError(500, 'error'));

		await expect(syncNow()).rejects.toThrow();

		expect(events()).toEqual([
			expect.objectContaining({
				event: 'sync_failed',
				level: 'error',
				data: expect.objectContaining({ phase: 'push', status: 500, offline: false, pages: 0 }),
			}),
		]);
		expect(JSON.stringify(logMock.mock.calls)).not.toMatch(/PADARIA|secreto/);
	});

	it('falha depois do push e do pull: fase finish', async () => {
		(setSyncState as jest.Mock).mockImplementation(async (key: string) => {
			if (key === 'lastSyncedAt') throw new RangeError('disco');
		});

		await expect(syncNow()).rejects.toThrow('disco');

		expect(events().map((entry) => [entry.event, entry.data.phase ?? null])).toEqual([
			['sync_pull_done', null],
			['sync_failed', 'finish'],
		]);
		expect(events()[1].data).toMatchObject({ error: 'RangeError' });
		(setSyncState as jest.Mock).mockImplementation(async () => undefined);
	});
});
