/**
 * Recurrence scheduling for Spendr.
 *
 * Pure calendar arithmetic, deliberately free of database and React Native imports so
 * the rules can be tested directly. A series is always regenerated from
 * `(year, month, preferredDay)`, never by stepping the previously clamped date. Stepping
 * loses the intent: a bill due on the 31st, clamped to 28 February, must return to
 * 31 March — not stay on the 28th.
 *
 * As recorrências antigas não lançam mais nada (SPD-113) e saíram do custo fixo (SPD-122).
 * O que sobra aqui é o que o `database.ts` ainda usa para gravar o `nextDue` de uma regra
 * (`firstDueOnOrAfter`, `nextDueAfterEdit`) e o id derivado que as Contas do mês usam na
 * baixa (`occurrenceId`). A varredura de ocorrências atrasadas e o "equivalente mensal"
 * saíram no SPD-128, sem uso.
 */

import { addDays, buildClampedDate, parseISODate } from './dateUtils';

export type RecurrenceType = 'weekly' | 'monthly' | 'yearly';

export interface RecurrenceRule {
	recurrenceType: RecurrenceType;
	/** Day of month, 1-31. Clamped into short months rather than overflowing. */
	day?: number;
	/** Month, 1-12. Yearly rules only. */
	month?: number;
	/** 1 = Monday … 7 = Sunday. Weekly rules only. */
	weekday?: number;
}

const clamp = (value: number | undefined, min: number, max: number, fallback: number): number => {
	if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
	return Math.min(Math.max(Math.trunc(value), min), max);
};

/** Weekday of a calendar date in the app's convention: 1 = Monday … 7 = Sunday. */
export const weekdayOf = (dateString: string): number => {
	const jsWeekday = parseISODate(dateString).getDay(); // 0 = Sunday
	return jsWeekday === 0 ? 7 : jsWeekday;
};

/**
 * The first occurrence of `rule` falling on or after `fromDate`.
 * Both arguments and the result are `YYYY-MM-DD`, which compares correctly as a string.
 */
export const firstDueOnOrAfter = (rule: RecurrenceRule, fromDate: string): string => {
	switch (rule.recurrenceType) {
		case 'monthly': {
			const day = clamp(rule.day, 1, 31, 1);
			const from = parseISODate(fromDate);
			let year = from.getFullYear();
			let month = from.getMonth() + 1;

			let candidate = buildClampedDate(year, month, day);
			if (candidate < fromDate) {
				month += 1;
				if (month > 12) {
					month = 1;
					year += 1;
				}
				candidate = buildClampedDate(year, month, day);
			}
			return candidate;
		}

		case 'yearly': {
			const month = clamp(rule.month, 1, 12, 1);
			const day = clamp(rule.day, 1, 31, 1);
			const year = parseISODate(fromDate).getFullYear();

			const candidate = buildClampedDate(year, month, day);
			return candidate < fromDate ? buildClampedDate(year + 1, month, day) : candidate;
		}

		case 'weekly': {
			const target = clamp(rule.weekday, 1, 7, 1);
			const offset = (target - weekdayOf(fromDate) + 7) % 7;
			return addDays(fromDate, offset);
		}

		default:
			return fromDate;
	}
};

/**
 * O primeiro dia do ciclo seguinte ao que contém `lastProcessed`.
 *
 * É a âncora usada quando uma regra é **editada** depois de já ter sido cobrada: a
 * academia paga no dia 10 e movida para o dia 20 não cobra de novo no dia 20 do mesmo
 * mês — a nova data vale a partir do mês que vem. Sem esta âncora, a edição gerava uma
 * segunda cobrança no mesmo período.
 *
 * Ciclo mensal = mês civil; anual = ano civil; semanal = semana de segunda a domingo.
 */
export const nextCycleStart = (rule: RecurrenceRule, lastProcessed: string): string => {
	const date = parseISODate(lastProcessed);

	switch (rule.recurrenceType) {
		case 'monthly': {
			const month = date.getMonth() + 2; // 1-12 do mês seguinte, ou 13 na virada
			return month > 12
				? buildClampedDate(date.getFullYear() + 1, 1, 1)
				: buildClampedDate(date.getFullYear(), month, 1);
		}
		case 'yearly':
			return buildClampedDate(date.getFullYear() + 1, 1, 1);
		case 'weekly':
			return addDays(lastProcessed, 8 - weekdayOf(lastProcessed));
		default:
			return addDays(lastProcessed, 1);
	}
};

/**
 * Onde uma regra passa a vencer depois de ser **editada**.
 *
 * É a única fonte de `nextDue` em `updateRecurringTransaction`, e a resposta à pergunta
 * "mudei a academia do dia 10 para o dia 20 depois de pagar no dia 10: cobra de novo
 * este mês?" — não. Uma regra já cobrada no ciclo corrente só volta a vencer a partir
 * do ciclo seguinte, então a nova data vale do mês que vem. Uma regra que nunca rodou
 * vence na primeira ocorrência a partir de hoje.
 *
 * Mover a data para **mais tarde no mesmo ciclo** também não cobra duas vezes: o
 * ciclo já foi cobrado. Mover para **mais cedo** no ciclo seguinte cobra na nova data
 * sem pular nenhum mês.
 */
export const nextDueAfterEdit = (
	rule: RecurrenceRule,
	lastProcessed: string | null | undefined,
	today: string
): string => {
	const anchor = lastProcessed ? nextCycleStart(rule, lastProcessed) : today;
	return firstDueOnOrAfter(rule, anchor);
};

/**
 * 32-bit FNV-1a over a string, seeded so several independent digests can be taken of
 * the same input. Not cryptographic — it only has to be stable and well spread.
 */
const fnv1a = (input: string, seed: number): number => {
	let hash = seed >>> 0;

	for (let index = 0; index < input.length; index += 1) {
		hash ^= input.charCodeAt(index);
		// The FNV prime, 16777619, via shifts: Math.imul keeps this in 32 bits.
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}

	return hash >>> 0;
};

/**
 * The id a recurring rule's occurrence on `dueDate` will always have.
 *
 * Posting an occurrence used to mint a random UUID, which is fine on one device and
 * wrong on two: phone and tablet both catching up on the same rent would each insert
 * their own row, and the ledger would show it twice. Deriving the id from the rule and
 * the due date makes the insert idempotent — both devices produce the same id, and the
 * server's upsert collapses them into one row.
 *
 * Formatted as a UUID so it is indistinguishable from `generateUniqueId()` output
 * everywhere else in the app. Version nibble 8 marks it as a custom-namespace id.
 */
export const occurrenceId = (recurringId: string, dueDate: string): string => {
	const input = `${recurringId}|${dueDate}`;

	// Four differently-seeded digests give the 128 bits a UUID needs.
	const hex = [0x811c9dc5, 0x1000193, 0x9e3779b9, 0x85ebca6b]
		.map((seed) => fnv1a(input, seed).toString(16).padStart(8, '0'))
		.join('');

	const version = `8${hex.slice(13, 16)}`;
	// Variant bits: the first nibble must be 8, 9, a or b.
	const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20);

	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${version}-${variant}-${hex.slice(20, 32)}`;
};

export default {
	weekdayOf,
	firstDueOnOrAfter,
	nextCycleStart,
	nextDueAfterEdit,
	occurrenceId,
};
