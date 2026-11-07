/**
 * A conta foi apagada em outro aparelho: este fica sabendo pelo sync e apaga a sua cópia
 * (SPD-083, DEC-35).
 *
 * Três jeitos de ficar sabendo — o `dataWipedAt` do pull, o do `/sync/status` no login e o
 * 409 `data_wiped` do push — e uma regra só (`sync/accountWipe.ts`): o aparelho que já
 * sincronizava com a conta apaga; o que está entrando nela pela primeira vez só passa a
 * conhecer o apagar, porque o que ele tem nunca esteve na conta.
 *
 * O que se confere aqui é o motor: a página que chegou com o apagar novo não é gravada
 * (ela pode ter sido lida antes do apagar), o cursor recomeça, nada apagado sobe depois,
 * e um 409 vira uma nova tentativa — uma só, nunca um laço.
 *
 * O `sync_state` é um Map e o apagar do aparelho é um mock que faz o que `wipeDevice` faz
 * com o estado de sync: grava a marca. O que ele faz no disco está em `wipeSql.test.ts`.
 */

jest.mock('../../api/sync', () => ({
	pull: jest.fn(),
	push: jest.fn(),
	fetchSyncStatus: jest.fn(),
}));

const mockSyncState = new Map<string, string>();
/** O aparelho já foi apagado: a partir daí, as linhas apagadas não estão mais sujas. */
const mockDevice = { wiped: false };

jest.mock('../../database/database', () => ({
	applyPulledChanges: jest.fn(async () => undefined),
	countDirtyRows: jest.fn(async () => 0),
	getDirtyChanges: jest.fn(),
	getSyncedIds: jest.fn(async () => new Set<string>()),
	getSyncState: jest.fn(async (key: string) => mockSyncState.get(key) ?? null),
	hasCategory: jest.fn(async () => false),
	markCategoryDirty: jest.fn(async () => undefined),
	markChangesClean: jest.fn(async () => undefined),
	reassignToUncategorized: jest.fn(async () => undefined),
	reconcilePreferences: jest.fn(async () => 0),
	repairPhantomAppAccounts: jest.fn(async () => 0),
	setSyncState: jest.fn(async (key: string, value: string | null) => {
		if (value === null) mockSyncState.delete(key);
		else mockSyncState.set(key, value);
	}),
	stampEverything: jest.fn(async () => undefined),
}));

import * as api from '../../api/sync';
import { applyPulledChanges, getDirtyChanges } from '../../database/database';
import { SCHEMA_VERSION } from '../../database/schema';
import {
	getKnownWipeAt,
	learnAccountWipe,
	pullAll,
	pushAll,
	replaceAccountWithDevice,
	setAccountWipedHandler,
	syncNow,
} from '../engine';
import { EMPTY_CURSOR, KNOWN_WIPE_AT_KEY, type SyncChanges } from '../types';

const CURSOR_KEY = `pullCursor@${SCHEMA_VERSION}`;
const WIPED_AT = '2026-10-27T10:00:00.000Z';
const WIPED_AGAIN = '2026-10-27T10:05:00.000Z';
const EARLIER = '2026-10-20T08:00:00.000Z';

const changes = (overrides: Partial<SyncChanges> = {}): SyncChanges => ({
	categories: [],
	transactions: [],
	recurringTransactions: [],
	budgets: [],
	...overrides,
});

const tx = (id: string) =>
	({
		id,
		amountCents: 5290,
		category: 'food',
		date: '2026-10-27',
		note: '',
		isIncome: false,
		updatedAt: '2026-10-27T09:00:00.000Z',
		deletedAt: null,
	}) as never;

const category = {
	id: 'pet',
	name: 'Pet',
	color: '#fff',
	icon: 'paw',
	type: 'expense',
	updatedAt: '2026-10-27T09:30:00.000Z',
	deletedAt: null,
} as never;

/** O 409 do servidor, com o corpo que o cliente HTTP guarda em `details`. */
const wipedRefusal = (dataWipedAt?: string) =>
	Object.assign(new Error('Os dados desta conta foram apagados.'), {
		name: 'ApiError',
		status: 409,
		code: 'data_wiped',
		details:
			dataWipedAt === undefined ? { code: 'data_wiped' } : { code: 'data_wiped', dataWipedAt },
	});

const page = (overrides: Record<string, unknown> = {}) => ({
	serverTime: '2026-10-27T10:00:01.000Z',
	cursor: { ...EMPTY_CURSOR, transactions: 70 },
	hasMore: false,
	changes: changes(),
	...overrides,
});

/** O que `wipeDevice` faz com o estado de sync: grava a marca, na mesma transação do apagar. */
const wipeDevice = jest.fn(async (dataWipedAt: string) => {
	mockDevice.wiped = true;
	mockSyncState.set(KNOWN_WIPE_AT_KEY, dataWipedAt);
});

