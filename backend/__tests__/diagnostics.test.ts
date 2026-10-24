/**
 * Diário de diagnóstico no servidor (`POST /api/diagnostics`, DEC-03): a validação do lote,
 * a gravação e a retenção de 30 dias.
 *
 * O que estes testes protegem:
 *
 *  - o lote segue os limites de `app/diagnostics/contract.ts` (o backend não importa o app,
 *    espelha a forma em zod): versão, de 1 a 500 eventos, metadados escalares e curtos;
 *  - texto longo é cortado, não recusado — o aviso de banco que o parser não entendeu é
 *    justamente o que mais interessa ler, e perder o evento por 1 caractere a mais seria
 *    perder o diagnóstico;
 *  - um evento ruim é recusado **sozinho**, com o motivo: derrubar o lote faria o aparelho
 *    reenviar para sempre os 499 bons junto com o ruim;
 *  - reenviar o mesmo id não duplica a linha e conta como `duplicates`;
 *  - a limpeza apaga o que tem `at` com mais de 30 dias, roda na subida e a cada 24 h, e
 *    o timer não segura o processo.
 *
 * Fora de `src/` de propósito, como os outros testes do servidor (ver `billWire.test.ts`).
 */

import {
	type DiagnosticsDb,
	type DiagnosticRow,
	insertDiagnostics,
	purgeExpiredDiagnostics,
	scheduleDiagnosticsRetention,
} from '../src/domain/diagnostics';
import {
	DIAGNOSTIC_LIMITS,
	parseDiagnosticBatch,
	retentionCutoff,
} from '../src/schemas/diagnostics';

// `domain/diagnostics.ts` importa o schema com a extensão `.js` do ESM, que o jest da raiz
// não resolve para o `.ts`: o módulo virtual aponta para o arquivo de verdade.
jest.mock('../src/schemas/diagnostics.js', () => jest.requireActual('../src/schemas/diagnostics'), {
	virtual: true,
});

const NOW = new Date('2026-10-24T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

const event = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
	id: '0f8fad5b-d9cb-469f-a165-70867728950e',
	at: '2026-10-24T11:59:00.000Z',
	level: 'warn',
	area: 'capture',
	event: 'capture_discarded',
	data: { packageName: 'com.exemplo.banco', reason: 'no_amount', length: 42, known: true, extra: null },
	rawText: 'Compra aprovada no cartão final 0000',
	appVersion: '1.2.9',
	platform: 'android',
	installId: 'c9bf9e57-1685-4c89-bafb-ff5af830be8a',
	...over,
});

const batch = (events: unknown[]): unknown => ({ schemaVersion: 1, events });

/** Um id diferente por evento, no formato do aparelho. */
const idOf = (n: number): string => `0f8fad5b-d9cb-469f-a165-${String(n).padStart(12, '0')}`;

const rejectedPaths = (raw: Record<string, unknown>): string[] =>
	parseDiagnosticBatch(batch([raw]), NOW).rejected.map((item) => item.reason);

describe('o lote', () => {
	it('um lote válido passa inteiro', () => {
		const parsed = parseDiagnosticBatch(batch([event(), event({ id: idOf(2), rawText: null, data: undefined })]), NOW);

		expect(parsed.rejected).toEqual([]);
		expect(parsed.events).toHaveLength(2);
		expect(parsed.events[0]).toMatchObject({ id: '0f8fad5b-d9cb-469f-a165-70867728950e', level: 'warn' });
	});

	it('versão desconhecida, lote vazio, lote acima de 500 e corpo que não é lote derrubam o envio', () => {
		const tooMany = Array.from({ length: DIAGNOSTIC_LIMITS.maxEventsPerBatch + 1 }, (_, n) => event({ id: idOf(n) }));

		expect(() => parseDiagnosticBatch({ schemaVersion: 2, events: [event()] }, NOW)).toThrow();
		expect(() => parseDiagnosticBatch(batch([]), NOW)).toThrow();
		expect(() => parseDiagnosticBatch(batch(tooMany), NOW)).toThrow();
		expect(() => parseDiagnosticBatch([event()], NOW)).toThrow();
		expect(() => parseDiagnosticBatch(undefined, NOW)).toThrow();
	});

	it('500 eventos é o teto, e cabe', () => {
		const full = Array.from({ length: DIAGNOSTIC_LIMITS.maxEventsPerBatch }, (_, n) => event({ id: idOf(n) }));

		expect(parseDiagnosticBatch(batch(full), NOW).events).toHaveLength(500);
	});

	it('um evento inválido sai sozinho, com o índice, o id e o motivo; os outros entram', () => {
		const parsed = parseDiagnosticBatch(
			batch([event({ id: idOf(1) }), event({ id: idOf(2), level: 'fatal' }), event({ id: idOf(3) })]),
			NOW
		);

		expect(parsed.events.map((item) => item.id)).toEqual([idOf(1), idOf(3)]);
		expect(parsed.rejected).toEqual([{ index: 1, id: idOf(2), reason: expect.stringContaining('level') }]);
	});

	it('um item que nem é objeto também sai sozinho, sem id', () => {
		const parsed = parseDiagnosticBatch(batch([event(), 'lixo', null]), NOW);

		expect(parsed.events).toHaveLength(1);
		expect(parsed.rejected.map((item) => [item.index, item.id])).toEqual([
			[1, null],
			[2, null],
		]);
	});
});

