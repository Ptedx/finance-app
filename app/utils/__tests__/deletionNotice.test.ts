/**
 * As confirmações de encerrar, apagar, juntar e reabrir conta ou cartão dizem o efeito em R$
 * (SPD-144). Os textos vêm da i18n de verdade.
 *
 * Antes (SPD-141) a confirmação de excluir contava quantos lançamentos ficavam "Sem conta" e
 * quantas transferências eram apagadas, sem dizer um real do que mudava no patrimônio. Agora
 * apagar só vale para conta vazia; conta com conteúdo é encerrada ou juntada, e cada frase
 * diz o que acontece com o dinheiro.
 */

import i18n from '../../i18n';
import {
	closeBlockedMessage,
	closeConfirmMessage,
	deleteConfirmMessage,
	deleteRefusedMessage,
	mergeConfirmMessage,
	reopenMessage,
} from '../deletionNotice';
import { configureMoney } from '../money';

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options);

const contents = (overrides: Partial<{ transactions: number; transfers: number; captures: number; openingBalanceCents: number; bills: number; debts: number }> = {}) => ({
	transactions: 0,
	transfers: 0,
	captures: 0,
	openingBalanceCents: 0,
	bills: 0,
	debts: 0,
	...overrides,
});

beforeAll(async () => {
	configureMoney({ locale: 'pt-BR', currencyCode: 'BRL', currencySymbol: 'R$' });
	await i18n.changeLanguage('pt');
});

describe('apagar: só conta vazia, e a frase diz que nada muda', () => {
	it('conta vazia: nada muda nos números', () => {
		expect(deleteConfirmMessage('accounts.edit', 'Antiga', contents(), t)).toBe(
			'Antiga não tem lançamento, transferência nem saldo: apagar não muda nada nos seus números. Continuar?'
		);
	});

	it('conta vazia com uma conta a pagar e uma dívida ligadas: elas ficam sem conta', () => {
		expect(deleteConfirmMessage('accounts.edit', 'Antiga', contents({ bills: 1, debts: 1 }), t)).toBe(
			'Antiga não tem lançamento, transferência nem saldo: apagar não muda nada nos seus números. 2 contas a pagar ou dívidas ligadas a ela passam a ficar sem conta. Continuar?'
		);
	});

	it('conta com 42 lançamentos: recusa e diz por quê', () => {
		expect(deleteRefusedMessage('accounts.edit', 'Corrente', contents({ transactions: 42, transfers: 3, openingBalanceCents: 100_000 }), t)).toBe(
			'Corrente tem 42 lançamentos. Apagar mudaria o patrimônio e o histórico. Encerre a conta (o histórico fica e dá para reabrir) ou junte com outra.'
		);
	});

	it('reserva só com a transferência de R$ 300: recusa pela transferência', () => {
		expect(deleteRefusedMessage('accounts.edit', 'Reserva', contents({ transfers: 1 }), t)).toBe(
			'Reserva tem 1 transferência. Apagar mudaria o patrimônio e o histórico. Encerre a conta (o histórico fica e dá para reabrir) ou junte com outra.'
		);
	});

	it('conta só com saldo de partida de R$ 5.000 (caso A2): recusa pelo saldo, com o valor', () => {
		expect(deleteRefusedMessage('accounts.edit', 'Reserva', contents({ openingBalanceCents: 500_000 }), t)).toBe(
			'Reserva tem saldo de partida de R$ 5.000,00. Apagar mudaria o patrimônio e o histórico. Encerre a conta (o histórico fica e dá para reabrir) ou junte com outra.'
		);
	});

	it('cartão com fatura informada de R$ 800 (caso B): recusa pela fatura', () => {
		expect(deleteRefusedMessage('cards.edit', 'Nubank', contents({ openingBalanceCents: -80_000 }), t)).toBe(
			'Nubank tem fatura informada de R$ 800,00. Apagar mudaria o patrimônio e as faturas. Encerre o cartão (o histórico fica e dá para reabrir) ou junte com outro.'
		);
	});

	it('cartão com 7 compras', () => {
		expect(deleteRefusedMessage('cards.edit', 'Nubank', contents({ transactions: 7, transfers: 1 }), t)).toBe(
			'Nubank tem 7 lançamentos. Apagar mudaria o patrimônio e as faturas. Encerre o cartão (o histórico fica e dá para reabrir) ou junte com outro.'
		);
	});
});

