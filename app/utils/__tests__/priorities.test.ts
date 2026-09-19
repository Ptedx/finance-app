import { buildReserveReadModel, type ReserveInput } from '../emergencyReserve';
import { buildPriorities, currentPriority, type PrioritiesInput } from '../priorities';

const R = (reais: number) => reais * 100;

const reserveOf = (balance: number, overrides: Partial<ReserveInput> = {}) =>
	buildReserveReadModel({
		accounts: [{ balanceCents: R(balance), purpose: null }],
		targetMonths: 12,
		cost: { cents: R(4_000), source: 'history' },
		monthlyContributionCents: R(2_000),
		monthlyRate: 0,
		...overrides,
	});

const input = (overrides: Partial<PrioritiesInput> = {}): PrioritiesInput => ({
	reserve: reserveOf(15_000),
	expensiveDebtCents: R(30_000),
	hasDebts: true,
	retirement: { capitalCents: 0, requiredCapitalCents: R(1_500_000) },
	...overrides,
});

const statuses = (items: ReturnType<typeof buildPriorities>) => Object.fromEntries(items.map((item) => [item.id, item.status]));

describe('a ordem', () => {
	it('reserva mínima → dívida cara → reserva cheia → aposentadoria', () => {
		expect(buildPriorities(input()).map((item) => item.id)).toEqual(['reserve-minimum', 'expensive-debt', 'reserve-full', 'retirement']);
	});

	it('sem dívida cadastrada, o degrau some', () => {
		expect(buildPriorities(input({ hasDebts: false })).map((item) => item.id)).toEqual(['reserve-minimum', 'reserve-full', 'retirement']);
	});
});

describe('o degrau de agora', () => {
	it('reserva abaixo de três meses: é ela, com o que falta', () => {
		const items = buildPriorities(input({ reserve: reserveOf(5_000) }));
		expect(statuses(items)).toEqual({ 'reserve-minimum': 'doing', 'expensive-debt': 'next', 'reserve-full': 'next', retirement: 'next' });
		expect(currentPriority(items)).toMatchObject({ id: 'reserve-minimum', missingCents: R(7_000) });
	});

	it('mínimo feito e dívida cara: amortizar vem antes de encher a reserva', () => {
		const items = buildPriorities(input());
		expect(statuses(items)).toMatchObject({ 'reserve-minimum': 'done', 'expensive-debt': 'doing', 'reserve-full': 'next' });
		expect(currentPriority(items)).toMatchObject({ id: 'expensive-debt', missingCents: R(30_000) });
	});

	it('sem dívida cara, encher a reserva', () => {
		const items = buildPriorities(input({ expensiveDebtCents: 0 }));
		expect(statuses(items)).toMatchObject({ 'expensive-debt': 'done', 'reserve-full': 'doing', retirement: 'next' });
		expect(currentPriority(items)?.missingCents).toBe(R(33_000));
	});

	it('tudo cumprido até a aposentadoria', () => {
		const items = buildPriorities(input({ reserve: reserveOf(60_000), expensiveDebtCents: 0 }));
		expect(currentPriority(items)).toMatchObject({ id: 'retirement', status: 'doing', missingCents: R(1_500_000) });
	});

	it('meta alcançada: nada a fazer', () => {
		const items = buildPriorities(input({ reserve: reserveOf(60_000), expensiveDebtCents: 0, retirement: { capitalCents: R(2_000_000), requiredCapitalCents: R(1_500_000) } }));
		expect(currentPriority(items)).toBeNull();
	});
});

describe('falta um dado', () => {
	it('sem custo essencial, a reserva pede o custo e o resto espera', () => {
		const items = buildPriorities(input({ reserve: reserveOf(10_000, { cost: null }) }));
		expect(statuses(items)).toEqual({ 'reserve-minimum': 'setup', 'expensive-debt': 'next', 'reserve-full': 'setup', retirement: 'next' });
	});

	it('sem meta de aposentadoria, o último degrau pede a meta', () => {
		const items = buildPriorities(input({ reserve: reserveOf(60_000), expensiveDebtCents: 0, retirement: null }));
		expect(currentPriority(items)).toMatchObject({ id: 'retirement', status: 'setup' });
	});
});