describe('os limites de um evento', () => {
	it('texto longo é cortado: metadado em 200, rawText em 2000', () => {
		const [parsed] = parseDiagnosticBatch(
			batch([event({ data: { note: 'a'.repeat(500) }, rawText: 'b'.repeat(5000) })]),
			NOW
		).events;

		expect(parsed?.data?.['note']).toBe('a'.repeat(DIAGNOSTIC_LIMITS.maxStringLength));
		expect(parsed?.rawText).toBe('b'.repeat(DIAGNOSTIC_LIMITS.maxRawTextLength));
	});

	it('o corte não parte um emoji ao meio', () => {
		const [parsed] = parseDiagnosticBatch(
			batch([event({ data: { note: `${'a'.repeat(199)}😀` } })]),
			NOW
		).events;
		const note = parsed?.data?.['note'] as string;

		expect(note).toBe('a'.repeat(199));
		expect(note.charCodeAt(note.length - 1)).toBeLessThan(0xd800);
	});

	it('o caractere nulo some do texto (o Postgres recusaria a linha e o lote inteiro)', () => {
		const [parsed] = parseDiagnosticBatch(
			batch([event({ data: { note: 'a\u0000b' }, rawText: 'c\u0000d' })]),
			NOW
		).events;

		expect(parsed?.data?.['note']).toBe('ab');
		expect(parsed?.rawText).toBe('cd');
	});

	it('o que não dá para cortar sem mudar o sentido é recusado, com o caminho no motivo', () => {
		const tooManyKeys = Object.fromEntries(
			Array.from({ length: DIAGNOSTIC_LIMITS.maxDataKeys + 1 }, (_, n) => [`k${n}`, n])
		);

		expect(rejectedPaths(event({ level: 'fatal' }))).toEqual([expect.stringContaining('level')]);
		expect(rejectedPaths(event({ area: 'banco' }))).toEqual([expect.stringContaining('area')]);
		expect(rejectedPaths(event({ platform: 'symbian' }))).toEqual([expect.stringContaining('platform')]);
		expect(rejectedPaths(event({ event: 'e'.repeat(65) }))).toEqual([expect.stringContaining('event')]);
		expect(rejectedPaths(event({ event: '' }))).toEqual([expect.stringContaining('event')]);
		expect(rejectedPaths(event({ id: '' }))).toEqual([expect.stringContaining('id')]);
		expect(rejectedPaths(event({ at: 'ontem' }))).toEqual([expect.stringContaining('at')]);
		expect(rejectedPaths(event({ appVersion: undefined }))).toEqual([expect.stringContaining('appVersion')]);
		expect(rejectedPaths(event({ data: tooManyKeys }))).toEqual([expect.stringContaining('data')]);
		expect(rejectedPaths(event({ data: { ['k'.repeat(41)]: 1 } }))).toEqual([expect.stringContaining('data')]);
		expect(rejectedPaths(event({ data: { nested: { a: 1 } } }))).toEqual([expect.stringContaining('data')]);
		expect(rejectedPaths(event({ data: { list: [1, 2] } }))).toEqual([expect.stringContaining('data')]);
	});

	it('20 chaves e chave de 40 caracteres ainda cabem', () => {
		const twenty = Object.fromEntries(
			Array.from({ length: DIAGNOSTIC_LIMITS.maxDataKeys }, (_, n) => [`k${n}`, n])
		);

		expect(rejectedPaths(event({ data: twenty }))).toEqual([]);
		expect(rejectedPaths(event({ data: { ['k'.repeat(40)]: 1 } }))).toEqual([]);
	});

	it('`at` com mais de 30 dias ou mais de um dia no futuro é recusado: a limpeza não daria conta dele', () => {
		const old = new Date(NOW.getTime() - 31 * DAY_MS).toISOString();
		const future = new Date(NOW.getTime() + 2 * DAY_MS).toISOString();
		const slightlyAhead = new Date(NOW.getTime() + 60 * 60 * 1000).toISOString();

		expect(rejectedPaths(event({ at: old }))).toEqual([expect.stringContaining('at')]);
		expect(rejectedPaths(event({ at: future }))).toEqual([expect.stringContaining('at')]);
		// Relógio do aparelho um pouco adiantado é normal e não pode custar o evento.
		expect(rejectedPaths(event({ at: slightlyAhead }))).toEqual([]);
	});

	it('o motivo não ecoa o texto recebido', () => {
		const [rejected] = parseDiagnosticBatch(batch([event({ level: 'segredo-123' })]), NOW).rejected;

		expect(rejected?.reason).not.toContain('segredo-123');
	});
});

