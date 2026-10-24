/**
 * Contas a pagar (`bills`) no servidor: a validação de cada linha e a tradução entre a
 * coluna e o fio.
 *
 * O que estes testes protegem é o que faria a coleção existir e ainda assim não servir:
 *
 *  - uma linha ruim tem de ser recusada **pela validação**, com motivo, e não chegar ao
 *    banco — `dueDay` fora de 1–31, valor negativo, `paidThrough` que não é `YYYY-MM`;
 *  - `amountCents` nulo quer dizer "o valor varia", e tem de continuar nulo na volta —
 *    virar 0 faria o app tratar a conta como gratuita;
 *  - `amountCents` tem de sair de bigint para number, senão o pull inteiro morre no
 *    `JSON.stringify`.
 *
 * Fora de `src/` de propósito, como os outros testes do servidor: quem roda é o jest da
 * raiz. `schemas/sync.ts` lê o teto de linhas de `lib/env.ts`, que exige variáveis de
 * ambiente e é importado com a extensão `.js` do ESM — aqui ele é trocado por um módulo
 * virtual com só o que o schema usa.
 */

import {
	billColumns,
	billToWire,
	type IncomingBill,
	type StoredBill,
} from '../src/domain/billWire';
import { billSchema, pushBodySchema } from '../src/schemas/sync';

jest.mock('../src/lib/env.js', () => ({ env: { syncPageSize: 500 } }), { virtual: true });

const incomingBill = (over: Partial<IncomingBill> = {}): IncomingBill => ({
	id: '6f1c2e9a-3b4d-4c5e-8f70-1a2b3c4d5e6f',
	name: 'Aluguel',
	dueDay: 10,
	amountCents: 180_000,
	accountId: 'acc-main',
	category: 'housing',
	matchHint: 'IMOBILIARIA',
	debtId: null,
	paidThrough: '2026-09',
	paidByRef: null,
	active: true,
	sortOrder: 0,
	updatedAt: '2026-10-24T12:00:00.000Z',
	deletedAt: null,
	...over,
});

const storedBill = (over: Partial<StoredBill> = {}): StoredBill => {
	const { amountCents, updatedAt, deletedAt, ...rest } = incomingBill();
	return {
		...rest,
		accountId: rest.accountId ?? null,
		category: rest.category ?? null,
		matchHint: rest.matchHint ?? null,
		debtId: rest.debtId ?? null,
		paidThrough: rest.paidThrough ?? null,
		paidByRef: rest.paidByRef ?? null,
		amountCents: amountCents == null ? null : BigInt(amountCents),
		updatedAt: new Date(updatedAt),
		deletedAt: null,
		...over,
	};
};

/** Os caminhos que a validação recusou, para o teste dizer **por que** recusou. */
const failedPaths = (raw: unknown): string[] => {
	const result = billSchema.safeParse(raw);
	return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
};

describe('validação de uma conta a pagar', () => {
	it('a linha completa passa', () => {
		expect(billSchema.safeParse(incomingBill()).success).toBe(true);
	});

	it('valor nulo passa: é a conta cujo valor varia', () => {
		expect(billSchema.safeParse(incomingBill({ amountCents: null })).success).toBe(true);
	});

	it('os campos opcionais podem vir nulos ou ausentes', () => {
		const {
			accountId: _a,
			category: _c,
			matchHint: _m,
			debtId: _d,
			paidThrough: _p,
			paidByRef: _r,
			deletedAt: _x,
			...required
		} = incomingBill();
		expect(billSchema.safeParse(required).success).toBe(true);
	});

	it('a lápide passa como instante', () => {
		expect(
			billSchema.safeParse(incomingBill({ deletedAt: '2026-10-24T13:00:00.000Z' })).success
		).toBe(true);
	});

	it('dueDay 1 e 31 passam; 0 e 32 não', () => {
		expect(billSchema.safeParse(incomingBill({ dueDay: 1 })).success).toBe(true);
		expect(billSchema.safeParse(incomingBill({ dueDay: 31 })).success).toBe(true);
		expect(failedPaths(incomingBill({ dueDay: 0 }))).toEqual(['dueDay']);
		expect(failedPaths(incomingBill({ dueDay: 32 }))).toEqual(['dueDay']);
	});

	it('dueDay fracionário não passa', () => {
		expect(failedPaths(incomingBill({ dueDay: 10.5 }))).toEqual(['dueDay']);
	});

	it('valor zero passa; negativo não', () => {
		expect(billSchema.safeParse(incomingBill({ amountCents: 0 })).success).toBe(true);
		expect(failedPaths(incomingBill({ amountCents: -1 }))).toEqual(['amountCents']);
	});

	it('valor acima do teto do app não passa', () => {
		expect(failedPaths(incomingBill({ amountCents: 1_000_000_000_000_001 }))).toEqual([
			'amountCents',
		]);
	});

	it.each([
		'2026-9',
		'2026-13',
		'2026-00',
		'2026-09-01',
		'26-09',
		'2026/09',
		'',
	])('paidThrough mal formado (%p) não passa', (paidThrough) => {
		expect(failedPaths(incomingBill({ paidThrough }))).toEqual(['paidThrough']);
	});

	it('paidThrough de janeiro a dezembro passa', () => {
		expect(billSchema.safeParse(incomingBill({ paidThrough: '2026-01' })).success).toBe(true);
		expect(billSchema.safeParse(incomingBill({ paidThrough: '2026-12' })).success).toBe(true);
	});

	it('nome vazio ou acima de 120 não passa', () => {
		expect(failedPaths(incomingBill({ name: '' }))).toEqual(['name']);
		expect(billSchema.safeParse(incomingBill({ name: 'x'.repeat(120) })).success).toBe(true);
		expect(failedPaths(incomingBill({ name: 'x'.repeat(121) }))).toEqual(['name']);
	});

	it('matchHint acima de 200 não passa', () => {
		expect(billSchema.safeParse(incomingBill({ matchHint: 'x'.repeat(200) })).success).toBe(true);
		expect(failedPaths(incomingBill({ matchHint: 'x'.repeat(201) }))).toEqual(['matchHint']);
	});

	it('active e sortOrder são obrigatórios', () => {
		const { active: _a, sortOrder: _s, ...rest } = incomingBill();
		expect(failedPaths(rest).sort()).toEqual(['active', 'sortOrder']);
	});
});

