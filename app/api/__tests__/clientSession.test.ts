/**
 * A sessão no diário (SPD-014), do lado do cliente HTTP: a renovação do token que deu
 * certo ou não, e o 401 que desloga. Só o status e o código: nunca o token, o e-mail nem
 * o caminho do pedido.
 */

jest.mock('../../diagnostics/log', () => ({ ...jest.requireActual('../../diagnostics/log'), log: jest.fn() }));

jest.mock('../tokens', () => ({
	loadTokens: jest.fn(async () => ({ accessToken: 'access-secreto', refreshToken: 'refresh-secreto' })),
	saveTokens: jest.fn(async () => undefined),
	clearTokens: jest.fn(async () => undefined),
}));

import { log } from '../../diagnostics/log';

type Client = typeof import('../client');

const logMock = log as jest.Mock;
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

const events = () => logMock.mock.calls.map(([area, event, options]) => ({ area, event, data: options?.data }));

let client: Client;
const sessionLost = jest.fn();

beforeAll(() => {
	process.env.EXPO_PUBLIC_API_URL = 'https://api.exemplo.test';
	(global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
	// O endereço é lido quando o módulo carrega.
	jest.isolateModules(() => {
		client = require('../client') as Client;
	});
});

beforeEach(() => {
	jest.clearAllMocks();
	client.setSessionLostHandler(sessionLost);
});

const expired = () => response(401, { error: 'expirou', code: 'token_expired' });

describe('renovação do token', () => {
	it('deu certo: session_refresh_ok, e o pedido segue', async () => {
		fetchMock
			.mockResolvedValueOnce(expired())
			.mockResolvedValueOnce(response(200, { accessToken: 'novo-access', refreshToken: 'novo-refresh' }))
			.mockResolvedValueOnce(response(200, { ok: true }));

		await expect(client.apiRequest('/api/sync/pull?cursor=x', { authenticated: true })).resolves.toEqual({ ok: true });

		expect(events()).toEqual([{ area: 'session', event: 'session_refresh_ok', data: undefined }]);
		expect(sessionLost).not.toHaveBeenCalled();
	});

	it('recusada: session_refresh_failed com o status, e a sessão cai', async () => {
		fetchMock.mockResolvedValueOnce(expired()).mockResolvedValueOnce(response(401, { error: 'não', code: 'invalid' }));

		await expect(client.apiRequest('/api/sync/pull', { authenticated: true })).rejects.toMatchObject({
			status: 401,
			code: 'session_lost',
		});

		expect(events()).toEqual([
			{ area: 'session', event: 'session_refresh_failed', data: { status: 401, offline: false, loggedOut: true } },
		]);
		expect(sessionLost).toHaveBeenCalledTimes(1);
	});

	it('sem rede na renovação: falhou, mas a sessão continua', async () => {
		fetchMock.mockResolvedValueOnce(expired()).mockRejectedValueOnce(new TypeError('Network request failed'));

		await expect(client.apiRequest('/api/sync/pull', { authenticated: true })).rejects.toMatchObject({ status: 0 });

		expect(events()).toEqual([
			{ area: 'session', event: 'session_refresh_failed', data: { status: 0, offline: true, loggedOut: false } },
		]);
		expect(sessionLost).not.toHaveBeenCalled();
	});
});

describe('o 401 que desloga', () => {
	it('session_lost com o status e o código', async () => {
		fetchMock.mockResolvedValueOnce(response(401, { error: 'conta removida', code: 'invalid_token' }));

		await expect(client.apiRequest('/api/sync/push', { authenticated: true })).rejects.toMatchObject({ status: 401 });

		expect(events()).toEqual([{ area: 'session', event: 'session_lost', data: { status: 401, code: 'invalid_token' } }]);
		expect(sessionLost).toHaveBeenCalledTimes(1);
	});

	it('erro que não desloga não vira evento de sessão', async () => {
		fetchMock.mockResolvedValueOnce(response(500, { error: 'quebrou', code: 'error' }));

		await expect(client.apiRequest('/api/sync/push', { authenticated: true })).rejects.toMatchObject({ status: 500 });

		expect(events()).toEqual([]);
	});

	it('nada de token, caminho nem mensagem no diário', async () => {
		fetchMock
			.mockResolvedValueOnce(expired())
			.mockResolvedValueOnce(response(200, { accessToken: 'novo-access', refreshToken: 'novo-refresh' }))
			.mockResolvedValueOnce(response(401, { error: 'conta removida', code: 'invalid_token' }));

		await expect(client.apiRequest('/api/sync/pull?cursor=x', { authenticated: true })).rejects.toBeTruthy();

		expect(events().map((entry) => entry.event)).toEqual(['session_refresh_ok', 'session_lost']);
		expect(JSON.stringify(logMock.mock.calls)).not.toMatch(/secreto|novo-|cursor|removida|exemplo/);
	});
});

describe('o corpo da resposta de erro (SPD-083)', () => {
	const push = () =>
		client.apiRequest('/api/sync/push', { method: 'POST', body: {}, authenticated: true });

	it('fica no erro: o 409 `data_wiped` do push traz o instante do apagar da conta', async () => {
		fetchMock.mockResolvedValueOnce(
			response(409, {
				error: 'Os dados desta conta foram apagados.',
				code: 'data_wiped',
				dataWipedAt: '2026-10-27T10:00:00.000Z',
			})
		);

		await expect(push()).rejects.toMatchObject({
			status: 409,
			code: 'data_wiped',
			details: { dataWipedAt: '2026-10-27T10:00:00.000Z' },
		});
	});

	it('resposta que não veio da API (um gateway): o erro de sempre, sem corpo', async () => {
		fetchMock.mockResolvedValueOnce(response(502, '<html>Bad Gateway</html>'));

		await expect(push()).rejects.toMatchObject({
			status: 502,
			code: 'gateway_unreachable',
			details: {},
		});
	});
});

describe('quem chama encerra a sessão (o "Apagar a conta", SPD-084)', () => {
	const deleteMe = () =>
		client.apiRequest('/api/me', {
			method: 'DELETE',
			authenticated: true,
			callerEndsSession: true,
		});

	it('o 401 sobe com o código, sem derrubar a sessão por conta própria', async () => {
		fetchMock.mockResolvedValueOnce(response(401, { error: 'não existe', code: 'account_gone' }));

		await expect(deleteMe()).rejects.toMatchObject({ status: 401, code: 'account_gone' });

		expect(sessionLost).not.toHaveBeenCalled();
		expect(events()).toEqual([]);
	});

	it('a renovação recusada continua derrubando: ela é de todos os pedidos, não deste', async () => {
		fetchMock
			.mockResolvedValueOnce(expired())
			.mockResolvedValueOnce(response(401, { error: 'não', code: 'invalid' }));

		await expect(deleteMe()).rejects.toMatchObject({ status: 401, code: 'session_lost' });

		expect(sessionLost).toHaveBeenCalledTimes(1);
	});

	it('o 204 volta sem corpo', async () => {
		fetchMock.mockResolvedValueOnce(response(204, null));

		await expect(deleteMe()).resolves.toBeUndefined();
	});
});

describe('a conta que não existe mais (401 `account_gone`)', () => {
	// O aviso diz o motivo: a conta apagada (noutro aparelho, ou aqui com o app fechado no
	// meio) apaga os dados deste aparelho além de sair; qualquer outro 401 só sai, como
	// sempre. O token vai junto para quem trata saber que é desta sessão — e só para isso.
	const gone = () => response(401, { error: 'Conta não encontrada.', code: 'account_gone' });

	it('avisa que a conta foi apagada, com o token que o pedido usou', async () => {
		fetchMock.mockResolvedValueOnce(gone());

		await expect(
			client.apiRequest('/api/sync/push', { authenticated: true })
		).rejects.toMatchObject({
			status: 401,
			code: 'account_gone',
			isAccountGone: true,
		});

		expect(sessionLost).toHaveBeenCalledTimes(1);
		expect(sessionLost).toHaveBeenCalledWith({
			reason: 'account_gone',
			accessToken: 'access-secreto',
		});
		expect(events()).toEqual([
			{ area: 'session', event: 'session_lost', data: { status: 401, code: 'account_gone' } },
		]);
	});

	it('depois de renovar: o token é o novo, o que o servidor recusou', async () => {
		fetchMock
			.mockResolvedValueOnce(expired())
			.mockResolvedValueOnce(
				response(200, { accessToken: 'novo-access', refreshToken: 'novo-refresh' })
			)
			.mockResolvedValueOnce(gone());

		await expect(client.apiRequest('/api/me', { authenticated: true })).rejects.toMatchObject({
			code: 'account_gone',
		});

		expect(sessionLost).toHaveBeenCalledTimes(1);
		expect(sessionLost).toHaveBeenCalledWith({
			reason: 'account_gone',
			accessToken: 'novo-access',
		});
		expect(JSON.stringify(logMock.mock.calls)).not.toMatch(/secreto|novo-/);
	});

	it('outro 401 continua sendo só a sessão que caiu', async () => {
		fetchMock.mockResolvedValueOnce(response(401, { error: 'não', code: 'invalid_token' }));

		await expect(
			client.apiRequest('/api/sync/push', { authenticated: true })
		).rejects.toMatchObject({
			isAccountGone: false,
		});

		expect(sessionLost).toHaveBeenCalledWith({ reason: 'session_lost' });
	});

	it('a renovação recusada também', async () => {
		fetchMock
			.mockResolvedValueOnce(expired())
			.mockResolvedValueOnce(response(401, { error: 'não', code: 'invalid' }));

		await expect(client.apiRequest('/api/sync/pull', { authenticated: true })).rejects.toBeTruthy();

		expect(sessionLost).toHaveBeenCalledTimes(1);
		expect(sessionLost).toHaveBeenCalledWith({ reason: 'session_lost' });
	});

	it('no "Apagar a conta" quem trata é quem pediu: nenhum aviso', async () => {
		fetchMock.mockResolvedValueOnce(gone());

		await expect(
			client.apiRequest('/api/me', {
				method: 'DELETE',
				authenticated: true,
				callerEndsSession: true,
			})
		).rejects.toMatchObject({ code: 'account_gone' });

		expect(sessionLost).not.toHaveBeenCalled();
	});
});