/** Um aparelho que já sincronizou com esta conta: tem o último sync e o cursor dela. */
const alreadySynced = () => {
	mockSyncState.set('syncAccountId', 'conta-1');
	mockSyncState.set('lastSyncedAt', '2026-10-26T20:00:00.000Z');
	mockSyncState.set(CURSOR_KEY, JSON.stringify({ ...EMPTY_CURSOR, transactions: 40 }));
};

/** Acabou de entrar nesta conta: o vínculo existe, mas nada desceu nem subiu ainda. */
const firstSession = () => {
	mockSyncState.set('syncAccountId', 'conta-1');
};

const pushCalls = () => (api.push as jest.Mock).mock.calls as Array<[SyncChanges, string | null]>;

beforeEach(() => {
	jest.clearAllMocks();
	mockSyncState.clear();
	mockDevice.wiped = false;
	setAccountWipedHandler(wipeDevice);
	(api.push as jest.Mock).mockResolvedValue({
		serverTime: '2026-10-27T10:00:01.000Z',
		applied: 1,
		rejected: [],
	});
	(api.pull as jest.Mock).mockResolvedValue(page());
	(api.fetchSyncStatus as jest.Mock).mockResolvedValue({
		hasData: true,
		counts: {},
		dataWipedAt: WIPED_AT,
	});
	// Antes do apagar: um lançamento por subir. Depois: só a categoria editada, que fica.
	(getDirtyChanges as jest.Mock).mockImplementation(async () =>
		mockDevice.wiped
			? changes({ categories: [category] })
			: changes({ transactions: [tx('offline')] })
	);
});

afterAll(() => setAccountWipedHandler(null));

describe('o aparelho que já sincronizava com a conta', () => {
	it('push recusado (409): apaga uma vez, guarda a marca e sobe de novo sem nada apagado', async () => {
		alreadySynced();
		(api.push as jest.Mock).mockRejectedValueOnce(wipedRefusal(WIPED_AT));

		await pushAll();

		expect(wipeDevice).toHaveBeenCalledTimes(1);
		expect(wipeDevice).toHaveBeenCalledWith(WIPED_AT);
		expect(await getKnownWipeAt()).toBe(WIPED_AT);

		// A segunda remessa sai com a marca nova e sem o lançamento: ele saiu com o apagar.
		expect(pushCalls()).toHaveLength(2);
		const [retried, mark] = pushCalls()[1];
		expect(mark).toBe(WIPED_AT);
		expect(retried.transactions).toEqual([]);
		expect(retried.categories).toEqual([category]);

		// O cursor recomeça: a conta foi esvaziada, e o próximo pull a traz inteira de novo.
		expect(mockSyncState.has(CURSOR_KEY)).toBe(false);
	});

	it('pull com apagar novo: a página não é gravada, o aparelho é apagado e o pull recomeça do zero', async () => {
		alreadySynced();
		const stale = page({
			dataWipedAt: WIPED_AT,
			cursor: { ...EMPTY_CURSOR, transactions: 90 },
			// Lida antes de o servidor ler a marca: pode ser do que acabou de ser apagado.
			changes: changes({ transactions: [tx('de-antes-do-apagar')] }),
		});
		const fresh = page({
			dataWipedAt: WIPED_AT,
			cursor: { ...EMPTY_CURSOR, categories: 3, transactions: 95 },
			changes: changes({ categories: [category] }),
		});
		(api.pull as jest.Mock).mockResolvedValueOnce(stale).mockResolvedValueOnce(fresh);

		await pullAll();

		expect(wipeDevice).toHaveBeenCalledTimes(1);
		expect(wipeDevice).toHaveBeenCalledWith(WIPED_AT);
		expect(applyPulledChanges).toHaveBeenCalledTimes(1);
		expect(applyPulledChanges).toHaveBeenCalledWith(fresh.changes);
		// A primeira leitura partiu do cursor de antes; a segunda, do zero.
		expect((api.pull as jest.Mock).mock.calls[0][0]).toEqual({ ...EMPTY_CURSOR, transactions: 40 });
		expect((api.pull as jest.Mock).mock.calls[1][0]).toEqual(EMPTY_CURSOR);
		expect(JSON.parse(mockSyncState.get(CURSOR_KEY) ?? 'null')).toEqual(fresh.cursor);
		expect(await getKnownWipeAt()).toBe(WIPED_AT);
	});

	it('uma rodada inteira: apaga uma vez só, e o pull seguinte já não estranha a marca', async () => {
		alreadySynced();
		(api.push as jest.Mock).mockRejectedValueOnce(wipedRefusal(WIPED_AT));
		(api.pull as jest.Mock).mockResolvedValue(page({ dataWipedAt: WIPED_AT }));

		await syncNow();

		expect(wipeDevice).toHaveBeenCalledTimes(1);
		expect(applyPulledChanges).toHaveBeenCalledTimes(1);
	});

	it('apagar já conhecido: nada acontece', async () => {
		alreadySynced();
		mockSyncState.set(KNOWN_WIPE_AT_KEY, WIPED_AT);
		(api.pull as jest.Mock).mockResolvedValue(page({ dataWipedAt: WIPED_AT }));

		await syncNow();

		expect(wipeDevice).not.toHaveBeenCalled();
		expect(pushCalls()[0][1]).toBe(WIPED_AT);
		expect(applyPulledChanges).toHaveBeenCalledTimes(1);
	});

	it('um apagar anterior conhecido não impede de apagar de novo', async () => {
		alreadySynced();
		mockSyncState.set(KNOWN_WIPE_AT_KEY, EARLIER);
		(api.pull as jest.Mock).mockResolvedValue(page({ dataWipedAt: WIPED_AT }));

		await pullAll();

		expect(wipeDevice).toHaveBeenCalledWith(WIPED_AT);
	});
});

