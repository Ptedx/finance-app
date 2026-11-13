/**
 * Invariantes de recorrência.
 *
 * `recurrence.test.ts` cobre casos nomeados. Aqui as regras são geradas aleatoriamente
 * e checadas contra propriedades que valem para qualquer regra: cada vencimento cai no
 * dia certo, sem pular nenhum, e a edição de uma regra já cobrada não cobra de novo no
 * mesmo ciclo. A simulação das aberturas do app (o catch-up) saiu no SPD-128 junto com a
 * varredura: as regras não lançam mais nada desde o SPD-113.
 */

import { addDays, buildClampedDate, getISODate, lastDayOfMonth, parseISODate } from '../dateUtils';
import {
	firstDueOnOrAfter,
	nextCycleStart,
	nextDueAfterEdit,
	occurrenceId,
	type RecurrenceRule,
	weekdayOf,
} from '../recurrence';

const makeRandom = (seed: number) => {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 0x100000000;
	};
};

const randomInt = (random: () => number, min: number, max: number): number =>
	min + Math.floor(random() * (max - min + 1));

const randomRule = (random: () => number): RecurrenceRule => {
	const kind = randomInt(random, 0, 2);
	if (kind === 0) return { recurrenceType: 'monthly', day: randomInt(random, 1, 31) };
	if (kind === 1) {
		return {
			recurrenceType: 'yearly',
			month: randomInt(random, 1, 12),
			day: randomInt(random, 1, 31),
		};
	}
	return { recurrenceType: 'weekly', weekday: randomInt(random, 1, 7) };
};

const randomDate = (random: () => number): string =>
	buildClampedDate(randomInt(random, 2000, 2040), randomInt(random, 1, 12), randomInt(random, 1, 31));

/** Verdadeiro quando `date` é uma ocorrência legítima de `rule`. */
const matchesRule = (rule: RecurrenceRule, date: string): boolean => {
	const parsed = parseISODate(date);
	const year = parsed.getFullYear();
	const month = parsed.getMonth() + 1;
	const day = parsed.getDate();

	switch (rule.recurrenceType) {
		case 'monthly':
			return day === Math.min(rule.day ?? 1, lastDayOfMonth(year, month));
		case 'yearly':
			return (
				month === (rule.month ?? 1) && day === Math.min(rule.day ?? 1, lastDayOfMonth(year, month))
			);
		case 'weekly':
			return weekdayOf(date) === (rule.weekday ?? 1);
		default:
			return false;
	}
};

const describeRule = (rule: RecurrenceRule): string => JSON.stringify(rule);

describe('firstDueOnOrAfter', () => {
	it('devolve sempre uma ocorrência válida, no dia pedido ou depois, e a primeira possível', () => {
		const random = makeRandom(101);

		for (let i = 0; i < 20_000; i += 1) {
			const rule = randomRule(random);
			const from = randomDate(random);
			const due = firstDueOnOrAfter(rule, from);

			if (due < from) throw new Error(`${describeRule(rule)}: ${due} < ${from}`);
			if (!matchesRule(rule, due)) throw new Error(`${describeRule(rule)}: ${due} não casa a regra`);

			// Nenhum dia entre `from` e `due` (exclusivo) pode ser uma ocorrência.
			let cursor = from;
			while (cursor < due) {
				if (matchesRule(rule, cursor)) {
					throw new Error(`${describeRule(rule)}: pulou a ocorrência ${cursor} a partir de ${from}`);
				}
				cursor = addDays(cursor, 1);
			}
		}
	});

	it('é idempotente: a primeira ocorrência a partir de si mesma é ela mesma', () => {
		const random = makeRandom(103);
		for (let i = 0; i < 5_000; i += 1) {
			const rule = randomRule(random);
			const due = firstDueOnOrAfter(rule, randomDate(random));
			expect(firstDueOnOrAfter(rule, due)).toBe(due);
		}
	});
});

describe('occurrenceId', () => {
	// Hoje é o id da baixa de uma conta do mês (`bill-paid:<conta>` + mês, no BillsContext):
	// dois aparelhos dando a mesma baixa convergem numa linha só.
	it('dois aparelhos lançando a mesma ocorrência geram o mesmo id', () => {
		const random = makeRandom(131);
		const ids = new Set<string>();
		let pairs = 0;

		for (let i = 0; i < 2_000; i += 1) {
			const ruleId = `rule-${randomInt(random, 1, 400)}`;
			const date = randomDate(random);
			const id = occurrenceId(ruleId, date);

			expect(id).toBe(occurrenceId(ruleId, date));
			expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
			ids.add(`${ruleId}|${date}|${id}`);
			pairs += 1;
		}

		// Sem colisão entre pares distintos.
		const distinctPairs = new Set([...ids].map((entry) => entry.split('|').slice(0, 2).join('|')));
		const distinctIds = new Set([...ids].map((entry) => entry.split('|')[2]));
		expect(distinctIds.size).toBe(distinctPairs.size);
		expect(pairs).toBe(2_000);
	});
});

