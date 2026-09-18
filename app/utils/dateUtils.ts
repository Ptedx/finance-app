/**
 * Date handling for Spendr.
 *
 * Transactions are keyed by *calendar date* (`YYYY-MM-DD`), not by instant. That
 * distinction matters: `new Date('2026-07-22')` is parsed by JS as midnight **UTC**,
 * so in UTC-3 it renders as 21 July — every date in the app was displayed a day early.
 * Likewise `new Date().toISOString()` rolls over to tomorrow after 21:00 in Brazil.
 *
 * The rule in this file: calendar dates are parsed and produced component-by-component
 * in local time, and `toISOString()` is never used to derive one.
 */

import { languageOf, monthLong, monthShort } from './locale';

const holder = globalThis as { __spendrDateLocale?: string };

/**
 * Guardado também no objeto global: quando só este módulo é recarregado (Fast Refresh,
 * atualização do JS), ele volta com o locale já configurado em vez de cair no inglês.
 */
let locale = holder.__spendrDateLocale ?? 'en-US';

export const configureDateLocale = (nextLocale: string): void => {
	locale = nextLocale;
	holder.__spendrDateLocale = nextLocale;
};

/** Parses a `YYYY-MM-DD` string as local midnight, not UTC midnight. */
export const parseISODate = (dateString: string): Date => {
	const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateString);

	if (!match) {
		// Fall back to the engine's parser for full timestamps or unexpected shapes.
		return new Date(dateString);
	}

	const [, year, month, day] = match;
	return new Date(Number(year), Number(month) - 1, Number(day));
};

/** Formats a Date as `YYYY-MM-DD` using its local calendar day. */
export const getISODate = (date: Date): string => {
	const year = date.getFullYear();
	const month = (date.getMonth() + 1).toString().padStart(2, '0');
	const day = date.getDate().toString().padStart(2, '0');

	return `${year}-${month}-${day}`;
};

/** Today's calendar date, local. The single source of "today" across the app. */
export const todayISO = (): string => getISODate(new Date());

/**
 * The current *instant*, as an ISO 8601 UTC timestamp.
 *
 * This is the one place `toISOString()` is the right answer: sync timestamps order
 * edits made on different devices in different zones, so they must be absolute. Never
 * use this where a calendar date is wanted — that is what `todayISO()` is for.
 */
export const nowTimestamp = (): string => new Date().toISOString();

/**
 * Datas por tabela, não por `Intl`: o formato fica igual em qualquer motor JS e em
 * qualquer região do aparelho. Português e italiano escrevem dia antes do mês.
 */
const parts = (dateString: string): { year: number; month: number; day: number } => {
	const date = parseISODate(dateString);
	return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
};

const two = (value: number): string => String(value).padStart(2, '0');

/** '16 set' no pt-BR, 'Sep 16' no en-US. */
export const formatDate = (dateString: string): string => {
	const { month, day } = parts(dateString);
	const language = languageOf(locale);
	return language === 'en' ? `${monthShort(language, month)} ${day}` : `${day} ${monthShort(language, month)}`;
};

/** '16/09' no pt-BR, '09/16' no en-US: dia e mês com dois dígitos, na ordem do idioma. */
export const formatDayMonth = (dateString: string): string => {
	const { month, day } = parts(dateString);
	return languageOf(locale) === 'en' ? `${two(month)}/${two(day)}` : `${two(day)}/${two(month)}`;
};

/** '16/09/2026' no pt-BR. */
export const formatShortDate = (dateString: string): string => {
	const { year } = parts(dateString);
	return `${formatDayMonth(dateString)}/${year}`;
};

/** Nome do mês por extenso ('setembro'). */
export const formatMonthLong = (dateString: string): string => monthLong(languageOf(locale), parts(dateString).month);

/** Mês abreviado ('set'), para rótulos curtos como as abas de fatura. */
export const formatMonthShort = (dateString: string): string => monthShort(languageOf(locale), parts(dateString).month);

/** '16 de setembro de 2026', 'September 16, 2026', '16 settembre 2026'. */
export const formatFullDate = (dateString: string): string => {
	const { year, month, day } = parts(dateString);
	const language = languageOf(locale);
	const name = monthLong(language, month);
	if (language === 'pt') return `${day} de ${name} de ${year}`;
	if (language === 'it') return `${day} ${name} ${year}`;
	return `${name} ${day}, ${year}`;
};

