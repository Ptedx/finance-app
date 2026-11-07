/**
 * "Apagar todos os dados" no servidor (DEC-35) e a marca que avisa os outros aparelhos.
 *
 * O que estes testes protegem:
 *
 *  - toda relação do `User` no schema.prisma tem destino declarado: apagada, mantida ou
 *    apagada em parte. Uma tabela nova que ninguém classificou faz o teste falhar, em vez
 *    de sobreviver em silêncio a um "apagar tudo" que o usuário pediu;
 *  - o que fica é exatamente o que a decisão manda ficar: a conta, as sessões, as
 *    categorias, as regras aprendidas e as preferências de configuração;
 *  - das preferências, saem só as duas que apontam para contas que deixam de existir, pela
 *    chave exata do AsyncStorage do app;
 *  - depois de apagar, um push que não sabe disso volta com 409 e não grava nada — senão o
 *    aparelho que ainda tinha os dados os subiria de novo e o "apagar" se desfaria;
 *  - quem nunca apagou continua sincronizando como sempre, mande o campo novo ou não.
 *
 * Fora de `src/` de propósito, como os outros testes do servidor (ver `budgetConflict.test.ts`).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	DATA_WIPED_CODE,
	PARTLY_WIPED_USER_RELATIONS,
	pushWipeConflict,
	USER_RELATION_FATE,
	WIPED_PREFERENCE_KEYS,
	WIPED_USER_RELATIONS,
	wipeMarkToWire,
} from '../src/domain/dataWipe';
import { pushBodySchema } from '../src/schemas/sync';

jest.mock('../src/lib/env.js', () => ({ env: { syncPageSize: 500 } }), { virtual: true });

const PRISMA_DIR = join(__dirname, '..', 'prisma');
const schema = readFileSync(join(PRISMA_DIR, 'schema.prisma'), 'utf8');

/** O corpo de um `model X { ... }` do schema.prisma. */
const modelBody = (name: string): string => {
	const match = new RegExp(`^model ${name} \\{([\\s\\S]*?)^\\}`, 'm').exec(schema);
	if (!match) throw new Error(`model ${name} não encontrado no schema.prisma`);
	return match[1] as string;
};

