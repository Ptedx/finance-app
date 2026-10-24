/**
 * Lembretes das contas a pagar: quando avisar, sem tocar em notificação nenhuma.
 *
 * Cada vencimento ainda não pago ganha cinco avisos, sempre às 09:00 locais: três dias
 * antes ('soon'), no dia ('today') e nos três dias seguintes ('late'). O dia do
 * vencimento segue a regra da conta: dia 31 em mês de 30, e 29/30/31 em fevereiro, caem no
 * último dia do mês.
 *
 * O agendamento no aparelho fica em `notificationUtils.scheduleBillReminders`; aqui é só a
 * conta, para dar para testar em qualquer fuso.
 */

import type { Bill } from '../database/schema';
import {
	addDays,
	buildClampedDate,
	getISODate,
	monthKeyOf,
	parseISODate,
	shiftMonthKey,
} from './dateUtils';

export type BillReminderKind = 'soon' | 'today' | 'late';

export type BillStatus = 'paid' | 'upcoming' | 'due_today' | 'late';

export interface BillReminder {
	billId: string;
	kind: BillReminderKind;
	/** Instante do aviso: 09:00 locais do dia do aviso. */
	at: Date;
	/** Mês do vencimento a que o aviso se refere, `YYYY-MM`. */
	month: string;
	/** Data do vencimento, `YYYY-MM-DD` (já com o dia ajustado ao fim do mês). */
	dueDate: string;
	/**
	 * Distância em dias até o vencimento: 3 no 'soon', 0 no 'today', 1–3 no 'late'. Junto
	 * com o mês e o tipo, deixa o identificador do aviso estável entre reagendamentos.
	 */
	n: number;
}

/** Quantos dias à frente de `now` a lista cobre. */
export const BILL_REMINDER_HORIZON_DAYS = 45;

/** Hora local de todos os avisos. */
export const BILL_REMINDER_HOUR = 9;

/** Desvio em dias a partir do vencimento, na ordem em que os avisos chegam. */
const OFFSETS: { kind: BillReminderKind; offset: number }[] = [
	{ kind: 'soon', offset: -3 },
	{ kind: 'today', offset: 0 },
	{ kind: 'late', offset: 1 },
	{ kind: 'late', offset: 2 },
	{ kind: 'late', offset: 3 },
];

/** Vencimento de uma conta num mês `YYYY-MM`, com o dia preso ao fim do mês. */
export const billDueDate = (bill: Pick<Bill, 'dueDay'>, month: string): string => {
	const [year, monthNumber] = month.split('-').map(Number);
	return buildClampedDate(year, monthNumber, bill.dueDay);
};

/** O mês já está pago quando `paidThrough` chega nele (chaves `YYYY-MM` comparam como texto). */
const isMonthPaid = (bill: Pick<Bill, 'paidThrough'>, month: string): boolean =>
	bill.paidThrough !== null && bill.paidThrough !== undefined && bill.paidThrough >= month;

/** Conta que pode avisar: ativa e não apagada. */
const isLive = (bill: Bill): boolean => bill.active && !bill.deletedAt;

const atReminderHour = (isoDate: string): Date => {
	const date = parseISODate(isoDate);
	date.setHours(BILL_REMINDER_HOUR, 0, 0, 0);
	return date;
};

/**
 * Lembretes dos próximos 45 dias, em ordem de horário.
 *
 * Só entram horários depois de `now`. Um vencimento que já passou sem ser pago ainda gera
 * os avisos de atraso que faltam (até D+3); conta inativa, apagada ou com o mês pago não
 * gera nada daquele mês.
 */
export const billReminders = (bills: Bill[], now: Date): BillReminder[] => {
	const horizon = new Date(now);
	horizon.setDate(horizon.getDate() + BILL_REMINDER_HORIZON_DAYS);

	// Do mês anterior (atrasos de um vencimento de até 3 dias atrás) até dois à frente
	// (um 'soon' 45 dias adiante pode ser de vencimento do mês seguinte ao seguinte).
	const currentMonth = monthKeyOf(getISODate(now));
	const months = [-1, 0, 1, 2].map((delta) => shiftMonthKey(currentMonth, delta));

	const reminders: BillReminder[] = [];

	for (const bill of bills) {
		if (!isLive(bill)) continue;

		for (const month of months) {
			if (isMonthPaid(bill, month)) continue;

			const dueDate = billDueDate(bill, month);

			for (const { kind, offset } of OFFSETS) {
				const at = atReminderHour(addDays(dueDate, offset));
				if (at <= now || at > horizon) continue;

				reminders.push({ billId: bill.id, kind, at, month, dueDate, n: Math.abs(offset) });
			}
		}
	}

	return reminders.sort((a, b) => a.at.getTime() - b.at.getTime());
};

/**
 * Situação de uma conta num mês `YYYY-MM`, vista do dia `today` (`YYYY-MM-DD`, data local
 * do calendário, como `todayISO()`).
 */
export const billStatus = (bill: Bill, month: string, today: string): BillStatus => {
	if (isMonthPaid(bill, month)) return 'paid';

	const dueDate = billDueDate(bill, month);
	const day = today.slice(0, 10);
	if (day < dueDate) return 'upcoming';
	if (day === dueDate) return 'due_today';
	return 'late';
};
