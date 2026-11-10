/**
 * O "Pagar fatura" recusado (SPD-133): qual pagamento já existia e por quê.
 *
 * `recordCardPayment` devolve falso em dois casos — o pagamento já estava no cartão, ou ele
 * completou o que o aviso do banco gravou sem destino. Com as transferências do cartão de
 * antes e de depois do toque, a tela diz qual dos dois foi e mostra o valor, a data e a conta.
 */

import { type CardTransferLike, findRefusedCardPayment } from '../cardPaymentNotice';

const transfer = (id: string, fromAccountId: string | null, toAccountId: string | null, amountCents: number, date: string): CardTransferLike => ({
	id,
	fromAccountId,
	toAccountId,
	amountCents,
	date,
});

const ATTEMPT = { fromAccountId: 'corrente', amountCents: 5000, date: '2026-11-10' };

describe('findRefusedCardPayment', () => {
	it('o mesmo pagamento já estava no cartão: R$ 50,00 em 09/11, da Corrente', () => {
		const before = [transfer('p1', 'corrente', 'nubank', 5000, '2026-11-09')];
		expect(findRefusedCardPayment('nubank', before, before, ATTEMPT)).toEqual({
			kind: 'already',
			fromAccountId: 'corrente',
			amountCents: 5000,
			date: '2026-11-09',
		});
	});

	it('completou o pagamento que o aviso do banco gravou sem destino', () => {
		// Antes do toque, o aviso não aparece no cartão: o destino dele estava em branco.
		const after = [transfer('aviso', 'corrente', 'nubank', 5000, '2026-11-09')];
		expect(findRefusedCardPayment('nubank', [], after, ATTEMPT)).toEqual({
			kind: 'completed',
			fromAccountId: 'corrente',
			amountCents: 5000,
			date: '2026-11-09',
		});
	});

	it('com dois iguais, vale o de data mais próxima; empate, o mais antigo', () => {
		const before = [
			transfer('a', 'corrente', 'nubank', 5000, '2026-11-09'),
			transfer('b', 'corrente', 'nubank', 5000, '2026-11-10'),
			transfer('c', 'corrente', 'nubank', 5000, '2026-11-11'),
		];
		expect(findRefusedCardPayment('nubank', before, before, ATTEMPT)?.date).toBe('2026-11-10');
		const tie = [before[2], before[0]];
		expect(findRefusedCardPayment('nubank', tie, tie, ATTEMPT)?.date).toBe('2026-11-09');
	});

	it('o que já estava veio de fora do app (origem nula): a conta fica nula', () => {
		const before = [transfer('p1', null, 'nubank', 5000, '2026-11-10')];
		expect(findRefusedCardPayment('nubank', before, before, ATTEMPT)).toEqual({
			kind: 'already',
			fromAccountId: null,
			amountCents: 5000,
			date: '2026-11-10',
		});
	});

	it('não acha nada: outro valor, outra conta, outro cartão, mais de um dia de diferença', () => {
		const before = [
			transfer('valor', 'corrente', 'nubank', 5001, '2026-11-10'),
			transfer('conta', 'poupanca', 'nubank', 5000, '2026-11-10'),
			transfer('saida', 'nubank', 'corrente', 5000, '2026-11-10'),
			transfer('longe', 'corrente', 'nubank', 5000, '2026-11-08'),
		];
		expect(findRefusedCardPayment('nubank', before, before, ATTEMPT)).toBeNull();
		expect(findRefusedCardPayment('inter', [], [transfer('x', 'corrente', 'nubank', 5000, '2026-11-10')], ATTEMPT)).toBeNull();
	});
});
