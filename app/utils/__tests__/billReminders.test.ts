/**
 * Lembretes das contas a pagar (REM-01): o usuário nunca recebeu aviso de vencimento de
 * consórcio nem de financiamento. Aqui fica a agenda pura — quando avisar — testada nas
 * bordas do calendário. As datas são montadas e lidas em hora local, então a suíte vale
 * em qualquer fuso (roda com `TZ` variado).
 */

import type { Bill } from '../../database/schema';
import { billReminders, billStatus, type CardReminderSource, cardReminders } from '../billReminders';
import { buildCardSummary, type CardEntry, type CardMovement, type CardSettings } from '../cardMath';
import { getISODate } from '../dateUtils';

const bill = (overrides: Partial<Bill> = {}): Bill => ({
	id: 'consorcio',
	name: 'Consórcio',
	dueDay: 10,
	amountCents: 45_000,
	accountId: null,
	category: null,
	matchHint: null,
	debtId: null,
	paidThrough: null,
	paidByRef: null,
	active: true,
	sortOrder: 0,
	updatedAt: '2026-10-01T00:00:00.000Z',
	...overrides,
});

const two = (value: number): string => String(value).padStart(2, '0');

/** "soon 2026-11-07 09:00 [2026-11]", lido em hora local. */
const describeReminder = (reminder: ReturnType<typeof billReminders>[number]): string =>
	`${reminder.kind} ${getISODate(reminder.at)} ${two(reminder.at.getHours())}:${two(reminder.at.getMinutes())} [${reminder.month}]`;

const remindersOf = (bills: Bill[], now: Date): string[] =>
	billReminders(bills, now).map(describeReminder);

