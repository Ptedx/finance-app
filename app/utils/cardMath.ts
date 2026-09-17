/**
 * Cartão de crédito: ciclo, faturas, limite e parcelas. Puro e testado.
 *
 * Cartão não tem saldo. Tem **limite**, uma **fatura aberta** que ainda recebe compras,
 * uma **fatura fechada** que espera pagamento e **parcelas futuras** que já ocupam o
 * limite mas ainda não caíram em fatura nenhuma. Este módulo transforma os lançamentos
 * do cartão nessas quatro coisas.
 *
 * ## Ciclo
 *
 * "Fecha dia 10" significa que a fatura fecha no começo do dia 10: compras do dia 10 em
 * diante vão para a próxima. O dia de fechamento é, por isso, o **melhor dia de compra**.
 * A fatura que fecha em 10/out cobre de 10/set a 09/out e vence no primeiro "dia de
 * vencimento" depois do fechamento. Ciclos são contíguos e cada dia pertence a
 * exatamente um — o teste por propriedades garante.
 *
 * ## De onde vem o dinheiro devido
 *
 * Mesma âncora das contas (`openingBalanceCents` no fim de `openingBalanceDate`): o que
 * o usuário informou como "fatura atual" vira um lançamento único naquele dia, e os
 * lançamentos até a âncora já estão dentro dele. Compra soma, estorno subtrai, pagamento
 * (transferência para o cartão) subtrai do devido. Assim o valor devido, a fatura aberta
 * e a fechada sempre fecham entre si.
 */

import { addDays, addMonthsClamped, buildClampedDate, parseISODate } from './dateUtils';

export interface InvoiceCycle {
	/** `YYYY-MM` do mês em que a fatura fecha. Identifica a fatura. */
	key: string;
	/** Primeiro dia com compras nesta fatura (o fechamento anterior). */
	start: string;
	/** Último dia com compras nesta fatura (véspera do fechamento). */
	end: string;
	closingDate: string;
	dueDate: string;
}

export interface CardSettings {
	closingDay: number | null;
	dueDay: number | null;
	creditLimitCents: number | null;
	openingBalanceCents: number;
	openingBalanceDate: string;
}

export interface CardEntry {
	id: string;
	amountCents: number;
	/** Estorno ou crédito no cartão. */
	isIncome: boolean;
	date: string;
	note: string;
	category: string;
	installmentGroup: string | null;
	installmentIndex: number | null;
	installmentCount: number | null;
}

export interface CardMovement {
	amountCents: number;
	date: string;
	/** Verdadeiro quando o dinheiro entra no cartão: um pagamento de fatura. */
	inbound: boolean;
}

// ---------------------------------------------------------------------------
// Datas
// ---------------------------------------------------------------------------

const pad = (value: number): string => String(value).padStart(2, '0');

const shiftYearMonth = (year: number, month: number, delta: number): [number, number] => {
	const total = year * 12 + (month - 1) + delta;
	return [Math.floor(total / 12), (total % 12) + 1];
};

const dayNumber = (date: string): number => {
	const [year, month, day] = date.split('-').map(Number);
	return Math.round(Date.UTC(year, month - 1, day) / 86_400_000);
};

/** Dias de `from` até `to`; negativo quando `to` já passou. */
export const daysBetween = (from: string, to: string): number => dayNumber(to) - dayNumber(from);

/** A fatura que fecha no mês `year`/`month`. Sempre derivada do dia preferido, nunca de uma data já presa. */
export const cycleClosingIn = (year: number, month: number, closingDay: number, dueDay: number | null): InvoiceCycle => {
	const closingDate = buildClampedDate(year, month, closingDay);
	const [py, pm] = shiftYearMonth(year, month, -1);
	const start = buildClampedDate(py, pm, closingDay);

	const due = dueDay ?? closingDay;
	let dueDate = buildClampedDate(year, month, due);
	if (dueDate <= closingDate) {
		const [ny, nm] = shiftYearMonth(year, month, 1);
		dueDate = buildClampedDate(ny, nm, due);
	}

	return { key: `${year}-${pad(month)}`, start, end: addDays(closingDate, -1), closingDate, dueDate };
};

