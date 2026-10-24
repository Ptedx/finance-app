/**
 * Envio do diário ao servidor (SPD-016): os lotes cabem nos limites da rota, o que subiu
 * (ou foi recusado) é marcado, a falha deixa para o próximo gatilho, e o envio só acontece
 * com sessão, com o app na frente e no máximo a cada 6 h. 401 fica para a sessão; servidor
 * sem a rota (404/405) só é tentado de novo na próxima abertura do app.
 *
 * O cliente HTTP, o diário, a fila de sync e o AppState são mocks.
 */

const mockApp: { state: string; handler: ((state: string) => void) | null; removed: number } = {
	state: 'active',
	handler: null,
	removed: 0,
};

jest.mock('react-native', () => ({
	AppState: {
		get currentState() {
			return mockApp.state;
		},
		addEventListener: (_event: string, handler: (state: string) => void) => {
			mockApp.handler = handler;
			return {
				remove: () => {
					mockApp.removed += 1;
				},
			};
		},
	},
}));

const mockDiary = {
	events: [] as { id: string; event: string }[],
	marked: [] as string[],
	stamp: null as number | null,
};

jest.mock('../diary', () => ({
	readEvents: jest.fn(async (options?: { pendingOnly?: boolean }) => {
		if (!options?.pendingOnly) return mockDiary.events;
		const cursor = mockDiary.marked[mockDiary.marked.length - 1];
		const index = cursor ? mockDiary.events.findIndex((event) => event.id === cursor) : -1;
		return mockDiary.events.slice(index + 1);
	}),
	markUploaded: jest.fn(async (id: string) => {
		mockDiary.marked.push(id);
		return true;
	}),
	logEvent: jest.fn(),
	readUploadStamp: jest.fn(async () => mockDiary.stamp),
	writeUploadStamp: jest.fn(async (at: number) => {
		mockDiary.stamp = at;
		return true;
	}),
	utf8Length: (text: string) => Buffer.byteLength(text, 'utf8'),
}));

// Sem `class` na fábrica (ver `diary.test.ts`): o erro é um Error com os campos do ApiError.
jest.mock('../../api/client', () => {
	function ApiError(this: Error & { status: number; code: string }, status: number, message: string, code: string) {
		const error = new Error(message) as Error & { status: number; code: string };
		error.name = 'ApiError';
		error.status = status;
		error.code = code;
		Object.setPrototypeOf(error, ApiError.prototype);
		return error;
	}
	ApiError.prototype = Object.create(Error.prototype);
	return { ApiError, apiRequest: jest.fn() };
});

const mockQueue: {
	enabled: boolean;
	status: string;
	listener: ((state: { status: string; lastError: string | null }) => void) | null;
} = { enabled: true, status: 'idle', listener: null };

jest.mock('../../sync/queue', () => ({
	isEnabled: () => mockQueue.enabled,
	getState: () => ({ status: mockQueue.status, lastError: null, pending: 0, pulledVersion: 0 }),
	subscribe: (listener: (state: { status: string; lastError: string | null }) => void) => {
		mockQueue.listener = listener;
		listener({ status: mockQueue.status, lastError: null });
		return () => {
			mockQueue.listener = null;
		};
	},
}));

import { ApiError, apiRequest } from '../../api/client';
import { DIAGNOSTIC_SCHEMA_VERSION, type DiagnosticBatchResult, type DiagnosticEvent } from '../contract';
import { logEvent, markUploaded, writeUploadStamp } from '../diary';
import {
	buildBatches,
	DIAGNOSTICS_PATH,
	maybeUploadDiary,
	resetUploadForTests,
	startDiaryUploads,
	UPLOAD_LIMITS,
	uploadPendingDiary,
} from '../upload';

const request = apiRequest as jest.Mock;
const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-10-24T12:00:00.000Z');

const makeEvent = (n: number, extra: Partial<DiagnosticEvent> = {}): DiagnosticEvent => ({
	id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
	at: '2026-10-24T10:00:00.000Z',
	level: 'info',
	area: 'app',
	event: `evento_${n}`,
	appVersion: '1.2.9',
	platform: 'android',
	installId: '11111111-1111-4111-8111-111111111111',
	...extra,
});