describe('o aparelho que está entrando na conta agora', () => {
	it('pull com apagar: não apaga nada, passa a conhecer a marca e relê a página', async () => {
		firstSession();
		const stale = page({
			dataWipedAt: WIPED_AT,
			changes: changes({ transactions: [tx('de-antes')] }),
		});
		const fresh = page({ dataWipedAt: WIPED_AT, changes: changes({ categories: [category] }) });
		(api.pull as jest.Mock).mockResolvedValueOnce(stale).mockResolvedValueOnce(fresh);

		await pullAll();

		expect(wipeDevice).not.toHaveBeenCalled();
		expect(await getKnownWipeAt()).toBe(WIPED_AT);
		expect(applyPulledChanges).toHaveBeenCalledTimes(1);
		expect(applyPulledChanges).toHaveBeenCalledWith(fresh.changes);
		// Nada foi apagado, então nada justifica perder o lugar: relê do mesmo cursor.
		expect((api.pull as jest.Mock).mock.calls[1][0]).toEqual(
			(api.pull as jest.Mock).mock.calls[0][0]
		);
	});

	it('o claim conhece o apagar pelo `/sync/status` antes do primeiro push, e o push o leva', async () => {
		firstSession();

		expect(await learnAccountWipe(WIPED_AT)).toBe('adopted');
		await pushAll();

		expect(wipeDevice).not.toHaveBeenCalled();
		expect(pushCalls()).toHaveLength(1);
		const [sent, mark] = pushCalls()[0];
		expect(mark).toBe(WIPED_AT);
		// O que foi criado aqui antes do login sobe inteiro.
		expect(sent.transactions).toEqual([tx('offline')]);
	});

	it('push recusado no primeiro upload (apagaram durante o login): conhece a marca e sobe tudo', async () => {
		firstSession();
		(api.push as jest.Mock).mockRejectedValueOnce(wipedRefusal(WIPED_AT));

		await pushAll();

		expect(wipeDevice).not.toHaveBeenCalled();
		expect(pushCalls()).toHaveLength(2);
		expect(pushCalls()[1][1]).toBe(WIPED_AT);
		expect(pushCalls()[1][0].transactions).toEqual([tx('offline')]);
	});

	it('com a escolha de dados pendente, nem um aparelho que já sincronizou apaga', async () => {
		// Entrou de novo na mesma conta sem o "sair" ter limpado nada, e a conta e o
		// aparelho têm dados: a pergunta está na tela, e o que está aqui é do usuário.
		alreadySynced();
		mockSyncState.set('pendingClaim', JSON.stringify({ accountId: 'conta-1', counts: {} }));
		(api.pull as jest.Mock).mockResolvedValue(page({ dataWipedAt: WIPED_AT }));

		await pullAll();

		expect(wipeDevice).not.toHaveBeenCalled();
		expect(await getKnownWipeAt()).toBe(WIPED_AT);
	});

	it('"subir deste aparelho" com a conta apagada no meio: refaz a foto da conta, sem lápide velha', async () => {
		firstSession();
		mockSyncState.set('pendingClaim', JSON.stringify({ accountId: 'conta-1', counts: {} }));
		// A foto da conta ainda tinha um lançamento que o apagar levou.
		(api.pull as jest.Mock)
			.mockResolvedValueOnce(
				page({ dataWipedAt: null, changes: changes({ transactions: [tx('so-na-conta')] }) })
			)
			.mockResolvedValue(page({ dataWipedAt: WIPED_AT }));
		(api.push as jest.Mock).mockRejectedValueOnce(wipedRefusal(WIPED_AT));

		await replaceAccountWithDevice();

		expect(wipeDevice).not.toHaveBeenCalled();
		expect(await getKnownWipeAt()).toBe(WIPED_AT);
		// A lápide recusada nunca é reenviada: a foto refeita não tem mais o lançamento.
		const tombstones = pushCalls().filter(([sent]) =>
			sent.transactions.some((row) => (row as { id: string }).id === 'so-na-conta')
		);
		expect(tombstones).toHaveLength(1);
		for (const [, mark] of pushCalls().slice(1)) expect(mark).toBe(WIPED_AT);
	});
});