describe('weekdayOf', () => {
	it('percorre 1..7 em sequência ao longo de qualquer semana', () => {
		let date = '2000-01-03'; // segunda-feira
		for (let i = 0; i < 3_000; i += 1) {
			expect(weekdayOf(date)).toBe((i % 7) + 1);
			date = addDays(date, 1);
		}
		expect(getISODate(parseISODate(date))).toBe(date);
	});
});

describe('nextCycleStart / nextDueAfterEdit — editar uma regra já cobrada', () => {
	const mondayOf = (date: string): string => addDays(date, 1 - weekdayOf(date));

	/** Verdadeiro quando `a` e `b` caem no mesmo ciclo da regra (mês, ano ou semana civil). */
	const sameCycle = (rule: RecurrenceRule, a: string, b: string): boolean => {
		switch (rule.recurrenceType) {
			case 'monthly':
				return a.slice(0, 7) === b.slice(0, 7);
			case 'yearly':
				return a.slice(0, 4) === b.slice(0, 4);
			case 'weekly':
				return mondayOf(a) === mondayOf(b);
			default:
				return false;
		}
	};

	it('o ciclo seguinte começa logo depois do ciclo de lastProcessed — nem antes, nem depois', () => {
		const random = makeRandom(211);

		for (let i = 0; i < 10_000; i += 1) {
			const rule = randomRule(random);
			const lastProcessed = randomDate(random);
			const start = nextCycleStart(rule, lastProcessed);

			if (start <= lastProcessed) {
				throw new Error(`${describeRule(rule)}: ciclo seguinte ${start} não é depois de ${lastProcessed}`);
			}
			if (sameCycle(rule, lastProcessed, start)) {
				throw new Error(`${describeRule(rule)}: ${start} ainda está no ciclo de ${lastProcessed}`);
			}
			if (!sameCycle(rule, lastProcessed, addDays(start, -1))) {
				throw new Error(`${describeRule(rule)}: ${start} pulou um ciclo depois de ${lastProcessed}`);
			}
		}
	});

	// A edição nunca põe o vencimento de volta no ciclo já cobrado, e nunca faz o ciclo
	// seguinte ficar sem vencimento.
	it('não cobra de novo no ciclo já cobrado e cobra exatamente uma vez no seguinte', () => {
		const random = makeRandom(223);

		for (let i = 0; i < 10_000; i += 1) {
			const rule = randomRule(random);
			const lastProcessed = randomDate(random);
			const cycleStart = nextCycleStart(rule, lastProcessed);
			const cycleEnd = addDays(cycleStart, -1);

			// A edição acontece em qualquer dia do ciclo cobrado, a partir da cobrança.
			const edited = addDays(lastProcessed, randomInt(random, 0, 40));
			const today = edited > cycleEnd ? cycleEnd : edited;

			const nextDue = nextDueAfterEdit(rule, lastProcessed, today);

			if (!matchesRule(rule, nextDue)) {
				throw new Error(`${describeRule(rule)}: ${nextDue} não casa a regra`);
			}
			if (nextDue < cycleStart) {
				throw new Error(`${describeRule(rule)}: ${nextDue} cobra de novo no ciclo de ${lastProcessed}`);
			}

			// Um vencimento por ciclo: cair dentro do ciclo seguinte é cobrar ali uma vez só.
			const nextCycleEnd = addDays(nextCycleStart(rule, cycleStart), -1);
			if (nextDue > nextCycleEnd) {
				throw new Error(`${describeRule(rule)}: ${nextDue} pulou o ciclo seguinte ao de ${lastProcessed}`);
			}
		}
	});

	it('uma regra que nunca rodou vence na primeira ocorrência a partir de hoje', () => {
		const random = makeRandom(227);

		for (let i = 0; i < 5_000; i += 1) {
			const rule = randomRule(random);
			const today = randomDate(random);
			expect(nextDueAfterEdit(rule, null, today)).toBe(firstDueOnOrAfter(rule, today));
		}
	});
});