const makeEvents = (count: number, extra?: Partial<DiagnosticEvent>): DiagnosticEvent[] =>
	Array.from({ length: count }, (_, i) => makeEvent(i + 1, extra));

/** Corpo como o cliente HTTP manda: `JSON.stringify` do lote, em bytes UTF-8. */
const bodyBytes = (events: DiagnosticEvent[]): number =>
	Buffer.byteLength(JSON.stringify({ schemaVersion: DIAGNOSTIC_SCHEMA_VERSION, events }), 'utf8');

const ok = (result: Partial<DiagnosticBatchResult> = {}) => ({ accepted: 0, duplicates: 0, ...result });

/** Os lotes que chegaram ao cliente HTTP. */
const sentBatches = (): DiagnosticEvent[][] =>
	request.mock.calls.map(([, options]) => (options as { body: { events: DiagnosticEvent[] } }).body.events);

const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
	jest.clearAllMocks();
	request.mockReset();
	mockApp.state = 'active';
	mockApp.handler = null;
	mockApp.removed = 0;
	mockDiary.events = [];
	mockDiary.marked = [];
	mockDiary.stamp = null;
	mockQueue.enabled = true;
	mockQueue.status = 'idle';
	mockQueue.listener = null;
	resetUploadForTests();
	jest.spyOn(console, 'warn').mockImplementation(() => {});
	jest.spyOn(console, 'log').mockImplementation(() => {});
});

// Só os espiões: `restoreAllMocks` também apagaria as implementações das fábricas acima.
afterEach(() => {
	(console.warn as jest.Mock).mockRestore();
	(console.log as jest.Mock).mockRestore();
	if (jest.isMockFunction(Date.now)) (Date.now as jest.Mock).mockRestore();
});

describe('montagem dos lotes', () => {
	it('por quantidade: no máximo 500 por lote, na ordem', () => {
		const events = makeEvents(1203);
		const batches = buildBatches(events);

		expect(batches.map((batch) => batch.length)).toEqual([500, 500, 203]);
		expect(batches.flat()).toEqual(events);
	});

	it('por tamanho: o corpo inteiro fica abaixo de ~450 KB, mesmo com eventos de ~7 KB', () => {
		// 2000 caracteres de texto cru de 3 bytes cada (o pior caso do UTF-8 por caractere):
		// mais de 6 KB por evento.
		const rawText = '€'.repeat(2000);
		const events = makeEvents(300, { rawText });
		const one = bodyBytes([events[0]]);
		expect(one).toBeGreaterThan(6 * 1024);

		const batches = buildBatches(events);

		expect(batches.length).toBeGreaterThan(1);
		expect(batches.flat()).toEqual(events);
		for (const batch of batches) {
			expect(batch.length).toBeLessThanOrEqual(UPLOAD_LIMITS.maxEventsPerBatch);
			expect(bodyBytes(batch)).toBeLessThanOrEqual(UPLOAD_LIMITS.maxBatchBytes);
		}
		// Não desperdiça: cada lote (menos o último) não comportava o evento seguinte.
		for (let i = 0; i < batches.length - 1; i++) {
			expect(bodyBytes([...batches[i], batches[i + 1][0]])).toBeGreaterThan(UPLOAD_LIMITS.maxBatchBytes);
		}
		expect(UPLOAD_LIMITS.maxBatchBytes).toBeLessThan(512 * 1024);
	});

	it('nada pendente: nenhum lote', () => {
		expect(buildBatches([])).toEqual([]);
	});

	it('evento maior que o teto vai sozinho, sem travar os outros', () => {
		const events = [makeEvent(1), makeEvent(2, { rawText: 'x'.repeat(2000) }), makeEvent(3)];
		const batches = buildBatches(events, { maxEventsPerBatch: 500, maxBatchBytes: 1000 });
		expect(batches.map((batch) => batch.map((event) => event.event))).toEqual([
			['evento_1'],
			['evento_2'],
			['evento_3'],
		]);
	});
});