describe('encerrar: o efeito em R$', () => {
	it('saldo zero: nada muda', () => {
		expect(closeConfirmMessage('accounts.edit', { name: 'Carteira', plan: { kind: 'direct' }, alreadyClosed: false, roleChange: false }, t)).toBe(
			'Carteira sai das listas e dos seletores. O histórico continua igual e dá para reabrir. Nada muda nos seus números.'
		);
	});

	it('R$ 450 da Carteira para a Corrente: o patrimônio não muda', () => {
		expect(
			closeConfirmMessage(
				'accounts.edit',
				{ name: 'Carteira', target: 'Corrente', plan: { kind: 'transfer', direction: 'out', amountCents: 45_000 }, alreadyClosed: false, roleChange: false },
				t
			)
		).toBe('R$ 450,00 vão de Carteira para Corrente numa transferência de hoje, e Carteira é encerrada. O patrimônio não muda e o histórico continua igual.');
	});

	it('R$ 300 da Reserva para a Corrente (caso A): papéis diferentes, a transferência é um resgate neste mês', () => {
		expect(
			closeConfirmMessage(
				'accounts.edit',
				{ name: 'Reserva', target: 'Corrente', plan: { kind: 'transfer', direction: 'out', amountCents: 30_000 }, alreadyClosed: false, roleChange: true },
				t
			)
		).toBe(
			'R$ 300,00 vão de Reserva para Corrente numa transferência de hoje, e Reserva é encerrada. O patrimônio não muda e o histórico continua igual. Como as duas contas têm papéis diferentes, a transferência entra no quadro deste mês (da reserva para a principal, por exemplo, é um resgate).'
		);
	});

	it('saldo negativo de R$ 200: a transferência entra e zera', () => {
		expect(
			closeConfirmMessage(
				'accounts.edit',
				{ name: 'Velha', target: 'Corrente', plan: { kind: 'transfer', direction: 'in', amountCents: 20_000 }, alreadyClosed: false, roleChange: false },
				t
			)
		).toBe('R$ 200,00 vão de Corrente para Velha numa transferência de hoje, zerando o saldo, e Velha é encerrada. O patrimônio não muda e o histórico continua igual.');
	});

	it('encerrada com saldo de R$ 300, acertada: o patrimônio de hoje sobe R$ 300, e a frase diz', () => {
		expect(
			closeConfirmMessage(
				'accounts.edit',
				{ name: 'Velha', target: 'Corrente', plan: { kind: 'transfer', direction: 'out', amountCents: 30_000 }, alreadyClosed: true, roleChange: false },
				t
			)
		).toBe('R$ 300,00 vão de Velha para Corrente numa transferência de hoje. Velha já estava encerrada, fora dos totais: o patrimônio de hoje sobe R$ 300,00.');
	});

	it('cartão zerado e cartão com crédito de R$ 40', () => {
		expect(closeConfirmMessage('cards.edit', { name: 'Nubank', plan: { kind: 'direct' }, alreadyClosed: false, roleChange: false }, t)).toBe(
			'Nubank sai das listas e dos seletores. As faturas e os pagamentos continuam no histórico, e dá para reabrir. Nada muda nos seus números.'
		);
		expect(
			closeConfirmMessage(
				'cards.edit',
				{ name: 'Nubank', target: 'Corrente', plan: { kind: 'transfer', direction: 'out', amountCents: 4_000 }, alreadyClosed: false, roleChange: false },
				t
			)
		).toBe('O crédito de R$ 40,00 volta de Nubank para Corrente numa transferência de hoje, e Nubank é encerrado. O patrimônio não muda e as faturas continuam como estão.');
	});

	it('recusas: cartão devendo R$ 500, compras a revisar, parcelas por cair', () => {
		expect(closeBlockedMessage('cards.edit', 'Nubank', { kind: 'blocked', reason: 'cardOwes', amountCents: 50_000, count: 0 }, t)).toBe(
			'Nubank ainda deve R$ 500,00. Pague a fatura na tela do cartão ("Pagar fatura") ou, se já pagou fora do app, acerte a fatura com o banco. Depois, encerre.'
		);
		expect(closeBlockedMessage('accounts.edit', 'Corrente', { kind: 'blocked', reason: 'pendingCaptures', amountCents: 0, count: 2 }, t)).toBe(
			'Há 2 compras de Corrente na caixa de entrada. Revise antes de encerrar: confirmadas ou descartadas, elas não mudam o saldo depois.'
		);
		expect(closeBlockedMessage('cards.edit', 'Nubank', { kind: 'blocked', reason: 'futureEntries', amountCents: 0, count: 3 }, t)).toBe(
			'Nubank tem 3 parcelas por cair. Encerre depois da última, ou junte com outro cartão.'
		);
	});
});

describe('juntar e reabrir', () => {
	it('juntar: o total continua R$ 1.450', () => {
		expect(mergeConfirmMessage('accounts.edit', 'Carteira', 'Corrente', 145_000, t)).toBe(
			'Os lançamentos, as capturas e as transferências de Carteira passam para Corrente, e Carteira é apagada. O saldo de Carteira soma no de Corrente: ficam R$ 1.450,00 em Corrente, e o total das contas não muda.'
		);
	});

	it('reabrir com saldo de R$ 300: volta a contar nos totais de hoje', () => {
		expect(reopenMessage('accounts.edit', 'Velha', 30_000, t)).toBe('Velha tem R$ 300,00. Reaberta, esse saldo volta a contar nos totais de hoje.');
		expect(reopenMessage('accounts.edit', 'Velha', 0, t)).toBeNull();
	});

	it('reabrir o cartão encerrado devendo R$ 500: a dívida volta aos totais', () => {
		expect(reopenMessage('cards.edit', 'Nubank', -50_000, t)).toBe('Nubank deve R$ 500,00. Reaberto, a dívida volta a contar nos totais de hoje.');
	});

	it('em inglês e italiano', async () => {
		try {
			await i18n.changeLanguage('en');
			expect(deleteRefusedMessage('accounts.edit', 'Checking', contents({ transactions: 42 }), t)).toBe(
				'Checking has 42 entries. Deleting it would change your net worth and your history. Close the account (the history stays and you can reopen it) or merge it into another.'
			);
			await i18n.changeLanguage('it');
			expect(closeConfirmMessage('accounts.edit', { name: 'Carteira', plan: { kind: 'direct' }, alreadyClosed: false, roleChange: false }, t)).toBe(
				'Carteira esce dagli elenchi e dai selettori. Lo storico resta uguale e puoi riaprirlo. Nei tuoi numeri non cambia nulla.'
			);
		} finally {
			await i18n.changeLanguage('pt');
		}
	});
});