/** A fatura em que uma compra feita em `date` entra. */
export const cycleFor = (date: string, closingDay: number, dueDay: number | null): InvoiceCycle => {
	const parsed = parseISODate(date);
	const year = parsed.getFullYear();
	const month = parsed.getMonth() + 1;
	if (date < buildClampedDate(year, month, closingDay)) return cycleClosingIn(year, month, closingDay, dueDay);
	const [ny, nm] = shiftYearMonth(year, month, 1);
	return cycleClosingIn(ny, nm, closingDay, dueDay);
};

/** A fatura `offset` ciclos depois (ou antes, se negativo) de `cycle`. */
export const shiftCycle = (cycle: InvoiceCycle, offset: number, closingDay: number, dueDay: number | null): InvoiceCycle => {
	const [year, month] = cycle.key.split('-').map(Number);
	const [ty, tm] = shiftYearMonth(year, month, offset);
	return cycleClosingIn(ty, tm, closingDay, dueDay);
};

// ---------------------------------------------------------------------------
// Valores
// ---------------------------------------------------------------------------

const signed = (entry: CardEntry): number => (entry.isIncome ? -entry.amountCents : entry.amountCents);

/**
 * Quanto o cartão deve no fim de `asOf`: a âncora mais compras, menos estornos e
 * pagamentos, contando só o que é datado depois da âncora. Negativo é crédito.
 */
export const owedOn = (settings: CardSettings, entries: CardEntry[], movements: CardMovement[], asOf: string): number => {
	// `0 - x` e não `-x`: com âncora zero, `-0` vazaria para a tela e para comparações.
	let owed = 0 - settings.openingBalanceCents;
	for (const entry of entries) {
		if (entry.date > settings.openingBalanceDate && entry.date <= asOf) owed += signed(entry);
	}
	for (const movement of movements) {
		if (movement.date > settings.openingBalanceDate && movement.date <= asOf) {
			owed += movement.inbound ? -movement.amountCents : movement.amountCents;
		}
	}
	return owed;
};

/**
 * O valor de uma fatura: compras menos estornos datados no ciclo, depois da âncora,
 * mais a própria âncora quando ela cai no ciclo. `upTo` limita ao que já foi lançado.
 */
export const invoiceAmount = (
	cycle: InvoiceCycle,
	settings: CardSettings,
	entries: CardEntry[],
	upTo?: string
): number => {
	const last = upTo && upTo < cycle.end ? upTo : cycle.end;
	let total = 0;
	for (const entry of entries) {
		if (entry.date < cycle.start || entry.date > last) continue;
		if (entry.date <= settings.openingBalanceDate) continue;
		total += signed(entry);
	}
	if (settings.openingBalanceDate >= cycle.start && settings.openingBalanceDate <= last) {
		total -= settings.openingBalanceCents;
	}
	return total + 0;
};

// ---------------------------------------------------------------------------
// Resumo
// ---------------------------------------------------------------------------

export type ClosedInvoiceStatus = 'none' | 'paid' | 'due' | 'due_soon' | 'overdue';

export interface InvoiceView {
	cycle: InvoiceCycle;
	amountCents: number;
	/** -1 fechada, 0 aberta, >0 futura, <-1 anteriores. */
	offset: number;
}

export interface InstallmentPlan {
	group: string;
	note: string;
	category: string;
	totalCount: number;
	/** Parcelas ainda por cair. */
	remainingCount: number;
	/** Valor da próxima parcela. */
	parcelCents: number;
	remainingCents: number;
	nextDate: string;
	lastDate: string;
}

