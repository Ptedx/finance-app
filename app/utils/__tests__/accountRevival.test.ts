/**
 * Conta apagada que volta encerrada (SPD-149): o efeito em R$ por mês.
 *
 * Lançamento ou transferência viva numa conta apagada não entra em saldo nem no mês: a conta
 * não está na lista, e a série dos Relatórios descarta conta desconhecida. Quando ela volta
 * encerrada, o histórico passa a vê-los. O efeito é a série com a conta menos a série sem ela,
 * com a mesma função das telas (`buildMonthSeries`).
 */

jest.mock('@react-native-async-storage/async-storage', () =>
	require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import type { Account } from '../../database/schema';
import { revivalMonthEffects, revivalMonthRange } from '../accountRevival';
import type { MonthSeriesInput } from '../reportSeries';

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

describe('revivalMonthEffects', () => {
	// Corrente gastou R$ 200 em novembro. A Velha (apagada) teve um "Já paguei" de R$ 90 em
	// novembro; a Poupança velha (apagada) recebeu R$ 300 da Corrente em outubro.
	const input: MonthSeriesInput = {
		months: ['2026-09', '2026-10', '2026-11'],
		accounts: [
			account({ id: 'corrente', name: 'Corrente' }),
			account({ id: 'velha', name: 'Velha', archived: true }),
			account({ id: 'poupanca', name: 'Poupança velha', kind: 'savings', role: 'reserve', archived: true }),
		],
		activity: [
			{ month: '2026-11', accountId: 'corrente', incomeCents: 0, expenseCents: 20_000, passThroughCents: 0 },
			{ month: '2026-11', accountId: 'velha', incomeCents: 0, expenseCents: 9_000, passThroughCents: 0 },
		],
		transfers: [
			{ month: '2026-10', accountId: 'corrente', inCents: 0, outCents: 30_000 },
			{ month: '2026-10', accountId: 'poupanca', inCents: 30_000, outCents: 0 },
		],
		cardEntries: new Map(),
		currentMonth: '2026-11',
	};

	it('outubro guarda R$ 300 a mais e novembro gasta R$ 90 a mais; setembro não aparece', () => {
		expect(revivalMonthEffects(input, ['velha', 'poupanca'])).toEqual([
			{ month: '2026-10', incomeCents: 0, spendCents: 0, savedCents: 30_000 },
			{ month: '2026-11', incomeCents: 0, spendCents: 9_000, savedCents: 0 },
		]);
	});

	it('só a Velha: só novembro', () => {
		expect(revivalMonthEffects(input, ['velha'])).toEqual([{ month: '2026-11', incomeCents: 0, spendCents: 9_000, savedCents: 0 }]);
	});

	it('a PJ apagada que mandou R$ 1.200 à Corrente: volta a ser receita do mês', () => {
		const withPj: MonthSeriesInput = {
			...input,
			accounts: [...input.accounts, account({ id: 'pj', name: 'PJ', role: 'external', archived: true })],
			transfers: [
				...input.transfers,
				{ month: '2026-09', accountId: 'pj', inCents: 0, outCents: 120_000 },
				{ month: '2026-09', accountId: 'corrente', inCents: 120_000, outCents: 0 },
			],
			transferLines: [{ date: '2026-09-05', fromAccountId: 'pj', toAccountId: 'corrente', amountCents: 120_000 }],
		};
		expect(revivalMonthEffects(withPj, ['pj'])).toEqual([{ month: '2026-09', incomeCents: 120_000, spendCents: 0, savedCents: 0 }]);
	});

	it('transferência entre duas contas do dia a dia: o mês não muda', () => {
		const internal: MonthSeriesInput = {
			...input,
			activity: [],
			transfers: [
				{ month: '2026-10', accountId: 'corrente', inCents: 0, outCents: 5_000 },
				{ month: '2026-10', accountId: 'velha', inCents: 5_000, outCents: 0 },
			],
		};
		expect(revivalMonthEffects(internal, ['velha'])).toEqual([]);
	});
});

describe('revivalMonthRange', () => {
	it('dos 12 meses antes de hoje até hoje, ou do primeiro lançamento, se for mais antigo', () => {
		expect(revivalMonthRange('2026-10-05', '2026-11-05', '2026-11-11')).toEqual([
			'2025-11',
			'2025-12',
			'2026-01',
			'2026-02',
			'2026-03',
			'2026-04',
			'2026-05',
			'2026-06',
			'2026-07',
			'2026-08',
			'2026-09',
			'2026-10',
			'2026-11',
		]);
		const old = revivalMonthRange('2025-06-10', '2026-11-05', '2026-11-11');
		expect(old[0]).toBe('2025-06');
		expect(old[old.length - 1]).toBe('2026-11');
	});

	it('parcela com data futura: vai até o mês dela', () => {
		const range = revivalMonthRange('2026-11-01', '2027-02-10', '2026-11-11');
		expect(range[range.length - 1]).toBe('2027-02');
	});
});
