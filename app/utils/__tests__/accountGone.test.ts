/**
 * A conta não existe mais e este aparelho fica sabendo por um pedido qualquer (401
 * `account_gone`): foi apagada noutro aparelho, ou neste com o app fechado entre o 204 do
 * servidor e o apagar daqui (SPD-084).
 *
 * O aparelho que já sincronizava com a conta apaga os dados como no "Apagar todos os
 * dados" sem conta — ficam as categorias, as regras aprendidas e a configuração — e
 * encerra a sessão aqui, sem o `/auth/logout`. O que estava entrando nela (a escolha de
 * dados no meio) só sai: o que ele tem nunca esteve na conta. E uma vez só: o segundo
 * 401 da mesma sessão, ou um que chega depois do "Apagar a conta" daqui, não faz nada.
 *
 * Como em `accountDeletion.test.ts`, são mocks e a pergunta é quem é chamado e em que
 * ordem. A fila de verdade, com o 401 chegando de dentro de uma rodada, está em
 * `accountGoneQueue.test.ts`.
 */

const mockCalls: string[] = [];
const mockStored: { tokens: { accessToken: string; refreshToken: string } | null } = {
	tokens: null,
};

jest.mock('../../api/tokens', () => ({
	loadTokens: jest.fn(async () => mockStored.tokens),
	clearTokens: jest.fn(async () => {
		mockCalls.push('tokens');
	}),
}));

jest.mock('../../api/auth', () => ({ deleteAccount: jest.fn() }));

jest.mock('../../api/client', () => ({ ApiError: class ApiError extends Error {} }));

jest.mock('../../sync/claim', () => ({
	endSyncSession: jest.fn(async () => {
		mockCalls.push('syncState');
	}),
}));

jest.mock('../../sync/engine', () => ({
	hasSyncedWithAccount: jest.fn(async () => {
		mockCalls.push('askedSynced');
		return true;
	}),
}));

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

import { clearTokens } from '../../api/tokens';
import { log } from '../../diagnostics/log';
import { endSyncSession } from '../../sync/claim';
import { hasSyncedWithAccount } from '../../sync/engine';
import * as syncQueue from '../../sync/queue';
import { leaveDeletedAccount } from '../accountDeletion';
import { wipeDevice } from '../dataWipe';

const SESSION = { accessToken: 'access-da-conta', refreshToken: 'refresh-da-conta' };

beforeEach(() => {
	mockCalls.length = 0;
	mockStored.tokens = SESSION;
	jest.clearAllMocks();
});

describe('o aparelho que já sincronizava com a conta', () => {
	it('apaga os dados e só depois encerra a sessão, com a fila parada', async () => {
		const outcome = await leaveDeletedAccount(SESSION.accessToken);

		expect(outcome).toBe('wiped');
		expect(mockCalls).toEqual([
			'exclusive',
			'queueStopped',
			'askedSynced',
			'wipe',
			'tokens',
			'syncState',
			'released',
		]);
	});

	it('como o "Apagar todos os dados" sem conta: sem marca de apagar', async () => {
		await leaveDeletedAccount(SESSION.accessToken);

		expect(wipeDevice).toHaveBeenCalledTimes(1);
		expect((wipeDevice as jest.Mock).mock.calls[0]).toEqual([]);
	});

	it('o apagar falhou: a sessão sai do mesmo jeito, e a resposta diz o que ficou', async () => {
		(wipeDevice as jest.Mock).mockRejectedValueOnce(new Error('disco cheio'));
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

		const outcome = await leaveDeletedAccount(SESSION.accessToken);

		expect(outcome).toBe('wipe_failed');
		expect(clearTokens).toHaveBeenCalledTimes(1);
		expect(endSyncSession).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});

	it('o diário novo começa com o fato, sem o token', async () => {
		await leaveDeletedAccount(SESSION.accessToken);

		expect(log).toHaveBeenCalledWith('session', 'account_gone', { data: { outcome: 'wiped' } });
		expect(JSON.stringify((log as jest.Mock).mock.calls)).not.toContain('access-da-conta');
	});
});

describe('o aparelho que nunca sincronizou com a conta', () => {
	it('só sai: nada é apagado aqui', async () => {
		(hasSyncedWithAccount as jest.Mock).mockResolvedValueOnce(false);

		const outcome = await leaveDeletedAccount(SESSION.accessToken);

		expect(outcome).toBe('signed_out');
		expect(wipeDevice).not.toHaveBeenCalled();
		expect(clearTokens).toHaveBeenCalledTimes(1);
		expect(endSyncSession).toHaveBeenCalledTimes(1);
		expect(log).toHaveBeenCalledWith('session', 'account_gone', {
			data: { outcome: 'signed_out' },
		});
	});
});

describe('a sessão que recebeu o 401 já acabou', () => {
	it.each([
		['o "Apagar a conta" daqui já encerrou (sem tokens)', null],
		[
			'outra sessão entrou no lugar (outro token)',
			{ accessToken: 'access-de-outra', refreshToken: 'r' },
		],
	])('%s: não apaga nem encerra nada', async (_label, stored) => {
		mockStored.tokens = stored;

		const outcome = await leaveDeletedAccount(SESSION.accessToken);

		expect(outcome).toBe('already_ended');
		expect(mockCalls).toEqual(['exclusive', 'released']);
		expect(syncQueue.stop).not.toHaveBeenCalled();
		expect(log).not.toHaveBeenCalled();
	});

	it('o segundo 401 da mesma sessão encontra a sessão encerrada: um apagar só', async () => {
		(clearTokens as jest.Mock).mockImplementationOnce(async () => {
			mockCalls.push('tokens');
			mockStored.tokens = null;
		});

		const outcomes = [
			await leaveDeletedAccount(SESSION.accessToken),
			await leaveDeletedAccount(SESSION.accessToken),
		];

		expect(outcomes).toEqual(['wiped', 'already_ended']);
		expect(wipeDevice).toHaveBeenCalledTimes(1);
	});
});
