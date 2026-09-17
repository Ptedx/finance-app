import type { Account } from '../../database/schema';
import { balanceAdjustment, owedCents, summarizeAccounts } from '../accountMath';

const account = (overrides: Partial<Account>): Account => ({
	id: 'a',
	name: 'Conta',
	kind: 'checking',
	role: 'main',
	envelopeMonthlyCents: null,
	network: null,
	bankName: 'Nubank',
	color: '#000',
	last4: null,
	closingDay: null,
	closingDaysBefore: null,
	dueDay: null,
	creditLimitCents: null,
	cardNames: null,
	packageName: null,
	accountKey: null,
	openingBalanceCents: 0,
	openingBalanceDate: '2026-09-01',
	sortOrder: 0,
	archived: false,
	updatedAt: '2026-09-01T00:00:00.000Z',
	...overrides,
});

describe('owedCents', () => {
	it('saldo negativo do cartão é valor a pagar; positivo é crédito', () => {
		expect(owedCents(-123456)).toBe(123456);
		expect(owedCents(5000)).toBe(0);
		expect(owedCents(0)).toBe(0);
	});
});

describe('summarizeAccounts', () => {
	it('caixa soma contas que não são cartão; cartões viram valor a pagar', () => {
		const accounts = [
			account({ id: 'nu', kind: 'checking' }),
			account({ id: 'mp', kind: 'savings' }),
			account({ id: 'card', kind: 'credit_card' }),
			account({ id: 'old', kind: 'checking', archived: true }),
		];
		const balances = new Map([
			['nu', 100000],
			['mp', 250000],
			['card', -45000],
			['old', 999999],
		]);
		expect(summarizeAccounts(accounts, balances, 1500)).toEqual({
			cashCents: 351500,
			cardsOwedCents: 45000,
			netCents: 306500,
		});
	});

	it('conta sem saldo calculado usa a âncora', () => {
		const accounts = [account({ id: 'x', openingBalanceCents: 777 })];
		expect(summarizeAccounts(accounts, new Map(), 0).cashCents).toBe(777);
	});
});

describe('balanceAdjustment — acertar o saldo de uma conta', () => {
	it('saldo do banco menor: a diferença é gasto', () => {
		expect(balanceAdjustment(100_000, 30_000)).toEqual({ amountCents: 70_000, isIncome: false });
	});

	it('saldo do banco maior: a diferença é entrada', () => {
		expect(balanceAdjustment(100_000, 130_000)).toEqual({ amountCents: 30_000, isIncome: true });
	});

	it('igual não gera lançamento', () => {
		expect(balanceAdjustment(100_000, 100_000)).toBeNull();
	});

	it('funciona com saldo negativo', () => {
		expect(balanceAdjustment(-5_000, 0)).toEqual({ amountCents: 5_000, isIncome: true });
	});
});
