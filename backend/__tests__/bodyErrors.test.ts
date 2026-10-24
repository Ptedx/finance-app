/**
 * Erros do leitor de corpo do Express no handler central (SPD-011).
 *
 * O `/api/diagnostics` tem teto de 512 KB, e o lote leva `rawText` (texto de aviso de banco).
 * Antes, um corpo grande demais ou um JSON malformado caía no "erro não tratado": a
 * resposta era 500, como se a culpa fosse do servidor, e o `console.error` imprimia o
 * objeto do erro — que no JSON malformado carrega o corpo cru inteiro em `body`.
 *
 * O que estes testes protegem: 413/400 com código próprio, e nada do corpo no stdout nem
 * na resposta. Os erros vêm do `express.json` de verdade, com o mesmo limite da rota.
 *
 * Fora de `src/` de propósito, como os outros testes do servidor (ver `billWire.test.ts`).
 */

import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import express, { type Request, type Response } from 'express';
import { errorHandler } from '../src/middleware/error';
import { DIAGNOSTIC_BODY_LIMIT } from '../src/schemas/diagnostics';

jest.mock('../src/lib/env.js', () => ({ isProduction: true, env: {} }), { virtual: true });

/** Passa `payload` pelo `express.json` como se viesse do socket, e devolve o erro (ou o corpo). */
const readJson = (limit: string, payload: string): Promise<{ error: unknown; body: unknown }> =>
	new Promise((resolve) => {
		const req = Object.assign(Readable.from([Buffer.from(payload)]), {
			headers: {
				'content-type': 'application/json',
				'content-length': String(Buffer.byteLength(payload)),
			},
			complete: false,
			// O `on-finished` do Express trata a requisição como do socket: ele precisa existir e escutar.
			socket: Object.assign(new EventEmitter(), { readable: true }),
		});
		express.json({ limit })(req as unknown as Request, {} as Response, (error?: unknown) =>
			resolve({ error, body: (req as unknown as { body?: unknown }).body })
		);
	});

const fakeResponse = () => {
	const res = {
		statusCode: 200,
		payload: undefined as unknown,
		status(code: number) {
			res.statusCode = code;
			return res;
		},
		json(body: unknown) {
			res.payload = body;
			return res;
		},
	};
	return res;
};

const handle = (error: unknown) => {
	const res = fakeResponse();
	errorHandler(error, {} as Request, res as unknown as Response, () => undefined);
	return res;
};

describe('o corpo da rota de diagnóstico', () => {
	let consoleError: jest.SpyInstance;

	beforeEach(() => {
		consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
	});

	afterEach(() => consoleError.mockRestore());

	it('o teto é 512 KB: um pouco abaixo passa, um pouco acima não', async () => {
		const pad = (bytes: number) => JSON.stringify({ schemaVersion: 1, events: [], pad: 'x'.repeat(bytes) });

		const fits = await readJson(DIAGNOSTIC_BODY_LIMIT, pad(500 * 1024));
		const tooBig = await readJson(DIAGNOSTIC_BODY_LIMIT, pad(520 * 1024));

		expect(fits.error).toBeUndefined();
		expect(fits.body).toMatchObject({ schemaVersion: 1 });
		expect(tooBig.error).toMatchObject({ status: 413, type: 'entity.too.large' });
	});

	it('corpo grande demais é 413, não 500, e não vai para o log', async () => {
		const { error } = await readJson(DIAGNOSTIC_BODY_LIMIT, JSON.stringify({ rawText: 'y'.repeat(600 * 1024) }));

		const res = handle(error);

		expect(res.statusCode).toBe(413);
		expect(res.payload).toEqual({ error: expect.any(String), code: 'payload_too_large' });
		expect(consoleError).not.toHaveBeenCalled();
	});

	it('JSON malformado é 400, e o corpo cru não sai nem no log nem na resposta', async () => {
		const { error } = await readJson(DIAGNOSTIC_BODY_LIMIT, '{"events":[{"rawText":"Compra aprovada 0000"');

		// O erro do Express carrega o corpo: é por isso que ele não pode ir para o console.
		expect(error).toMatchObject({ status: 400, type: 'entity.parse.failed' });
		expect(String((error as { body?: unknown }).body)).toContain('Compra aprovada');

		const res = handle(error);

		expect(res.statusCode).toBe(400);
		expect(res.payload).toEqual({ error: expect.any(String), code: 'invalid_json' });
		expect(JSON.stringify(res.payload)).not.toContain('Compra aprovada');
		expect(consoleError).not.toHaveBeenCalled();
	});

	it('um erro de servidor de verdade continua 500 e logado', () => {
		const res = handle(new Error('banco caiu'));

		expect(res.statusCode).toBe(500);
		expect(consoleError).toHaveBeenCalledTimes(1);
	});
});
