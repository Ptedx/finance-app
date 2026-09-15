/**
 * Invariantes de recorrência.
 *
 * `recurrence.test.ts` cobre casos nomeados. Aqui as regras são geradas aleatoriamente
 * e checadas contra propriedades que valem para qualquer regra: cada ocorrência cai no
 * dia certo, não há duplicata nem buraco, e — o que importa para o livro-caixa — abrir
 * o app em qualquer cadência produz exatamente o mesmo conjunto de lançamentos que
 * abri-lo uma única vez. Uma cobrança a mais ou a menos é um erro de centavos em escala.
 */

import { addDays, buildClampedDate, getISODate, lastDayOfMonth, parseISODate } from '../dateUtils';
import {
	firstDueOnOrAfter,
	MAX_CATCH_UP_OCCURRENCES,
	monthlyEquivalentCents,
	nextCycleStart,
	nextDueAfter,
	nextDueAfterEdit,
	occurrenceId,
	occurrencesBetween,
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

describe('firstDueOnOrAfter / nextDueAfter', () => {
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

	it('nextDueAfter é estritamente posterior e não pula nenhuma ocorrência', () => {
		const random = makeRandom(107);
		for (let i = 0; i < 5_000; i += 1) {
			const rule = randomRule(random);
			const from = randomDate(random);
			const next = nextDueAfter(rule, from);

			expect(next > from).toBe(true);
			expect(matchesRule(rule, next)).toBe(true);
			expect(firstDueOnOrAfter(rule, addDays(from, 1))).toBe(next);
		}
	});

	it('dia 31 mensal volta ao 31 depois de um mês curto (nunca fica preso no 28/30)', () => {
		const rule: RecurrenceRule = { recurrenceType: 'monthly', day: 31 };
		let due = firstDueOnOrAfter(rule, '2026-01-01');
		const seen: string[] = [];
		for (let i = 0; i < 24; i += 1) {
			seen.push(due);
			due = nextDueAfter(rule, due);
		}
		expect(seen.slice(0, 5)).toEqual([
			'2026-01-31',
			'2026-02-28',
			'2026-03-31',
			'2026-04-30',
			'2026-05-31',
		]);
		expect(seen).toHaveLength(24);
		expect(new Set(seen.map((d) => d.slice(0, 7))).size).toBe(24);
	});

	it('29 de fevereiro anual cai em 28 nos anos comuns e volta ao 29 no bissexto', () => {
		const rule: RecurrenceRule = { recurrenceType: 'yearly', month: 2, day: 29 };
		expect(firstDueOnOrAfter(rule, '2024-01-01')).toBe('2024-02-29');
		expect(nextDueAfter(rule, '2024-02-29')).toBe('2025-02-28');
		expect(nextDueAfter(rule, '2025-02-28')).toBe('2026-02-28');
		expect(nextDueAfter(rule, '2027-02-28')).toBe('2028-02-29');
	});
});

describe('occurrencesBetween', () => {
	it('lista exatamente os dias do intervalo que casam a regra, em ordem, sem duplicata', () => {
		const random = makeRandom(109);

		for (let i = 0; i < 3_000; i += 1) {
			const rule = randomRule(random);
			const from = randomDate(random);
			const to = addDays(from, randomInt(random, 0, 800));

			const expected: string[] = [];
			for (let cursor = from; cursor <= to; cursor = addDays(cursor, 1)) {
				if (matchesRule(rule, cursor)) expected.push(cursor);
			}

			const actual = occurrencesBetween(rule, from, to);
			if (JSON.stringify(actual) !== JSON.stringify(expected)) {
				throw new Error(
					`${describeRule(rule)} [${from}..${to}]\n esperado ${expected}\n obtido ${actual}`
				);
			}
		}
	});

	it('intervalo invertido devolve vazio; intervalo de um dia devolve 0 ou 1', () => {
		const random = makeRandom(113);
		for (let i = 0; i < 2_000; i += 1) {
			const rule = randomRule(random);
			const date = randomDate(random);
			expect(occurrencesBetween(rule, addDays(date, 1), date)).toEqual([]);
			const single = occurrencesBetween(rule, date, date);
			expect(single.length).toBeLessThanOrEqual(1);
			expect(single.length === 1).toBe(matchesRule(rule, date));
		}
	});

	it('respeita o teto de catch-up', () => {
		const weekly: RecurrenceRule = { recurrenceType: 'weekly', weekday: 1 };
		expect(occurrencesBetween(weekly, '1990-01-01', '2040-01-01')).toHaveLength(
			MAX_CATCH_UP_OCCURRENCES
		);
	});
});

/**
 * Simula `processRecurringTransactions` ao longo do tempo.
 *
 * O app não sabe quando será aberto: pode ser todo dia, uma vez por mês ou uma vez por
 * ano. A cada abertura ele lança as ocorrências em `[lastProcessed + 1, hoje]` e avança
 * `lastProcessed` para a última lançada. Seja qual for a cadência, o conjunto de datas
 * lançadas tem que ser o mesmo — e o mesmo id por ocorrência, para que dois aparelhos
 * convirjam numa linha só.
 */
const simulateOpenings = (
	rule: RecurrenceRule,
	createdOn: string,
	openings: string[]
): { posted: string[]; lastProcessed?: string; nextDue: string } => {
	let lastProcessed: string | undefined;
	let nextDue = firstDueOnOrAfter(rule, createdOn);
	const posted: string[] = [];

	for (const today of openings) {
		if (nextDue > today) continue; // a query filtra nextDue <= hoje

		const windowStart = lastProcessed ? addDays(lastProcessed, 1) : nextDue;
		const dueDates = occurrencesBetween(rule, windowStart, today);
		posted.push(...dueDates);

		const lastPosted = dueDates.length > 0 ? dueDates[dueDates.length - 1] : undefined;
		lastProcessed = lastPosted ?? lastProcessed;
		nextDue = lastPosted ? nextDueAfter(rule, lastPosted) : firstDueOnOrAfter(rule, today);
	}

	return { posted, lastProcessed, nextDue };
};

describe('catch-up: simulação de aberturas do app', () => {
	it('qualquer cadência de abertura lança o mesmo conjunto de ocorrências que uma única', () => {
		const random = makeRandom(127);

		for (let i = 0; i < 1_500; i += 1) {
			const rule = randomRule(random);
			const createdOn = randomDate(random);
			const horizon = addDays(createdOn, randomInt(random, 1, 900));

			// Cadência aleatória de aberturas, sempre terminando no horizonte.
			const openings: string[] = [];
			let cursor = createdOn;
			while (cursor < horizon) {
				cursor = addDays(cursor, randomInt(random, 1, 120));
				openings.push(cursor < horizon ? cursor : horizon);
			}
			if (openings[openings.length - 1] !== horizon) openings.push(horizon);

			const sparse = simulateOpenings(rule, createdOn, openings);
			const single = simulateOpenings(rule, createdOn, [horizon]);
			const expected = occurrencesBetween(rule, createdOn, horizon);

			if (JSON.stringify(sparse.posted) !== JSON.stringify(expected)) {
				throw new Error(
					`${describeRule(rule)} criada ${createdOn}, aberturas ${openings}\n esperado ${expected}\n obtido ${sparse.posted}`
				);
			}
			expect(single.posted).toEqual(expected);
			expect(sparse.nextDue).toBe(single.nextDue);
			expect(sparse.nextDue > horizon).toBe(true);
			expect(sparse.lastProcessed).toBe(expected[expected.length - 1]);
		}
	});

	it('abrir o app todo dia por dois anos nunca lança duas vezes nem pula', () => {
		const rules: RecurrenceRule[] = [
			{ recurrenceType: 'monthly', day: 31 },
			{ recurrenceType: 'monthly', day: 1 },
			{ recurrenceType: 'monthly', day: 15 },
			{ recurrenceType: 'yearly', month: 2, day: 29 },
			{ recurrenceType: 'weekly', weekday: 7 },
		];
		const createdOn = '2023-12-15';
		const openings: string[] = [];
		for (let d = createdOn; d <= '2025-12-31'; d = addDays(d, 1)) openings.push(d);

		for (const rule of rules) {
			const { posted } = simulateOpenings(rule, createdOn, openings);
			expect(posted).toEqual(occurrencesBetween(rule, createdOn, '2025-12-31'));
			expect(new Set(posted).size).toBe(posted.length);
		}
	});

	it('uma regra criada hoje com vencimento hoje é lançada hoje, uma vez', () => {
		const today = '2026-09-14';
		const rule: RecurrenceRule = { recurrenceType: 'monthly', day: 14 };
		const { posted, nextDue } = simulateOpenings(rule, today, [today, today, addDays(today, 1)]);
		expect(posted).toEqual([today]);
		expect(nextDue).toBe('2026-10-14');
	});

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

describe('monthlyEquivalentCents', () => {
	it('doze mensalidades de um compromisso anual desviam no máximo 6 centavos do valor anual', () => {
		for (let yearly = 0; yearly < 200_000; yearly += 37) {
			const monthly = monthlyEquivalentCents({ recurrenceType: 'yearly' }, yearly);
			expect(Math.abs(monthly * 12 - yearly)).toBeLessThanOrEqual(6);
		}
	});

	it('doze mensalidades de um compromisso semanal equivalem a 52 semanas (± 6 centavos)', () => {
		for (let weekly = 0; weekly < 200_000; weekly += 41) {
			const monthly = monthlyEquivalentCents({ recurrenceType: 'weekly' }, weekly);
			expect(Math.abs(monthly * 12 - weekly * 52)).toBeLessThanOrEqual(6);
		}
	});

	it('mensal é identidade e nunca devolve fração de centavo', () => {
		for (let cents = 0; cents < 100_000; cents += 13) {
			expect(monthlyEquivalentCents({ recurrenceType: 'monthly' }, cents)).toBe(cents);
			expect(Number.isInteger(monthlyEquivalentCents({ recurrenceType: 'yearly' }, cents))).toBe(true);
			expect(Number.isInteger(monthlyEquivalentCents({ recurrenceType: 'weekly' }, cents))).toBe(true);
		}
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

	// A propriedade que importa para o livro-caixa: a edição nunca gera uma segunda
	// cobrança no ciclo já cobrado, e nunca faz o ciclo seguinte ficar sem cobrança.
	// A janela é a mesma de `processRecurringTransactions` — resume de `lastProcessed + 1`,
	// mas nunca antes de `nextDue`.
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

			const resumeFrom = addDays(lastProcessed, 1);
			const windowStart = nextDue > resumeFrom ? nextDue : resumeFrom;
			const nextCycleEnd = addDays(nextCycleStart(rule, cycleStart), -1);

			expect(occurrencesBetween(rule, windowStart, cycleEnd)).toEqual([]);
			expect(occurrencesBetween(rule, windowStart, nextCycleEnd)).toEqual([nextDue]);
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