export interface CardSummary {
	/** Sem dia de fechamento o app não sabe montar faturas; o resto funciona. */
	configured: boolean;
	/** Tudo o que já caiu e não foi pago. */
	owedCents: number;
	/** Pagamento a mais: fica como crédito na próxima fatura. */
	creditCents: number;
	/** Compras já feitas que cairão em faturas futuras (parcelas). */
	futureCommittedCents: number;
	limitCents: number | null;
	/** Devido mais o comprometido — é o que o banco desconta do limite. */
	limitUsedCents: number;
	limitAvailableCents: number | null;
	/** 0-100+, nulo sem limite. */
	limitUsagePercent: number | null;

	openCycle: InvoiceCycle | null;
	/** Fatura aberta inteira, inclusive parcelas já programadas para este ciclo. */
	openInvoiceCents: number;
	closedCycle: InvoiceCycle | null;
	closedInvoiceCents: number;
	/** O que falta pagar das faturas já fechadas. */
	toPayCents: number;
	closedStatus: ClosedInvoiceStatus;
	/** Pagamentos registrados desde o último fechamento. */
	paidSinceClosingCents: number;
	daysToClosing: number | null;
	daysToDue: number | null;
	/** O dia do mês em que comprar joga a compra para o mais longe possível. */
	bestPurchaseDay: number | null;

	/** Faturas anteriores, a atual e as futuras com valor, da mais antiga para a mais nova. */
	invoices: InvoiceView[];
	installmentPlans: InstallmentPlan[];
}

const INSTALLMENT_SUFFIX = /\s*\(\d{1,2}\/\d{1,2}\)\s*$/;

/** Planos de parcelamento com alguma parcela ainda por cair. */
export const buildInstallmentPlans = (entries: CardEntry[], today: string): InstallmentPlan[] => {
	const groups = new Map<string, CardEntry[]>();
	for (const entry of entries) {
		if (!entry.installmentGroup || entry.isIncome) continue;
		const list = groups.get(entry.installmentGroup) ?? [];
		list.push(entry);
		groups.set(entry.installmentGroup, list);
	}

	const plans: InstallmentPlan[] = [];
	for (const [group, list] of groups) {
		const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date) || (a.installmentIndex ?? 0) - (b.installmentIndex ?? 0));
		const future = sorted.filter((entry) => entry.date > today);
		if (future.length === 0) continue;

		plans.push({
			group,
			note: sorted[0].note.replace(INSTALLMENT_SUFFIX, ''),
			category: sorted[0].category,
			totalCount: sorted[0].installmentCount ?? sorted.length,
			remainingCount: future.length,
			parcelCents: future[0].amountCents,
			remainingCents: future.reduce((total, entry) => total + entry.amountCents, 0),
			nextDate: future[0].date,
			lastDate: sorted[sorted.length - 1].date,
		});
	}

	return plans.sort((a, b) => a.nextDate.localeCompare(b.nextDate) || a.note.localeCompare(b.note));
};

const DUE_SOON_DAYS = 3;
const PAST_INVOICES = 6;
const FUTURE_INVOICES = 12;

