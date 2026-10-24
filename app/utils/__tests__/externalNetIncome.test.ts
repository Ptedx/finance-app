/*
 * SPD-033 (DEC-09 a): a receita que vem da conta `external` (a PJ) é o líquido do mês —
 * o que ela mandou para as suas contas menos o que as suas contas mandaram para ela —, com
 * piso zero. A volta do próprio dinheiro não é renda. Home e Relatórios, mesma regra.
 */
import type { Account } from '../../database/schema';
import { buildMonthOverview } from '../monthOverview';
import { buildMonthSeries, externalTransfersOutByMonth, type MonthAccountRow, type MonthTransferRow } from '../reportSeries';

const account = (id: string, overrides: Partial<Account> = {}): Account => ({
	id,
	name: id,
	kind: 'checking',
	role: 'main',
	envelopeMonthlyCents: null,
	network: null,
	bankName: null,
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
	openingBalanceDate: '2026-01-01',
	sortOrder: 0,
	archived: false,
	updatedAt: '2026-01-01T00:00:00.000Z',
	...overrides,
});

const main = account('main', { name: 'Principal' });
const reserve = account('res', { name: 'Reserva', kind: 'savings', role: 'reserve' });
const pj = account('pj', { name: 'PJ', role: 'external' });
const accounts = [main, reserve, pj];

type Line = { date: string; fromAccountId: string | null; toAccountId: string | null; amountCents: number };

/** As somas por conta e mês que o banco devolveria para estas linhas. */
const transferRows = (lines: Line[]): MonthTransferRow[] => {
	const byKey = new Map<string, MonthTransferRow>();
	const add = (accountId: string | null, month: string, inCents: number, outCents: number) => {
		if (!accountId) return;
		const key = `${month}|${accountId}`;
		const row = byKey.get(key) ?? { month, accountId, inCents: 0, outCents: 0 };
		row.inCents += inCents;
		row.outCents += outCents;
		byKey.set(key, row);
	};
	for (const line of lines) {
		add(line.toAccountId, line.date.slice(0, 7), line.amountCents, 0);
		add(line.fromAccountId, line.date.slice(0, 7), 0, line.amountCents);
	}
	return [...byKey.values()];
};

const octoberOf = (lines: Line[], activity: MonthAccountRow[] = []) => {
	const [point] = buildMonthSeries({
		months: ['2026-10'],
		accounts,
		activity,
		transfers: transferRows(lines),
		transferLines: lines,
		cardEntries: new Map(),
		currentMonth: '2026-10',
	});
	return point.overview;
};

describe('Relatórios (buildMonthSeries): receita vinda da external é o líquido do mês', () => {
	it('CALC-08: principal → PJ → principal (ida e volta de R$ 1.000) não é receita', () => {
		const overview = octoberOf([
			{ date: '2026-10-03', fromAccountId: 'main', toAccountId: 'pj', amountCents: 100_000 },
			{ date: '2026-10-20', fromAccountId: 'pj', toAccountId: 'main', amountCents: 100_000 },
		]);
		expect({ income: overview.incomeCents, leftover: overview.leftoverCents }).toEqual({ income: 0, leftover: 0 });
	});

	it('mandou R$ 300 para a PJ e recebeu R$ 1.000 de pró-labore: receita R$ 700', () => {
		const overview = octoberOf([
			{ date: '2026-10-03', fromAccountId: 'main', toAccountId: 'pj', amountCents: 30_000 },
			{ date: '2026-10-05', fromAccountId: 'pj', toAccountId: 'main', amountCents: 100_000 },
		]);
		expect(overview.incomeCents).toBe(70_000);
		expect(overview.grossIncomeCents).toBe(70_000);
	});

	it('o líquido é do mês todo, somando as suas contas: sai da reserva, volta na principal', () => {
		const overview = octoberOf([
			{ date: '2026-10-03', fromAccountId: 'res', toAccountId: 'pj', amountCents: 100_000 },
			{ date: '2026-10-20', fromAccountId: 'pj', toAccountId: 'main', amountCents: 100_000 },
		]);
		expect(overview.incomeCents).toBe(0);
	});

	it('piso zero: mandar mais para a PJ do que voltou não come a receita lançada', () => {
		const overview = octoberOf(
			[
				{ date: '2026-10-03', fromAccountId: 'main', toAccountId: 'pj', amountCents: 200_000 },
				{ date: '2026-10-20', fromAccountId: 'pj', toAccountId: 'main', amountCents: 50_000 },
			],
			[{ month: '2026-10', accountId: 'main', incomeCents: 500_000, expenseCents: 0, passThroughCents: 0 }]
		);
		expect(overview.incomeCents).toBe(500_000);
	});

	it('o que foi para a PJ em setembro não desconta a volta de outubro', () => {
		const overview = octoberOf([
			{ date: '2026-09-28', fromAccountId: 'main', toAccountId: 'pj', amountCents: 100_000 },
			{ date: '2026-10-05', fromAccountId: 'pj', toAccountId: 'main', amountCents: 100_000 },
		]);
		expect(overview.incomeCents).toBe(100_000);
	});
});

describe('externalTransfersOutByMonth', () => {
	it('só o que sai de uma conta sua para uma external, por mês|conta', () => {
		const out = externalTransfersOutByMonth(
			[
				{ date: '2026-10-03', fromAccountId: 'main', toAccountId: 'pj', amountCents: 100_000 },
				{ date: '2026-10-04', fromAccountId: 'main', toAccountId: 'res', amountCents: 5_000 },
				{ date: '2026-10-05', fromAccountId: null, toAccountId: 'pj', amountCents: 7_000 },
				{ date: '2026-10-06', fromAccountId: 'pj', toAccountId: 'main', amountCents: 9_000 },
			],
			accounts
		);
		expect([...out]).toEqual([['2026-10|main', 100_000]]);
	});
});

describe('Home (buildMonthOverview): a mesma regra pelo campo de saída para a external', () => {
	it('ida e volta de R$ 1.000 na principal: receita zero, igual aos Relatórios', () => {
		const home = buildMonthOverview({
			accounts: [
				{ accountId: 'main', name: 'Principal', kind: 'checking', role: 'main', incomeCents: 0, expenseCents: 0, transfersInCents: 100_000, transfersInFromExternalCents: 100_000, transfersOutCents: 100_000, transfersOutToExternalCents: 100_000 },
				{ accountId: 'pj', name: 'PJ', kind: 'checking', role: 'external', incomeCents: 0, expenseCents: 0, transfersInCents: 100_000, transfersOutCents: 100_000 },
			],
			unassigned: { incomeCents: 0, expenseCents: 0 },
		});
		expect(home.incomeCents).toBe(0);
	});
});
