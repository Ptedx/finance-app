/**
 * Preferências (`preferences`) no servidor e o status do primeiro login.
 *
 * O que estes testes protegem:
 *
 *  - a coleção nova existe nas duas pontas do protocolo: o push a aceita (e um cliente
 *    antigo, sem ela, continua aceito), o cursor do pull a tem — é pela chave do cursor
 *    que o app sabe que este servidor a conhece;
 *  - a linha é chave + texto: o servidor não interpreta o valor, e recusa o que não cabe;
 *  - o status do login enxerga **todas** as coleções de dado do usuário. Antes só
 *    lançamentos, recorrências, orçamentos e categorias próprias contavam: uma conta com
 *    caixa de entrada, contas, dívidas ou contas a pagar era "vazia", e o primeiro login
 *    de outro aparelho juntava os dois lados sem perguntar.
 *
 * Fora de `src/` de propósito, como os outros testes do servidor (ver `billWire.test.ts`).
 */

import { type IncomingPreference, preferenceColumns, preferenceToWire, type StoredPreference } from '../src/domain/preferenceWire';
import { EMPTY_STATUS_COUNTS, syncStatusOf } from '../src/domain/syncStatus';
import { cursorSchema, preferenceSchema, pullQuerySchema, pushBodySchema } from '../src/schemas/sync';

jest.mock('../src/lib/env.js', () => ({ env: { syncPageSize: 500 } }), { virtual: true });

const incoming = (over: Partial<IncomingPreference> = {}): IncomingPreference => ({
	id: 'selectedCurrency',
	value: '{"code":"BRL","symbol":"R$","name":"Brazilian Real"}',
	updatedAt: '2026-10-24T12:00:00.000Z',
	deletedAt: null,
	...over,
});

const failedPaths = (raw: unknown): string[] => {
	const result = preferenceSchema.safeParse(raw);
	return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
};

describe('validação de uma preferência', () => {
	it('a linha completa passa, e a lápide também', () => {
		expect(preferenceSchema.safeParse(incoming()).success).toBe(true);
		expect(preferenceSchema.safeParse(incoming({ deletedAt: '2026-10-24T13:00:00.000Z' })).success).toBe(true);
	});

	it('o carimbo de semente (1970) passa: é o de quem só descobriu o valor', () => {
		expect(preferenceSchema.safeParse(incoming({ updatedAt: '1970-01-01T00:00:00.000Z' })).success).toBe(true);
	});

	it('chave vazia ou acima de 64 não passa', () => {
		expect(failedPaths(incoming({ id: '' }))).toEqual(['id']);
		expect(failedPaths(incoming({ id: 'x'.repeat(65) }))).toEqual(['id']);
	});

	it('valor é obrigatório e tem teto', () => {
		const { value: _v, ...rest } = incoming();
		expect(failedPaths(rest)).toEqual(['value']);
		expect(preferenceSchema.safeParse(incoming({ value: '' })).success).toBe(true);
		expect(failedPaths(incoming({ value: 'x'.repeat(2_001) }))).toEqual(['value']);
	});
});

describe('preferências no protocolo', () => {
	it('cliente antigo, sem preferences na remessa: a coleção vem vazia', () => {
		expect(pushBodySchema.parse({ changes: { budgets: [] } }).changes.preferences).toEqual([]);
		expect(pushBodySchema.parse({}).changes.preferences).toEqual([]);
	});

	it('o cursor tem a chave, e um cursor antigo sem ela parte do zero', () => {
		expect(cursorSchema.parse({}).preferences).toBe(0);
		expect(pullQuerySchema.parse({ cursor: JSON.stringify({ bills: 3 }) }).cursor.preferences).toBe(0);
		expect(pullQuerySchema.parse({}).cursor.preferences).toBe(0);
	});
});

describe('preferências no fio', () => {
	it('ida e volta sem tradução: chave, texto e os dois carimbos', () => {
		const columns = preferenceColumns(incoming({ deletedAt: '2026-10-24T13:00:00.000Z' }));
		expect(columns).toEqual({
			value: '{"code":"BRL","symbol":"R$","name":"Brazilian Real"}',
			updatedAt: new Date('2026-10-24T12:00:00.000Z'),
			deletedAt: new Date('2026-10-24T13:00:00.000Z'),
		});

		const stored: StoredPreference = { id: 'selectedCurrency', ...columns };
		expect(preferenceToWire(stored)).toEqual(incoming({ deletedAt: '2026-10-24T13:00:00.000Z' }));
	});

	it('lápide ausente vira nulo na coluna, nunca `undefined`', () => {
		const { deletedAt: _d, ...rest } = incoming();
		expect(preferenceColumns(rest).deletedAt).toBeNull();
	});
});

describe('o status do primeiro login', () => {
	it('conta vazia (só as categorias padrão, que nem entram) não tem dados', () => {
		expect(syncStatusOf(EMPTY_STATUS_COUNTS)).toEqual({ hasData: false, counts: EMPTY_STATUS_COUNTS });
	});

	it.each([
		'transactions',
		'recurringTransactions',
		'budgets',
		'customCategories',
		'accounts',
		'transfers',
		'debts',
		'retirementGoals',
		'reserveGoals',
		'captures',
		'merchantRules',
		'bills',
	] as const)('só %s já é dado da conta', (collection) => {
		expect(syncStatusOf({ ...EMPTY_STATUS_COUNTS, [collection]: 1 }).hasData).toBe(true);
	});

	it('as preferências não são contadas: juntam linha a linha, sem precisar perguntar', () => {
		expect(Object.keys(EMPTY_STATUS_COUNTS)).not.toContain('preferences');
	});
});