export const buildCardSummary = (
	settings: CardSettings,
	entries: CardEntry[],
	movements: CardMovement[],
	today: string
): CardSummary => {
	const owedNow = owedOn(settings, entries, movements, today);
	const owedCents = Math.max(0, owedNow);
	const creditCents = Math.max(0, -owedNow);

	let futureCommittedCents = 0;
	for (const entry of entries) {
		if (entry.date > today && entry.date > settings.openingBalanceDate) futureCommittedCents += signed(entry);
	}
	futureCommittedCents = Math.max(0, futureCommittedCents);

	const limitUsedCents = Math.max(0, owedNow + futureCommittedCents);
	const limitCents = settings.creditLimitCents && settings.creditLimitCents > 0 ? settings.creditLimitCents : null;
	const limitAvailableCents = limitCents === null ? null : limitCents - limitUsedCents;
	const limitUsagePercent = limitCents === null ? null : Math.round((limitUsedCents / limitCents) * 100);
	const installmentPlans = buildInstallmentPlans(entries, today);

	const base = {
		owedCents,
		creditCents,
		futureCommittedCents,
		limitCents,
		limitUsedCents,
		limitAvailableCents,
		limitUsagePercent,
		installmentPlans,
	};

	if (settings.closingDay === null) {
		return {
			...base,
			configured: false,
			openCycle: null,
			openInvoiceCents: 0,
			closedCycle: null,
			closedInvoiceCents: 0,
			toPayCents: owedCents,
			closedStatus: owedCents > 0 ? 'due' : 'none',
			paidSinceClosingCents: 0,
			daysToClosing: null,
			daysToDue: null,
			bestPurchaseDay: null,
			invoices: [],
		};
	}

	const { closingDay, dueDay } = settings;
	const openCycle = cycleFor(today, closingDay, dueDay);
	const closedCycle = shiftCycle(openCycle, -1, closingDay, dueDay);

	const openInvoiceCents = invoiceAmount(openCycle, settings, entries);
	const openPostedCents = invoiceAmount(openCycle, settings, entries, today);
	const closedInvoiceCents = invoiceAmount(closedCycle, settings, entries);
	const toPayCents = Math.max(0, owedNow - Math.max(0, openPostedCents));

	let paidSinceClosingCents = 0;
	for (const movement of movements) {
		if (movement.inbound && movement.date >= closedCycle.closingDate && movement.date <= today) {
			paidSinceClosingCents += movement.amountCents;
		}
	}

	const daysToDue = daysBetween(today, closedCycle.dueDate);
	let closedStatus: ClosedInvoiceStatus;
	if (toPayCents === 0) closedStatus = closedInvoiceCents > 0 ? 'paid' : 'none';
	else if (daysToDue < 0) closedStatus = 'overdue';
	else if (daysToDue <= DUE_SOON_DAYS) closedStatus = 'due_soon';
	else closedStatus = 'due';

	const invoices: InvoiceView[] = [];
	for (let offset = -PAST_INVOICES; offset <= FUTURE_INVOICES; offset += 1) {
		const cycle = shiftCycle(openCycle, offset, closingDay, dueDay);
		const amountCents = invoiceAmount(cycle, settings, entries);
		if (offset < -1 && amountCents === 0) continue;
		if (offset > 0 && amountCents === 0) continue;
		invoices.push({ cycle, amountCents, offset });
	}

	return {
		...base,
		configured: true,
		openCycle,
		openInvoiceCents,
		closedCycle,
		closedInvoiceCents,
		toPayCents,
		closedStatus,
		paidSinceClosingCents,
		daysToClosing: daysBetween(today, openCycle.closingDate),
		daysToDue,
		bestPurchaseDay: closingDay,
		invoices,
	};
};

/**
 * Datas das parcelas restantes de uma compra parcelada feita **antes** do app, a partir
 * da parcela que cai na fatura aberta. A parcela atual entra no começo do ciclo aberto;
 * as seguintes, no começo de cada ciclo depois dele — uma por fatura, como no banco.
 * Sem dia de fechamento, a atual fica hoje e as outras de mês em mês.
 */
export const existingInstallmentDates = (
	currentIndex: number,
	totalCount: number,
	closingDay: number | null,
	dueDay: number | null,
	today: string
): Array<{ index: number; date: string }> => {
	const dates: Array<{ index: number; date: string }> = [];
	if (currentIndex < 1 || totalCount < currentIndex) return dates;

	const open = closingDay === null ? null : cycleFor(today, closingDay, dueDay);
	for (let index = currentIndex; index <= totalCount; index += 1) {
		const offset = index - currentIndex;
		const date =
			open && closingDay !== null
				? shiftCycle(open, offset, closingDay, dueDay).start
				: addMonthsClamped(today, offset);
		dates.push({ index, date });
	}
	return dates;
};

export default {
	cycleFor,
	cycleClosingIn,
	shiftCycle,
	owedOn,
	invoiceAmount,
	buildCardSummary,
	buildInstallmentPlans,
	existingInstallmentDates,
	daysBetween,
};
