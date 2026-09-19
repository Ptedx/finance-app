/**
 * Os indicadores de saúde financeira: cinco perguntas que um consultor faria, cada uma
 * com um status (bom, atenção, ruim, sem dados), o valor, o alvo e o porquê.
 *
 *  - Taxa de poupança: quanto da renda ficou com você.
 *  - Reserva de emergência: quantos meses de custo essencial a reserva cobre (ou, sem
 *    custo essencial conhecido, quantos meses de gasto o caixa e o guardado sustentam).
 *  - Custo fixo: quanto da renda já está comprometida antes do mês começar.
 *  - Peso do cartão: as faturas (fechada e aberta) contra a renda média.
 *  - Ritmo de gastos: o mês contra a média, proporcional ao dia em que ele está.
 *
 * Os limiares são os mesmos de `insights.ts` onde eles já existiam, para o painel e as
 * frases nunca discordarem. Puro: nada de React Native, nada de banco.
 */

import {
	HEALTHY_SAVINGS_RATE_BASIS_POINTS,
	HEAVY_FIXED_COST_BASIS_POINTS,
	LOW_SAVINGS_RATE_BASIS_POINTS,
	SOLID_RUNWAY_MONTHS,
	THIN_RUNWAY_MONTHS,
} from './insights';
import { FULL_BASIS_POINTS } from './metrics';
import type { Cents } from './money';

export type HealthStatus = 'good' | 'warn' | 'bad' | 'unknown';

export type HealthIndicatorId = 'savings-rate' | 'emergency-reserve' | 'fixed-cost' | 'card-load' | 'spending-trend';

export interface HealthIndicator {
	id: HealthIndicatorId;
	status: HealthStatus;
	/** Pontos-base ou meses (com uma casa). */
	unit: 'bp' | 'months';
	/** Nulo quando não há como responder. */
	value: number | null;
	/** O alvo, na mesma unidade. */
	target: number;
	/** Bom é ficar acima do alvo (`atLeast`) ou abaixo dele (`atMost`). */
	direction: 'atLeast' | 'atMost';
	/** Valores já formatados para a frase de cada status. */
	params: Record<string, string | number>;
	/** Só na taxa de poupança: quanto seria preciso guardar, em pontos-base da renda. */
	neededBp?: number | null;
	/** Qual frase usar: `essential` quando a reserva é medida pelo custo essencial. */
	variant?: 'essential';
}

export interface HealthInput {
	/** Taxa de poupança do mês selecionado; nula sem renda. */
	savingsRateBp: number | null;
	/** Fatia da renda que a meta pede por mês; nula sem meta ou sem renda. */
	neededSavingsRateBp: number | null;
	/** Caixa mais guardado. */
	liquidCents: Cents;
	/** Gasto médio dos meses fechados; nulo sem histórico. */
	averageMonthlySpendCents: Cents | null;
	/** Custo fixo sobre a renda; nulo sem recorrências ou sem renda. */
	fixedCostBp: number | null;
	/** Fatura fechada por pagar mais a aberta, somando os cartões. */
	cardOwedCents: Cents;
	/** Renda média dos meses fechados; nula sem histórico. */
	averageMonthlyIncomeCents: Cents | null;
	/** Uso do limite no cartão mais carregado, 0-100+; nulo sem limite informado. */
	limitUsagePercent: number | null;
	/** Gasto do mês selecionado até agora. */
	currentSpendCents: Cents;
	/** Quanto do mês selecionado já passou, em pontos-base (10.000 = mês fechado). */
	elapsedBp: number;
	/**
	 * A reserva de emergência da cascata e o custo essencial. Com ela, o indicador mede
	 * reserva ÷ custo essencial contra a meta de meses; sem ela, caixa + guardado ÷ gasto.
	 */
	reserve?: { reserveCents: Cents; monthlyCostCents: Cents; targetMonths: number } | null;
}

export const HEALTH_THRESHOLDS = {
	savingsRate: { good: HEALTHY_SAVINGS_RATE_BASIS_POINTS, warn: LOW_SAVINGS_RATE_BASIS_POINTS },
	reserveMonths: { good: SOLID_RUNWAY_MONTHS, warn: THIN_RUNWAY_MONTHS },
	fixedCost: { good: 4_000, warn: HEAVY_FIXED_COST_BASIS_POINTS },
	cardLoad: { good: 3_000, warn: 5_000, limitWarnPercent: 80 },
	/** Até +5% da média é ritmo normal; até +15% pede atenção. Antes de 15% do mês, é cedo. */
	spendingTrend: { good: 500, warn: 1_500, minElapsedBp: 1_500 },
} as const;

const percentText = (basisPoints: number): string => `${Math.round(basisPoints / 100)}%`;

const monthsText = (months: number): string => months.toFixed(1);

/** Bom acima de `good`, atenção acima de `warn`, ruim abaixo. */
const atLeast = (value: number, good: number, warn: number): HealthStatus => (value >= good ? 'good' : value >= warn ? 'warn' : 'bad');

/** Bom até `good`, atenção até `warn`, ruim acima. */
const atMost = (value: number, good: number, warn: number): HealthStatus => (value <= good ? 'good' : value <= warn ? 'warn' : 'bad');

