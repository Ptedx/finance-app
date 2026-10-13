/**
 * Dois orçamentos para o mesmo mês: quem fica vivo.
 *
 * O caso real que motivou: o aparelho usado meses sem conta tinha o orçamento de outubro
 * com um id; a conta, criada depois no computador, tinha o mesmo mês com outro. Ao
 * conectar, o push violava o índice de "um orçamento vivo por mês", o Prisma lançava
 * P2002, o erro virava 500 e a fila reenviava a mesma remessa para sempre — nada mais
 * saía daquele aparelho, nem lançamento, nem conta.
 *
 * Fora de `src/` de propósito: o `tsconfig` do servidor cobre `src/**` com
 * `moduleResolution: nodenext`, que exigiria a extensão no import; aqui quem roda é o
 * jest da raiz.
 */

import { type LiveBudget, resolveBudgetPeriod } from '../src/domain/budgetConflict';

const at = (iso: string): Date => new Date(iso);

const incoming = (id: string, updatedAt: string, deletedAt: string | null = null) => ({
	id,
	updatedAt: at(updatedAt),
	deletedAt: deletedAt === null ? null : at(deletedAt),
});

const live = (id: string, updatedAt: string): LiveBudget => ({ id, updatedAt: at(updatedAt) });

describe('um orçamento vivo por mês', () => {
	it('mês livre: grava e pronto', () => {
		expect(resolveBudgetPeriod(incoming('b1', '2026-10-01T10:00:00.000Z'), null)).toEqual({
			kind: 'none',
		});
	});

	it('a mesma linha de novo não disputa com ela mesma', () => {
		const resolution = resolveBudgetPeriod(
			incoming('b1', '2026-10-02T10:00:00.000Z'),
			live('b1', '2026-10-01T10:00:00.000Z')
		);
		expect(resolution).toEqual({ kind: 'none' });
	});

	it('a que chegou é mais nova: a de lá ganha lápide, com o carimbo da vencedora', () => {
		const resolution = resolveBudgetPeriod(
			incoming('doAparelho', '2026-10-05T12:00:00.000Z'),
			live('daConta', '2026-10-01T09:00:00.000Z')
		);
		expect(resolution).toEqual({
			kind: 'tombstone_existing',
			id: 'daConta',
			at: at('2026-10-05T12:00:00.000Z'),
		});
	});

	it('a que chegou é mais antiga: é ela que entra apagada', () => {
		const resolution = resolveBudgetPeriod(
			incoming('doAparelho', '2026-10-01T09:00:00.000Z'),
			live('daConta', '2026-10-05T12:00:00.000Z')
		);
		expect(resolution).toEqual({ kind: 'tombstone_incoming', at: at('2026-10-05T12:00:00.000Z') });
	});

	it('empate vai para quem envia, como no resto do last-write-wins', () => {
		const resolution = resolveBudgetPeriod(
			incoming('doAparelho', '2026-10-05T12:00:00.000Z'),
			live('daConta', '2026-10-05T12:00:00.000Z')
		);
		expect(resolution).toEqual({
			kind: 'tombstone_existing',
			id: 'daConta',
			at: at('2026-10-05T12:00:00.000Z'),
		});
	});

	it('uma lápide que chega não disputa nada: o índice só olha as linhas vivas', () => {
		const resolution = resolveBudgetPeriod(
			incoming('doAparelho', '2026-10-06T12:00:00.000Z', '2026-10-06T12:00:00.000Z'),
			live('daConta', '2026-10-01T09:00:00.000Z')
		);
		expect(resolution).toEqual({ kind: 'none' });
	});

	it('a lápide do perdedor é sempre >= a versão que ele tinha, senão o aparelho a ignoraria', () => {
		// O app só aplica o que vem do servidor quando é mais novo que o local
		// (`applyPulledChanges`): uma lápide com carimbo antigo seria descartada e a linha
		// perdedora ficaria viva naquele aparelho para sempre.
		const pairs: Array<[string, string]> = [
			['2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z'],
			['2026-10-02T00:00:00.000Z', '2026-10-01T00:00:00.000Z'],
			['2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z'],
		];

		for (const [incomingAt, liveAt] of pairs) {
			const resolution = resolveBudgetPeriod(incoming('b1', incomingAt), live('b2', liveAt));
			const loserVersion = resolution.kind === 'tombstone_incoming' ? at(incomingAt) : at(liveAt);

			expect(resolution.kind).not.toBe('none');
			if (resolution.kind !== 'none') {
				expect(resolution.at.getTime()).toBeGreaterThanOrEqual(loserVersion.getTime());
			}
		}
	});
});
