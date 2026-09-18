/**
 * Dias úteis bancários no Brasil, para o vencimento de cartão.
 *
 * Vencimento em sábado, domingo ou feriado bancário nacional passa para o próximo dia
 * útil. Feriados considerados: os nacionais fixos (inclusive 20 de novembro, nacional
 * desde 2024), a segunda e a terça de Carnaval, a Sexta-feira Santa e Corpus Christi —
 * os bancos não abrem nesses dias, pelo calendário da Febraban. Feriados estaduais e
 * municipais ficam de fora: variam por cidade e o banco digital não segue nenhum.
 */

const pad = (value: number): string => String(value).padStart(2, '0');

const iso = (date: Date): string => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;

const utc = (dateString: string): Date => {
	const [year, month, day] = dateString.split('-').map(Number);
	return new Date(Date.UTC(year, month - 1, day));
};

const shift = (dateString: string, days: number): string => {
	const date = utc(dateString);
	date.setUTCDate(date.getUTCDate() + days);
	return iso(date);
};

/** Domingo de Páscoa, pelo algoritmo gregoriano anônimo (Meeus/Jones/Butcher). */
export const easterSunday = (year: number): string => {
	const a = year % 19;
	const b = Math.floor(year / 100);
	const c = year % 100;
	const d = Math.floor(b / 4);
	const e = b % 4;
	const f = Math.floor((b + 8) / 25);
	const g = Math.floor((b - f + 1) / 3);
	const h = (19 * a + b - d - g + 15) % 30;
	const i = Math.floor(c / 4);
	const k = c % 4;
	const l = (32 + 2 * e + 2 * i - h - k) % 7;
	const m = Math.floor((a + 11 * h + 22 * l) / 451);
	const month = Math.floor((h + l - 7 * m + 114) / 31);
	const day = ((h + l - 7 * m + 114) % 31) + 1;
	return `${year}-${pad(month)}-${pad(day)}`;
};

const FIXED_HOLIDAYS = ['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '12-25'];

const holidayCache = new Map<number, Set<string>>();

/** Feriados bancários nacionais do ano, como `YYYY-MM-DD`. */
export const bankHolidays = (year: number): Set<string> => {
	const cached = holidayCache.get(year);
	if (cached) return cached;

	const easter = easterSunday(year);
	const days = new Set<string>(FIXED_HOLIDAYS.map((day) => `${year}-${day}`));
	if (year >= 2024) days.add(`${year}-11-20`);
	days.add(shift(easter, -48)); // segunda de Carnaval
	days.add(shift(easter, -47)); // terça de Carnaval
	days.add(shift(easter, -2)); // Sexta-feira Santa
	days.add(shift(easter, 60)); // Corpus Christi

	holidayCache.set(year, days);
	return days;
};

export const isBusinessDay = (dateString: string): boolean => {
	const weekday = utc(dateString).getUTCDay();
	if (weekday === 0 || weekday === 6) return false;
	return !bankHolidays(Number(dateString.slice(0, 4))).has(dateString);
};

/** A própria data, se for dia útil; senão o próximo dia útil. */
export const nextBusinessDay = (dateString: string): string => {
	let date = dateString;
	while (!isBusinessDay(date)) date = shift(date, 1);
	return date;
};

export default { easterSunday, bankHolidays, isBusinessDay, nextBusinessDay };