describe('envio e marcação do que subiu', () => {
	it('sucesso: manda pela rota autenticada e marca até o último id de cada lote', async () => {
		mockDiary.events = makeEvents(700);
		request.mockResolvedValue(ok({ accepted: 500 }));

		const report = await uploadPendingDiary();

		expect(report).toEqual({ outcome: 'sent', sent: 700, rejected: 0 });
		expect(DIAGNOSTICS_PATH).toBe('/api/diagnostics');
		expect(request).toHaveBeenCalledTimes(2);
		for (const [path, options] of request.mock.calls) {
			expect(path).toBe('/api/diagnostics');
			expect(options).toMatchObject({ method: 'POST', authenticated: true });
			expect(options.body.schemaVersion).toBe(DIAGNOSTIC_SCHEMA_VERSION);
		}
		expect(sentBatches().map((batch) => batch.length)).toEqual([500, 200]);
		expect(markUploaded).toHaveBeenNthCalledWith(1, mockDiary.events[499].id);
		expect(markUploaded).toHaveBeenNthCalledWith(2, mockDiary.events[699].id);
		expect(logEvent).not.toHaveBeenCalled();
	});

	it('só manda o que está pendente', async () => {
		mockDiary.events = makeEvents(5);
		mockDiary.marked = [mockDiary.events[2].id];
		request.mockResolvedValue(ok({ accepted: 2 }));

		await uploadPendingDiary();

		expect(sentBatches()).toEqual([mockDiary.events.slice(3)]);
	});

	it('recusados contam como enviados e viram um evento local só com a contagem', async () => {
		mockDiary.events = makeEvents(4, { rawText: 'texto do banco' });
		request.mockResolvedValue(
			ok({
				accepted: 2,
				duplicates: 0,
				rejected: [
					{ index: 1, id: mockDiary.events[1].id, reason: 'at: mais antigo que 30 dias.' },
					{ index: 3, id: mockDiary.events[3].id, reason: 'data.x: inválido' },
				],
			})
		);

		const report = await uploadPendingDiary();

		expect(report).toEqual({ outcome: 'sent', sent: 4, rejected: 2 });
		expect(markUploaded).toHaveBeenCalledWith(mockDiary.events[3].id);
		expect(logEvent).toHaveBeenCalledTimes(1);
		const [area, name, options] = (logEvent as jest.Mock).mock.calls[0];
		expect([area, name]).toEqual(['app', 'diary_upload_rejected']);
		expect(options.data).toEqual({ rejected: 2, batch: 4 });
		// Nem o motivo nem o texto do evento recusado.
		expect(JSON.stringify(options)).not.toMatch(/mais antigo|inválido|texto do banco/);
	});

	it('servidor que ainda não manda `rejected` (o campo é opcional)', async () => {
		mockDiary.events = makeEvents(2);
		request.mockResolvedValue({ accepted: 1, duplicates: 1 });

		expect(await uploadPendingDiary()).toEqual({ outcome: 'sent', sent: 2, rejected: 0 });
		expect(markUploaded).toHaveBeenCalledWith(mockDiary.events[1].id);
	});

	it('nada pendente: não chama o servidor', async () => {
		expect(await uploadPendingDiary()).toEqual({ outcome: 'empty', sent: 0, rejected: 0 });
		expect(request).not.toHaveBeenCalled();
	});

	it('falha de rede no segundo lote: o primeiro fica marcado, o resto espera', async () => {
		mockDiary.events = makeEvents(600);
		request
			.mockResolvedValueOnce(ok({ accepted: 500 }))
			.mockRejectedValueOnce(new ApiError(0, 'Sem conexão com o servidor.', 'offline'));

		const report = await uploadPendingDiary();

		expect(report).toEqual({ outcome: 'retry', sent: 500, rejected: 0 });
		expect(markUploaded).toHaveBeenCalledTimes(1);
		expect(markUploaded).toHaveBeenCalledWith(mockDiary.events[499].id);
	});

	it('5xx e 429: nada marcado, tenta de novo depois', async () => {
		for (const status of [500, 503, 429]) {
			jest.clearAllMocks();
			mockDiary.events = makeEvents(3);
			request.mockRejectedValueOnce(new ApiError(status, 'Erro no servidor.', 'error'));

			expect((await uploadPendingDiary()).outcome).toBe('retry');
			expect(markUploaded).not.toHaveBeenCalled();
		}
	});

	it('401: nada marcado, a sessão resolve', async () => {
		mockDiary.events = makeEvents(3);
		request.mockRejectedValueOnce(new ApiError(401, 'Sessão expirada.', 'session_lost'));

		expect((await uploadPendingDiary()).outcome).toBe('auth');
		expect(markUploaded).not.toHaveBeenCalled();
	});

	it('404 e 405: servidor sem a rota', async () => {
		for (const status of [404, 405]) {
			jest.clearAllMocks();
			mockDiary.events = makeEvents(3);
			request.mockRejectedValueOnce(new ApiError(status, 'Não foi possível completar a operação.', 'error'));

			expect((await uploadPendingDiary()).outcome).toBe('unsupported');
			expect(markUploaded).not.toHaveBeenCalled();
		}
	});

	it('o app foi para o fundo no meio: para antes do próximo lote', async () => {
		mockDiary.events = makeEvents(1000);
		request.mockImplementation(async () => {
			mockApp.state = 'background';
			return ok({ accepted: 500 });
		});

		const report = await uploadPendingDiary();

		expect(report).toEqual({ outcome: 'paused', sent: 500, rejected: 0 });
		expect(request).toHaveBeenCalledTimes(1);
	});

	it('nunca põe o conteúdo dos eventos no console', async () => {
		const secret = 'COMPRA APROVADA R$ 123,45 LOJA X';
		mockDiary.events = makeEvents(2, { rawText: secret });
		const warn = console.warn as jest.Mock;
		const log = console.log as jest.Mock;
		const error = jest.spyOn(console, 'error').mockImplementation(() => {});

		for (const failure of [
			new ApiError(500, 'Erro no servidor.', 'error'),
			new ApiError(404, 'Não foi possível completar a operação.', 'error'),
			new ApiError(400, 'events.0: inválido', 'error'),
			new Error(`quebrou ${secret}`),
		]) {
			request.mockRejectedValueOnce(failure);
			await uploadPendingDiary();
		}

		const printed = JSON.stringify([warn.mock.calls, log.mock.calls, error.mock.calls]);
		error.mockRestore();
		expect(printed).not.toContain(secret);
		expect(printed).not.toContain('evento_1');
		expect(printed).not.toContain(mockDiary.events[0].id);
	});
});

