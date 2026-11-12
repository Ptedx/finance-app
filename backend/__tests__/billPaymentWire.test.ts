/**
 * Os meses das contas a pagar (`billPayments`, SPD-146) no servidor: a validação de cada
 * linha, a tradução entre a coluna e o fio, o cursor e a migração.
 *
 * A coleção guarda um registro por conta e mês — o mês pago fora de ordem, o mês pulado
 * ("não vou pagar este mês") e a quitação com o lançamento que a fez. `paidThrough` da
 * conta continua sendo o trecho contínuo já pago; estes registros são o que ele não
 * consegue dizer. O que estes testes protegem:
 *
 *  - é **aditiva**: um app que não conhece a coleção (1.2.9) manda a remessa sem ela, e o
 *    cursor que ele guarda, sem a chave nova, continua valendo;
 *  - uma linha ruim é recusada pela validação, com motivo — mês que não é `YYYY-MM`,
 *    situação desconhecida, valor negativo —, e não chega ao banco;
 *  - `amountCents` nulo ("não se sabe o valor", o mês pulado) continua nulo na volta, e o
 *    bigint vira number, senão o pull inteiro morre no `JSON.stringify`;
 *  - a migração só cria a tabela nova, com a FK em cascata e o gatilho de `serverSeq`.
 *
 * Fora de `src/` de propósito, como os outros testes do servidor: quem roda é o jest da
 * raiz, sem banco (ver `billWire.test.ts`).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	billPaymentColumns,
	billPaymentToWire,
	type IncomingBillPayment,
	type StoredBillPayment,
} from '../src/domain/billPaymentWire';
import { billPaymentSchema, cursorSchema, pullQuerySchema, pushBodySchema } from '../src/schemas/sync';

jest.mock('../src/lib/env.js', () => ({ env: { syncPageSize: 500 } }), { virtual: true });

const incomingPayment = (over: Partial<IncomingBillPayment> = {}): IncomingBillPayment => ({
	id: '0b6f1d2e-3c4a-4b5c-9d6e-7f8091a2b3c4',
	billId: '6f1c2e9a-3b4d-4c5e-8f70-1a2b3c4d5e6f',
	month: '2026-11',
	status: 'paid',
	transactionId: 'tx-1',
	amountCents: 50_000,
	updatedAt: '2026-11-12T12:00:00.000Z',
	deletedAt: null,
	...over,
});

const storedPayment = (over: Partial<StoredBillPayment> = {}): StoredBillPayment => {
	const { amountCents, updatedAt, deletedAt: _deletedAt, ...rest } = incomingPayment();
	return {
		...rest,
		transactionId: rest.transactionId ?? null,
		amountCents: amountCents == null ? null : BigInt(amountCents),
		updatedAt: new Date(updatedAt),
		deletedAt: null,
		...over,
	};
};

/** Os caminhos que a validação recusou, para o teste dizer **por que** recusou. */
const failedPaths = (raw: unknown): string[] => {
	const result = billPaymentSchema.safeParse(raw);
	return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
};

describe('validação de um mês de conta a pagar', () => {
	it('a linha completa passa', () => {
		expect(billPaymentSchema.safeParse(incomingPayment()).success).toBe(true);
	});

	it('o mês pulado passa sem lançamento e sem valor', () => {
		expect(
			billPaymentSchema.safeParse(
				incomingPayment({ status: 'skipped', transactionId: null, amountCents: null })
			).success
		).toBe(true);
	});

	it('os campos opcionais podem vir ausentes', () => {
		const { transactionId: _t, amountCents: _a, deletedAt: _d, ...required } = incomingPayment();
		expect(billPaymentSchema.safeParse(required).success).toBe(true);
	});

	it('a lápide (o desfazer) passa como instante', () => {
		expect(
			billPaymentSchema.safeParse(incomingPayment({ deletedAt: '2026-11-12T13:00:00.000Z' })).success
		).toBe(true);
	});

	it('só "paid" e "skipped" são situações', () => {
		expect(billPaymentSchema.safeParse(incomingPayment({ status: 'skipped' })).success).toBe(true);
		expect(failedPaths({ ...incomingPayment(), status: 'late' })).toEqual(['status']);
		expect(failedPaths({ ...incomingPayment(), status: '' })).toEqual(['status']);
	});

	it.each(['2026-9', '2026-13', '2026-00', '2026-11-01', '26-11', '2026/11', ''])(
		'mês mal formado (%p) não passa',
		(month) => {
			expect(failedPaths(incomingPayment({ month }))).toEqual(['month']);
		}
	);

	it('valor zero passa; negativo não', () => {
		expect(billPaymentSchema.safeParse(incomingPayment({ amountCents: 0 })).success).toBe(true);
		expect(failedPaths(incomingPayment({ amountCents: -1 }))).toEqual(['amountCents']);
	});

	it('valor acima do teto do app não passa', () => {
		expect(failedPaths(incomingPayment({ amountCents: 1_000_000_000_000_001 }))).toEqual([
			'amountCents',
		]);
	});

	it('id, conta e mês são obrigatórios', () => {
		const { id: _i, billId: _b, month: _m, ...rest } = incomingPayment();
		expect(failedPaths(rest).sort()).toEqual(['billId', 'id', 'month']);
	});
});

