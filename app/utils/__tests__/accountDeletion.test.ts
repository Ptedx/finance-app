/**
 * A ordem do "Apagar a conta" (SPD-084, DEC-35).
 *
 * O servidor apaga **primeiro** (`DELETE /api/me`, com a senha). Só quando ele confirma —
 * ou diz que a conta já não existe — o aparelho apaga os dados e encerra a sessão aqui,
 * sem depender do `/auth/logout`: as sessões já sumiram junto com a conta. Senha errada,
 * sem rede, servidor antigo sem a rota: nada sai do aparelho e a sessão continua.
 *
 * Como em `dataWipe.test.ts`, são mocks e a pergunta é quem é chamado e em que ordem.
 */

const mockCalls: string[] = [];

jest.mock('../../api/auth', () => ({
	deleteAccount: jest.fn(async () => {
		mockCalls.push('server');
	}),
}));

jest.mock('../../api/client', () => {
	function ApiError(
		this: { status: number; code: string; message: string },
		status: number,
		message: string,
		code: string
	) {
		this.status = status;
		this.message = message;
		this.code = code;
	}
	ApiError.prototype = Object.create(Error.prototype);
	return { ApiError };
});

jest.mock('../../api/tokens', () => ({
	clearTokens: jest.fn(async () => {
		mockCalls.push('tokens');
	}),
}));

jest.mock('../../sync/claim', () => ({
	endSyncSession: jest.fn(async () => {
		mockCalls.push('syncState');
	}),
}));

// Só o `leaveDeletedAccount` pergunta ao motor (`accountGone.test.ts`); o "Apagar a conta" não.
jest.mock('../../sync/engine', () => ({ hasSyncedWithAccount: jest.fn() }));

jest.mock('../dataWipe', () => ({
	wipeDevice: jest.fn(async () => {
		mockCalls.push('wipe');
	}),
}));

jest.mock('../../diagnostics/log', () => ({
	log: jest.fn(),
	errorData: jest.fn(() => ({})),
}));

jest.mock('../../sync/queue', () => ({
	runExclusive: jest.fn(async (work: () => Promise<unknown>) => {
		mockCalls.push('exclusive');
		const result = await work();
		mockCalls.push('released');
		return result;
	}),
	stop: jest.fn(() => {
		mockCalls.push('queueStopped');
	}),
}));

import { deleteAccount } from '../../api/auth';
import { ApiError } from '../../api/client';
import { clearTokens } from '../../api/tokens';
import { log } from '../../diagnostics/log';
import { endSyncSession } from '../../sync/claim';
import * as syncQueue from '../../sync/queue';
import { deleteAccountAndData } from '../accountDeletion';
import { wipeDevice } from '../dataWipe';

const apiError = (status: number, code: string) =>
	new (ApiError as unknown as new (s: number, m: string, c: string) => Error)(
		status,
		'mensagem do servidor',
		code
	);

const serverFails = (error: unknown) => {
	(deleteAccount as jest.Mock).mockImplementationOnce(async () => {
		mockCalls.push('server');
		throw error;
	});
};

beforeEach(() => {
	mockCalls.length = 0;
	jest.clearAllMocks();
});