describe('contas a pagar no push', () => {
	it('cliente antigo, sem bills na remessa: a coleção vem vazia', () => {
		const { changes } = pushBodySchema.parse({ changes: { budgets: [] } });
		expect(changes.bills).toEqual([]);
	});

	it('remessa sem changes nenhum: bills vazio também', () => {
		expect(pushBodySchema.parse({}).changes.bills).toEqual([]);
	});

	it('as linhas chegam cruas: uma inválida não derruba o envelope', () => {
		// Cada linha é validada sozinha no controller (`partitionRows`); o envelope não
		// pode recusar a remessa inteira por causa de uma conta ruim.
		const { changes } = pushBodySchema.parse({
			changes: { bills: [incomingBill(), incomingBill({ id: 'ruim', dueDay: 0 })] },
		});
		expect(changes.bills).toHaveLength(2);
	});
});

describe('contas a pagar no fio', () => {
	it('o valor sai de bigint para number, serializável em JSON', () => {
		const wire = billToWire(storedBill({ amountCents: 1_234_567n }));
		expect(wire.amountCents).toBe(1_234_567);
		expect(() => JSON.stringify(wire)).not.toThrow();
	});

	it('o teto do app (10^15 centavos) atravessa sem perder um centavo', () => {
		const wire = billToWire(storedBill({ amountCents: 1_000_000_000_000_000n }));
		expect(wire.amountCents).toBe(1_000_000_000_000_000);
	});

	it('valor nulo continua nulo nas duas direções, nunca vira 0', () => {
		expect(billToWire(storedBill({ amountCents: null })).amountCents).toBeNull();
		expect(billColumns(incomingBill({ amountCents: null })).amountCents).toBeNull();
		expect(billColumns(incomingBill({ amountCents: undefined })).amountCents).toBeNull();
	});

	it('valor zero continua zero, e não nulo', () => {
		expect(billToWire(storedBill({ amountCents: 0n })).amountCents).toBe(0);
		expect(billColumns(incomingBill({ amountCents: 0 })).amountCents).toBe(0n);
	});

	it('a lápide viaja como instante, e a linha viva como nulo', () => {
		expect(billToWire(storedBill()).deletedAt).toBeNull();
		expect(
			billToWire(storedBill({ deletedAt: new Date('2026-10-24T13:00:00.000Z') })).deletedAt
		).toBe('2026-10-24T13:00:00.000Z');
	});

	it('o que o pull entrega passa na validação do push', () => {
		expect(billSchema.safeParse(billToWire(storedBill())).success).toBe(true);
		expect(billSchema.safeParse(billToWire(storedBill({ amountCents: null }))).success).toBe(true);
	});

	it('ida e volta: o que o pull entrega é o que o push aceita, campo a campo', () => {
		const wire = billToWire(storedBill());
		const columns = billColumns(wire);
		expect(billToWire({ id: wire.id, ...columns })).toEqual(wire);
	});

	it('o fio tem exatamente os campos do contrato', () => {
		expect(Object.keys(billToWire(storedBill())).sort()).toEqual(
			[
				'id',
				'name',
				'dueDay',
				'amountCents',
				'accountId',
				'category',
				'matchHint',
				'debtId',
				'paidThrough',
				'paidByRef',
				'active',
				'sortOrder',
				'updatedAt',
				'deletedAt',
			].sort()
		);
	});

	it('campo ausente na chegada vira nulo na coluna, nunca undefined', () => {
		// `undefined` numa coluna faria o Prisma **manter o valor antigo** no update, e a
		// edição que limpou o campo — desvincular a dívida, apagar a pista — nunca se
		// propagaria.
		const columns = billColumns({
			...incomingBill(),
			amountCents: undefined,
			accountId: undefined,
			category: undefined,
			matchHint: undefined,
			debtId: undefined,
			paidThrough: undefined,
			paidByRef: undefined,
			deletedAt: undefined,
		});

		for (const value of Object.values(columns)) {
			expect(value).not.toBeUndefined();
		}
		expect(columns.paidThrough).toBeNull();
		expect(columns.debtId).toBeNull();
		expect(columns.deletedAt).toBeNull();
	});

	it('as datas chegam como texto e entram como Date, para o last-write-wins comparar', () => {
		const columns = billColumns(
			incomingBill({ updatedAt: '2026-10-24T12:00:00.000Z', deletedAt: '2026-10-24T13:00:00.000Z' })
		);
		expect(columns.updatedAt).toEqual(new Date('2026-10-24T12:00:00.000Z'));
		expect(columns.deletedAt).toEqual(new Date('2026-10-24T13:00:00.000Z'));
		// Já `paidThrough` é um mês de calendário, texto: não vira Date nem ganha fuso.
		expect(columns.paidThrough).toBe('2026-09');
	});
});
