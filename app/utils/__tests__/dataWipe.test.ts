/**
 * A ordem do "Apagar todos os dados" (SPD-082, DEC-35).
 *
 * Logado, o servidor apaga **primeiro**: se ele não confirmar (sem rede, servidor antigo
 * sem a rota, erro), nada sai do aparelho — apagar aqui e não lá faria o próximo pull
 * devolver tudo, e o usuário acharia que apagou. Deslogado, não há servidor a chamar.
 *
 * O que cada passo faz no disco está em `database/__tests__/wipeSql.test.ts`; aqui são
 * mocks e a pergunta é quem é chamado, com o quê e em que ordem.
 */

const mockCalls: string[] = [];

jest.mock('../../api/sync', () => ({
	wipeAccountData: jest.fn(async () => {
		mockCalls.push('server');
		return { dataWipedAt: '2026-10-27T10:00:00.000Z' };
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

jest.mock('../../database/database', () => ({
	wipeLocalData: jest.fn(async () => {
		mockCalls.push('local');
	}),
}));

jest.mock('../../../modules/spendr-captures', () => ({
	drainCaptures: jest.fn(() => {
		mockCalls.push('drainCaptures');
		return [
			{
				id: 'n1',
				packageName: 'com.nu.production',
				appLabel: 'Nubank',
				title: 'Compra aprovada',
				text: 'Compra de R$ 52,90 na PADARIA',
				postedAt: '2026-10-27T09:59:00.000Z',
			},
		];
	}),
	drainDiagnostics: jest.fn(() => {
		mockCalls.push('drainDiagnostics');
		return [];
	}),
}));

jest.mock('../notificationUtils', () => ({
	clearScheduledNotifications: jest.fn(async () => {
		mockCalls.push('notifications');
	}),
}));

jest.mock('../../diagnostics/diary', () => ({
	clearDiary: jest.fn(async () => {
		mockCalls.push('diary');
	}),
}));

jest.mock('../../diagnostics/log', () => ({
	log: jest.fn(),
	errorData: jest.fn(() => ({})),
}));

jest.mock('../../sync/queue', () => ({
	runExclusive: jest.fn(async (work: () => Promise<unknown>) => {
		mockCalls.push('exclusive');
		return work();
	}),
	notifyDataChanged: jest.fn(() => {
		mockCalls.push('dataChanged');
	}),
}));

import { drainCaptures } from '../../../modules/spendr-captures';
import { ApiError } from '../../api/client';
import { wipeAccountData } from '../../api/sync';
import { wipeLocalData } from '../../database/database';
import { clearDiary } from '../../diagnostics/diary';
import * as syncQueue from '../../sync/queue';
import { fingerprintOf } from '../captureMatcher';
import { eraseAllData, wipeDevice } from '../dataWipe';
import { clearScheduledNotifications } from '../notificationUtils';

const serverFails = (error: unknown) => {
	(wipeAccountData as jest.Mock).mockImplementationOnce(async () => {
		mockCalls.push('server');
		throw error;
	});
};

beforeEach(() => {
	mockCalls.length = 0;
	jest.clearAllMocks();
});

describe('logado: o servidor apaga primeiro', () => {
	it.each([
		[
			'sem rede',
			new (ApiError as unknown as new (s: number, m: string, c: string) => Error)(
				0,
				'Sem conexão com o servidor.',
				'offline'
			),
		],
		[
			'servidor antigo, sem a rota',
			new (ApiError as unknown as new (s: number, m: string, c: string) => Error)(
				404,
				'Not found',
				'error'
			),
		],
		[
			'erro no servidor',
			new (ApiError as unknown as new (s: number, m: string, c: string) => Error)(
				500,
				'Erro no servidor.',
				'error'
			),
		],
	])('%s: nada sai do aparelho, e a resposta diz que não apagou', async (_label, error) => {
		serverFails(error);

		const result = await eraseAllData({ signedIn: true });

		expect(result).toEqual({ ok: false, reason: 'server' });
		expect(mockCalls).toEqual(['exclusive', 'server']);
		expect(wipeLocalData).not.toHaveBeenCalled();
		expect(drainCaptures).not.toHaveBeenCalled();
		expect(clearScheduledNotifications).not.toHaveBeenCalled();
		expect(clearDiary).not.toHaveBeenCalled();
		expect(syncQueue.notifyDataChanged).not.toHaveBeenCalled();
	});

	it('confirmado: apaga aqui depois, e guarda o `dataWipedAt` como o apagar que este aparelho conhece', async () => {
		const result = await eraseAllData({ signedIn: true });

		expect(result).toEqual({ ok: true });
		expect(mockCalls.indexOf('server')).toBeLessThan(mockCalls.indexOf('local'));
		expect(wipeLocalData).toHaveBeenCalledWith(
			expect.objectContaining({ knownWipeAt: '2026-10-27T10:00:00.000Z' })
		);
	});

	it('tudo acontece com a fila de sync parada: nenhuma rodada sobe ou desce no meio', async () => {
		await eraseAllData({ signedIn: true });

		expect(syncQueue.runExclusive).toHaveBeenCalledTimes(1);
		expect(mockCalls[0]).toBe('exclusive');
	});

	it('o servidor apagou e o aparelho falhou: o erro chega a quem chamou', async () => {
		(wipeLocalData as jest.Mock).mockRejectedValueOnce(new Error('disco cheio'));

		await expect(eraseAllData({ signedIn: true })).rejects.toThrow('disco cheio');
	});
});

describe('deslogado', () => {
	it('não chama servidor nenhum e apaga aqui, sem marca de apagar da conta', async () => {
		const result = await eraseAllData({ signedIn: false });

		expect(result).toEqual({ ok: true });
		expect(wipeAccountData).not.toHaveBeenCalled();
		expect(wipeLocalData).toHaveBeenCalledTimes(1);
		expect((wipeLocalData as jest.Mock).mock.calls[0][0].knownWipeAt).toBeUndefined();
	});
});

describe('o apagar do aparelho (o mesmo que o SPD-083 chama quando outro aparelho apagou)', () => {
	it('esvazia a fila nativa antes do banco, e guarda só a impressão digital do que estava nela', async () => {
		await wipeDevice('2026-10-27T10:00:00.000Z');

		expect(mockCalls.indexOf('drainCaptures')).toBeLessThan(mockCalls.indexOf('local'));
		const fingerprint = fingerprintOf({
			packageName: 'com.nu.production',
			appLabel: 'Nubank',
			title: 'Compra aprovada',
			text: 'Compra de R$ 52,90 na PADARIA',
			postedAt: '2026-10-27T09:59:00.000Z',
		});
		expect(wipeLocalData).toHaveBeenCalledWith({
			seenFingerprints: [fingerprint],
			knownWipeAt: '2026-10-27T10:00:00.000Z',
		});
	});

	it('cancela os lembretes agendados, apaga o diário, descarta a fila de diagnóstico nativa e avisa as telas', async () => {
		await wipeDevice();

		expect(mockCalls).toEqual([
			'drainCaptures',
			'drainDiagnostics',
			'local',
			'notifications',
			'diary',
			'dataChanged',
		]);
	});
});