describe('sem laço', () => {
	it('recusado de novo depois de aplicar a marca: para e falha, sem uma terceira tentativa', async () => {
		alreadySynced();
		(api.push as jest.Mock)
			.mockRejectedValueOnce(wipedRefusal(WIPED_AT))
			.mockRejectedValueOnce(wipedRefusal(WIPED_AGAIN));

		await expect(pushAll()).rejects.toMatchObject({ code: 'data_wiped' });

		expect(pushCalls()).toHaveLength(2);
		expect(wipeDevice).toHaveBeenCalledTimes(1);
	});

	it('o pull que traz outro apagar novo na mesma rodada também para', async () => {
		alreadySynced();
		(api.pull as jest.Mock)
			.mockResolvedValueOnce(page({ dataWipedAt: WIPED_AT }))
			.mockResolvedValueOnce(page({ dataWipedAt: WIPED_AGAIN }));

		await expect(pullAll()).rejects.toThrow();

		expect(api.pull).toHaveBeenCalledTimes(2);
		expect(wipeDevice).toHaveBeenCalledTimes(1);
		expect(applyPulledChanges).not.toHaveBeenCalled();
	});

	it('409 que não ensina nada novo (a marca daqui já é a do servidor): falha sem repetir', async () => {
		alreadySynced();
		mockSyncState.set(KNOWN_WIPE_AT_KEY, WIPED_AT);
		(api.push as jest.Mock).mockRejectedValueOnce(wipedRefusal(WIPED_AT));

		await expect(pushAll()).rejects.toMatchObject({ code: 'data_wiped' });

		expect(pushCalls()).toHaveLength(1);
		expect(wipeDevice).not.toHaveBeenCalled();
	});

	it('409 sem o instante: pergunta ao `/sync/status`', async () => {
		alreadySynced();
		(api.push as jest.Mock).mockRejectedValueOnce(wipedRefusal());

		await pushAll();

		expect(api.fetchSyncStatus).toHaveBeenCalledTimes(1);
		expect(wipeDevice).toHaveBeenCalledWith(WIPED_AT);
		expect(pushCalls()[1][1]).toBe(WIPED_AT);
	});

	it('sem quem apague (o app ainda não registrou): falha sem gravar a marca nem a página', async () => {
		alreadySynced();
		setAccountWipedHandler(null);
		(api.pull as jest.Mock).mockResolvedValue(page({ dataWipedAt: WIPED_AT }));

		await expect(pullAll()).rejects.toThrow();

		expect(await getKnownWipeAt()).toBeNull();
		expect(applyPulledChanges).not.toHaveBeenCalled();
		// A marca guardada sem o apagar faria o próximo push subir o que devia sumir.
		expect(mockSyncState.get(CURSOR_KEY)).toBe(
			JSON.stringify({ ...EMPTY_CURSOR, transactions: 40 })
		);
	});
});

describe('o servidor de hoje, que não manda `dataWipedAt`', () => {
	it('tudo como antes: grava a página, não apaga, não inventa marca', async () => {
		alreadySynced();
		const legacy = page({ changes: changes({ transactions: [tx('normal')] }) });
		(api.pull as jest.Mock).mockResolvedValue(legacy);

		await syncNow();

		expect(wipeDevice).not.toHaveBeenCalled();
		expect(applyPulledChanges).toHaveBeenCalledWith(legacy.changes);
		expect(pushCalls()).toHaveLength(1);
		expect(pushCalls()[0][1]).toBeNull();
		expect(mockSyncState.has(KNOWN_WIPE_AT_KEY)).toBe(false);
		expect(JSON.parse(mockSyncState.get(CURSOR_KEY) ?? 'null')).toEqual(legacy.cursor);
	});

	it('o login sem o campo no `/sync/status` também não muda nada', async () => {
		firstSession();

		expect(await learnAccountWipe(undefined)).toBe('none');
		expect(mockSyncState.has(KNOWN_WIPE_AT_KEY)).toBe(false);
	});
});