describe('billReminders', () => {
	it('avisa em D−3, no dia e em D+1, D+2 e D+3, sempre às 09:00 locais', () => {
		const now = new Date(2026, 9, 24, 12, 0); // 24/out, meio-dia
		const reminders = remindersOf([bill({ dueDay: 10 })], now);

		// Outubro já passou de D+3 (dia 13); novembro e dezembro cabem nos 45 dias.
		expect(reminders.filter((line) => line.endsWith('[2026-11]'))).toEqual([
			'soon 2026-11-07 09:00 [2026-11]',
			'today 2026-11-10 09:00 [2026-11]',
			'late 2026-11-11 09:00 [2026-11]',
			'late 2026-11-12 09:00 [2026-11]',
			'late 2026-11-13 09:00 [2026-11]',
		]);
		// 24/out + 45 dias = 8/dez: o 'soon' de dezembro (7/dez) entra, o dia 10 não.
		expect(reminders.filter((line) => line.endsWith('[2026-12]'))).toEqual([
			'soon 2026-12-07 09:00 [2026-12]',
		]);
		expect(reminders.some((line) => line.endsWith('[2026-10]'))).toBe(false);
	});

	it('traz identificação estável: conta, mês e distância até o vencimento', () => {
		const [first, ...rest] = billReminders([bill({ dueDay: 10 })], new Date(2026, 9, 24, 12, 0));
		expect(first).toMatchObject({
			billId: 'consorcio',
			kind: 'soon',
			month: '2026-11',
			dueDate: '2026-11-10',
			n: 3,
		});
		expect(rest.map((reminder) => `${reminder.kind}:${reminder.n}`).slice(0, 4)).toEqual([
			'today:0',
			'late:1',
			'late:2',
			'late:3',
		]);
	});

	it('só devolve horários no futuro: D−3 já passado fica de fora', () => {
		// 08/nov 10:00 — o 'soon' de 07/nov já foi; o 'today' de 10/nov ainda vem.
		const reminders = remindersOf([bill({ dueDay: 10 })], new Date(2026, 10, 8, 10, 0));
		expect(reminders[0]).toBe('today 2026-11-10 09:00 [2026-11]');
		expect(reminders).not.toContain('soon 2026-11-07 09:00 [2026-11]');
	});

	it('09:00 em ponto já não é futuro', () => {
		const reminders = remindersOf([bill({ dueDay: 10 })], new Date(2026, 10, 10, 9, 0));
		expect(reminders[0]).toBe('late 2026-11-11 09:00 [2026-11]');
	});

	it('vencimento passado e não pago gera os atrasos que ainda faltam', () => {
		// Venceu dia 22; hoje é 24 às 12:00: D+1 (23) e D+2 (24, 09:00) já passaram, falta D+3.
		const reminders = remindersOf([bill({ dueDay: 22 })], new Date(2026, 9, 24, 12, 0));
		expect(reminders.filter((line) => line.endsWith('[2026-10]'))).toEqual([
			'late 2026-10-25 09:00 [2026-10]',
		]);

		// Às 08:00 do dia 24, o D+2 ainda vem.
		const early = remindersOf([bill({ dueDay: 22 })], new Date(2026, 9, 24, 8, 0));
		expect(early.filter((line) => line.endsWith('[2026-10]'))).toEqual([
			'late 2026-10-24 09:00 [2026-10]',
			'late 2026-10-25 09:00 [2026-10]',
		]);
	});

	it('atraso de um vencimento do mês anterior atravessa a virada', () => {
		// Venceu 30/set; hoje é 01/out de manhã: faltam D+1 (01/out), D+2 e D+3.
		const reminders = remindersOf([bill({ dueDay: 30 })], new Date(2026, 9, 1, 8, 0));
		expect(reminders.filter((line) => line.endsWith('[2026-09]'))).toEqual([
			'late 2026-10-01 09:00 [2026-09]',
			'late 2026-10-02 09:00 [2026-09]',
			'late 2026-10-03 09:00 [2026-09]',
		]);
	});

	it('dia 31 em mês de 30 cai no último dia', () => {
		const reminders = remindersOf([bill({ dueDay: 31 })], new Date(2026, 10, 20, 12, 0));
		expect(reminders).toContain('soon 2026-11-27 09:00 [2026-11]');
		expect(reminders).toContain('today 2026-11-30 09:00 [2026-11]');
		expect(reminders).toContain('late 2026-12-01 09:00 [2026-11]');
		// Dezembro tem 31: volta ao dia 31.
		expect(reminders).toContain('today 2026-12-31 09:00 [2026-12]');
	});

	it.each([29, 30, 31])('dia %i em fevereiro cai no dia 28 (ano comum)', (dueDay) => {
		const reminders = remindersOf([bill({ dueDay })], new Date(2027, 1, 1, 12, 0));
		expect(reminders).toContain('soon 2027-02-25 09:00 [2027-02]');
		expect(reminders).toContain('today 2027-02-28 09:00 [2027-02]');
		expect(reminders).toContain('late 2027-03-01 09:00 [2027-02]');
		expect(reminders).toContain('late 2027-03-03 09:00 [2027-02]');
	});

	it('em ano bissexto, 30 e 31 de fevereiro caem no dia 29', () => {
		const reminders = remindersOf([bill({ dueDay: 31 })], new Date(2028, 1, 1, 12, 0));
		expect(reminders).toContain('today 2028-02-29 09:00 [2028-02]');
		expect(reminders).toContain('soon 2028-02-26 09:00 [2028-02]');
	});

	it('mês pago não gera nada; o mês seguinte segue avisando', () => {
		const reminders = remindersOf(
			[bill({ dueDay: 10, paidThrough: '2026-11' })],
			new Date(2026, 9, 24, 12, 0)
		);
		expect(reminders.some((line) => line.endsWith('[2026-11]'))).toBe(false);
		expect(reminders).toContain('soon 2026-12-07 09:00 [2026-12]');
	});

	it('pago adiantado (paidThrough à frente) cala todos os meses cobertos', () => {
		expect(
			remindersOf([bill({ dueDay: 10, paidThrough: '2027-01' })], new Date(2026, 9, 24, 12, 0))
		).toEqual([]);
	});

	it('pago até o mês anterior não cala o atraso deste mês', () => {
		const reminders = remindersOf(
			[bill({ dueDay: 22, paidThrough: '2026-09' })],
			new Date(2026, 9, 24, 8, 0)
		);
		expect(reminders).toContain('late 2026-10-24 09:00 [2026-10]');
	});

	it('conta inativa ou apagada não avisa', () => {
		const now = new Date(2026, 9, 24, 12, 0);
		expect(remindersOf([bill({ active: false })], now)).toEqual([]);
		expect(remindersOf([bill({ deletedAt: '2026-10-20T00:00:00.000Z' })], now)).toEqual([]);
	});

	it('várias contas saem misturadas em ordem de horário', () => {
		const reminders = billReminders(
			[bill({ id: 'b', dueDay: 15 }), bill({ id: 'a', dueDay: 5 })],
			new Date(2026, 9, 24, 12, 0)
		);
		const times = reminders.map((reminder) => reminder.at.getTime());
		expect(times).toEqual([...times].sort((x, y) => x - y));
		expect(reminders[0]).toMatchObject({ billId: 'a', kind: 'soon', dueDate: '2026-11-05' });
	});

	it('não passa de 45 dias à frente', () => {
		const now = new Date(2026, 9, 24, 12, 0);
		const limit = new Date(now);
		limit.setDate(limit.getDate() + 45);
		for (const reminder of billReminders(
			[bill({ dueDay: 1 }), bill({ id: 'x', dueDay: 28 })],
			now
		)) {
			expect(reminder.at.getTime()).toBeGreaterThan(now.getTime());
			expect(reminder.at.getTime()).toBeLessThanOrEqual(limit.getTime());
		}
	});

	it('virada de ano: vencimento de janeiro avisado em dezembro', () => {
		const reminders = remindersOf([bill({ dueDay: 2 })], new Date(2026, 11, 20, 12, 0));
		expect(reminders).toContain('soon 2026-12-30 09:00 [2027-01]');
		expect(reminders).toContain('today 2027-01-02 09:00 [2027-01]');
	});
});