describe('o servidor apagou a conta (204)', () => {
	it('manda a senha, e só depois apaga o aparelho e encerra a sessão, com a fila parada', async () => {
		const result = await deleteAccountAndData('minha-senha');

		expect(result).toEqual({ ok: true, alreadyGone: false, deviceWiped: true });
		expect(deleteAccount).toHaveBeenCalledWith('minha-senha');
		expect(mockCalls).toEqual([
			'exclusive',
			'server',
			'queueStopped',
			'wipe',
			'tokens',
			'syncState',
			'released',
		]);
	});

	it('apaga o aparelho como o "Apagar todos os dados" sem conta: sem marca de apagar', async () => {
		await deleteAccountAndData('minha-senha');

		expect(wipeDevice).toHaveBeenCalledTimes(1);
		expect((wipeDevice as jest.Mock).mock.calls[0]).toEqual([]);
	});

	it('a fila é desligada antes de soltar: nenhuma rodada sai com a sessão de uma conta que não existe mais', async () => {
		await deleteAccountAndData('minha-senha');

		expect(syncQueue.stop).toHaveBeenCalledTimes(1);
		expect(mockCalls.indexOf('queueStopped')).toBeLessThan(mockCalls.indexOf('released'));
	});

	it('o aparelho falhou ao apagar: a sessão sai do mesmo jeito, e a resposta diz o que ficou', async () => {
		(wipeDevice as jest.Mock).mockRejectedValueOnce(new Error('disco cheio'));

		const result = await deleteAccountAndData('minha-senha');

		expect(result).toEqual({ ok: true, alreadyGone: false, deviceWiped: false });
		expect(clearTokens).toHaveBeenCalledTimes(1);
		expect(endSyncSession).toHaveBeenCalledTimes(1);
	});

	it('limpar a sessão falhou: não desfaz nada nem derruba quem chamou — a conta já não existe', async () => {
		(clearTokens as jest.Mock).mockRejectedValueOnce(new Error('keystore'));

		const result = await deleteAccountAndData('minha-senha');

		expect(result).toEqual({ ok: true, alreadyGone: false, deviceWiped: true });
		expect(endSyncSession).toHaveBeenCalledTimes(1);
	});

	it('o diário novo começa com o fato, sem e-mail nem senha', async () => {
		await deleteAccountAndData('minha-senha');

		expect(log).toHaveBeenCalledWith('session', 'account_deleted', {
			data: { alreadyGone: false, deviceWiped: true },
		});
		expect(JSON.stringify((log as jest.Mock).mock.calls)).not.toContain('minha-senha');
	});
});

describe('a conta já não existia (401 account_gone)', () => {
	it('é o mesmo fim: apaga o aparelho e encerra a sessão', async () => {
		serverFails(apiError(401, 'account_gone'));

		const result = await deleteAccountAndData('minha-senha');

		expect(result).toEqual({ ok: true, alreadyGone: true, deviceWiped: true });
		expect(mockCalls).toEqual([
			'exclusive',
			'server',
			'queueStopped',
			'wipe',
			'tokens',
			'syncState',
			'released',
		]);
	});
});

describe('o servidor não apagou: nada sai do aparelho e a sessão continua', () => {
	it('senha errada (403 wrong_password)', async () => {
		serverFails(apiError(403, 'wrong_password'));

		const result = await deleteAccountAndData('senha-errada');

		expect(result).toEqual({ ok: false, reason: 'wrong_password' });
		expect(mockCalls).toEqual(['exclusive', 'server', 'released']);
	});

	it.each([
		['sem rede', apiError(0, 'offline')],
		['servidor antigo, sem a rota', apiError(404, 'error')],
		['erro no servidor', apiError(500, 'error')],
		['gateway fora', apiError(502, 'gateway_unreachable')],
		['muitas tentativas', apiError(429, 'rate_limited')],
		['corpo recusado', apiError(400, 'invalid_body')],
		['erro que não é do cliente HTTP', new Error('inesperado')],
	])('%s: não deu para apagar agora', async (_label, error) => {
		serverFails(error);

		const result = await deleteAccountAndData('minha-senha');

		expect(result).toEqual({ ok: false, reason: 'unavailable' });
		expect(mockCalls).toEqual(['exclusive', 'server', 'released']);
		expect(wipeDevice).not.toHaveBeenCalled();
		expect(clearTokens).not.toHaveBeenCalled();
		expect(endSyncSession).not.toHaveBeenCalled();
		expect(syncQueue.stop).not.toHaveBeenCalled();
	});

	it.each([
		['renovação recusada', apiError(401, 'session_lost')],
		['token recusado', apiError(401, 'invalid_token')],
		['sem sessão guardada', apiError(401, 'no_session')],
	])('%s: a sessão caiu, e a conta continua lá', async (_label, error) => {
		serverFails(error);

		const result = await deleteAccountAndData('minha-senha');

		expect(result).toEqual({ ok: false, reason: 'session_lost' });
		expect(wipeDevice).not.toHaveBeenCalled();
	});

	it('a recusa vai para o diário só com o status e o código', async () => {
		serverFails(apiError(403, 'wrong_password'));

		await deleteAccountAndData('senha-errada');

		expect(log).toHaveBeenCalledWith(
			'session',
			'account_delete_refused',
			expect.objectContaining({ level: 'warn' })
		);
		expect(JSON.stringify((log as jest.Mock).mock.calls)).not.toContain('senha-errada');
	});
});