/** Number of days in a month. `month` is 1-12. */
export const lastDayOfMonth = (year: number, month: number): number =>
	new Date(year, month, 0).getDate();

/**
 * Adds months to a calendar date, clamping the day to the end of the target month.
 *
 * Plain `setMonth` overflows: 31 January + 1 month lands on 3 March, and a bill due on
 * the 31st silently skips every 30-day month. `addMonthsClamped('2026-01-31', 1)`
 * returns `2026-02-28`.
 */
export const addMonthsClamped = (dateString: string, months: number): string => {
	const date = parseISODate(dateString);
	const targetMonthIndex = date.getMonth() + months;
	const targetYear = date.getFullYear() + Math.floor(targetMonthIndex / 12);
	const targetMonth = ((targetMonthIndex % 12) + 12) % 12; // 0-11, handles negatives

	const day = Math.min(date.getDate(), lastDayOfMonth(targetYear, targetMonth + 1));

	return getISODate(new Date(targetYear, targetMonth, day));
};

/**
 * Builds a calendar date from parts, clamping the day into the month.
 * `buildClampedDate(2026, 2, 31)` returns `2026-02-28`.
 */
export const buildClampedDate = (year: number, month: number, day: number): string => {
	const clampedDay = Math.min(Math.max(day, 1), lastDayOfMonth(year, month));
	return getISODate(new Date(year, month - 1, clampedDay));
};

export const addDays = (dateString: string, days: number): string => {
	const date = parseISODate(dateString);
	date.setDate(date.getDate() + days);
	return getISODate(date);
};

export const addYearsClamped = (dateString: string, years: number): string =>
	addMonthsClamped(dateString, years * 12);

export const getCurrentMonthRange = (): { startDate: string; endDate: string } => {
	const today = new Date();
	return getMonthRange(today.getMonth() + 1, today.getFullYear());
};

export const getMonthRange = (
	month: number,
	year: number
): { startDate: string; endDate: string } => ({
	startDate: getISODate(new Date(year, month - 1, 1)),
	endDate: getISODate(new Date(year, month, 0)),
});

export const getMonthName = (month: number): string => monthLong(languageOf(locale), month);

/**
 * Chave de mês (`YYYY-MM`) de uma data ISO. É a mesma chave que nomeia a fatura do
 * cartão e agrupa as séries dos relatórios.
 */
export const monthKeyOf = (dateString: string): string => dateString.slice(0, 7);

/** Anda `delta` meses (negativo volta) numa chave `YYYY-MM`, atravessando o ano. */
export const shiftMonthKey = (key: string, delta: number): string => {
	const [year, month] = key.split('-').map(Number);
	const index = year * 12 + (month - 1) + delta;
	const nextYear = Math.floor(index / 12);
	const nextMonth = ((index % 12) + 12) % 12;
	return `${nextYear}-${String(nextMonth + 1).padStart(2, '0')}`;
};

/** Primeiro e último dia do mês de uma chave `YYYY-MM`. */
export const monthKeyRange = (key: string): { startDate: string; endDate: string } => {
	const [year, month] = key.split('-').map(Number);
	return getMonthRange(month, year);
};

/** Nome do mês de uma chave `YYYY-MM`, no idioma do app. */
export const monthKeyName = (key: string): string => getMonthName(Number(key.slice(5, 7)));

export const getCurrentMonthName = (): string =>
	getMonthName(new Date().getMonth() + 1).toUpperCase();

export const getCurrentYear = (): number => new Date().getFullYear();

export default {
	configureDateLocale,
	parseISODate,
	getISODate,
	todayISO,
	nowTimestamp,
	formatDate,
	formatFullDate,
	lastDayOfMonth,
	addMonthsClamped,
	buildClampedDate,
	addDays,
	addYearsClamped,
	getCurrentMonthRange,
	getMonthRange,
	monthKeyOf,
	shiftMonthKey,
	monthKeyRange,
	monthKeyName,
	getMonthName,
	getCurrentMonthName,
	getCurrentYear,
};
