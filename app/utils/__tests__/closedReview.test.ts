/**
 * Encerradas com saldo (SPD-150): as regras puras.
 *
 * Conta ou cartão encerrado (arquivado) com saldo diferente de zero — os arquivados antes do
 * SPD-144 e os que voltaram do reparo do SPD-149 — fica fora de "Em caixa" e de "Depois das
 * faturas", mas o cartão arquivado devendo ainda conta no Patrimônio. A lista põe cada um na
 * mão do usuário, e cada decisão mostra antes o efeito em R$: o número que a tela vai mostrar
 * depois, calculado com a mesma conta do Patrimônio (`netWorth`).
 */

jest.mock('@react-native-async-storage/async-storage', () =>
	require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import type { Account } from '../../database/schema';
import { type ClosedTotals, closedDecisionEffect, closedReviewItems, closedReviewTargets, unseenClosedReview } from '../closedReview';

const account = (overrides: Partial<Account>): Account => ({
	id: 'x',
	name: 'Conta',
	kind: 'checking',
	role: 'main',
	envelopeMonthlyCents: null,
	bankName: null,
	color: '#FF7A00',
	last4: null,
	network: null,
	closingDay: null,
	dueDay: null,
	closingDaysBefore: null,
	creditLimitCents: null,
	cardNames: null,
	yieldCdiBp: null,
	reservePurpose: null,
	packageName: null,
	accountKey: null,
	openingBalanceCents: 0,
	openingBalanceDate: '2026-09-30',
	sortOrder: 0,
	archived: false,
	updatedAt: '',
	...overrides,
});

const CORRENTE = account({ id: 'corrente', name: 'Corrente' });
const RESERVA = account({ id: 'reserva', name: 'Reserva', kind: 'savings', role: 'reserve' });
const CARTEIRA_VELHA = account({ id: 'carteira', name: 'Carteira velha', kind: 'cash', archived: true });
const POUPANCA_VELHA = account({ id: 'poupanca', name: 'Poupança velha', kind: 'savings', role: 'reserve', archived: true });
const CARTAO_VELHO = account({ id: 'cartao', name: 'Cartão velho', kind: 'credit_card', role: 'card', archived: true });
const CARTAO_CREDITO = account({ id: 'credito', name: 'Cartão com crédito', kind: 'credit_card', role: 'card', archived: true });
const NO_VERMELHO = account({ id: 'vermelho', name: 'No vermelho', archived: true });
const PJ_VELHA = account({ id: 'pj', name: 'PJ', role: 'external', archived: true });
const ZERADA = account({ id: 'zerada', name: 'Zerada', archived: true });
const APAGADA = account({ id: 'apagada', name: 'Apagada', archived: true, deletedAt: '2026-11-01T00:00:00.000Z' });

const balances = new Map<string, number>([
	['corrente', 2_415_000],
	['reserva', 30_000],
	['carteira', 12_000],
	['poupanca', 8_000],
	['cartao', -20_000],
	['credito', 3_000],
	['vermelho', -5_000],
	['pj', 500_000],
	['zerada', 0],
	['apagada', 7_000],
]);

describe('closedReviewItems', () => {
	it('lista só encerrada viva com saldo, fora a externa; o cartão leva a dívida que o Patrimônio conta', () => {
		const items = closedReviewItems(
			[CORRENTE, RESERVA, CARTEIRA_VELHA, POUPANCA_VELHA, CARTAO_VELHO, CARTAO_CREDITO, NO_VERMELHO, PJ_VELHA, ZERADA, APAGADA],
			balances,
			new Map([['cartao', 20_000]])
		);
		expect(items.map((item) => [item.account.id, item.balanceCents, item.owedCents])).toEqual([
			['carteira', 12_000, 0],
			['poupanca', 8_000, 0],
			['cartao', -20_000, 20_000],
			['credito', 3_000, 0],
			['vermelho', -5_000, 0],
		]);
	});

	it('sem saldo no mapa, vale o saldo de partida', () => {
		const items = closedReviewItems([account({ id: 'antiga', archived: true, openingBalanceCents: 4_500 })], new Map(), new Map());
		expect(items.map((item) => item.balanceCents)).toEqual([4_500]);
	});
});

describe('unseenClosedReview', () => {
	it('aparece de novo só quando entra conta que ainda não foi mostrada', () => {
		const items = closedReviewItems([CARTEIRA_VELHA, POUPANCA_VELHA], balances, new Map());
		expect(unseenClosedReview(items, new Set())).toBe(true);
		expect(unseenClosedReview(items, new Set(['carteira', 'poupanca']))).toBe(false);
		expect(unseenClosedReview(items, new Set(['carteira']))).toBe(true);
		expect(unseenClosedReview([], new Set())).toBe(false);
	});
});

describe('closedDecisionEffect: o Patrimônio e o "Depois das faturas" antes e depois', () => {
	// Hoje: Corrente R$ 24.150, Reserva R$ 300, o cartão ativo deve R$ 500 e o Cartão velho
	// (encerrado) deve R$ 200. O Patrimônio conta os dois cartões: 24.150 + 300 − 500 − 200 =
	// R$ 23.750. "Depois das faturas" só o ativo: 24.150 − 500 = R$ 23.650.
	const totals: ClosedTotals = {
		cashCents: 2_415_000,
		savedCents: 30_000,
		outsideCents: 0,
		cardsCents: 70_000,
		debtsCents: 0,
		netCents: 2_365_000,
	};
	const [carteira, poupanca, cartao, credito, vermelho] = closedReviewItems(
		[CARTEIRA_VELHA, POUPANCA_VELHA, CARTAO_VELHO, CARTAO_CREDITO, NO_VERMELHO],
		balances,
		new Map([['cartao', 20_000]])
	);

	it.each([
		['Carteira velha (R$ 120) → Corrente: entra no caixa', carteira, { kind: 'transfer', target: CORRENTE }, 2_375_000, 2_387_000, 2_365_000, 2_377_000, 0],
		['Carteira velha (R$ 120) → Reserva: entra no guardado deste mês', carteira, { kind: 'transfer', target: RESERVA }, 2_375_000, 2_387_000, 2_365_000, 2_365_000, 12_000],
		['Carteira velha (R$ 120) reaberta: volta ao caixa', carteira, { kind: 'reopen' }, 2_375_000, 2_387_000, 2_365_000, 2_377_000, 0],
		['Carteira velha (R$ 120) zerada: nada muda', carteira, { kind: 'zero' }, 2_375_000, 2_375_000, 2_365_000, 2_365_000, 0],
		['Poupança velha (R$ 80) reaberta: volta ao guardado', poupanca, { kind: 'reopen' }, 2_375_000, 2_383_000, 2_365_000, 2_365_000, 0],
		['Poupança velha (R$ 80) → Corrente: é um resgate deste mês', poupanca, { kind: 'transfer', target: CORRENTE }, 2_375_000, 2_383_000, 2_365_000, 2_373_000, -8_000],
		['Cartão velho (deve R$ 200) pago pela Corrente: o Patrimônio já contava', cartao, { kind: 'transfer', target: CORRENTE }, 2_375_000, 2_375_000, 2_365_000, 2_345_000, 0],
		['Cartão velho (deve R$ 200) pago pela Reserva', cartao, { kind: 'transfer', target: RESERVA }, 2_375_000, 2_375_000, 2_365_000, 2_365_000, -20_000],
		['Cartão velho (deve R$ 200) reaberto: entra no "Depois das faturas"', cartao, { kind: 'reopen' }, 2_375_000, 2_375_000, 2_365_000, 2_345_000, 0],
		['Cartão velho (deve R$ 200) zerado: a dívida sai do Patrimônio', cartao, { kind: 'zero' }, 2_375_000, 2_395_000, 2_365_000, 2_365_000, 0],
		['Cartão com crédito de R$ 30 → Corrente', credito, { kind: 'transfer', target: CORRENTE }, 2_375_000, 2_378_000, 2_365_000, 2_368_000, 0],
		['Cartão com crédito de R$ 30 reaberto: crédito não vira ativo', credito, { kind: 'reopen' }, 2_375_000, 2_375_000, 2_365_000, 2_365_000, 0],
		['Cartão com crédito de R$ 30 zerado', credito, { kind: 'zero' }, 2_375_000, 2_375_000, 2_365_000, 2_365_000, 0],
		['Conta no vermelho (−R$ 50) coberta pela Corrente', vermelho, { kind: 'transfer', target: CORRENTE }, 2_375_000, 2_370_000, 2_365_000, 2_360_000, 0],
		['Conta no vermelho (−R$ 50) reaberta', vermelho, { kind: 'reopen' }, 2_375_000, 2_370_000, 2_365_000, 2_360_000, 0],
		['Conta no vermelho (−R$ 50) zerada', vermelho, { kind: 'zero' }, 2_375_000, 2_375_000, 2_365_000, 2_365_000, 0],
	] as const)('%s', (_label, item, decision, worthBefore, worthAfter, netBefore, netAfter, savedThisMonth) => {
		expect(closedDecisionEffect(item, decision, totals)).toEqual({
			worth: { beforeCents: worthBefore, afterCents: worthAfter },
			net: { beforeCents: netBefore, afterCents: netAfter },
			savedThisMonthCents: savedThisMonth,
		});
	});
});

/**
 * Para onde vai o saldo (ou de onde sai o pagamento) de uma encerrada (SPD-155): só conta
 * principal ativa, a mesma regra do levar cartão para o débito (`isDebitTarget`, SPD-152). A
 * Reserva e a conta externa ficam de fora; o encerrar normal e o juntar têm as listas deles.
 */
describe('closedReviewTargets', () => {
	const CARTEIRA = account({ id: 'carteira-viva', name: 'Carteira', kind: 'cash' });
	const PJ = account({ id: 'pj-viva', name: 'PJ', role: 'external' });
	const OUTRO_CARTAO = account({ id: 'outro-cartao', name: 'Outro cartão', kind: 'credit_card', role: 'card' });
	const ENCERRADA = account({ id: 'encerrada', name: 'Encerrada', archived: true });
	const todas = [CORRENTE, RESERVA, CARTEIRA, PJ, OUTRO_CARTAO, ENCERRADA, APAGADA, CARTEIRA_VELHA, CARTAO_VELHO];

	it('a conta encerrada vai só para conta principal ativa: nem Reserva, nem externa, nem cartão, nem encerrada', () => {
		expect(closedReviewTargets(todas, CARTEIRA_VELHA).map((target) => target.id)).toEqual(['corrente', 'carteira-viva']);
	});

	it('o cartão encerrado devendo paga a fatura só com conta principal ativa', () => {
		expect(closedReviewTargets(todas, CARTAO_VELHO).map((target) => target.id)).toEqual(['corrente', 'carteira-viva']);
	});

	it('a própria conta não aparece, e só com Reserva e externa a lista fica vazia', () => {
		expect(closedReviewTargets([CORRENTE], CORRENTE)).toEqual([]);
		expect(closedReviewTargets([RESERVA, PJ, POUPANCA_VELHA], POUPANCA_VELHA)).toEqual([]);
	});
});