describe('meses das contas no push', () => {
	it('app que não conhece a coleção (1.2.9): a remessa sem ela é aceita, e vem vazia', () => {
		const { changes } = pushBodySchema.parse({ changes: { bills: [] } });
		expect(changes.billPayments).toEqual([]);
		expect(changes.bills).toEqual([]);
	});

	it('remessa sem changes nenhum: billPayments vazio também', () => {
		expect(pushBodySchema.parse({}).changes.billPayments).toEqual([]);
	});

	it('as linhas chegam cruas: uma inválida não derruba o envelope', () => {
		const { changes } = pushBodySchema.parse({
			changes: { billPayments: [incomingPayment(), incomingPayment({ id: 'ruim', month: '2026-13' })] },
		});
		expect(changes.billPayments).toHaveLength(2);
	});
});

describe('meses das contas no cursor', () => {
	it('o cursor que um app sem a coleção guardou continua valendo, e a coleção nova parte do zero', () => {
		const { cursor } = pullQuerySchema.parse({
			cursor: JSON.stringify({ categories: 10, bills: 7, preferences: 3 }),
		});
		expect(cursor.bills).toBe(7);
		expect(cursor.billPayments).toBe(0);
	});

	it('sem cursor (primeiro login), a coleção nova também parte do zero', () => {
		expect(pullQuerySchema.parse({}).cursor.billPayments).toBe(0);
	});

	it('a chave existe no cursor: é por ela que o app sabe que este servidor conhece a coleção', () => {
		expect(Object.keys(cursorSchema.shape)).toContain('billPayments');
	});
});

describe('meses das contas no fio', () => {
	it('o valor sai de bigint para number, serializável em JSON', () => {
		const wire = billPaymentToWire(storedPayment({ amountCents: 1_234_567n }));
		expect(wire.amountCents).toBe(1_234_567);
		expect(() => JSON.stringify(wire)).not.toThrow();
	});

	it('valor nulo continua nulo nas duas direções, nunca vira 0', () => {
		expect(billPaymentToWire(storedPayment({ amountCents: null })).amountCents).toBeNull();
		expect(billPaymentColumns(incomingPayment({ amountCents: null })).amountCents).toBeNull();
		expect(billPaymentColumns(incomingPayment({ amountCents: undefined })).amountCents).toBeNull();
	});

	it('a lápide viaja como instante, e a linha viva como nulo', () => {
		expect(billPaymentToWire(storedPayment()).deletedAt).toBeNull();
		expect(
			billPaymentToWire(storedPayment({ deletedAt: new Date('2026-11-12T13:00:00.000Z') })).deletedAt
		).toBe('2026-11-12T13:00:00.000Z');
	});

	it('ida e volta: o que o pull entrega é o que o push aceita, campo a campo', () => {
		const wire = billPaymentToWire(storedPayment());
		expect(billPaymentSchema.safeParse(wire).success).toBe(true);
		expect(billPaymentToWire({ id: wire.id, ...billPaymentColumns(wire) })).toEqual(wire);
	});

	it('o fio tem exatamente os campos do contrato', () => {
		expect(Object.keys(billPaymentToWire(storedPayment())).sort()).toEqual(
			['id', 'billId', 'month', 'status', 'transactionId', 'amountCents', 'updatedAt', 'deletedAt'].sort()
		);
	});

	it('campo ausente na chegada vira nulo na coluna, nunca undefined', () => {
		// `undefined` faria o Prisma manter o valor antigo no update: o desfazer que tirou a
		// lápide, ou o mês que deixou de ter lançamento, nunca se propagaria.
		const columns = billPaymentColumns({
			...incomingPayment(),
			transactionId: undefined,
			amountCents: undefined,
			deletedAt: undefined,
		});
		for (const value of Object.values(columns)) {
			expect(value).not.toBeUndefined();
		}
		expect(columns.transactionId).toBeNull();
		expect(columns.deletedAt).toBeNull();
	});

	it('o mês é texto de calendário, não vira Date; o carimbo vira, para o last-write-wins', () => {
		const columns = billPaymentColumns(incomingPayment());
		expect(columns.month).toBe('2026-11');
		expect(columns.updatedAt).toEqual(new Date('2026-11-12T12:00:00.000Z'));
	});
});

