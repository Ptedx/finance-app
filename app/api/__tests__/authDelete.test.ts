/**
 * O pedido do "Apagar a conta" (SPD-084): `DELETE /api/me` com a senha no corpo, e o fim
 * da sessão por conta de quem chama — um 401 `account_gone` aqui é o resultado esperado
 * de quem já apagou em outro aparelho, não uma sessão que caiu sozinha.
 */

jest.mock('../client', () => ({
	apiRequest: jest.fn(async () => undefined),
}));

jest.mock('../tokens', () => ({
	clearTokens: jest.fn(),
	loadTokens: jest.fn(),
	saveTokens: jest.fn(),
}));

import { deleteAccount } from '../auth';
import { apiRequest } from '../client';

it('DELETE /api/me com a senha, autenticado, sem o cliente derrubar a sessão sozinho', async () => {
	await deleteAccount('minha-senha');

	expect(apiRequest).toHaveBeenCalledWith('/api/me', {
		method: 'DELETE',
		body: { password: 'minha-senha' },
		authenticated: true,
		callerEndsSession: true,
	});
});
