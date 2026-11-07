/**
 * O que vai pelo fio no "Apagar todos os dados" (SPD-082): a rota que apaga na conta e o
 * `knownWipeAt` no corpo de todo push. O contrato é o do SPD-080.
 */

jest.mock('../client', () => ({
	apiRequest: jest.fn(async () => ({})),
}));

import { apiRequest } from '../client';
import { push, wipeAccountData } from '../sync';

beforeEach(() => jest.clearAllMocks());

describe('rotas do apagar', () => {
	it('apagar na conta é um POST autenticado em /me/wipe, e devolve o `dataWipedAt`', async () => {
		(apiRequest as jest.Mock).mockResolvedValueOnce({ dataWipedAt: '2026-10-27T10:00:00.000Z' });

		expect(await wipeAccountData()).toEqual({ dataWipedAt: '2026-10-27T10:00:00.000Z' });
		expect(apiRequest).toHaveBeenCalledWith('/api/me/wipe', {
			method: 'POST',
			authenticated: true,
		});
	});

	it('o push leva `knownWipeAt` no corpo, `null` inclusive', async () => {
		const changes = { categories: [], transactions: [], recurringTransactions: [], budgets: [] };

		await push(changes, null);
		await push(changes, '2026-10-27T10:00:00.000Z');

		expect((apiRequest as jest.Mock).mock.calls[0]).toEqual([
			'/api/sync/push',
			{ method: 'POST', body: { changes, knownWipeAt: null }, authenticated: true },
		]);
		expect((apiRequest as jest.Mock).mock.calls[1][1].body.knownWipeAt).toBe(
			'2026-10-27T10:00:00.000Z'
		);
	});
});