describe('billStatus', () => {
	it('antes do vencimento é upcoming, no dia é due_today, depois é late', () => {
		const conta = bill({ dueDay: 10 });
		expect(billStatus(conta, '2026-11', '2026-11-09')).toBe('upcoming');
		expect(billStatus(conta, '2026-11', '2026-11-10')).toBe('due_today');
		expect(billStatus(conta, '2026-11', '2026-11-11')).toBe('late');
		// Mês seguinte, ainda não pago: continua atrasada.
		expect(billStatus(bill({ dueDay: 10, paidThrough: '2026-10' }), '2026-11', '2026-12-01')).toBe('late');
	});

	it('sem mês pago nenhum, o passado não fica atrasado; e o atraso vai até 3 meses para trás (SPD-145)', () => {
		// A conta de dívida antes de ganhar o mês de partida: novembro visto de dezembro.
		expect(billStatus(bill({ dueDay: 10 }), '2026-11', '2026-12-01')).toBe('paid');
		const velha = bill({ dueDay: 10, paidThrough: '2026-05' });
		expect(billStatus(velha, '2026-07', '2026-11-11')).toBe('paid');
		expect(billStatus(velha, '2026-08', '2026-11-11')).toBe('late');
	});

	it('mês pago é paid, inclusive pago adiantado', () => {
		expect(billStatus(bill({ paidThrough: '2026-11' }), '2026-11', '2026-11-20')).toBe('paid');
		expect(billStatus(bill({ paidThrough: '2027-01' }), '2026-11', '2026-11-01')).toBe('paid');
		expect(billStatus(bill({ paidThrough: '2026-10' }), '2026-11', '2026-11-20')).toBe('late');
	});

	it('dia 31 em mês curto vence no último dia', () => {
		const conta = bill({ dueDay: 31 });
		expect(billStatus(conta, '2026-11', '2026-11-30')).toBe('due_today');
		expect(billStatus(conta, '2027-02', '2027-02-28')).toBe('due_today');
		expect(billStatus(conta, '2028-02', '2028-02-28')).toBe('upcoming');
		expect(billStatus(conta, '2028-02', '2028-02-29')).toBe('due_today');
	});

	it('mês futuro é upcoming', () => {
		expect(billStatus(bill({ dueDay: 1 }), '2026-12', '2026-11-30')).toBe('upcoming');
	});
});

