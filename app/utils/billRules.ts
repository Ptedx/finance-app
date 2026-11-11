/**
 * Regras das contas a pagar que a tela, a Home e os contextos dividem — sem banco e sem
 * React, para dar para testar.
 *
 * - **Conta nova** nasce com o mês anterior pago (`paidThrough`): quem cadastra o plano de
 *   saúde hoje quer o aviso do próximo vencimento, não um "atrasado" de meses que nunca
 *   viveram no app. Se o vencimento deste mês já passou, a tela pergunta se este mês já
 *   está pago (o padrão é sim).
 * - **Conta de dívida** (`debtId`): nome, dia, valor e conta seguem a dívida —
 *   `ensureDebtBills` os regrava a cada carga —, então a tela não os edita e, enquanto a
 *   dívida estiver viva, a conta não se desliga nem se apaga. Quitada ou apagada a dívida,
 *   o app a desativa; aí ela pode ser apagada, mas não religada (a dívida a desligaria de
 *   novo).
 * - **Contas do mês**: o status de cada ativa no mês corrente e o total que ainda falta
 *   pagar. A de valor variável ("varia") fica fora do total e é contada à parte, para a
 *   Home dizer que o total não é tudo. Contas a pagar mostra também outros meses
 *   (`billsOfMonth`) e filtra por situação (`filterMonthRows`).
 * - **Tela inicial** (SPD-142): só as atrasadas e as que vencem nos próximos 7 dias, no
 *   máximo 3 (`homeBills`).
 */

import type { Bill, BillDraft } from '../database/schema';
import { type BillStatus, billDueDate, billStatus } from './billReminders';
import { addDays, monthKeyOf, shiftMonthKey } from './dateUtils';

/** O que a tela de cadastro edita. */
export interface BillInput {
	name: string;
	dueDay: number;
	/** `null` = varia. */
	amountCents: number | null;
	accountId: string | null;
	category: string | null;
	matchHint: string | null;
}

/** O mês pago e a baixa, o par que "Já paguei" e desfazer trocam. */
export interface PaidState {
	paidThrough: string | null;
	paidByRef: string | null;
}

export const isValidDueDay = (day: number): boolean =>
	Number.isInteger(day) && day >= 1 && day <= 31;

/** O vencimento deste mês (com o dia preso ao fim do mês) já passou? No próprio dia, não. */
export const dueDatePassed = (dueDay: number, today: string): boolean =>
	billDueDate({ dueDay }, monthKeyOf(today)) < today.slice(0, 10);

/** Mês pago de partida: o anterior, ou o atual quando este mês já está pago. */
export const initialPaidThrough = (today: string, currentMonthPaid: boolean): string => {
	const month = monthKeyOf(today);
	return currentMonthPaid ? month : shiftMonthKey(month, -1);
};

/**
 * Conta de dívida que `ensureDebtBills` acabou de criar: nunca recebeu baixa (nem mês
 * pago, nem lançamento). Ganha o mês de partida pelo padrão da pergunta ("já está pago"
 * quando o vencimento deste mês já passou).
 */
export const needsInitialPaidThrough = (bill: Bill): boolean =>
	bill.debtId !== null && bill.paidThrough === null && bill.paidByRef === null;

/** Ligada a dívida viva: o app a mantém ativa enquanto a dívida existir e não estiver quitada. */
export const isLockedByDebt = (bill: Pick<Bill, 'debtId' | 'active'>): boolean =>
	bill.debtId !== null && bill.active;

export const canDeleteBill = (bill: Pick<Bill, 'debtId' | 'active'>): boolean =>
	!isLockedByDebt(bill);

/** Só a cadastrada à mão liga e desliga; a de dívida segue a dívida. */
export const canToggleActive = (bill: Pick<Bill, 'debtId'>): boolean => bill.debtId === null;

/** Os campos gravados de uma conta, para regravar só o que muda. */
export const billDraftOf = (bill: Bill): BillDraft => ({
	name: bill.name,
	dueDay: bill.dueDay,
	amountCents: bill.amountCents,
	accountId: bill.accountId,
	category: bill.category,
	matchHint: bill.matchHint,
	debtId: bill.debtId,
	paidThrough: bill.paidThrough,
	paidByRef: bill.paidByRef,
	active: bill.active,
	sortOrder: bill.sortOrder,
});

const cleanHint = (hint: string | null): string | null => {
	const trimmed = hint?.trim() ?? '';
	return trimmed === '' ? null : trimmed;
};

export const newBillDraft = (
	input: BillInput,
	today: string,
	currentMonthPaid: boolean,
	sortOrder: number
): BillDraft => ({
	name: input.name.trim(),
	dueDay: input.dueDay,
	amountCents: input.amountCents,
	accountId: input.accountId,
	category: input.category,
	matchHint: cleanHint(input.matchHint),
	debtId: null,
	paidThrough: initialPaidThrough(today, currentMonthPaid),
	paidByRef: null,
	active: true,
	sortOrder,
});

/**
 * A edição de uma conta já gravada. Na de dívida, nome, dia, valor e conta continuam os
 * da dívida, digite-se o que for; o mês pago e a baixa nunca mudam por aqui.
 */
export const editedBillDraft = (bill: Bill, input: BillInput): BillDraft => {
	const base = billDraftOf(bill);
	const fromDebt = bill.debtId !== null;
	return {
		...base,
		name: fromDebt ? bill.name : input.name.trim(),
		dueDay: fromDebt ? bill.dueDay : input.dueDay,
		amountCents: fromDebt ? bill.amountCents : input.amountCents,
		accountId: fromDebt ? bill.accountId : input.accountId,
		category: input.category,
		matchHint: cleanHint(input.matchHint),
	};
};

