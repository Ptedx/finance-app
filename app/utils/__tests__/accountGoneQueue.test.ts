/**
 * O 401 `account_gone` com a fila de sync de verdade e o cliente HTTP de verdade (SPD-084):
 * de onde ele chega, quem trata, e que nada trava nem apaga duas vezes.
 *
 * - **De dentro de uma rodada** (o push, o pull): quem trata espera a fila parada
 *   (`runExclusive`), e a fila espera a rodada terminar. Se o cliente HTTP esperasse quem
 *   trata, a rodada esperaria a si mesma — por isso o aviso dele não espera ninguém, e a
 *   rodada termina com o erro antes de o aparelho ser apagado.
 * - **No meio do "Apagar a conta" daqui**: um pedido que saiu antes (o diário, por
 *   exemplo) recebe o 401 enquanto o apagar roda. Quem trata espera o apagar terminar e
 *   encontra a sessão encerrada: um apagar só, e nenhum aviso a mais.
 *
 * O que fica de mentira é o motor do sync (cada rodada é um pedido), o apagar do aparelho e
 * o estado de sync; o que importa aqui é a ordem entre eles.
 */

const mockStored: { tokens: { accessToken: string; refreshToken: string } | null } = {
	tokens: null,
};

jest.mock('../../api/tokens', () => ({
	loadTokens: jest.fn(async () => mockStored.tokens),
	saveTokens: jest.fn(async (tokens: { accessToken: string; refreshToken: string }) => {
		mockStored.tokens = tokens;
	}),
	clearTokens: jest.fn(async () => {
		mockStored.tokens = null;
	}),
}));

jest.mock('../../sync/engine', () => ({
	syncNow: jest.fn(),
	hasSyncedWithAccount: jest.fn(async () => true),
}));

jest.mock('../../sync/claim', () => ({ endSyncSession: jest.fn(async () => undefined) }));

jest.mock('../dataWipe', () => ({ wipeDevice: jest.fn(async () => undefined) }));

jest.mock('../../diagnostics/log', () => ({ log: jest.fn(), errorData: jest.fn(() => ({})) }));

type Client = typeof import('../../api/client');
type Queue = typeof import('../../sync/queue');
type Deletion = typeof import('../accountDeletion');
type Engine = typeof import('../../sync/engine');
type Wipe = typeof import('../dataWipe');

let client: Client;
let queue: Queue;
let deletion: Deletion;
let engine: Engine;
let wipe: Wipe;

const fetchMock = jest.fn();

/** O que o `fetch` devolve, só com o que o cliente lê. */
const response = (status: number, body: unknown) => {
	const value = {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
		clone: () => value,
	};
	return value;
};

const gone = () => response(401, { error: 'Conta não encontrada.', code: 'account_gone' });