/** Banco falso: guarda as chaves (userId, id) como o `skipDuplicates` faria. */
const fakeDb = () => {
	const keys = new Set<string>();
	const calls: { data: DiagnosticRow[]; skipDuplicates: boolean }[] = [];
	const deletes: { where: { at: { lt: Date } } }[] = [];
	const db: DiagnosticsDb = {
		diagnosticEvent: {
			createMany: async (args) => {
				calls.push(args);
				let count = 0;
				for (const row of args.data) {
					const key = `${row.userId}/${row.id}`;
					if (!keys.has(key)) {
						keys.add(key);
						count++;
					}
				}
				return { count };
			},
			deleteMany: async (args) => {
				deletes.push(args);
				return { count: 7 };
			},
		},
	};
	return { db, calls, deletes };
};

describe('a gravação', () => {
	it('grava com o dono do token, pulando duplicata, e conta o que entrou', async () => {
		const { db, calls } = fakeDb();
		const parsed = parseDiagnosticBatch(batch([event({ id: idOf(1) }), event({ id: idOf(2), rawText: null, data: undefined })]), NOW);

		const result = await insertDiagnostics(db, 'user-1', parsed);

		expect(result).toEqual({ accepted: 2, duplicates: 0, rejected: [] });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.skipDuplicates).toBe(true);
		expect(calls[0]?.data[0]).toEqual({
			userId: 'user-1',
			id: idOf(1),
			at: new Date('2026-10-24T11:59:00.000Z'),
			level: 'warn',
			area: 'capture',
			event: 'capture_discarded',
			data: { packageName: 'com.exemplo.banco', reason: 'no_amount', length: 42, known: true, extra: null },
			rawText: 'Compra aprovada no cartão final 0000',
			appVersion: '1.2.9',
			platform: 'android',
			installId: 'c9bf9e57-1685-4c89-bafb-ff5af830be8a',
		});
		// Sem metadado, a coluna fica de fora (NULL), e não vira um JSON `null`.
		expect(calls[0]?.data[1]).not.toHaveProperty('data');
		expect(calls[0]?.data[1]?.rawText).toBeNull();
	});

	it('reenviar o mesmo lote não duplica: tudo volta como `duplicates`', async () => {
		const { db } = fakeDb();
		const raw = batch([event({ id: idOf(1) }), event({ id: idOf(2) })]);

		await insertDiagnostics(db, 'user-1', parseDiagnosticBatch(raw, NOW));
		const again = await insertDiagnostics(db, 'user-1', parseDiagnosticBatch(raw, NOW));

		expect(again).toEqual({ accepted: 0, duplicates: 2, rejected: [] });
	});

	it('o mesmo id duas vezes no lote entra uma vez só', async () => {
		const { db } = fakeDb();
		const parsed = parseDiagnosticBatch(batch([event({ id: idOf(1) }), event({ id: idOf(1) })]), NOW);

		expect(await insertDiagnostics(db, 'user-1', parsed)).toEqual({ accepted: 1, duplicates: 1, rejected: [] });
	});

	it('o mesmo id de outro usuário não é duplicata', async () => {
		const { db } = fakeDb();
		const raw = batch([event({ id: idOf(1) })]);

		await insertDiagnostics(db, 'user-1', parseDiagnosticBatch(raw, NOW));

		expect(await insertDiagnostics(db, 'user-2', parseDiagnosticBatch(raw, NOW))).toMatchObject({ accepted: 1 });
	});

	it('o recusado volta na resposta e não entra; lote só de recusados nem vai ao banco', async () => {
		const { db, calls } = fakeDb();

		const mixed = await insertDiagnostics(
			db,
			'user-1',
			parseDiagnosticBatch(batch([event({ id: idOf(1) }), event({ id: idOf(2), area: 'banco' })]), NOW)
		);
		const onlyBad = await insertDiagnostics(db, 'user-1', parseDiagnosticBatch(batch([event({ area: 'banco' })]), NOW));

		expect(mixed).toMatchObject({ accepted: 1, duplicates: 0, rejected: [{ index: 1, id: idOf(2) }] });
		expect(onlyBad).toMatchObject({ accepted: 0, duplicates: 0 });
		expect(onlyBad.rejected).toHaveLength(1);
		expect(calls).toHaveLength(1);
	});
});