describe('quando enviar', () => {
	it('sem sessão: não envia', async () => {
		mockQueue.enabled = false;
		mockDiary.events = makeEvents(3);

		expect(await maybeUploadDiary(NOW)).toBeNull();
		expect(request).not.toHaveBeenCalled();
	});

	it('app em segundo plano: não envia', async () => {
		mockApp.state = 'background';
		mockDiary.events = makeEvents(3);

		expect(await maybeUploadDiary(NOW)).toBeNull();
		expect(request).not.toHaveBeenCalled();
	});

	it('no máximo uma vez a cada 6 h', async () => {
		mockDiary.events = makeEvents(3);
		request.mockResolvedValue(ok({ accepted: 3 }));

		expect((await maybeUploadDiary(NOW))?.outcome).toBe('sent');
		expect(writeUploadStamp).toHaveBeenCalledWith(NOW);

		mockDiary.events = makeEvents(5);
		expect(await maybeUploadDiary(NOW + 5 * HOUR)).toBeNull();
		expect(request).toHaveBeenCalledTimes(1);

		expect((await maybeUploadDiary(NOW + 6 * HOUR))?.outcome).toBe('sent');
		expect(request).toHaveBeenCalledTimes(2);
	});

	it('o intervalo vale entre aberturas do app (fica gravado)', async () => {
		mockDiary.stamp = NOW - 2 * HOUR;
		mockDiary.events = makeEvents(3);

		expect(await maybeUploadDiary(NOW)).toBeNull();

		resetUploadForTests();
		mockDiary.stamp = NOW - 7 * HOUR;
		request.mockResolvedValue(ok({ accepted: 3 }));
		expect((await maybeUploadDiary(NOW))?.outcome).toBe('sent');
	});

	it('relógio voltou para antes do último envio: não espera para sempre', async () => {
		mockDiary.stamp = NOW + 48 * HOUR;
		mockDiary.events = makeEvents(1);
		request.mockResolvedValue(ok({ accepted: 1 }));

		expect((await maybeUploadDiary(NOW))?.outcome).toBe('sent');
	});

	it('nada pendente também conta como envio feito', async () => {
		expect((await maybeUploadDiary(NOW))?.outcome).toBe('empty');
		expect(writeUploadStamp).toHaveBeenCalledWith(NOW);
		expect(await maybeUploadDiary(NOW + HOUR)).toBeNull();
	});

	it('falha de rede ou 5xx: tenta no próximo gatilho, sem esperar 6 h e sem laço', async () => {
		mockDiary.events = makeEvents(3);
		request.mockRejectedValueOnce(new ApiError(0, 'Sem conexão com o servidor.', 'offline'));

		expect((await maybeUploadDiary(NOW))?.outcome).toBe('retry');
		expect(writeUploadStamp).not.toHaveBeenCalled();
		await flush();
		// Uma tentativa por gatilho: nada de nova tentativa sozinha.
		expect(request).toHaveBeenCalledTimes(1);

		request.mockRejectedValueOnce(new ApiError(502, 'O servidor não está respondendo.', 'gateway_unreachable'));
		expect((await maybeUploadDiary(NOW + 60_000))?.outcome).toBe('retry');
		expect(request).toHaveBeenCalledTimes(2);

		request.mockResolvedValueOnce(ok({ accepted: 3 }));
		expect((await maybeUploadDiary(NOW + 120_000))?.outcome).toBe('sent');
		expect(markUploaded).toHaveBeenCalledWith(mockDiary.events[2].id);
	});

	it('401: não marca, não grava o intervalo; o próximo gatilho com sessão tenta', async () => {
		mockDiary.events = makeEvents(3);
		request.mockRejectedValueOnce(new ApiError(401, 'Sessão expirada.', 'session_lost'));

		expect((await maybeUploadDiary(NOW))?.outcome).toBe('auth');
		expect(writeUploadStamp).not.toHaveBeenCalled();

		request.mockResolvedValueOnce(ok({ accepted: 3 }));
		expect((await maybeUploadDiary(NOW + 60_000))?.outcome).toBe('sent');
	});

	it('servidor antigo (404/405): para até a próxima abertura do app', async () => {
		for (const status of [404, 405]) {
			resetUploadForTests();
			request.mockReset();
			jest.clearAllMocks();
			mockDiary.marked = [];
			mockDiary.stamp = null;
			mockDiary.events = makeEvents(3);
			request.mockRejectedValueOnce(new ApiError(status, 'Não foi possível completar a operação.', 'error'));

			expect((await maybeUploadDiary(NOW))?.outcome).toBe('unsupported');
			expect(await maybeUploadDiary(NOW + 7 * HOUR)).toBeNull();
			expect(await maybeUploadDiary(NOW + 30 * HOUR)).toBeNull();
			expect(request).toHaveBeenCalledTimes(1);
			expect(markUploaded).not.toHaveBeenCalled();

			// Nova abertura do app: o módulo nasce de novo.
			resetUploadForTests();
			request.mockResolvedValueOnce(ok({ accepted: 3 }));
			expect((await maybeUploadDiary(NOW + 31 * HOUR))?.outcome).toBe('sent');
		}
	});

	it('outro 4xx (lote recusado inteiro): registra o status e espera o intervalo', async () => {
		mockDiary.events = makeEvents(3);
		request.mockRejectedValueOnce(new ApiError(413, 'Corpo grande demais.', 'error'));

		expect((await maybeUploadDiary(NOW))?.outcome).toBe('failed');
		expect(markUploaded).not.toHaveBeenCalled();
		expect(logEvent).toHaveBeenCalledWith('app', 'diary_upload_failed', {
			level: 'warn',
			data: { status: 413 },
		});
		expect(await maybeUploadDiary(NOW + HOUR)).toBeNull();
	});

	it('dois gatilhos juntos: um envio só', async () => {
		mockDiary.events = makeEvents(3);
		let release: (value: unknown) => void = () => {};
		request.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve;
				})
		);

		const first = maybeUploadDiary(NOW);
		const second = maybeUploadDiary(NOW);
		await flush();
		release(ok({ accepted: 3 }));

		expect((await first)?.outcome).toBe('sent');
		expect(await second).toBeNull();
		expect(request).toHaveBeenCalledTimes(1);
	});
});

