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
