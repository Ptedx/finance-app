/**
 * Juntar contas, juntar cartões e levar cartão para o débito (SPD-152): as regras puras e as
 * frases da confirmação, com os textos da i18n de verdade e os números do banco de exemplo
 * de `accountsMergeCardsSql.test.tsx` (Cartão deve R$ 500, Cartão 2 deve R$ 370, Corrente
 * com R$ 23.600).
 */

import type { Account } from '../../database/schema';
import i18n from '../../i18n';
import {
	canMergeAccounts,
	cardMergeTotals,
	DebitFutureError,
	debitConvertTotals,
	futureCardEntries,
	isDebitTarget,
	MergeRoleError,
} from '../accountMerging';
import {
	cardMergeConfirmMessage,
	debitBlockedFutureMessage,
	debitConvertConfirmMessage,
	mergeRoleBlockedMessage,
} from '../deletionNotice';
import { configureMoney } from '../money';

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options);

const empty = { transactions: 0, transfers: 0, captures: 0, openingBalanceCents: 0, bills: 0, debts: 0 };
const used = { ...empty, transfers: 1 };

const role = (kind: Account['kind'], accountRole: Account['role']) => ({ kind, role: accountRole });

beforeAll(async () => {
	configureMoney({ locale: 'pt-BR', currencyCode: 'BRL', currencySymbol: 'R$' });
	await i18n.changeLanguage('pt');
});

describe('juntar contas: só do mesmo papel, ou a que sai vazia', () => {
	it('principal com principal, reserva com reserva: pode', () => {
		expect(canMergeAccounts(role('cash', 'main'), role('checking', 'main'), used)).toBe(true);
		expect(canMergeAccounts(role('savings', 'reserve'), role('savings', 'reserve'), used)).toBe(true);
	});

	it('a reserva com R$ 300 guardados na corrente: não pode (o "Guardado" de outubro sumiria)', () => {
		expect(canMergeAccounts(role('savings', 'reserve'), role('checking', 'main'), used)).toBe(false);
		expect(canMergeAccounts(role('checking', 'main'), role('savings', 'reserve'), used)).toBe(false);
		expect(canMergeAccounts(role('checking', 'main'), role('checking', 'external'), { ...empty, openingBalanceCents: 100 })).toBe(false);
	});

	it('a ficha vazia de outro papel: pode (não há histórico a reclassificar)', () => {
		expect(canMergeAccounts(role('savings', 'reserve'), role('checking', 'main'), empty)).toBe(true);
	});

	it('cartão nunca: ele tem o próprio juntar', () => {
		expect(canMergeAccounts(role('credit_card', 'card'), role('credit_card', 'card'), empty)).toBe(false);
	});

	it('o erro se chama MergeRoleError (a tela o reconhece pelo nome)', () => {
		expect(new MergeRoleError().name).toBe('MergeRoleError');
	});
});

describe('levar o cartão para o débito: só para conta principal ativa', () => {
	const account = (overrides: Partial<Pick<Account, 'kind' | 'role' | 'archived' | 'deletedAt'>>) => ({
		kind: 'checking' as Account['kind'],
		role: 'main' as Account['role'],
		archived: false,
		deletedAt: undefined,
		...overrides,
	});

	it('corrente e carteira principais: sim; reserva, externa, cartão, encerrada: não', () => {
		expect(isDebitTarget(account({}))).toBe(true);
		expect(isDebitTarget(account({ kind: 'cash' }))).toBe(true);
		expect(isDebitTarget(account({ kind: 'savings', role: 'reserve' }))).toBe(false);
		expect(isDebitTarget(account({ role: 'external' }))).toBe(false);
		expect(isDebitTarget(account({ kind: 'credit_card', role: 'card' }))).toBe(false);
		expect(isDebitTarget(account({ archived: true }))).toBe(false);
	});
});

describe('os valores da confirmação', () => {
	it('juntar cartões: R$ 370 + R$ 500 = R$ 870', () => {
		expect(cardMergeTotals(-37_000, -50_000)).toEqual({ fromOwedCents: 37_000, intoOwedCents: 50_000, totalOwedCents: 87_000 });
	});

	it('juntar com um cartão com crédito: R$ 370 + (−R$ 20) = R$ 350', () => {
		expect(cardMergeTotals(-37_000, 2_000)).toEqual({ fromOwedCents: 37_000, intoOwedCents: -2_000, totalOwedCents: 35_000 });
	});

	it('levar para o débito: a Corrente vai de R$ 23.600 a R$ 23.100 (a dívida de R$ 500 passa a sair dela)', () => {
		expect(debitConvertTotals(-50_000, 2_360_000)).toEqual({
			cardOwedCents: 50_000,
			accountBeforeCents: 2_360_000,
			accountAfterCents: 2_310_000,
		});
	});
	it('com parcelas por cair: quantas e quanto (estorno desconta; hoje e antes não contam)', () => {
		const entry = (accountId: string, date: string, amountCents: number, isIncome = false) => ({ accountId, date, amountCents, isIncome });
		const list = [
			entry('cartao', '2026-11-11', 9_000),
			entry('cartao', '2026-12-10', 25_000),
			entry('cartao', '2027-01-10', 25_000),
			entry('cartao', '2027-01-12', 1_000, true),
			entry('corrente', '2026-12-10', 7_000),
		];
		expect(futureCardEntries(list, 'cartao', '2026-11-11')).toEqual({ count: 3, amountCents: 49_000 });
		expect(futureCardEntries(list, 'cartao', '2027-01-12')).toEqual({ count: 0, amountCents: 0 });
		expect(new DebitFutureError().name).toBe('DebitFutureError');
	});
});

