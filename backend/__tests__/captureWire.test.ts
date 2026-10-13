/**
 * A tradução das capturas e das regras aprendidas (v19) entre a coluna e o fio.
 *
 * O caso real que motivou a coleção: o app foi desinstalado e duas semanas de compras
 * capturadas, que esperavam revisão só no aparelho, foram embora. O que estes testes
 * protegem é o que faria a sincronização existir e ainda assim não funcionar:
 *
 *  - o `id` que viaja tem de ser o fingerprint, não o id local do aparelho;
 *  - `postedAt` e `createdAt` têm de voltar verbatim, inclusive sem fuso (o que a
 *    importação de extrato gera) — reformatar faria as duas cópias deixarem de casar;
 *  - `amountCents` tem de sair de bigint para number, senão o pull inteiro morre no
 *    `JSON.stringify`.
 *
 * Fora de `src/` de propósito, como o teste dos orçamentos: aqui quem roda é o jest da
 * raiz. O módulo testado não importa Prisma nem `env`, então roda sem banco e sem
 * variável de ambiente nenhuma.
 */

import {
	captureColumns,
	captureToWire,
	type IncomingCapture,
	type StoredCapture,
	merchantRuleColumns,
	merchantRuleToWire,
} from '../src/domain/captureWire';

const incomingCapture = (over: Partial<IncomingCapture> = {}): IncomingCapture => ({
	// O id é o fingerprint da notificação (`fingerprintOf`), não o id local.
	id: 'a1b2c3d4-e5f6a7b8',
	packageName: 'com.nubank.app',
	appLabel: 'Nubank',
	title: 'Compra aprovada',
	text: 'Compra de R$ 37,90 em IFD*IFOOD aprovada no cartão final 1234',
	postedAt: '2026-10-13T21:14:00.000Z',
	amountCents: 3790,
	direction: 'out',
	kind: 'purchase',
	counterparty: 'IFD*IFOOD',
	merchantKey: 'ifood',
	cardLast4: '1234',
	status: 'pending',
	question: null,
	relatedFingerprint: null,
	suggestedCategory: 'food',
	transactionId: null,
	autoConfirmed: false,
	reason: null,
	accountId: null,
	transferId: null,
	installments: null,
	createdAt: '2026-10-13T21:14:02.500Z',
	updatedAt: '2026-10-13T21:14:02.500Z',
	deletedAt: null,
	...over,
});

const storedCapture = (over: Partial<StoredCapture> = {}): StoredCapture => {
	const { amountCents, updatedAt, deletedAt, ...rest } = incomingCapture();
	return {
		...rest,
		amountCents: BigInt(amountCents),
		updatedAt: new Date(updatedAt),
		deletedAt: null,
		...over,
	};
};

