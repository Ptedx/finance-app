import { EMPTY_CURSOR, inheritCursor, type SyncCursor } from '../types';

/**
 * Voltar para a 1.0 e depois para a 1.1 não pode perder dívidas: a 1.0 grava o cursor
 * inteiro do servidor, inclusive o de `debts`, sem gravar as dívidas. A 1.1 herda desse
 * cursor só o que a 1.0 conhecia.
 */
describe('cursor herdado da versão anterior', () => {
	const legacy: SyncCursor = { ...EMPTY_CURSOR, categories: 10, transactions: 500, accounts: 7, retirementGoals: 2, debts: 9 };

	it('mantém as coleções que a versão anterior conhecia', () => {
		expect(inheritCursor(legacy, 14)).toMatchObject({ categories: 10, transactions: 500, accounts: 7, retirementGoals: 2 });
	});

	it('zera as coleções que entraram depois dela', () => {
		expect(inheritCursor(legacy, 14).debts).toBe(0);
		expect(inheritCursor(legacy, 13).retirementGoals).toBe(0);
	});

	it('de uma versão que já conhecia tudo, herda tudo', () => {
		expect(inheritCursor(legacy, 15)).toEqual(legacy);
	});
});