describe('as frases', () => {
	const side = (name: string, balanceCents: number, openingBalanceCents: number, openingBalanceDate: string) => ({
		name,
		balanceCents,
		openingBalanceCents,
		openingBalanceDate,
	});

	it('juntar cartões com a fatura informada no mesmo dia: a soma em R$ e o patrimônio igual', () => {
		const message = cardMergeConfirmMessage(side('Cartão 2', -37_000, -30_000, '2026-09-30'), side('Cartão', -50_000, -80_000, '2026-09-30'), t);
		expect(message).toContain('Dívida do cartão: R$ 370,00 + R$ 500,00 = R$ 870,00; o patrimônio não muda.');
		expect(message).toContain('Cartão continua com o fechamento e o limite dele.');
		expect(message).toContain('use "Acertar valor" com a fatura do banco');
		expect(message).not.toContain('passa a contar a partir de');
	});

	it('com as faturas informadas em dias diferentes: a mais nova muda de data, com o valor', () => {
		const message = cardMergeConfirmMessage(side('Cartão', -50_000, -80_000, '2026-09-30'), side('Cartão 2', -37_000, -30_000, '2026-10-31'), t);
		expect(message).toContain(
			'A fatura informada de Cartão 2 (R$ 300,00, em 31/10/2026) passa a contar a partir de 30/09/2026, junto com a de Cartão'
		);
	});

	it('levar para o débito: saldo da conta antes → depois, patrimônio igual e o efeito nos relatórios', () => {
		const message = debitConvertConfirmMessage(
			{ account: 'Corrente', cardBalanceCents: -50_000, accountBalanceCents: 2_360_000, cardOpeningBalanceCents: -80_000, purchasesCents: 50_000 },
			t
		);
		expect(message).toContain('O que o cartão deve (R$ 500,00) passa a sair de Corrente: R$ 23.600,00 → R$ 23.100,00. O patrimônio não muda.');
		expect(message).toContain('as compras do cartão (R$ 500,00) passam a contar no dia de cada uma');
		expect(message).toContain('A fatura informada no cadastro do cartão (R$ 800,00) entra no saldo de Corrente');
		expect(message).toMatch(/Continuar\?$/);
	});

	it('levar para o débito um cartão vazio e quitado: só que nada muda', () => {
		const message = debitConvertConfirmMessage(
			{ account: 'Corrente', cardBalanceCents: 0, accountBalanceCents: 2_360_000, cardOpeningBalanceCents: 0, purchasesCents: 0 },
			t
		);
		expect(message).toContain('O saldo de Corrente e o patrimônio não mudam.');
		expect(message).not.toContain('relatórios');
	});

	it('levar para o débito um cartão com crédito: o crédito passa para a conta', () => {
		const message = debitConvertConfirmMessage(
			{ account: 'Corrente', cardBalanceCents: 2_000, accountBalanceCents: 100_000, cardOpeningBalanceCents: 0, purchasesCents: 0 },
			t
		);
		expect(message).toContain('O crédito do cartão (R$ 20,00) passa para Corrente: R$ 1.000,00 → R$ 1.020,00.');
	});

	it('levar para o débito com parcelas por cair: quantas, quanto e quando dá', () => {
		const message = debitBlockedFutureMessage('Cartão', 2, 50_000, t);
		expect(message).toContain('Cartão tem 2 parcelas por cair (R$ 500,00)');
		expect(debitBlockedFutureMessage('Cartão', 1, 25_000, t)).toContain('Cartão tem 1 parcela por cair (R$ 250,00)');
	});

	it('juntar papéis diferentes: recusado, com o porquê e o caminho', () => {
		const message = mergeRoleBlockedMessage('Reserva', 'Corrente', t);
		expect(message).toContain('Reserva e Corrente têm papéis diferentes');
		expect(message).toContain('encerre Reserva com transferência');
	});
});
