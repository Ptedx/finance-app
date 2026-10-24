/**
 * Uma linha de log por requisição na API (SPD-012, DEC-03).
 *
 * Antes não havia registro nenhum de requisição: um erro do aparelho só podia ser
 * cruzado com o banco. A linha é o mínimo para cruzar — quando, qual rota, de quem,
 * quanto demorou — e nada que vire vazamento se o log sair da VM:
 *
 *  - nunca corpo, query string, cabeçalho nem token;
 *  - id na rota vira `:id` (a rota agrupa; o id identificaria o registro);
 *  - o usuário é o id interno, nunca o e-mail; o IP perde o último octeto;
 *  - `/health` com 200 não loga: o healthcheck do Docker e do nginx bate o tempo todo.
 *
 * Fora de `src/` de propósito, como os outros testes do servidor (ver `billWire.test.ts`).
 */

import { EventEmitter } from 'node:events';
import type { NextFunction, Request, Response } from 'express';
import { normalizeRoute, requestLog, truncateIp } from '../src/middleware/requestLog';

interface FakeRequest {
	method: string;
	originalUrl: string;
	headers: Record<string, string>;
	ip?: string | undefined;
	userId?: string;
}

const fakeRequest = (over: Partial<FakeRequest> = {}): FakeRequest => ({
	method: 'POST',
	originalUrl: '/api/sync/push',
	headers: { 'content-length': '1234', 'content-type': 'application/json' },
	ip: '203.0.113.77',
	...over,
});

// `null` = sem content-length (um `undefined` aqui cairia no valor padrão).
const fakeResponse = (status = 200, length: number | null = 56) => {
	const res = new EventEmitter() as EventEmitter & { statusCode: number; getHeader: (name: string) => unknown };
	res.statusCode = status;
	res.getHeader = (name: string) => (name.toLowerCase() === 'content-length' ? (length ?? undefined) : undefined);
	return res;
};

/** Roda o middleware até o fim da resposta e devolve as linhas escritas. */
const run = (
	req: FakeRequest,
	res = fakeResponse(),
	afterNext: (req: FakeRequest) => void = () => undefined,
	events: string[] = ['finish', 'close']
): string[] => {
	const lines: string[] = [];
	const next = jest.fn() as unknown as NextFunction;
	requestLog((line) => lines.push(line))(req as unknown as Request, res as unknown as Response, next);
	expect(next).toHaveBeenCalledTimes(1);
	afterNext(req);
	for (const name of events) res.emit(name);
	return lines;
};

const only = (lines: string[]): Record<string, unknown> => {
	expect(lines).toHaveLength(1);
	expect(lines[0]).not.toContain('\n');
	return JSON.parse(lines[0] ?? '') as Record<string, unknown>;
};