const flush = async () => {
	for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

/** Uma espera que trava vira falha do teste, não um teste pendurado até o timeout. */
const settles = <T>(promise: Promise<T>): Promise<T> =>
	Promise.race([
		promise,
		new Promise<T>((_, reject) => {
			setTimeout(() => reject(new Error('travou: ninguém soltou a fila')), 1_000);
		}),
	]);

/** O que o `AuthContext` registra: a conta apagada vai para `leaveDeletedAccount`. */
const handled: Array<Promise<string>> = [];
let plainLosses = 0;

beforeAll(() => {
	process.env.EXPO_PUBLIC_API_URL = 'https://api.exemplo.test';
	(global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
	// O endereço é lido quando o cliente carrega; os outros módulos precisam deste cliente.
	jest.isolateModules(() => {
		client = require('../../api/client') as Client;
		queue = require('../../sync/queue') as Queue;
		deletion = require('../accountDeletion') as Deletion;
		engine = require('../../sync/engine') as Engine;
		wipe = require('../dataWipe') as Wipe;
	});
	client.setSessionLostHandler((loss) => {
		if (loss.reason !== 'account_gone') {
			plainLosses += 1;
			return;
		}
		const leaving = deletion.leaveDeletedAccount(loss.accessToken);
		handled.push(leaving);
		// Devolvida de propósito: se o cliente HTTP passar a esperar quem trata, a rodada
		// espera a si mesma, e o primeiro teste trava.
		return leaving;
	});
});

let warn: jest.SpyInstance;

beforeEach(() => {
	jest.clearAllMocks();
	queue.stop();
	handled.length = 0;
	plainLosses = 0;
	mockStored.tokens = { accessToken: 'access-da-conta', refreshToken: 'refresh-da-conta' };
	(engine.hasSyncedWithAccount as jest.Mock).mockResolvedValue(true);
	// A rodada é um push: um pedido autenticado, como o do motor.
	(engine.syncNow as jest.Mock).mockImplementation(async () => {
		await client.apiRequest('/api/sync/push', { method: 'POST', body: {}, authenticated: true });
		return { pulled: 0, pushed: 0, pendingAfter: 0 };
	});
	// "Sync falhou" da fila: esperado aqui.
	warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
	queue.stop();
	warn.mockRestore();
});

describe('o 401 `account_gone` de dentro de uma rodada', () => {
	it('não trava: a rodada termina, o aparelho é apagado uma vez e a fila fica desligada', async () => {
		fetchMock.mockResolvedValue(gone());

		queue.start();
		await flush();
		expect(handled).toHaveLength(1);

		await expect(settles(handled[0])).resolves.toBe('wiped');

		expect(wipe.wipeDevice).toHaveBeenCalledTimes(1);
		expect(engine.syncNow).toHaveBeenCalledTimes(1);
		expect(queue.isEnabled()).toBe(false);
		expect(mockStored.tokens).toBeNull();
		expect(plainLosses).toBe(0);
	});

	it('dois pedidos recusados juntos (a rodada e o diário): um apagar só', async () => {
		fetchMock.mockResolvedValue(gone());

		queue.start();
		const diary = client
			.apiRequest('/api/diagnostics', { method: 'POST', body: {}, authenticated: true })
			.catch(() => undefined);
		await diary;
		await flush();
		expect(handled).toHaveLength(2);

		await expect(settles(Promise.all(handled))).resolves.toEqual(['wiped', 'already_ended']);
		expect(wipe.wipeDevice).toHaveBeenCalledTimes(1);
	});

	it('aparelho que nunca sincronizou com a conta: sai sem apagar', async () => {
		(engine.hasSyncedWithAccount as jest.Mock).mockResolvedValue(false);
		fetchMock.mockResolvedValue(gone());

		queue.start();
		await flush();

		await expect(settles(handled[0])).resolves.toBe('signed_out');
		expect(wipe.wipeDevice).not.toHaveBeenCalled();
		expect(mockStored.tokens).toBeNull();
	});

	it('outro 401 continua como antes: a sessão cai e nada é apagado', async () => {
		fetchMock.mockResolvedValue(
			response(401, { error: 'Token de acesso inválido.', code: 'invalid_token' })
		);

		queue.start();
		await flush();

		expect(handled).toHaveLength(0);
		expect(plainLosses).toBe(1);
		expect(wipe.wipeDevice).not.toHaveBeenCalled();
		expect(queue.isEnabled()).toBe(false);
	});
});

describe('o "Apagar a conta" deste aparelho', () => {
	it('um pedido que recebe o 401 no meio dele espera o fim, e não apaga nem avisa de novo', async () => {
		let answerDelete: () => void = () => {};
		fetchMock.mockImplementation((url: string, init: { method?: string }) => {
			if (url.endsWith('/api/me') && init.method === 'DELETE') {
				return new Promise((resolve) => {
					answerDelete = () => resolve(response(204, null));
				});
			}
			return Promise.resolve(gone());
		});

		const deleting = deletion.deleteAccountAndData('minha-senha');
		await flush();

		// O diário que saiu antes do apagar volta com o 401 enquanto o servidor apaga.
		await client
			.apiRequest('/api/diagnostics', { method: 'POST', body: {}, authenticated: true })
			.catch(() => undefined);
		expect(handled).toHaveLength(1);
		await flush();
		expect(wipe.wipeDevice).not.toHaveBeenCalled();

		answerDelete();
		await expect(settles(deleting)).resolves.toEqual({
			ok: true,
			alreadyGone: false,
			deviceWiped: true,
		});
		await expect(settles(handled[0])).resolves.toBe('already_ended');

		expect(wipe.wipeDevice).toHaveBeenCalledTimes(1);
	});

	it('a conta já não existia (o próprio DELETE recebe o 401): quem pediu trata, sozinho', async () => {
		fetchMock.mockResolvedValue(gone());

		await expect(settles(deletion.deleteAccountAndData('minha-senha'))).resolves.toEqual({
			ok: true,
			alreadyGone: true,
			deviceWiped: true,
		});

		expect(handled).toHaveLength(0);
		expect(plainLosses).toBe(0);
		expect(wipe.wipeDevice).toHaveBeenCalledTimes(1);
	});
});
