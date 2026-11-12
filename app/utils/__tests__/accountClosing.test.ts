/**
 * Encerrar, juntar e apagar conta (SPD-144): as regras puras.
 *
 * Encerrar exige saldo zero — ou uma transferência de encerramento que zera — para que
 * nada mude no patrimônio. Apagar só vale para conta vazia. Juntar só com conta do mesmo
 * papel (cartão com cartão), porque juntar papéis diferentes reclassifica o histórico.
 */

import type { Account } from '../../database/schema';
import {
	CLOSE_UNDO_WINDOW_MS,
	canUndoClose,
	closeTargets,
	closeUndoRemainingMs,
	isAccountEmpty,
	mergeTargets,
	planAccountClose,
} from '../accountClosing';

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
const CARTEIRA = account({ id: 'carteira', name: 'Carteira', kind: 'cash', sortOrder: 1 });
const RESERVA = account({
	id: 'reserva',
	name: 'Reserva',
	kind: 'savings',
	role: 'reserve',
	sortOrder: 2,
});
const OUTRA_RESERVA = account({
	id: 'reserva2',
	name: 'Caixinha',
	kind: 'savings',
	role: 'reserve',
	sortOrder: 3,
});
const PJ = account({ id: 'pj', name: 'PJ', role: 'external', sortOrder: 4 });
const ENVELOPE = account({ id: 'envelope', name: 'Mercado', role: 'envelope', sortOrder: 5 });
const CARTAO = account({
	id: 'cartao',
	name: 'Nubank',
	kind: 'credit_card',
	role: 'card',
	sortOrder: 6,
});
const OUTRO_CARTAO = account({
	id: 'cartao2',
	name: 'Inter',
	kind: 'credit_card',
	role: 'card',
	sortOrder: 7,
});
const ENCERRADA = account({ id: 'velha', name: 'Velha', archived: true, sortOrder: 8 });
const APAGADA = account({
	id: 'apagada',
	name: 'Apagada',
	deletedAt: '2026-11-01T00:00:00.000Z',
	sortOrder: 9,
});
const ALL = [
	CORRENTE,
	CARTEIRA,
	RESERVA,
	OUTRA_RESERVA,
	PJ,
	ENVELOPE,
	CARTAO,
	OUTRO_CARTAO,
	ENCERRADA,
	APAGADA,
];

describe('isAccountEmpty: o que é conta vazia', () => {
	const empty = {
		transactions: 0,
		transfers: 0,
		captures: 0,
		openingBalanceCents: 0,
		bills: 0,
		debts: 0,
	};

	it('sem lançamento, transferência, captura e saldo de partida: vazia, mesmo com conta a pagar e dívida ligadas', () => {
		expect(isAccountEmpty(empty)).toBe(true);
		expect(isAccountEmpty({ ...empty, bills: 2, debts: 1 })).toBe(true);
	});

	it.each([
		['um lançamento', { transactions: 1 }],
		['uma transferência', { transfers: 1 }],
		['uma captura', { captures: 1 }],
		['saldo de partida de R$ 5.000', { openingBalanceCents: 500_000 }],
		['fatura informada de R$ 800 (cartão)', { openingBalanceCents: -80_000 }],
	])('com %s não é vazia', (_label, overrides) => {
		expect(isAccountEmpty({ ...empty, ...overrides })).toBe(false);
	});
});

