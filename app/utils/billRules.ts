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
 * - **Mês atrasado** (SPD-145): a conta guarda só "pago até" (`paidThrough`), então "Já
 *   paguei" e desfazer andam um mês por vez, sempre pelo mês mais antigo em aberto
 *   (`firstOpenMonth`, até 3 meses para trás): com outubro em aberto, "Já paguei" em novembro
 *   quita outubro. O atraso de meses anteriores aparece à parte (`overdueBills`, "Em
 *   atraso"), fora de "Falta pagar este mês" e do custo fixo.
 * - **Mês pulado e fora de ordem** (SPD-146): "Não vou pagar este mês" e o pagamento de um mês
 *   com outro mais antigo em aberto viram registro (`bill_payments`); toda baixa também grava
 *   o seu. `paidThrough` continua sendo o trecho contínuo pago e anda por cima dos meses com
 *   registro quando o trecho chega neles (`settleMonth`). Um `paidThrough` vindo de um app
 *   antigo é piso: o que está antes dele conta como pago, e os registros continuam valendo.
 */

import type {
	Bill,
	BillDraft,
	BillPayment,
	BillPaymentDraft,
	BillPaymentStatus,
} from '../database/schema';
import { billPaymentDraft, paymentFor } from './billPayments';
import {
	type BillStatus,
	billDueDate,
	billStatus,
	firstOpenMonth,
	firstUnsettledMonth,
} from './billReminders';
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

/**
 * O mês que o "Já paguei" quita, visto do mês `current`: o mais antigo em aberto
 * (`firstOpenMonth`), pulando os que já têm registro (`firstUnsettledMonth`). `null` quando
 * tudo até o mês atual está pago — o "Já paguei" não paga mês adiante.
 */
export const payableMonth = (
	bill: Pick<Bill, 'id' | 'paidThrough'>,
	current: string,
	payments: readonly BillPayment[] = []
): string | null => {
	const month = firstUnsettledMonth(bill, current, payments);
	return month <= current ? month : null;
};

/**
 * O mês `month` está em aberto e pode ser quitado ou pulado agora (SPD-146): até o mês
 * `current`, não antes do mais antigo em aberto (`firstOpenMonth`) e sem registro.
 */
export const isOpenMonth = (
	bill: Pick<Bill, 'id' | 'paidThrough'>,
	month: string,
	current: string,
	payments: readonly BillPayment[] = []
): boolean =>
	month <= current &&
	month >= firstOpenMonth(bill, current) &&
	!paymentFor(payments, bill.id, month);

/** Leva `paidThrough` adiante enquanto o mês seguinte tiver registro. */
const advanceOverRecords = (
	billId: string,
	paidThrough: string,
	payments: readonly Pick<BillPayment, 'billId' | 'month' | 'deletedAt'>[]
): string => {
	let month = paidThrough;
	while (paymentFor(payments, billId, shiftMonthKey(month, 1))) month = shiftMonthKey(month, 1);
	return month;
};

/** O que um mês quitado ou pulado grava: o novo `paidThrough` e o registro do mês. */
export interface SettledMonth {
	paidThrough: string | null;
	record: BillPaymentDraft;
}

/**
 * Quita (`paid`) ou pula (`skipped`) o mês `month` de uma conta, visto do mês `current`.
 *
 * Toda vez grava o registro do mês. Se `month` é o mais antigo em aberto (ou anterior), o
 * trecho contínuo anda: `paidThrough` vai a ele e segue por cima dos meses seguintes que já
 * têm registro — pagar outubro com novembro pago fora de ordem leva `paidThrough` a novembro.
 * Se há um mês mais antigo em aberto, é fora de ordem: só o registro, `paidThrough` fica.
 *
 * O pulado não leva lançamento nem valor.
 */
export const settleMonth = (
	bill: Pick<Bill, 'id' | 'paidThrough'>,
	payments: readonly BillPayment[],
	month: string,
	current: string,
	entry: { status: BillPaymentStatus; transactionId?: string | null; amountCents?: number | null }
): SettledMonth => {
	const record = billPaymentDraft(
		bill.id,
		month,
		entry.status,
		entry.transactionId ?? null,
		entry.amountCents ?? null
	);
	const contiguous =
		bill.paidThrough === null ||
		bill.paidThrough === undefined ||
		month <= firstUnsettledMonth(bill, current, payments);
	if (!contiguous) return { paidThrough: bill.paidThrough, record };

	const start = bill.paidThrough && bill.paidThrough > month ? bill.paidThrough : month;
	const others = payments.filter((payment) => payment.id !== record.id);
	return { paidThrough: advanceOverRecords(bill.id, start, [...others, record]), record };
};

/** O que desfazer um mês faz: o novo `paidThrough`, o registro que sai e os que entram. */
export interface UndoneMonth {
	paidThrough: string | null;
	/** O registro do mês, que vira lápide; `null` quando o mês não tinha (a regra da fase 1). */
	remove: BillPayment | null;
	/**
	 * Meses depois do reaberto que estavam pagos só por `paidThrough` (sem registro): ganham o
	 * registro de pago, sem lançamento, para continuarem pagos quando `paidThrough` voltar.
	 */
	fill: BillPaymentDraft[];
}

/**
 * Desfazer o mês `month`: ele volta a ficar em aberto, e só ele.
 *
 * Com registro, sai o registro. Se o mês está dentro do trecho contínuo, `paidThrough` volta
 * para antes dele — ao estado de antes (`previous`) quando a tela o guardou e ele é anterior
 * —, e os meses entre ele e o antigo `paidThrough` sem registro ganham um, para não reabrirem
 * junto. Sem registro, só o último mês pago (`paidThrough`) desfaz, como na fase 1. `null`
 * quando não há o que desfazer.
 */
export const undoMonth = (
	bill: Pick<Bill, 'id' | 'paidThrough'>,
	payments: readonly BillPayment[],
	month: string,
	previous?: Pick<PaidState, 'paidThrough'>
): UndoneMonth | null => {
	const remove = paymentFor(payments, bill.id, month) ?? null;
	const paidThrough = bill.paidThrough ?? null;
	if (!remove && paidThrough !== month) return null;
	if (paidThrough === null || month > paidThrough) return { paidThrough, remove, fill: [] };

	const restored =
		previous && (previous.paidThrough === null || previous.paidThrough < month)
			? previous.paidThrough
			: shiftMonthKey(month, -1);

	const fill: BillPaymentDraft[] = [];
	for (let next = shiftMonthKey(month, 1); next <= paidThrough; next = shiftMonthKey(next, 1)) {
		if (!paymentFor(payments, bill.id, next)) fill.push(billPaymentDraft(bill.id, next, 'paid'));
	}
	return { paidThrough: restored, remove, fill };
};

/**
 * "Já paguei": quita o mês mais antigo em aberto (`payableMonth`) — um só, nunca pulando um
 * mês em aberto. Com tudo pago até o mês atual, nada muda. A baixa não muda.
 */
export const markedPaid = (bill: Bill, current: string): PaidState => ({
	paidThrough: payableMonth(bill, current) ?? bill.paidThrough,
	paidByRef: bill.paidByRef,
});

/**
 * "Desfazer" reabre o mês que tem registro (SPD-146) ou, sem registro, só o último mês pago:
 * reabrir um do meio sem registro deixaria um buraco que "pago até" não guarda.
 */
export const canUndoMonth = (
	bill: Pick<Bill, 'id' | 'paidThrough'>,
	month: string,
	payments: readonly BillPayment[] = []
): boolean =>
	paymentFor(payments, bill.id, month) !== undefined ||
	(bill.paidThrough !== null && bill.paidThrough !== undefined && bill.paidThrough === month);

/**
 * Desfazer o "Já paguei" de `month`, que tem de ser o último mês pago: volta ao estado de
 * antes quando a tela o guardou; senão (o app reabriu), `month` volta para em aberto e só ele.
 * Outro mês não muda nada — reabrir o mês atual de quem está pago só até setembro deixaria
 * outubro pago sem pagamento. A baixa fica: se veio de um lançamento, é ela que impede o
 * mesmo lançamento de casar de novo.
 */
export const undonePaid = (bill: Bill, month: string, previous?: PaidState): PaidState => {
	if (previous) return previous;
	return {
		paidThrough: canUndoMonth(bill, month) ? shiftMonthKey(month, -1) : bill.paidThrough,
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

const monthRow = (
	bill: Bill,
	month: string,
	today: string,
	payments: readonly BillPayment[] = []
): MonthBillRow => ({
	bill,
	status: billStatus(bill, month, today, payments),
	dueDate: billDueDate(bill, month),
});

/** Pago ou pulado: nada a pagar no mês. */
const isSettled = (status: BillStatus): boolean => status === 'paid' || status === 'skipped';

const byDueDate = (a: MonthBillRow, b: MonthBillRow): number =>
	a.dueDate.localeCompare(b.dueDate) || a.bill.name.localeCompare(b.bill.name);

/** As contas ativas no mês de `today`, com status, e o que ainda falta pagar nele. */
export const monthBills = (
	bills: Bill[],
	today: string,
	payments: readonly BillPayment[] = []
): MonthBills => billsOfMonth(bills, monthKeyOf(today), today, payments);

/**
 * As contas ativas num mês `YYYY-MM` qualquer, com o status visto de `today`, e o que falta
 * pagar nele — a troca de mês de Contas a pagar. Mês passado não pago está atrasado; o
 * seguinte, a vencer (salvo pago adiante). Como `paidThrough` é "pago até", os meses de antes
 * do mês pago de partida de uma conta aparecem pagos, e também os de mais de 3 meses atrás
 * (`firstOpenMonth`). O mês pulado ou pago fora de ordem (`payments`, SPD-146) não entra no
 * que falta pagar.
 */
export const billsOfMonth = (
	bills: Bill[],
	month: string,
	today: string,
	payments: readonly BillPayment[] = []
): MonthBills => {
	const rows = bills
		.filter(isLiveActive)
		.map((bill) => monthRow(bill, month, today, payments))
		.sort(byDueDate);

	let dueCents = 0;
	let variableCount = 0;
	let lateCount = 0;
	for (const row of rows) {
		if (isSettled(row.status)) continue;
		if (row.status === 'late') lateCount += 1;
		if (row.bill.amountCents === null) variableCount += 1;
		else dueCents += row.bill.amountCents;
	}

	return { month, rows, dueCents, variableCount, lateCount };
};

/** O atraso de meses anteriores ao corrente, à parte do mês (SPD-145). */
export interface OverdueBills {
	/** Soma dos meses em aberto antes do corrente, das contas com valor: dois meses contam duas vezes. */
	cents: number;
	/** Contas com algum mês anterior em aberto. */
	billCount: number;
	/** Delas, as de valor variável: contadas, fora da soma. */
	variableCount: number;
	/** O mês em aberto mais antigo entre elas, `YYYY-MM`; `null` sem atraso. */
	oldestMonth: string | null;
}

/**
 * O que está em atraso de meses anteriores a `current` (`YYYY-MM`): de cada conta ativa, os
 * meses do mais antigo em aberto (no máximo 3 para trás) até o anterior ao corrente.
 *
 * Fica fora de "Falta pagar este mês" (`monthBills`) e do custo fixo, que são o compromisso
 * de um mês: somar o atraso neles contaria a mesma conta duas vezes.
 *
 * Mês com registro (`payments`, SPD-146) — pulado ou pago fora de ordem — não é atraso.
 */
export const overdueBills = (
	bills: Bill[],
	current: string,
	payments: readonly BillPayment[] = []
): OverdueBills => {
	let cents = 0;
	let billCount = 0;
	let variableCount = 0;
	let oldestMonth: string | null = null;

	for (const bill of bills.filter(isLiveActive)) {
		const open: string[] = [];
		for (
			let month = firstOpenMonth(bill, current);
			month < current;
			month = shiftMonthKey(month, 1)
		) {
			if (!paymentFor(payments, bill.id, month)) open.push(month);
		}
		if (open.length === 0) continue;
		billCount += 1;
		if (oldestMonth === null || open[0] < oldestMonth) oldestMonth = open[0];
		if (bill.amountCents === null) {
			variableCount += 1;
			continue;
		}
		cents += bill.amountCents * open.length;
	}

	return { cents, billCount, variableCount, oldestMonth };
};

/** O filtro de Contas a pagar. "A vencer" inclui a que vence hoje; o mês pulado só aparece em "Todas". */
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
 * Cada conta entra uma vez, pelo vencimento em aberto mais antigo: o de um mês passado ainda
 * em aberto (SPD-145: atrasada, com a data dele — outubro em novembro), o deste mês, ou — já
 * pago este mês, perto da virada — o do mês seguinte (hoje 28/11, a do dia 3 vence em 3/12).
 * Paga no mês e sem vencimento perto, fica fora. Os meses com registro (`payments`, SPD-146)
 * — pulados ou pagos fora de ordem — não contam como em aberto.
 */
export const homeBills = (
	bills: Bill[],
	today: string,
	payments: readonly BillPayment[] = []
): HomeBills => {
	const day = today.slice(0, 10);
	const month = monthKeyOf(day);
	const limit = addDays(day, HOME_BILLS_DAYS_AHEAD);
	const next = shiftMonthKey(month, 1);

	const due: MonthBillRow[] = [];
	for (const bill of bills.filter(isLiveActive)) {
		const first = firstUnsettledMonth(bill, month, payments);
		if (first < month) {
			due.push(monthRow(bill, first, day, payments));
			continue;
		}
		const current = monthRow(bill, month, day, payments);
		const row = isSettled(current.status) ? monthRow(bill, next, day, payments) : current;
		if (isSettled(row.status)) continue;
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