/**
 * Lembrete da fatura do cartão (E2E-22): com o Nubank (vence 17/11) e o Inter (vence 12/11 e
 * 14/12) cadastrados, o aparelho só tinha os avisos da conta a pagar. A fatura avisa como a
 * conta: 3 dias antes do vencimento e no dia, às 09:00, com o que falta pagar dela.
 */
describe('cardReminders', () => {
	const NUBANK: CardSettings = {
		closingDay: 10,
		closingDaysBefore: 7,
		creditLimitCents: 500_000,
		openingBalanceCents: 0,
		openingBalanceDate: '2026-11-06',
	};

	const entry = (id: string, amountCents: number, date: string): CardEntry => ({
		id,
		amountCents,
		isIncome: false,
		date,
		note: id,
		category: 'shopping',
		installmentGroup: null,
		installmentIndex: null,
		installmentCount: null,
	});

	/** A fatura do achado: R$ 1.234,56 informados, R$ 100 de compra e a parcela 2/5 de R$ 300. */
	const NUBANK_ENTRIES = [
		entry('ajuste', 123_456, '2026-11-07'),
		entry('compra', 10_000, '2026-11-07'),
		entry('parcela', 30_000, '2026-11-07'),
	];

	const payment = (amountCents: number, date: string): CardMovement => ({ amountCents, date, inbound: true });

	const source = (
		settings: CardSettings,
		entries: CardEntry[],
		movements: CardMovement[],
		now: Date,
		cardId = 'nubank'
	): CardReminderSource => ({
		cardId,
		name: cardId,
		summary: buildCardSummary(settings, entries, movements, getISODate(now)),
	});

	/** "soon 2026-11-14 09:00 [2026-11] 163456", lido em hora local. */
	const lines = (sources: CardReminderSource[], now: Date): string[] =>
		cardReminders(sources, now).map(
			(reminder) =>
				`${reminder.cardId} ${reminder.kind} ${getISODate(reminder.at)} ${two(reminder.at.getHours())}:${two(reminder.at.getMinutes())} [${reminder.invoice}] ${reminder.amountCents}`
		);

	it('fatura a fechar: fecha 10/11, vence 17/11 — avisa em 14/11 e 17/11 às 09:00 com R$ 1.634,56', () => {
		const now = new Date(2026, 10, 7, 10, 0); // 07/11, dia do cadastro
		expect(lines([source(NUBANK, NUBANK_ENTRIES, [], now)], now)).toEqual([
			'nubank soon 2026-11-14 09:00 [2026-11] 163456',
			'nubank today 2026-11-17 09:00 [2026-11] 163456',
		]);
	});

	it('fatura fechada: depois do fechamento continua avisando o vencimento', () => {
		const now = new Date(2026, 10, 12, 10, 0);
		expect(lines([source(NUBANK, NUBANK_ENTRIES, [], now)], now)).toEqual([
			'nubank soon 2026-11-14 09:00 [2026-11] 163456',
			'nubank today 2026-11-17 09:00 [2026-11] 163456',
		]);
	});

	it('paga a fatura inteira (R$ 1.634,56), nenhum aviso — antes ou depois do fechamento', () => {
		const before = new Date(2026, 10, 7, 10, 0);
		expect(lines([source(NUBANK, NUBANK_ENTRIES, [payment(163_456, '2026-11-07')], before)], before)).toEqual([]);

		const after = new Date(2026, 10, 12, 10, 0);
		expect(lines([source(NUBANK, NUBANK_ENTRIES, [payment(163_456, '2026-11-12')], after)], after)).toEqual([]);
	});

	it('pagamento parcial: avisa o que falta', () => {
		const now = new Date(2026, 10, 12, 10, 0);
		expect(lines([source(NUBANK, NUBANK_ENTRIES, [payment(100_000, '2026-11-11')], now)], now)).toEqual([
			'nubank soon 2026-11-14 09:00 [2026-11] 63456',
			'nubank today 2026-11-17 09:00 [2026-11] 63456',
		]);
	});

	it('só os horários depois de agora: no dia 15 resta o do vencimento; depois dele, nada', () => {
		const on15 = new Date(2026, 10, 15, 10, 0);
		expect(lines([source(NUBANK, NUBANK_ENTRIES, [], on15)], on15)).toEqual([
			'nubank today 2026-11-17 09:00 [2026-11] 163456',
		]);
		const on18 = new Date(2026, 10, 18, 10, 0);
		expect(lines([source(NUBANK, NUBANK_ENTRIES, [], on18)], on18)).toEqual([]);
	});

	it('fechada a pagar e aberta a fechar, cada uma no seu vencimento (Inter: 12/11 e 14/12)', () => {
		const inter: CardSettings = { ...NUBANK, closingDay: 5, openingBalanceDate: '2026-10-31' };
		const entries = [entry('fechada', 200_000, '2026-11-01'), entry('aberta', 8_000, '2026-11-06')];
		const now = new Date(2026, 10, 7, 10, 0);
		expect(lines([source(inter, entries, [], now, 'inter')], now)).toEqual([
			'inter soon 2026-11-09 09:00 [2026-11] 200000',
			'inter today 2026-11-12 09:00 [2026-11] 200000',
			// Vence 12/12, um sábado: vai para segunda, 14/12; o aviso de 3 dias antes é 11/12.
			'inter soon 2026-12-11 09:00 [2026-12] 8000',
			'inter today 2026-12-14 09:00 [2026-12] 8000',
		]);
	});

	it('vários cartões, em ordem de horário', () => {
		const inter: CardSettings = { ...NUBANK, closingDay: 5, openingBalanceDate: '2026-10-31' };
		const now = new Date(2026, 10, 7, 10, 0);
		const sources = [
			source(NUBANK, NUBANK_ENTRIES, [], now),
			source(inter, [entry('fechada', 200_000, '2026-11-01')], [], now, 'inter'),
		];
		expect(lines(sources, now)).toEqual([
			'inter soon 2026-11-09 09:00 [2026-11] 200000',
			'inter today 2026-11-12 09:00 [2026-11] 200000',
			'nubank soon 2026-11-14 09:00 [2026-11] 163456',
			'nubank today 2026-11-17 09:00 [2026-11] 163456',
		]);
	});

	it('sem dia de fechamento o app não sabe o vencimento: não avisa', () => {
		const now = new Date(2026, 10, 7, 10, 0);
		const loose: CardSettings = { ...NUBANK, closingDay: null };
		expect(lines([source(loose, NUBANK_ENTRIES, [], now)], now)).toEqual([]);
	});

	it('fatura zerada ou de crédito não avisa', () => {
		const now = new Date(2026, 10, 7, 10, 0);
		expect(lines([source(NUBANK, [], [], now)], now)).toEqual([]);
		const refund = { ...entry('estorno', 5_000, '2026-11-07'), isIncome: true };
		expect(lines([source(NUBANK, [refund], [], now)], now)).toEqual([]);
	});

	describe('pagamento de antes da fatura informada (E2E-41): o mesmo "falta pagar" da tela', () => {
		// Cadastro de 07/11 com R$ 1.234,56: âncora no fim de 06/11. Mercado R$ 100 e parcela 2/5 de R$ 300 em 07/11.
		const informed: CardSettings = { ...NUBANK, openingBalanceCents: -123_456 };
		const purchases = [entry('mercado', 10_000, '2026-11-07'), entry('notebook 2/5', 30_000, '2026-11-07')];

		it('o "Pagamento recebido" de 05/11 já está no valor informado: avisa R$ 1.634,56, não R$ 400', () => {
			const now = new Date(2026, 10, 7, 10, 0);
			expect(lines([source(informed, purchases, [payment(123_456, '2026-11-05')], now)], now)).toEqual([
				'nubank soon 2026-11-14 09:00 [2026-11] 163456',
				'nubank today 2026-11-17 09:00 [2026-11] 163456',
			]);
		});

		it('pagamento de R$ 1.000 em 08/11 abate: avisa R$ 634,56', () => {
			const now = new Date(2026, 10, 8, 10, 0);
			expect(
				lines([source(informed, purchases, [payment(123_456, '2026-11-05'), payment(100_000, '2026-11-08')], now)], now)
			).toEqual(['nubank soon 2026-11-14 09:00 [2026-11] 63456', 'nubank today 2026-11-17 09:00 [2026-11] 63456']);
		});
	});
});
