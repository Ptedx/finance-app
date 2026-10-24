import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AuthenticatedRequest } from './auth.js';

/**
 * Uma linha JSON por requisição no stdout (DEC-03, SPD-012).
 *
 * Antes a API não registrava nada: um erro relatado do aparelho só podia ser cruzado com
 * o banco. A linha é o mínimo para cruzar — quando chegou, qual rota, de quem, quanto
 * demorou, quanto trafegou — e nada que vire vazamento se o log sair da VM:
 *
 *  - nunca corpo, query string, cabeçalho nem token (o `Authorization` nem é lido aqui);
 *  - segmento da rota que pareça id vira `:id`: a rota agrupa, o id identificaria o registro;
 *  - o usuário é o id interno que o `requireAuth` pôs na requisição, nunca o e-mail;
 *  - o IP perde o fim (/24 no IPv4, /48 no IPv6): dá para ver "mesma rede", não a pessoa.
 *
 * `/health` com 200 não loga: o healthcheck do Docker e do nginx bate o tempo todo e
 * enterraria o resto. Fora do ar (503) loga, que é quando interessa.
 *
 * O Docker guarda o stdout com rotação (`logging` no docker-compose.yml).
 */

/** Teto da rota na linha: um caminho de 8 KB de um robô não pode virar 8 KB de log. */
const MAX_ROUTE_LENGTH = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGITS = /^\d+$/;
const LONG_HEX = /^[0-9a-f]{16,}$/i;

/**
 * O que parece id: uuid, número, hex longo (ObjectId e afins), texto longo com dígito (os
 * ids do app, como `tx_1729781234567_ab12`) e qualquer coisa com `@` — um e-mail na rota
 * não pode ir para o log.
 */
const looksLikeId = (segment: string): boolean =>
	UUID.test(segment) ||
	DIGITS.test(segment) ||
	LONG_HEX.test(segment) ||
	(segment.length >= 20 && /\d/.test(segment)) ||
	segment.includes('@') ||
	segment.toLowerCase().includes('%40');

/** O caminho sem query string nem fragmento, com os ids trocados por `:id`. */
export const normalizeRoute = (url: string): string => {
	const path = url.split(/[?#]/, 1)[0] || '/';
	const route = path
		.split('/')
		.map((segment) => (segment.length > 0 && looksLikeId(segment) ? ':id' : segment))
		.join('/');
	return route.length > MAX_ROUTE_LENGTH ? `${route.slice(0, MAX_ROUTE_LENGTH)}…` : route;
};

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HEXTET = /^[0-9a-f]{1,4}$/i;

const truncateIpv4 = (ip: string): string | null => {
	const match = IPV4.exec(ip);
	if (!match) return null;
	const octets = match.slice(1).map(Number);
	if (octets.some((octet) => octet > 255)) return null;
	return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
};

const truncateIpv6 = (ip: string): string | null => {
	const address = ip.split('%', 1)[0] ?? '';
	const halves = address.split('::');
	if (halves.length > 2) return null;

	const head = halves[0] ? halves[0].split(':') : [];
	const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
	const groups =
		halves.length === 2 ? [...head, ...Array<string>(8 - head.length - tail.length).fill('0'), ...tail] : head;

	if (groups.length !== 8 || !groups.every((group) => HEXTET.test(group))) return null;
	return `${groups
		.slice(0, 3)
		.map((group) => Number.parseInt(group, 16).toString(16))
		.join(':')}::/48`;
};

/** IPv4 em /24, IPv6 em /48; o que não for IP reconhecível vira `null`, nunca o texto cru. */
export const truncateIp = (ip: string | undefined): string | null => {
	if (!ip) return null;
	const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
	if (mapped?.[1]) return truncateIpv4(mapped[1]);
	return ip.includes(':') ? truncateIpv6(ip) : truncateIpv4(ip);
};

const byteCount = (value: unknown): number => {
	const count = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(count) && count >= 0 ? count : 0;
};

const writeStdout = (line: string): void => {
	process.stdout.write(`${line}\n`);
};

/**
 * O middleware. Vai antes de tudo no `server.ts`, para pegar também o 404, o 413 do corpo
 * grande e o que o helmet recusar. `write` existe para o teste; em produção é o stdout.
 */
export const requestLog =
	(write: (line: string) => void = writeStdout): RequestHandler =>
	(req: Request, res: Response, next: NextFunction): void => {
		// `ts` é a chegada (o `ms` diz quanto durou): é o instante que se cruza com o
		// `at` dos eventos de diagnóstico do aparelho.
		const ts = new Date().toISOString();
		const started = process.hrtime.bigint();
		const route = normalizeRoute(req.originalUrl);
		let logged = false;

		const log = (aborted: boolean) => (): void => {
			if (logged) return;
			logged = true;

			const status = res.statusCode;
			if (route === '/health' && status === 200) return;

			const ms = Number(process.hrtime.bigint() - started) / 1e6;
			write(
				JSON.stringify({
					ts,
					method: req.method,
					route,
					status,
					ms: Math.round(ms * 10) / 10,
					userId: (req as Partial<AuthenticatedRequest>).userId ?? null,
					ip: truncateIp(req.ip),
					reqBytes: byteCount(req.headers['content-length']),
					resBytes: byteCount(res.getHeader('content-length')),
					// O cliente desistiu antes da resposta acabar (timeout do app, rede caiu).
					...(aborted ? { aborted: true } : {}),
				})
			);
		};

		res.once('finish', log(false));
		res.once('close', log(true));
		next();
	};
