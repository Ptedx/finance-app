/**
 * Regressão: editar um lançamento não pode mover a data.
 *
 * `TransactionForm` inicializava o estado com `new Date(transaction.date)`. Para uma
 * string `YYYY-MM-DD` o construtor devolve meia-noite **UTC**; em qualquer fuso a oeste
 * de Greenwich isso ainda é o dia anterior, e `getISODate` — que lê o dia local —
 * gravava a data um dia para trás a cada edição. O formulário passou a usar
 * `parseISODate`. Este teste fixa o contrato: para toda data, o caminho do formulário
 * (parse → getISODate) é identidade, em qualquer fuso.
 */

import { getISODate, lastDayOfMonth, parseISODate } from '../../utils/dateUtils';

/** O mesmo helper do formulário (não exportado de lá para não virar API do componente). */
const buildPickedDate = (year: number, monthIndex: number, day: number): Date =>
	new Date(year, monthIndex, Math.min(day, lastDayOfMonth(year, monthIndex + 1)));

describe('TransactionForm — data', () => {
	it('parse → getISODate é identidade para todos os dias de 2020 a 2030', () => {
		const cursor = new Date(2020, 0, 1);
		while (cursor.getFullYear() <= 2030) {
			const iso = getISODate(cursor);
			expect(getISODate(parseISODate(iso))).toBe(iso);
			cursor.setDate(cursor.getDate() + 1);
		}
	});

	it('o construtor Date com YYYY-MM-DD perde um dia em fusos negativos (o bug corrigido)', () => {
		const offsetMinutes = new Date(2026, 8, 14).getTimezoneOffset();
		const viaConstructor = getISODate(new Date('2026-09-14'));

		if (offsetMinutes > 0) {
			// Oeste de Greenwich (ex.: Brasil): meia-noite UTC ainda é 13/09 local.
			expect(viaConstructor).toBe('2026-09-13');
		} else {
			expect(viaConstructor).toBe('2026-09-14');
		}

		// O caminho correto não depende do fuso.
		expect(getISODate(parseISODate('2026-09-14'))).toBe('2026-09-14');
	});

	it('o seletor de data nunca transborda para o mês seguinte', () => {
		// 31 de janeiro, mês trocado para fevereiro: fica em fevereiro.
		expect(getISODate(buildPickedDate(2026, 1, 31))).toBe('2026-02-28');
		expect(getISODate(buildPickedDate(2024, 1, 31))).toBe('2024-02-29');
		// Dia 31 escolhido num mês de 30: fica no último dia.
		expect(getISODate(buildPickedDate(2026, 3, 31))).toBe('2026-04-30');
		// Ano trocado a partir de 29/02: 28/02 do ano comum.
		expect(getISODate(buildPickedDate(2025, 1, 29))).toBe('2025-02-28');

		for (let year = 2020; year <= 2030; year += 1) {
			for (let monthIndex = 0; monthIndex < 12; monthIndex += 1) {
				for (let day = 1; day <= 31; day += 1) {
					expect(buildPickedDate(year, monthIndex, day).getMonth()).toBe(monthIndex);
				}
			}
		}
	});
});