const savingsRateIndicator = (input: HealthInput): HealthIndicator => {
	const { good, warn } = HEALTH_THRESHOLDS.savingsRate;
	const value = input.savingsRateBp;
	const needed = input.neededSavingsRateBp;
	return {
		id: 'savings-rate',
		status: value === null ? 'unknown' : atLeast(value, good, warn),
		unit: 'bp',
		value,
		target: good,
		direction: 'atLeast',
		params: {
			percent: value === null ? '—' : percentText(value),
			target: percentText(good),
			needed: needed === null ? '—' : percentText(needed),
		},
		neededBp: needed,
	};
};

const emergencyReserveIndicator = (input: HealthInput): HealthIndicator => {
	const reserve = input.reserve;
	if (reserve && reserve.monthlyCostCents > 0) {
		const months = Math.round((Math.max(0, reserve.reserveCents) / reserve.monthlyCostCents) * 10) / 10;
		const target = Math.max(1, reserve.targetMonths);
		return {
			id: 'emergency-reserve',
			status: atLeast(months, target, Math.min(THIN_RUNWAY_MONTHS, target)),
			unit: 'months',
			value: months,
			target,
			direction: 'atLeast',
			params: { months: monthsText(months), target },
			variant: 'essential',
		};
	}
	const { good, warn } = HEALTH_THRESHOLDS.reserveMonths;
	const spend = input.averageMonthlySpendCents;
	const months = spend === null || spend <= 0 ? null : Math.round((Math.max(0, input.liquidCents) / spend) * 10) / 10;
	return {
		id: 'emergency-reserve',
		status: months === null ? 'unknown' : atLeast(months, good, warn),
		unit: 'months',
		value: months,
		target: good,
		direction: 'atLeast',
		params: { months: months === null ? '—' : monthsText(months), target: good },
	};
};

const fixedCostIndicator = (input: HealthInput): HealthIndicator => {
	const { good, warn } = HEALTH_THRESHOLDS.fixedCost;
	const value = input.fixedCostBp;
	return {
		id: 'fixed-cost',
		status: value === null ? 'unknown' : atMost(value, good, warn),
		unit: 'bp',
		value,
		target: good,
		direction: 'atMost',
		params: { percent: value === null ? '—' : percentText(value), target: percentText(good) },
	};
};

const cardLoadIndicator = (input: HealthInput): HealthIndicator => {
	const { good, warn, limitWarnPercent } = HEALTH_THRESHOLDS.cardLoad;
	const income = input.averageMonthlyIncomeCents;
	const value = income === null || income <= 0 ? null : Math.round((Math.max(0, input.cardOwedCents) * FULL_BASIS_POINTS) / income);
	let status: HealthStatus = value === null ? 'unknown' : atMost(value, good, warn);
	// Fatura leve mas limite quase todo tomado: o problema é outro, e vale um aviso.
	const limitHigh = input.limitUsagePercent !== null && input.limitUsagePercent >= limitWarnPercent;
	if (status === 'good' && limitHigh) status = 'warn';
	return {
		id: 'card-load',
		status,
		unit: 'bp',
		value,
		target: good,
		direction: 'atMost',
		params: {
			percent: value === null ? '—' : percentText(value),
			target: percentText(good),
			limitPercent: input.limitUsagePercent === null ? '—' : `${Math.round(input.limitUsagePercent)}%`,
		},
	};
};

const spendingTrendIndicator = (input: HealthInput): HealthIndicator => {
	const { good, warn, minElapsedBp } = HEALTH_THRESHOLDS.spendingTrend;
	const average = input.averageMonthlySpendCents;
	const tooEarly = input.elapsedBp < minElapsedBp;
	const expected = average === null || average <= 0 || tooEarly ? null : Math.round((average * Math.min(FULL_BASIS_POINTS, input.elapsedBp)) / FULL_BASIS_POINTS);
	const value = expected === null || expected <= 0 ? null : Math.round(((input.currentSpendCents - expected) * FULL_BASIS_POINTS) / expected);
	const signed = value === null ? '—' : `${value > 0 ? '+' : ''}${percentText(value)}`;
	return {
		id: 'spending-trend',
		status: value === null ? 'unknown' : atMost(value, good, warn),
		unit: 'bp',
		value,
		target: good,
		direction: 'atMost',
		params: { percent: signed, target: `+${percentText(good)}` },
	};
};

/** Sempre os cinco, sempre nesta ordem: a grade da tela não muda de lugar. */
export const buildHealthIndicators = (input: HealthInput): HealthIndicator[] => [
	savingsRateIndicator(input),
	emergencyReserveIndicator(input),
	fixedCostIndicator(input),
	cardLoadIndicator(input),
	spendingTrendIndicator(input),
];

export const healthSummary = (items: HealthIndicator[]): Record<HealthStatus, number> => {
	const summary: Record<HealthStatus, number> = { good: 0, warn: 0, bad: 0, unknown: 0 };
	for (const item of items) summary[item.status] += 1;
	return summary;
};

/**
 * Todo arquivo sob app/ é tratado como rota pelo expo-router, e uma rota sem export
 * default é um módulo quebrado do ponto de vista dele. Este export existe só para
 * satisfazer essa exigência — nada navega para cá.
 */
export default { buildHealthIndicators, healthSummary };