/** Os campos do `User` cujo tipo é outro model: as tabelas que pertencem a ele. */
const userRelations = (): string[] => {
	const models = new Set([...schema.matchAll(/^model (\w+) \{/gm)].map((m) => m[1] as string));
	return modelBody('User')
		.split(/\r?\n/)
		.map((line) => /^\s*(\w+)\s+(\w+)(\[\])?\??\s*(?:@.*)?$/.exec(line))
		.filter((match): match is RegExpExecArray => match !== null && models.has(match[2] as string))
		.map((match) => match[1] as string);
};

describe('destino de cada tabela do usuário', () => {
	it('lê as relações do schema (o teste não passa por não achar nada)', () => {
		expect(userRelations()).toEqual(expect.arrayContaining(['transactions', 'refreshTokens']));
		expect(userRelations().length).toBeGreaterThan(15);
	});

	it('toda relação do User tem destino declarado, e nenhum destino aponta para relação que não existe', () => {
		expect(Object.keys(USER_RELATION_FATE).sort()).toEqual(userRelations().sort());
	});

	it('fica a conta: sessões, categorias e regras aprendidas', () => {
		const kept = Object.entries(USER_RELATION_FATE)
			.filter(([, fate]) => fate === 'keep')
			.map(([relation]) => relation)
			.sort();
		expect(kept).toEqual(['categories', 'merchantRules', 'refreshTokens']);
	});

	it('das preferências, só algumas chaves saem', () => {
		expect([...PARTLY_WIPED_USER_RELATIONS]).toEqual(['preferences']);
	});

	it('todo o resto é apagado de verdade, inclusive as tabelas antigas sem tela', () => {
		expect([...WIPED_USER_RELATIONS].sort()).toEqual(
			[
				'transactions',
				'recurringTransactions',
				'budgets',
				'transfers',
				'accounts',
				'retirementGoals',
				'debts',
				'reserveGoals',
				'bills',
				'captures',
				'diagnosticEvents',
				'assets',
				'liabilities',
				'netWorthSnapshots',
				'goals',
				'portfolioAllocations',
				'passiveIncomes',
			].sort()
		);
	});

	it('as preferências que saem são as das contas, pela chave exata do app', () => {
		expect([...WIPED_PREFERENCE_KEYS].sort()).toEqual([
			'@spendr_business_feeds',
			'@spendr_distinct_account_pairs',
		]);
	});
});

describe('a coluna dataWipedAt', () => {
	it('existe no User, opcional', () => {
		expect(modelBody('User')).toMatch(/^\s*dataWipedAt\s+DateTime\?\s*$/m);
	});

	it('tem migração que só acrescenta a coluna', () => {
		const sql = readdirSync(join(PRISMA_DIR, 'migrations'))
			.filter((dir) => !dir.endsWith('.toml'))
			.map((dir) => readFileSync(join(PRISMA_DIR, 'migrations', dir, 'migration.sql'), 'utf8'))
			.find((text) => text.includes('"dataWipedAt"'));
		expect(sql).toMatch(/ALTER TABLE "users" ADD COLUMN "dataWipedAt" TIMESTAMP\(3\);/);
		expect(sql).not.toMatch(/DROP|NOT NULL/);
	});

	it('vai para o fio como ISO, ou null para quem nunca apagou', () => {
		expect(wipeMarkToWire(null)).toBeNull();
		expect(wipeMarkToWire(new Date('2026-10-27T15:04:05.678Z'))).toBe('2026-10-27T15:04:05.678Z');
	});
});

describe('push depois de apagar', () => {
	const wipedAt = new Date('2026-10-27T15:00:00.000Z');

	it.each([
		['sem o campo (app antigo)', undefined],
		['com null', null],
		['com uma data qualquer', '2026-10-27T15:00:00.000Z'],
	])('quem nunca apagou sincroniza como sempre: %s', (_label, known) => {
		expect(pushWipeConflict(null, known)).toBeNull();
	});

	it.each([
		['sem o campo (app antigo)', undefined],
		['com null (o aparelho não sabe de apagamento nenhum)', null],
		['com um apagamento anterior', '2026-10-20T15:00:00.000Z'],
		['com um milissegundo antes', '2026-10-27T14:59:59.999Z'],
	])('quem não sabe do apagamento leva 409: %s', (_label, known) => {
		expect(pushWipeConflict(wipedAt, known)).toEqual({
			error: expect.stringMatching(/apagados/),
			code: DATA_WIPED_CODE,
			dataWipedAt: '2026-10-27T15:00:00.000Z',
		});
	});

	it('o código é o que o app espera', () => {
		expect(DATA_WIPED_CODE).toBe('data_wiped');
	});

	it.each([
		['o mesmo instante', '2026-10-27T15:00:00.000Z'],
		['o mesmo instante, escrito noutro fuso', '2026-10-27T12:00:00.000-03:00'],
		['o mesmo instante, sem milissegundos', '2026-10-27T15:00:00Z'],
		['um instante depois', '2026-10-28T09:00:00.000Z'],
	])('quem já sabe do apagamento sincroniza: %s', (_label, known) => {
		expect(pushWipeConflict(wipedAt, known)).toBeNull();
	});
});

describe('knownWipeAt no corpo do push', () => {
	it('é opcional: o corpo de um app antigo continua aceito', () => {
		expect(pushBodySchema.parse({ changes: {} }).knownWipeAt).toBeUndefined();
	});

	it('aceita null e um instante ISO', () => {
		expect(pushBodySchema.parse({ knownWipeAt: null }).knownWipeAt).toBeNull();
		expect(pushBodySchema.parse({ knownWipeAt: '2026-10-27T15:00:00.000Z' }).knownWipeAt).toBe(
			'2026-10-27T15:00:00.000Z'
		);
	});

	it('recusa o que não é instante', () => {
		expect(pushBodySchema.safeParse({ knownWipeAt: 'ontem' }).success).toBe(false);
		expect(pushBodySchema.safeParse({ knownWipeAt: 0 }).success).toBe(false);
	});
});