/** "Já paguei": pago até o mês atual. Um mês pago já adiante fica; a baixa não muda. */
export const markedPaid = (bill: Bill, month: string): PaidState => ({
	paidThrough: bill.paidThrough !== null && bill.paidThrough > month ? bill.paidThrough : month,
	paidByRef: bill.paidByRef,
});

/**
 * Desfazer o "Já paguei": volta ao estado de antes quando a tela o guardou; senão (o app
 * reabriu), deixa o mês atual em aberto. A baixa fica: se veio de um lançamento, é ela que
 * impede o mesmo lançamento de casar de novo.
 */
export const undonePaid = (bill: Bill, month: string, previous?: PaidState): PaidState => {
	if (previous) return previous;
	return {
		paidThrough:
			bill.paidThrough !== null && bill.paidThrough >= month
				? shiftMonthKey(month, -1)
				: bill.paidThrough,
		paidByRef: bill.paidByRef,
	};
};

export interface MonthBillRow {
	bill: Bill;
	status: BillStatus;
	/** Vencimento no mês, `YYYY-MM-DD`, já com o dia preso ao fim do mês. */
	dueDate: string;
}

export interface MonthBills {
	month: string;
	/** As ativas, em ordem de vencimento. */
	rows: MonthBillRow[];
	/** Soma das não pagas com valor. */
	dueCents: number;
	/** Não pagas de valor variável: fora do total. */
	variableCount: number;
	lateCount: number;
}

const isLiveActive = (bill: Bill): boolean => bill.active && !bill.deletedAt;

const monthRow = (bill: Bill, month: string, today: string): MonthBillRow => ({
	bill,
	status: billStatus(bill, month, today),
	dueDate: billDueDate(bill, month),
});

const byDueDate = (a: MonthBillRow, b: MonthBillRow): number =>
	a.dueDate.localeCompare(b.dueDate) || a.bill.name.localeCompare(b.bill.name);

/** As contas ativas no mês de `today`, com status, e o que ainda falta pagar nele. */
export const monthBills = (bills: Bill[], today: string): MonthBills =>
	billsOfMonth(bills, monthKeyOf(today), today);

/**
 * As contas ativas num mês `YYYY-MM` qualquer, com o status visto de `today`, e o que falta
 * pagar nele — a troca de mês de Contas a pagar. Mês passado não pago está atrasado; o
 * seguinte, a vencer (salvo pago adiante). Como `paidThrough` é "pago até", os meses de antes
 * do mês pago de partida de uma conta aparecem pagos.
 */
export const billsOfMonth = (bills: Bill[], month: string, today: string): MonthBills => {
	const rows = bills
		.filter(isLiveActive)
		.map((bill) => monthRow(bill, month, today))
		.sort(byDueDate);

	let dueCents = 0;
	let variableCount = 0;
	let lateCount = 0;
	for (const row of rows) {
		if (row.status === 'paid') continue;
		if (row.status === 'late') lateCount += 1;
		if (row.bill.amountCents === null) variableCount += 1;
		else dueCents += row.bill.amountCents;
	}

	return { month, rows, dueCents, variableCount, lateCount };
};

/** O filtro de Contas a pagar. "A vencer" inclui a que vence hoje. */
export type BillFilter = 'all' | 'upcoming' | 'late' | 'paid';

const FILTER_STATUSES: Record<Exclude<BillFilter, 'all'>, BillStatus[]> = {
	upcoming: ['upcoming', 'due_today'],
	late: ['late'],
	paid: ['paid'],
};

export const filterMonthRows = (rows: MonthBillRow[], filter: BillFilter): MonthBillRow[] =>
	filter === 'all' ? rows : rows.filter((row) => FILTER_STATUSES[filter].includes(row.status));

/** Quantos dias à frente de hoje (hoje incluído) a tela inicial mostra. */
export const HOME_BILLS_DAYS_AHEAD = 7;

/** Quantas contas cabem na tela inicial; o resto vira "e mais N". */
export const HOME_BILLS_MAX_ROWS = 3;

export interface HomeBills {
	/** No máximo `HOME_BILLS_MAX_ROWS`: atrasadas primeiro, depois por vencimento. */
	rows: MonthBillRow[];
	/** As que pediam atenção e não couberam. */
	moreCount: number;
}

/**
 * O que a tela inicial mostra: as atrasadas e as que vencem de hoje a 7 dias, no máximo 3.
 *
 * Cada conta entra uma vez, pelo vencimento em aberto mais próximo: o deste mês, ou — já pago
 * este mês, perto da virada — o do mês seguinte (hoje 28/11, a do dia 3 vence em 3/12). Paga
 * no mês e sem vencimento perto, fica fora. "Atrasada" é a do mês corrente, como em
 * `monthBills`.
 */
export const homeBills = (bills: Bill[], today: string): HomeBills => {
	const day = today.slice(0, 10);
	const month = monthKeyOf(day);
	const limit = addDays(day, HOME_BILLS_DAYS_AHEAD);
	const next = shiftMonthKey(month, 1);

	const due: MonthBillRow[] = [];
	for (const bill of bills.filter(isLiveActive)) {
		const current = monthRow(bill, month, day);
		const row = current.status === 'paid' ? monthRow(bill, next, day) : current;
		if (row.status === 'paid') continue;
		if (row.status === 'late' || row.dueDate <= limit) due.push(row);
	}

	const sorted = [
		...due.filter((row) => row.status === 'late').sort(byDueDate),
		...due.filter((row) => row.status !== 'late').sort(byDueDate),
	];
	return {
		rows: sorted.slice(0, HOME_BILLS_MAX_ROWS),
		moreCount: Math.max(0, sorted.length - HOME_BILLS_MAX_ROWS),
	};
};