describe('capturas no fio', () => {
	it('o id que viaja é o fingerprint, e volta igual', () => {
		const wire = captureToWire(storedCapture({ id: 'deadbeef-cafebabe' }));
		expect(wire.id).toBe('deadbeef-cafebabe');
	});

	it('o valor sai de bigint para number, serializável em JSON', () => {
		const wire = captureToWire(storedCapture({ amountCents: 1_234_567n }));
		expect(wire.amountCents).toBe(1_234_567);
		expect(() => JSON.stringify(wire)).not.toThrow();
	});

	it('o teto do app (10^15 centavos) atravessa sem perder um centavo', () => {
		const wire = captureToWire(storedCapture({ amountCents: 1_000_000_000_000_000n }));
		expect(wire.amountCents).toBe(1_000_000_000_000_000);
	});

	it('postedAt e createdAt voltam verbatim, inclusive sem fuso', () => {
		// É o que `statementPostedAt` gera na importação de extrato: meio-dia local, sem
		// fuso. Virar timestamp e voltar escreveria outro texto, e o app ordena por ele.
		const row = storedCapture({ postedAt: '2026-10-13T12:00:00.000', createdAt: '2026-10-13T12:00:00.000' });
		const wire = captureToWire(row);
		expect(wire.postedAt).toBe('2026-10-13T12:00:00.000');
		expect(wire.createdAt).toBe('2026-10-13T12:00:00.000');
	});

	it('o texto cru da notificação não é tocado', () => {
		const text = 'Compra de R$ 1.234,56 em  PAG*LOJA   \n(parcela 2/3)';
		const wire = captureToWire(storedCapture({ text, title: '  Nubank  ' }));
		expect(wire.text).toBe(text);
		expect(wire.title).toBe('  Nubank  ');
	});

	it('a lápide viaja como instante, e a linha viva como nulo', () => {
		expect(captureToWire(storedCapture()).deletedAt).toBeNull();
		expect(
			captureToWire(storedCapture({ deletedAt: new Date('2026-10-14T08:00:00.000Z') })).deletedAt
		).toBe('2026-10-14T08:00:00.000Z');
	});

	it('ida e volta: o que o pull entrega é o que o push aceita, campo a campo', () => {
		const wire = captureToWire(storedCapture());
		const { id, ...columns } = { id: wire.id, ...captureColumns(wire) };

		expect(id).toBe(wire.id);
		expect(captureToWire({ ...columns, id } as StoredCapture)).toEqual(wire);
	});

	it('campo ausente na chegada vira nulo na coluna, nunca undefined', () => {
		// Um aparelho anterior a um campo simplesmente não o manda. `undefined` numa
		// coluna faria o Prisma **manter o valor antigo** no update, e a edição que
		// limpou o campo nunca se propagaria.
		const columns = captureColumns({
			...incomingCapture(),
			counterparty: undefined,
			merchantKey: undefined,
			cardLast4: undefined,
			question: undefined,
			relatedFingerprint: undefined,
			suggestedCategory: undefined,
			transactionId: undefined,
			reason: undefined,
			accountId: undefined,
			transferId: undefined,
			installments: undefined,
			deletedAt: undefined,
		});

		for (const value of Object.values(columns)) {
			expect(value).not.toBeUndefined();
		}
		expect(columns.counterparty).toBeNull();
		expect(columns.installments).toBeNull();
		expect(columns.deletedAt).toBeNull();
	});

	it('as datas chegam como texto e entram como Date, para o last-write-wins comparar', () => {
		const columns = captureColumns(
			incomingCapture({ updatedAt: '2026-10-13T21:14:02.500Z', deletedAt: '2026-10-14T08:00:00.000Z' })
		);
		expect(columns.updatedAt).toEqual(new Date('2026-10-13T21:14:02.500Z'));
		expect(columns.deletedAt).toEqual(new Date('2026-10-14T08:00:00.000Z'));
		// Já `postedAt` continua texto: é o único instante do schema que não é DateTime.
		expect(typeof columns.postedAt).toBe('string');
	});
});

describe('regras aprendidas no fio', () => {
	const rule = {
		id: 'ifood',
		categoryId: 'food',
		treatAs: 'transaction',
		confirmations: 3,
		updatedAt: '2026-10-13T21:20:00.000Z',
		deletedAt: null,
	};

	it('o id é a própria merchantKey', () => {
		const wire = merchantRuleToWire({
			...rule,
			updatedAt: new Date(rule.updatedAt),
			deletedAt: null,
		});
		expect(wire.id).toBe('ifood');
	});

	it('a contagem de confirmações vem como está, sem somar nem tomar o máximo', () => {
		// Tentador juntar as duas contagens, mas o app aplica o pull por last-write-wins:
		// um servidor que inventasse outra regra faria as cópias nunca convergirem.
		expect(merchantRuleColumns({ ...rule, confirmations: 1 }).confirmations).toBe(1);
		expect(merchantRuleColumns({ ...rule, confirmations: 0 }).confirmations).toBe(0);
	});

	it('categoria ausente vira nulo: a regra "só ignore isto" não tem categoria', () => {
		const columns = merchantRuleColumns({ ...rule, categoryId: undefined, treatAs: 'ignore' });
		expect(columns.categoryId).toBeNull();
		expect(columns.treatAs).toBe('ignore');
	});

	it('ida e volta sem perder nada', () => {
		const wire = merchantRuleToWire({ ...rule, updatedAt: new Date(rule.updatedAt), deletedAt: null });
		const columns = merchantRuleColumns(wire);
		expect(merchantRuleToWire({ id: wire.id, ...columns })).toEqual(wire);
	});
});