describe('gatilhos ligados (startDiaryUploads)', () => {
	const finishSync = (lastError: string | null = null) => {
		mockQueue.listener?.({ status: 'syncing', lastError: null });
		mockQueue.listener?.({ status: lastError ? 'error' : 'idle', lastError });
	};

	beforeEach(() => {
		mockDiary.events = makeEvents(3);
		request.mockResolvedValue(ok({ accepted: 3 }));
	});

	it('depois de um sync que deu certo', async () => {
		const stop = startDiaryUploads();
		await flush();
		expect(request).not.toHaveBeenCalled();

		finishSync();
		await flush();
		await flush();
		expect(request).toHaveBeenCalledTimes(1);
		stop();
	});

	it('sync que falhou não dispara', async () => {
		const stop = startDiaryUploads();
		finishSync('Sem conexão com o servidor.');
		await flush();
		expect(request).not.toHaveBeenCalled();
		stop();
	});

	it('mudança de estado que não é fim de sync não dispara (pulledVersion, idle → idle)', async () => {
		const stop = startDiaryUploads();
		mockQueue.listener?.({ status: 'idle', lastError: null });
		mockQueue.listener?.({ status: 'idle', lastError: null });
		await flush();
		expect(request).not.toHaveBeenCalled();
		stop();
	});

	it('sync que terminou com o app no fundo não envia', async () => {
		const stop = startDiaryUploads();
		mockApp.state = 'background';
		finishSync();
		await flush();
		expect(request).not.toHaveBeenCalled();
		stop();
	});

	it('sync que terminou sem sessão (a fila parou) não envia', async () => {
		const stop = startDiaryUploads();
		mockQueue.enabled = false;
		finishSync();
		await flush();
		expect(request).not.toHaveBeenCalled();
		stop();
	});

	it('voltar ao primeiro plano envia se passou do intervalo', async () => {
		jest.spyOn(Date, 'now').mockReturnValue(NOW);
		mockDiary.stamp = NOW - 7 * HOUR;
		mockApp.state = 'background';
		const stop = startDiaryUploads();

		mockApp.state = 'active';
		mockApp.handler?.('active');
		await flush();
		await flush();
		expect(request).toHaveBeenCalledTimes(1);
		stop();
	});

	it('voltar ao primeiro plano antes do intervalo não envia', async () => {
		jest.spyOn(Date, 'now').mockReturnValue(NOW);
		mockDiary.stamp = NOW - HOUR;
		mockApp.state = 'background';
		const stop = startDiaryUploads();

		mockApp.state = 'active';
		mockApp.handler?.('active');
		await flush();
		await flush();
		expect(request).not.toHaveBeenCalled();
		stop();
	});

	it('ir para o fundo não envia', async () => {
		const stop = startDiaryUploads();
		mockApp.state = 'background';
		mockApp.handler?.('background');
		await flush();
		expect(request).not.toHaveBeenCalled();
		stop();
	});

	it('desligar solta a fila e o AppState', () => {
		const stop = startDiaryUploads();
		stop();
		expect(mockQueue.listener).toBeNull();
		expect(mockApp.removed).toBe(1);
	});
});
