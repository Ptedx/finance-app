import type { Account } from '../../database/schema';
import { counterpartCents, owedCents, spendingAdjustment, summarizeAccounts } from '../accountMath';
import { centsToDisplayInput, configureMoney, finaliseAmountInput, formatAmountInput, parseAmountToCents } from '../money';

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
			savedCents: 0,
			cardsOwedCents: 45000,
			netCents: 306500,
		});
	});

	it('conta sem saldo calculado usa a âncora', () => {
		const accounts = [account({ id: 'x', openingBalanceCents: 777 })];
		expect(summarizeAccounts(accounts, new Map(), 0).cashCents).toBe(777);
	});
});

describe('spendingAdjustment — acertar o gasto do mês numa conta', () => {
	it('gastou mais do que o app tinha: entra como despesa', () => {
		// O app tinha R$ 0 de gasto no Inter e o usuário informa R$ 845,20.
		expect(spendingAdjustment(0, 84_520)).toEqual({ amountCents: 84_520, isIncome: false });
	});

	it('gastou menos do que o app tinha: entra como entrada', () => {
		expect(spendingAdjustment(84_520, 20_000)).toEqual({ amountCents: 64_520, isIncome: true });
	});

	it('igual não gera lançamento', () => {
		expect(spendingAdjustment(84_520, 84_520)).toBeNull();
	});
});

describe('acertar a conta: "já gastei" e "ainda tenho" são o mesmo dinheiro', () => {
	afterEach(() => configureMoney({ locale: 'en-US', currencyCode: 'USD', currencySymbol: '$' }));

	it('com R$ 1.000 no mês, digitar 845,20 deixa 154,80 do outro lado, e vice-versa', () => {
		expect(counterpartCents(100_000, 84_520)).toBe(15_480);
		expect(counterpartCents(100_000, 15_480)).toBe(84_520);
	});

	it('gastou mais do que o mês tinha: o outro lado não fica negativo', () => {
		expect(counterpartCents(100_000, 120_000)).toBe(0);
	});

	it('digitando em português, o valor não se perde no caminho', () => {
		configureMoney({ locale: 'pt-BR', currencyCode: 'BRL', currencySymbol: 'R$' });

		// Digitação tecla a tecla no campo, como o app formata a cada letra.
		let typed = '';
		for (const key of '845,20') typed = formatAmountInput(typed + key);
		expect(typed).toBe('845,20');
		expect(parseAmountToCents(typed)).toBe(84_520);

		// O outro campo é preenchido pelo app e volta ao mesmo centavo.
		const other = centsToDisplayInput(counterpartCents(100_000, parseAmountToCents(typed) as number));
		expect(other).toBe('154,80');
		expect(parseAmountToCents(other)).toBe(15_480);

		// Sair do campo arredonda sem mudar o valor.
		expect(finaliseAmountInput('845,2')).toBe('845,20');
		expect(parseAmountToCents(finaliseAmountInput('1.000'))).toBe(100_000);
	});
});

describe('reserva fora do "Em caixa"', () => {
	it('o investimento não entra no caixa nem no depois das faturas, e aparece como guardado', () => {
		const accounts = [
			account({ id: 'nu', role: 'main' }),
			account({ id: 'mp', name: 'Investimentos MP', kind: 'savings', role: 'reserve' }),
			account({ id: 'card', kind: 'credit_card', role: 'card' }),
		];
		const balances = new Map([
			['nu', 50_000],
			['mp', 700_000],
			['card', -380_000],
		]);

		expect(summarizeAccounts(accounts, balances, 0)).toEqual({
			cashCents: 50_000,
			savedCents: 700_000,
			cardsOwedCents: 380_000,
			netCents: -330_000,
		});
	});

	it('reserva arquivada não conta em lugar nenhum', () => {
		const accounts = [account({ id: 'mp', kind: 'savings', role: 'reserve', archived: true })];
		expect(summarizeAccounts(accounts, new Map([['mp', 700_000]]), 0)).toMatchObject({ cashCents: 0, savedCents: 0 });
	});
});
