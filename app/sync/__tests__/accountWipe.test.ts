/**
 * Quando a conta foi apagada em outro aparelho, quem apaga aqui (SPD-083, DEC-35).
 *
 * O "Apagar todos os dados" vale para todos os aparelhos da conta: o que já sincronizava
 * com ela apaga a sua cópia quando fica sabendo. Mas o aparelho que está entrando na conta
 * pela primeira vez não tem cópia nenhuma da conta — o que ele tem foi criado aqui, antes
 * do login, e apagar isso seria perder o que nunca esteve na conta. Esse só passa a
 * conhecer o apagar e segue.
 *
 * A regra é pura e mora em `sync/accountWipe.ts`; quem a aplica é o motor do sync.
 */

import {
	dataWipedRefusal,
	decideAccountGone,
	decideAccountWipe,
	isNewerWipe,
} from '../accountWipe';

const WIPED_AT = '2026-10-27T10:00:00.000Z';
const EARLIER = '2026-10-20T08:00:00.000Z';

describe('o servidor sabe de um apagar que este aparelho não conhece?', () => {
	it('servidor que não manda o campo (o de produção hoje): não', () => {
		expect(isNewerWipe(null, undefined)).toBe(false);
		expect(isNewerWipe(EARLIER, undefined)).toBe(false);
	});

	it('conta que nunca apagou (`null`): não', () => {
		expect(isNewerWipe(null, null)).toBe(false);
		expect(isNewerWipe(EARLIER, null)).toBe(false);
	});

	it('o aparelho nunca soube de apagar nenhum: sim', () => {
		expect(isNewerWipe(null, WIPED_AT)).toBe(true);
	});

	it('o aparelho conhece um apagar anterior: sim', () => {
		expect(isNewerWipe(EARLIER, WIPED_AT)).toBe(true);
	});

	it('o mesmo apagar: não — inclusive escrito de outro jeito', () => {
		expect(isNewerWipe(WIPED_AT, WIPED_AT)).toBe(false);
		expect(isNewerWipe('2026-10-27T07:00:00-03:00', WIPED_AT)).toBe(false);
	});

	it('o aparelho conhece um apagar mais novo que o do servidor: não', () => {
		expect(isNewerWipe(WIPED_AT, EARLIER)).toBe(false);
	});

	it('instante ilegível do servidor não apaga nada', () => {
		expect(isNewerWipe(null, 'ontem')).toBe(false);
		expect(isNewerWipe(EARLIER, '')).toBe(false);
	});

	it('marca local ilegível perde para a do servidor: senão todo push seria recusado para sempre', () => {
		expect(isNewerWipe('lixo', WIPED_AT)).toBe(true);
	});
});

describe('o que fazer com o apagar de outro aparelho', () => {
	it('aparelho que já sincronizava com a conta: apaga a sua cópia', () => {
		expect(
			decideAccountWipe({ knownWipeAt: null, dataWipedAt: WIPED_AT, syncedBefore: true })
		).toBe('wipe');
		expect(
			decideAccountWipe({ knownWipeAt: EARLIER, dataWipedAt: WIPED_AT, syncedBefore: true })
		).toBe('wipe');
	});

	it('primeiro login nesta conta (claim, instalação nova): só passa a conhecer o apagar', () => {
		expect(
			decideAccountWipe({ knownWipeAt: null, dataWipedAt: WIPED_AT, syncedBefore: false })
		).toBe('adopt');
		expect(
			decideAccountWipe({ knownWipeAt: EARLIER, dataWipedAt: WIPED_AT, syncedBefore: false })
		).toBe('adopt');
	});

	it('apagar já conhecido: nada, sincronizado ou não', () => {
		for (const syncedBefore of [true, false]) {
			expect(
				decideAccountWipe({ knownWipeAt: WIPED_AT, dataWipedAt: WIPED_AT, syncedBefore })
			).toBe('none');
		}
	});

	it('servidor sem o campo, ou conta que nunca apagou: nada — o sync de sempre', () => {
		for (const dataWipedAt of [undefined, null]) {
			expect(decideAccountWipe({ knownWipeAt: null, dataWipedAt, syncedBefore: true })).toBe(
				'none'
			);
		}
	});
});

describe('o push recusado porque a conta foi apagada', () => {
	const apiError = (status: number, code: string, details: Record<string, unknown> = {}) =>
		Object.assign(new Error('recusado'), { name: 'ApiError', status, code, details });

	it('409 `data_wiped` traz o instante do apagar', () => {
		expect(dataWipedRefusal(apiError(409, 'data_wiped', { dataWipedAt: WIPED_AT }))).toEqual({
			dataWipedAt: WIPED_AT,
		});
	});

	it('409 `data_wiped` sem o instante: ainda é a recusa, o instante vem de outro lugar', () => {
		expect(dataWipedRefusal(apiError(409, 'data_wiped'))).toEqual({ dataWipedAt: null });
		expect(dataWipedRefusal(apiError(409, 'data_wiped', { dataWipedAt: 42 }))).toEqual({
			dataWipedAt: null,
		});
	});

	it('qualquer outra falha não é esta', () => {
		expect(dataWipedRefusal(apiError(409, 'conflict', { dataWipedAt: WIPED_AT }))).toBeNull();
		expect(dataWipedRefusal(apiError(500, 'data_wiped'))).toBeNull();
		expect(dataWipedRefusal(apiError(0, 'offline'))).toBeNull();
		expect(dataWipedRefusal(new Error('qualquer'))).toBeNull();
		expect(dataWipedRefusal(null)).toBeNull();
	});
});

describe('a conta não existe mais (401 `account_gone`, SPD-084)', () => {
	// A conta foi apagada noutro aparelho — ou neste, com o app fechado antes de ele
	// terminar. A mesma regra do apagar de outro aparelho: quem já sincronizava apaga.
	it('o aparelho que já sincronizava com ela apaga os dados e sai', () => {
		expect(decideAccountGone({ syncedBefore: true })).toBe('wipe');
	});

	it('o que estava entrando nela (a escolha de dados no meio) só sai: o que tem aqui nunca esteve na conta', () => {
		expect(decideAccountGone({ syncedBefore: false })).toBe('sign_out');
	});
});