describe('planAccountClose: encerrar sem mexer no patrimônio', () => {
	const base = { pendingCaptures: 0, futureEntries: 0 };

	it('saldo zero: encerra direto', () => {
		expect(planAccountClose({ ...base, account: CORRENTE, balanceCents: 0 })).toEqual({
			kind: 'direct',
		});
	});

	it('reserva com R$ 300 (caso A): transferência de encerramento de R$ 300 para fora', () => {
		expect(planAccountClose({ ...base, account: RESERVA, balanceCents: 30_000 })).toEqual({
			kind: 'transfer',
			direction: 'out',
			amountCents: 30_000,
		});
	});

	it('conta com R$ 200 negativos: a transferência entra e zera', () => {
		expect(planAccountClose({ ...base, account: CORRENTE, balanceCents: -20_000 })).toEqual({
			kind: 'transfer',
			direction: 'in',
			amountCents: 20_000,
		});
	});

	it('cartão devendo R$ 500: recusado, com o valor', () => {
		expect(planAccountClose({ ...base, account: CARTAO, balanceCents: -50_000 })).toEqual({
			kind: 'blocked',
			reason: 'cardOwes',
			amountCents: 50_000,
			count: 0,
		});
	});

	it('cartão com R$ 40 de crédito: o crédito volta para uma conta', () => {
		expect(planAccountClose({ ...base, account: CARTAO, balanceCents: 4_000 })).toEqual({
			kind: 'transfer',
			direction: 'out',
			amountCents: 4_000,
		});
	});

	it('cartão zerado, mas com 3 parcelas por cair: recusado', () => {
		expect(
			planAccountClose({ ...base, futureEntries: 3, account: CARTAO, balanceCents: 0 })
		).toEqual({
			kind: 'blocked',
			reason: 'futureEntries',
			amountCents: 0,
			count: 3,
		});
	});

	it('compra da conta ainda na caixa de entrada: recusado até revisar', () => {
		expect(
			planAccountClose({ ...base, pendingCaptures: 2, account: CORRENTE, balanceCents: 0 })
		).toEqual({
			kind: 'blocked',
			reason: 'pendingCaptures',
			amountCents: 0,
			count: 2,
		});
	});

	it('conta externa (PJ) com R$ 24.000: encerra direto — o saldo dela nunca contou nos totais', () => {
		expect(planAccountClose({ ...base, account: PJ, balanceCents: 2_400_000 })).toEqual({
			kind: 'direct',
		});
	});
});

describe('para onde vai o saldo, e com quem juntar', () => {
	const names = (list: Account[]) => list.map((item) => item.name);

	it('o saldo vai para uma conta ativa que conta no caixa ou na reserva: nem cartão, nem externa, nem encerrada', () => {
		expect(names(closeTargets(ALL, RESERVA))).toEqual([
			'Corrente',
			'Carteira',
			'Caixinha',
			'Mercado',
		]);
		expect(names(closeTargets(ALL, CARTAO))).toEqual([
			'Corrente',
			'Carteira',
			'Reserva',
			'Caixinha',
			'Mercado',
		]);
	});

	it('juntar só com o mesmo papel: principal com principal, reserva com reserva, cartão com cartão', () => {
		expect(names(mergeTargets(ALL, CORRENTE))).toEqual(['Carteira']);
		expect(names(mergeTargets(ALL, RESERVA))).toEqual(['Caixinha']);
		expect(names(mergeTargets(ALL, CARTAO))).toEqual(['Inter']);
		expect(names(mergeTargets(ALL, PJ))).toEqual([]);
	});
});

describe('desfazer logo depois de encerrar (SPD-154)', () => {
	// Encerrou às 12:00:00 de 11/11/2026.
	const closedAt = new Date(2026, 10, 11, 12, 0, 0).getTime();
	const undo = { closedAt };

	it('a janela é curta, como a barra da caixa de entrada: 8 segundos', () => {
		expect(CLOSE_UNDO_WINDOW_MS).toBe(8_000);
	});

	it('dentro da janela dá para desfazer, e a barra sabe quanto falta', () => {
		expect(canUndoClose(undo, closedAt)).toBe(true);
		expect(closeUndoRemainingMs(undo, closedAt)).toBe(8_000);
		expect(canUndoClose(undo, closedAt + 7_999)).toBe(true);
		expect(closeUndoRemainingMs(undo, closedAt + 3_000)).toBe(5_000);
	});

	it('passados os 8 segundos não dá mais: o caminho é "Reabrir"', () => {
		expect(canUndoClose(undo, closedAt + 8_000)).toBe(false);
		expect(canUndoClose(undo, closedAt + 60_000)).toBe(false);
		expect(closeUndoRemainingMs(undo, closedAt + 8_000)).toBe(0);
		expect(closeUndoRemainingMs(undo, closedAt + 60_000)).toBe(0);
	});

	it('relógio que voltou para antes do encerramento não reabre a janela', () => {
		expect(canUndoClose(undo, closedAt - 1)).toBe(false);
	});
});