describe('a linha de log', () => {
	it('tem os campos combinados, nessa ordem, e só eles', () => {
		const line = only(run(fakeRequest(), fakeResponse(200, 56)));

		expect(Object.keys(line)).toEqual(['ts', 'method', 'route', 'status', 'ms', 'userId', 'ip', 'reqBytes', 'resBytes']);
		expect(line).toMatchObject({
			method: 'POST',
			route: '/api/sync/push',
			status: 200,
			userId: null,
			ip: '203.0.113.0/24',
			reqBytes: 1234,
			resBytes: 56,
		});
		expect(new Date(line['ts'] as string).toISOString()).toBe(line['ts']);
		expect(typeof line['ms']).toBe('number');
		expect(line['ms'] as number).toBeGreaterThanOrEqual(0);
	});

	it('autenticado, leva o id interno do usuário — o que o requireAuth pôs na requisição', () => {
		const line = only(run(fakeRequest(), fakeResponse(), (req) => (req.userId = 'b1946ac9-2f0e-4f3c-9d55-0c7e5d1f8a10')));

		expect(line['userId']).toBe('b1946ac9-2f0e-4f3c-9d55-0c7e5d1f8a10');
	});

	it('nunca leva query string, cabeçalho, token nem corpo', () => {
		const raw = run(
			fakeRequest({
				originalUrl: '/api/sync/pull?cursor=abc123&email=pessoa@exemplo.com',
				headers: {
					authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.segredo.assinatura',
					cookie: 'sessao=xyz',
					'content-length': '10',
					'x-forwarded-for': '198.51.100.9',
				},
			})
		).join('\n');
		const line = JSON.parse(raw) as Record<string, unknown>;

		expect(line['route']).toBe('/api/sync/pull');
		for (const leak of ['cursor', 'abc123', 'pessoa@exemplo.com', 'Bearer', 'eyJ', 'segredo', 'sessao', 'xyz', '198.51.100.9', 'authorization']) {
			expect(raw).not.toContain(leak);
		}
	});

	it('uma linha só, mesmo com `finish` e `close` disparando', () => {
		expect(run(fakeRequest(), fakeResponse(), undefined, ['finish', 'close', 'finish'])).toHaveLength(1);
	});

	it('o cliente que desiste no meio também fica registrado, marcado', () => {
		const line = only(run(fakeRequest(), fakeResponse(200, null), undefined, ['close']));

		expect(line).toMatchObject({ route: '/api/sync/push', aborted: true, resBytes: 0 });
	});

	it('sem content-length, os bytes são 0', () => {
		const line = only(run(fakeRequest({ method: 'GET', headers: {} }), fakeResponse(304, null)));

		expect(line).toMatchObject({ reqBytes: 0, resBytes: 0, status: 304 });
	});
});

describe('o /health', () => {
	it('com 200 não loga, com ou sem query', () => {
		expect(run(fakeRequest({ method: 'GET', originalUrl: '/health' }))).toEqual([]);
		expect(run(fakeRequest({ method: 'GET', originalUrl: '/health?probe=1' }))).toEqual([]);
	});

	it('fora do ar (503) loga: é justamente o que se quer ver', () => {
		const line = only(run(fakeRequest({ method: 'GET', originalUrl: '/health' }), fakeResponse(503)));

		expect(line).toMatchObject({ route: '/health', status: 503 });
	});
});

describe('a rota', () => {
	it.each([
		['/api/bills/0f8fad5b-d9cb-469f-a165-70867728950e', '/api/bills/:id'],
		['/api/bills/0F8FAD5B-D9CB-469F-A165-70867728950E/pay', '/api/bills/:id/pay'],
		['/api/things/12345/edit', '/api/things/:id/edit'],
		['/api/things/5f2b9c0d8e7a6b4c3d2e1f00', '/api/things/:id'],
		['/api/things/tx_1729781234567_ab12cd', '/api/things/:id'],
		['/api/users/pessoa@exemplo.com', '/api/users/:id'],
		['/api/users/pessoa%40exemplo.com', '/api/users/:id'],
		['/api/sync/push', '/api/sync/push'],
		['/api/auth/login?next=/x', '/api/auth/login'],
		['/api/me#frag', '/api/me'],
		['/', '/'],
	])('%s → %s', (url, route) => {
		expect(normalizeRoute(url)).toBe(route);
	});

	it('um caminho enorme é cortado, para a linha não virar o vetor de encher o disco', () => {
		expect(normalizeRoute(`/api/${'a'.repeat(5000)}`).length).toBeLessThanOrEqual(201);
	});
});

describe('o IP', () => {
	it.each([
		['203.0.113.77', '203.0.113.0/24'],
		['::ffff:203.0.113.77', '203.0.113.0/24'],
		['2001:db8:85a3:1:2:3:4:5', '2001:db8:85a3::/48'],
		['2001:0db8:0000::1', '2001:db8:0::/48'],
		['::1', '0:0:0::/48'],
		['fe80::1%eth0', 'fe80:0:0::/48'],
	])('%s → %s', (ip, truncated) => {
		expect(truncateIp(ip)).toBe(truncated);
	});

	it('o que não é IP reconhecível não é logado cru', () => {
		expect(truncateIp(undefined)).toBeNull();
		expect(truncateIp('')).toBeNull();
		expect(truncateIp('não-é-ip')).toBeNull();
		expect(truncateIp('999.1.1.1')).toBeNull();
		expect(truncateIp('1::2::3')).toBeNull();
	});
});
