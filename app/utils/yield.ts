/**
 * Rendimento de uma conta que rende uma fração do CDI (ex.: 120% do CDI).
 *
 * O saldo guardado é uma âncora; o que o banco mostra hoje é essa âncora mais os aportes e
 * saques **mais o rendimento**. Sem somar o rendimento, a conta ficaria sempre abaixo do
 * valor real e precisaria de acerto a cada poucos dias. Aqui ele é estimado:
 *
 *  - O CDI rende por **dia útil** (base 252): a taxa diária é (1 + CDI anual)^(1/252) − 1, e
 *    "120% do CDI" é 1,2 vez essa taxa.
 *  - Cada dia útil depois da âncora e **antes de hoje** rende sobre o saldo daquele dia (o
 *    rendimento de hoje só aparece amanhã, como no banco). Um aporte começa a render no dia
 *    útil seguinte. O rendimento compõe: entra no saldo e rende junto.
 *  - Saldo negativo não rende.
 *
 * É estimativa: o CDI de hoje vale para o período inteiro desde a âncora, e o IR (que o banco
 * só desconta no resgate) não entra — o saldo bruto é o que o app do banco mostra. Acertar o
 * saldo move a âncora e zera o erro acumulado.
 *
 * Puro: nada de React Native, nada de banco, nada de rede.
 */

import { isBusinessDay } from './businessDays';
import { addDays } from './dateUtils';
import { FULL_BASIS_POINTS } from './metrics';
import type { Cents } from './money';

/** Dias úteis num ano, a base do CDI. */
export const CDI_BUSINESS_DAYS = 252;

/** Um movimento da conta depois da âncora: positivo entra, negativo sai. */
export interface YieldFlow {
	date: string;
	cents: Cents;
}

/** A taxa de um dia útil para uma conta que rende `percentOfCdiBp` (12.000 = 120%) do CDI. */
export const cdiDailyRate = (cdiAnnualBp: number, percentOfCdiBp: number): number => {
	if (cdiAnnualBp <= 0 || percentOfCdiBp <= 0) return 0;
	const cdiDaily = (1 + cdiAnnualBp / FULL_BASIS_POINTS) ** (1 / CDI_BUSINESS_DAYS) - 1;
	return (percentOfCdiBp / FULL_BASIS_POINTS) * cdiDaily;
};

export interface YieldInput {
	/** Saldo no fim de `anchorDate`. */
	anchorCents: Cents;
	anchorDate: string;
	/** Movimentos datados depois da âncora. */
	flows: YieldFlow[];
	today: string;
	cdiAnnualBp: number;
	percentOfCdiBp: number;
}

/** O rendimento estimado desde a âncora até ontem, em centavos. */
export const accruedYieldCents = ({ anchorCents, anchorDate, flows, today, cdiAnnualBp, percentOfCdiBp }: YieldInput): Cents => {
	const daily = cdiDailyRate(cdiAnnualBp, percentOfCdiBp);
	if (daily === 0 || anchorDate >= today) return 0;

	const byDate = new Map<string, Cents>();
	for (const flow of flows) {
		if (flow.date <= anchorDate) continue;
		byDate.set(flow.date, (byDate.get(flow.date) ?? 0) + flow.cents);
	}

	let balance = anchorCents;
	let earned = 0;
	for (let day = addDays(anchorDate, 1); day < today; day = addDays(day, 1)) {
		if (isBusinessDay(day)) {
			const gain = Math.max(0, balance) * daily;
			balance += gain;
			earned += gain;
		}
		// O que entrou ou saiu neste dia só rende a partir do próximo dia útil.
		balance += byDate.get(day) ?? 0;
	}
	return Math.round(earned);
};

/**
 * Lê a resposta do Banco Central: `[{"data":"17/09/2026","valor":"14.90"}]`. Nula se o
 * formato não for o esperado ou a taxa não for plausível (entre 0 e 100% ao ano).
 */
export const parseBcbCdi = (json: unknown): { annualBp: number; date: string } | null => {
	if (!Array.isArray(json) || json.length === 0) return null;
	const last = json[json.length - 1] as { data?: unknown; valor?: unknown };
	if (typeof last?.data !== 'string' || (typeof last.valor !== 'string' && typeof last.valor !== 'number')) return null;
	const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(last.data);
	const value = Number(String(last.valor).replace(',', '.'));
	if (!match || !Number.isFinite(value) || value <= 0 || value >= 100) return null;
	return { annualBp: Math.round(value * 100), date: `${match[3]}-${match[2]}-${match[1]}` };
};

/**
 * Todo arquivo sob app/ é tratado como rota pelo expo-router, e uma rota sem export
 * default é um módulo quebrado do ponto de vista dele. Este export existe só para
 * satisfazer essa exigência — nada navega para cá.
 */
export default { cdiDailyRate, accruedYieldCents, parseBcbCdi };
