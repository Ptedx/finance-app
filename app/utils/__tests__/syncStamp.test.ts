/**
 * O carimbo de uma edição sempre passa o que a linha já tinha (SPD-107).
 *
 * O caso do aparelho: uma transação criada com o relógio adiantado ficou com `updatedAt`
 * 2026-11-12T03:20:05; em 07/11 o valor mudou de R$ 200 para R$ 250 com o carimbo de
 * agora, mais velho que o guardado no servidor. O push voltou `stale` e o pull seguinte
 * desfez a edição para R$ 200, sem aviso.
 */

import { nextStamp } from '../syncStamp';

const NOW = '2026-11-07T12:00:00.000Z';

describe('nextStamp', () => {
	it('anterior no futuro (relógio adiantado): 1 ms depois dele, não agora', () => {
		expect(nextStamp('2026-11-12T03:20:05.123Z', NOW)).toBe('2026-11-12T03:20:05.124Z');
	});

	it('o milissegundo a mais vira o segundo, o dia e o ano', () => {
		expect(nextStamp('2026-11-12T03:20:05.999Z', NOW)).toBe('2026-11-12T03:20:06.000Z');
		expect(nextStamp('2026-12-31T23:59:59.999Z', NOW)).toBe('2027-01-01T00:00:00.000Z');
	});

	it('anterior no passado: agora', () => {
		expect(nextStamp('2026-11-01T08:00:00.000Z', NOW)).toBe(NOW);
		expect(nextStamp('1970-01-01T00:00:00.000Z', NOW)).toBe(NOW);
	});

	it('anterior igual a agora: 1 ms depois, para a edição nunca empatar com a versão de antes', () => {
		expect(nextStamp(NOW, NOW)).toBe('2026-11-07T12:00:00.001Z');
	});

	it('anterior nulo, vazio ou ilegível: agora', () => {
		expect(nextStamp(null, NOW)).toBe(NOW);
		expect(nextStamp(undefined, NOW)).toBe(NOW);
		expect(nextStamp('', NOW)).toBe(NOW);
		expect(nextStamp('lixo', NOW)).toBe(NOW);
	});

	it('anterior sem milissegundos: compara pelo instante, não pelo texto', () => {
		// Pelo texto, "…05Z" é maior que "…05.500Z" ('Z' > '.') e a edição ficaria para trás.
		expect(nextStamp('2026-11-12T03:20:05Z', '2026-11-12T03:20:05.500Z')).toBe('2026-11-12T03:20:05.500Z');
		expect(nextStamp('2026-11-12T03:20:05Z', NOW)).toBe('2026-11-12T03:20:05.001Z');
	});
});

/**
 * Carimbo no futuro (SPD-127): uma linha que chegou de um aparelho com o relógio 2 dias à
 * frente. O "servidor" daqui é a regra de `isStale` do backend (`sync.controller.ts`):
 * recusa só o que chega mais velho que o guardado; empate vence quem envia.
 */
describe('linha com carimbo adiantado por outro aparelho', () => {
	const push = (server: { updatedAt: string }, incoming: string): 'aplicada' | 'stale' => {
		if (Date.parse(server.updatedAt) > Date.parse(incoming)) return 'stale';
		server.updatedAt = incoming;
		return 'aplicada';
	};

	it('quem edita depois de puxar sempre vence, com o relógio certo ou não; a linha só sai do futuro quando o relógio alcança', () => {
		// B (relógio +2 dias) grava às 10:00 do dia 9: o carimbo diz dia 11.
		const server = { updatedAt: '2026-11-11T10:00:00.000Z' };

		// A, com o relógio certo, puxa e edita às 11:00 do dia 9.
		const a1 = nextStamp(server.updatedAt, '2026-11-09T11:00:00.000Z');
		expect(a1).toBe('2026-11-11T10:00:00.001Z');
		expect(push(server, a1)).toBe('aplicada');

		// C, também certo, puxa a de A e edita às 12:00.
		const c1 = nextStamp(server.updatedAt, '2026-11-09T12:00:00.000Z');
		expect(push(server, c1)).toBe('aplicada');
		expect(server.updatedAt).toBe('2026-11-11T10:00:00.002Z');

		// B puxa e edita de novo (13:00 do dia 9 = dia 11 no relógio dele); A responde às 14:00.
		expect(push(server, nextStamp(server.updatedAt, '2026-11-11T13:00:00.000Z'))).toBe('aplicada');
		expect(push(server, nextStamp(server.updatedAt, '2026-11-09T14:00:00.000Z'))).toBe('aplicada');
		expect(server.updatedAt).toBe('2026-11-11T13:00:00.001Z');

		// Quando o relógio passa do carimbo, a edição volta a sair com agora.
		expect(nextStamp(server.updatedAt, '2026-11-11T15:00:00.000Z')).toBe('2026-11-11T15:00:00.000Z');
	});

	it('o que perde é a edição sobre uma versão velha, e perderia igual sem o +1 ms: o culpado é o carimbo adiantado', () => {
		const server = { updatedAt: '2026-11-11T10:00:00.000Z' };
		// D estava offline com a versão do dia 8 e edita às 15:00 do dia 9, depois de B.
		const d = nextStamp('2026-11-08T09:00:00.000Z', '2026-11-09T15:00:00.000Z');
		expect(d).toBe('2026-11-09T15:00:00.000Z');
		expect(push(server, d)).toBe('stale');
		// Limitar o anterior (a agora, ou agora + margem) não salva D e faria A perder também.
		expect(push({ updatedAt: '2026-11-11T10:00:00.000Z' }, '2026-11-09T11:00:00.000Z')).toBe('stale');
	});
});
