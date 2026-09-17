import type { Account } from '../../database/schema';
import { cardCycleOn, limitUsagePercent, owedCents, summarizeAccounts } from '../accountMath';

const account = (overrides: Partial<Account>): Account => ({
	id: 'a',
	name: 'Conta',
	kind: 'checking',
	role: 'main',
	envelopeMonthlyCents: null,
	bankName: 'Nubank',
	color: '#000',
	last4: null,
	closingDay: null,
	dueDay: null,
	creditLimitCents: null,
	packageName: null,
	accountKey: null,
	openingBalanceCents: 0,
	openingBalanceDate: '2026-09-01',
	sortOrder: 0,
	archived: false,
	updatedAt: '2026-09-01T00:00:00.000Z',
	...overrides,
});

describe('cardCycleOn', () => {
	it('antes do dia de fechamento, o último fechamento foi no mês passado', () => {
		const cycle = cardCycleOn(10, 17, '2026-09-05');
		expect(cycle.lastClosing).toBe('2026-08-10');
		expect(cycle.cycleStart).toBe('2026-08-11');
		expect(cycle.nextClosing).toBe('2026-09-10');
		expect(cycle.nextDue).toBe('2026-09-17');
		expect(cycle.daysToClosing).toBe(5);
	});

	it('no dia do fechamento e depois dele, o ciclo aberto começou hoje ou antes', () => {
		expect(cardCycleOn(10, 17, '2026-09-10')).toMatchObject({
			lastClosing: '2026-09-10',
			cycleStart: '2026-09-11',
			nextClosing: '2026-10-10',
			nextDue: '2026-10-17',
			daysToClosing: 30,
		});
		expect(cardCycleOn(10, 17, '2026-09-25').lastClosing).toBe('2026-09-10');
	});

	it('vencimento antes do dia de fechamento cai no mês seguinte ao fechamento', () => {
		// Fecha dia 25, vence dia 3: a fatura que fecha em 25/09 vence em 03/10.
		expect(cardCycleOn(25, 3, '2026-09-20')).toMatchObject({ nextClosing: '2026-09-25', nextDue: '2026-10-03' });
	});

	it('dia 31 fecha no último dia dos meses curtos e volta ao 31', () => {
		expect(cardCycleOn(31, 5, '2026-02-15')).toMatchObject({ lastClosing: '2026-01-31', nextClosing: '2026-02-28' });
		expect(cardCycleOn(31, 5, '2026-03-01')).toMatchObject({ lastClosing: '2026-02-28', nextClosing: '2026-03-31' });
	});

	it('sem dia de vencimento, vence no dia do fechamento do mês seguinte', () => {
		expect(cardCycleOn(10, null, '2026-09-05').nextDue).toBe('2026-10-10');
	});

	it('virada de ano', () => {
		expect(cardCycleOn(20, 27, '2026-12-28')).toMatchObject({
			lastClosing: '2026-12-20',
			nextClosing: '2027-01-20',
			nextDue: '2027-01-27',
		});
	});
});

describe('owedCents e limitUsagePercent', () => {
	it('saldo negativo do cartão é valor a pagar; positivo é crédito', () => {
		expect(owedCents(-123456)).toBe(123456);
		expect(owedCents(5000)).toBe(0);
		expect(owedCents(0)).toBe(0);
	});

	it('percentual do limite', () => {
		expect(limitUsagePercent(25000, 100000)).toBe(25);
		expect(limitUsagePercent(150000, 100000)).toBe(150);
		expect(limitUsagePercent(1000, null)).toBeNull();
		expect(limitUsagePercent(1000, 0)).toBeNull();
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