// ---------------------------------------------------------------------------
// O schema e a migração
// ---------------------------------------------------------------------------

const PRISMA_DIR = join(__dirname, '..', 'prisma');
const schema = readFileSync(join(PRISMA_DIR, 'schema.prisma'), 'utf8');

const migrationOf = (table: string): string | undefined =>
	readdirSync(join(PRISMA_DIR, 'migrations'))
		.filter((dir) => !dir.endsWith('.toml'))
		.map((dir) => readFileSync(join(PRISMA_DIR, 'migrations', dir, 'migration.sql'), 'utf8'))
		.find((text) => text.includes(`CREATE TABLE "${table}"`));

describe('a tabela bill_payments', () => {
	it('existe no schema, ligada ao usuário', () => {
		expect(schema).toMatch(/^model BillPayment \{/m);
		expect(schema).toMatch(/^\s*billPayments\s+BillPayment\[\]\s*$/m);
		expect(schema).toMatch(/@@map\("bill_payments"\)/);
	});

	it('tem migração que só cria a tabela nova: nada é apagado nem alterado nas outras', () => {
		const sql = migrationOf('bill_payments');
		expect(sql).toBeDefined();
		expect(sql).not.toMatch(/DROP/);
		// O único ALTER é a FK da própria tabela nova.
		const alters = [...(sql ?? '').matchAll(/ALTER TABLE "(\w+)"/g)].map((m) => m[1]);
		expect(alters).toEqual(['bill_payments']);
	});

	it('a FK para users apaga em cascata (apagar a conta leva os meses junto)', () => {
		expect(migrationOf('bill_payments')).toMatch(
			/ADD CONSTRAINT "bill_payments_userId_fkey" FOREIGN KEY \("userId"\) REFERENCES "users"\("id"\) ON DELETE CASCADE/
		);
	});

	it('tem o gatilho que dá serverSeq nova a cada UPDATE, como as outras tabelas sincronizadas', () => {
		// Sem ele, desfazer um mês num aparelho nunca chegaria aos outros: o cursor deles já
		// passou daquela sequência.
		expect(migrationOf('bill_payments')).toMatch(
			/CREATE TRIGGER bill_payments_bump_server_seq\s+BEFORE UPDATE ON "bill_payments"\s+FOR EACH ROW EXECUTE FUNCTION bump_server_seq\(\);/
		);
	});

	it('a chave é (usuário, id) e o cursor tem índice, como em bills', () => {
		const sql = migrationOf('bill_payments') ?? '';
		expect(sql).toMatch(/CONSTRAINT "bill_payments_pkey" PRIMARY KEY \("userId","id"\)/);
		expect(sql).toMatch(/CREATE UNIQUE INDEX "bill_payments_serverSeq_key"/);
		expect(sql).toMatch(/CREATE INDEX "bill_payments_userId_serverSeq_idx" ON "bill_payments"\("userId", "serverSeq"\)/);
	});
});