describe('a retenção de 30 dias', () => {
	it('o corte é 30 dias exatos antes de agora, em qualquer fuso', () => {
		expect(DIAGNOSTIC_LIMITS.retentionDays).toBe(30);
		expect(retentionCutoff(NOW).toISOString()).toBe('2026-09-24T12:00:00.000Z');
		// Atravessa o início do horário de verão da Nova Zelândia (27/09) sem perder uma hora.
		expect(retentionCutoff(new Date('2026-10-01T00:30:00.000Z')).toISOString()).toBe('2026-09-01T00:30:00.000Z');
	});

	it('a limpeza apaga o que tem `at` antes do corte e devolve quantos', async () => {
		const { db, deletes } = fakeDb();

		expect(await purgeExpiredDiagnostics(db, NOW)).toBe(7);
		expect(deletes).toEqual([{ where: { at: { lt: new Date('2026-09-24T12:00:00.000Z') } } }]);
	});

	describe('o agendamento', () => {
		let log: jest.SpyInstance;
		let error: jest.SpyInstance;

		beforeEach(() => {
			log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
			error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
		});

		afterEach(() => {
			jest.useRealTimers();
			log.mockRestore();
			error.mockRestore();
		});

		it('roda na subida e depois a cada 24 h', async () => {
			jest.useFakeTimers();
			const { db, deletes } = fakeDb();

			const timer = scheduleDiagnosticsRetention(db, { now: () => NOW });
			await Promise.resolve();
			expect(deletes).toHaveLength(1);

			jest.advanceTimersByTime(DAY_MS - 1);
			expect(deletes).toHaveLength(1);
			jest.advanceTimersByTime(1);
			expect(deletes).toHaveLength(2);
			jest.advanceTimersByTime(DAY_MS);
			expect(deletes).toHaveLength(3);

			clearInterval(timer);
		});

		it('o timer não segura o processo', () => {
			const { db } = fakeDb();

			const timer = scheduleDiagnosticsRetention(db, { now: () => NOW });

			expect(timer.hasRef()).toBe(false);
			clearInterval(timer);
		});

		it('uma falha do banco vira uma linha de erro, não uma rejeição solta que derruba o processo', async () => {
			const db: DiagnosticsDb = {
				diagnosticEvent: {
					createMany: async () => ({ count: 0 }),
					deleteMany: async () => {
						throw new Error('conexão recusada');
					},
				},
			};

			const timer = scheduleDiagnosticsRetention(db, { now: () => NOW });
			await new Promise((resolve) => setImmediate(resolve));

			expect(error).toHaveBeenCalledTimes(1);
			expect(String(error.mock.calls[0]?.join(' '))).toContain('conexão recusada');
			clearInterval(timer);
		});
	});
});
