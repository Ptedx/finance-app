/**
 * Leitura de riqueza do Spendr: os números da camada de métricas viram frases.
 *
 * Duas funções, nesta ordem:
 *
 *  - `computeWealthMetrics` compõe `metrics.ts` num único read-model. É o objeto que a
 *    tela consome e é o objeto que o chatbot vai consumir como ferramenta de leitura —
 *    um lugar só onde a taxa de poupança, o custo fixo e o fôlego são calculados, para
 *    que a resposta do bot e o card da Home nunca discordem.
 *
 *  - `buildInsights` olha esse read-model e devolve o que vale a pena dizer, já ordenado
 *    por urgência. Cada insight carrega um `id` estável (chave de tradução e de
 *    deduplicação), os números crus que o originaram, e um `title` em inglês que serve de
 *    fallback e de texto para o modelo.
 *
 * Puro como `metrics.ts`: nada de React Native, nada de banco. Os limiares ficam
 * exportados como constantes justamente para poderem ser inspecionados e testados em vez
 * de ficarem enterrados em `if`s.
 */

import {
	type CategoryDelta,
	categoryDeltas,
	consecutiveSavingsRateDrops,
	type ExpenseTotalsByNature,
	fixedCostShare,
	type MonthlySavingsRate,
	type MonthlyTotal,
	monthlyFixedCostCents,
	monthlyRecurringIncomeCents,
	NEEDS_WANTS_SAVINGS_TARGET,
	type NeedsWantsSavings,
	needsWantsSavingsSplit,
	type PeriodTotals,
	type CategoryTotal as PeriodCategoryTotal,
	type RecurringCommitment,
	type SavingsRate,
	runwayMonths,
	savingsRate,
	savingsRateDelta,
	savingsRateTrend,
} from './metrics';
import { monthKeyName } from './dateUtils';
import type { HealthIndicator } from './healthScore';
import { type Cents, formatCents } from './money';
import type { DuplicateIncome } from './reportSeries';
import type { RetirementReadModel } from './retirement';

// ---------------------------------------------------------------------------
// Read-model
// ---------------------------------------------------------------------------

/**
 * Tudo o que o cálculo precisa, no formato em que o banco já entrega.
 *
 * Nenhum campo é opcional por acaso: o que falta vira `null` no resultado em vez de virar
 * zero, porque "não sei" e "zero" levam a conselhos diferentes.
 */
export interface WealthSnapshot {
	/** Mês selecionado, 1-12. Usado para cortar a série anual no ponto certo. */
	month: number;
	/** Receita e despesa do período selecionado. */
	periodTotals: PeriodTotals;
	/** O mesmo do período anterior, quando existe — é a seta ao lado do número. */
	previousPeriodTotals?: PeriodTotals | null;
	/**
	 * Saldo disponível. v1 é o saldo de caixa acumulado (`getBalanceAsOf`); quando o
	 * Pilar 1 existir passa a ser o ativo líquido real, e só este campo muda.
	 */
	liquidCents: Cents;
	/** Recorrências vivas, ativas ou não — o filtro é feito por `metrics.ts`. */
	recurring: RecurringCommitment[];
	/** Despesas do período separadas pela natureza da categoria. */
	expenseTotalsByNature: ExpenseTotalsByNature;
	/** Totais por categoria do período e do período anterior. */
	categoryTotals: PeriodCategoryTotal[];
	previousCategoryTotals: PeriodCategoryTotal[];
	/** Receita e despesa mês a mês do ano corrente. */
	monthlyIncome: MonthlyTotal[];
	monthlyExpense: MonthlyTotal[];
	/** Nome por id, só para as frases ficarem legíveis. */
	categoryNameById?: Record<string, string>;
}

export interface WealthMetrics {
	savingsRate: SavingsRate;
	previousSavingsRate: SavingsRate | null;
	/** Movimento em pontos-base contra o período anterior. `null` sem base. */
	savingsRateDeltaBasisPoints: number | null;
	/** Há quantos meses seguidos a taxa cai, terminando no mês selecionado. */
	consecutiveDrops: number;
	monthlyFixedCents: Cents;
	monthlyRecurringIncomeCents: Cents;
	/** Fatia da renda já comprometida com custo fixo, em pontos-base. */
	fixedCostBasisPoints: number | null;
	/** Meses de fôlego. `null` quando não há custo fixo cadastrado. */
	runwayMonths: number | null;
	split: NeedsWantsSavings;
	categoryDeltas: CategoryDelta[];
	trend: MonthlySavingsRate[];
}

export const computeWealthMetrics = (snapshot: WealthSnapshot): WealthMetrics => {
	const current = savingsRate(snapshot.periodTotals);
	const previous = snapshot.previousPeriodTotals
		? savingsRate(snapshot.previousPeriodTotals)
		: null;

	const monthlyFixedCents = monthlyFixedCostCents(snapshot.recurring);
	const trend = savingsRateTrend(snapshot.monthlyIncome, snapshot.monthlyExpense);

	return {
		savingsRate: current,
		previousSavingsRate: previous,
		savingsRateDeltaBasisPoints: previous ? savingsRateDelta(current, previous) : null,
		consecutiveDrops: consecutiveSavingsRateDrops(trend, snapshot.month),
		monthlyFixedCents,
		monthlyRecurringIncomeCents: monthlyRecurringIncomeCents(snapshot.recurring),
		fixedCostBasisPoints: fixedCostShare({
			monthlyFixedCents,
			incomeCents: snapshot.periodTotals.incomeCents,
		}),
		runwayMonths: runwayMonths({ liquidCents: snapshot.liquidCents, monthlyFixedCents }),
		split: needsWantsSavingsSplit(snapshot.expenseTotalsByNature, current.netCents),
		categoryDeltas: categoryDeltas(snapshot.categoryTotals, snapshot.previousCategoryTotals),
		trend,
	};
};

// ---------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------

/**
 * Quão urgente é a frase.
 *
 * `positive` existe de propósito: um painel que só fala quando algo vai mal ensina o
 * usuário a evitá-lo. `neutral` é contexto, não recado.
 */
export type InsightSeverity = 'critical' | 'attention' | 'positive' | 'neutral';

export type InsightId =
	| 'savings-rate-negative'
	| 'savings-rate-low'
	| 'savings-rate-healthy'
	| 'savings-rate-falling'
	| 'fixed-cost-heavy'
	| 'runway-thin'
	| 'runway-solid'
	| 'needs-over-target'
	| 'category-jump'
	| 'goal-unset'
	| 'goal-reached'
	| 'goal-on-track'
	| 'goal-needs-more'
	| 'goal-no-contribution'
	| 'reserve-yield-low'
	| 'card-load-heavy'
	| 'spending-above-pace'
	| 'income-possibly-duplicated';

export interface Insight {
	/** Estável entre execuções: chave de tradução na UI, chave de deduplicação no bot. */
	id: InsightId;
	severity: InsightSeverity;
	/**
	 * A frase em inglês, já montada. A UI prefere `t('insights.<id>', params)` e cai aqui
	 * quando não há tradução; o modelo lê isto direto.
	 */
	title: string;
	/** Valores para interpolar na tradução, já formatados para exibição. */
	params: Record<string, string | number>;
	/** Os números crus por trás da frase, quando fazem sentido. */
	valueCents?: Cents;
	basisPoints?: number;
	pct?: number;
	months?: number;
	categoryId?: string;
}

/** A partir daqui a taxa de poupança é digna de comemoração (20%). */
export const HEALTHY_SAVINGS_RATE_BASIS_POINTS = 2_000;

/** Abaixo daqui ela é positiva mas frágil (10%). */
export const LOW_SAVINGS_RATE_BASIS_POINTS = 1_000;

/** Duas quedas podem ser ruído; três já são uma tendência que vale relatar. */
export const MIN_CONSECUTIVE_DROPS = 3;

/** Metade da renda comprometida antes de qualquer escolha é o ponto de aperto. */
export const HEAVY_FIXED_COST_BASIS_POINTS = 5_000;

/** Menos de três meses de fôlego é a faixa em que um imprevisto vira dívida. */
export const THIN_RUNWAY_MONTHS = 3;

/** Seis meses é a reserva de emergência clássica. */
export const SOLID_RUNWAY_MONTHS = 6;

/** Uma categoria só "saltou" se subiu um quarto **e** um valor que se sente. */
export const CATEGORY_JUMP_PCT = 0.25;
export const CATEGORY_JUMP_MIN_CENTS = 50_00;

const SEVERITY_ORDER: Record<InsightSeverity, number> = {
	critical: 0,
	attention: 1,
	positive: 2,
	neutral: 3,
};

/** Pontos-base como texto de porcentagem, sem casas decimais falsas. */
const percentText = (basisPoints: number): string => `${Math.round(basisPoints / 100)}%`;

/** Meses com uma casa, que é toda a precisão que "meses de fôlego" comporta. */
const monthsText = (months: number): string => months.toFixed(1);

/**
 * As frases que o mês sustenta, da mais urgente para a menos.
 *
 * Cada regra é independente e silencia sozinha quando falta dado: um mês sem renda não
 * produz insight de taxa de poupança, um app sem recorrência não produz insight de custo
 * fixo. É preferível uma lista curta a uma lista que inventa.
 */
export const buildInsights = (metrics: WealthMetrics, snapshot?: WealthSnapshot): Insight[] => {
	const insights: Insight[] = [];
	const { savingsRate: rate } = metrics;

	// --- Taxa de poupança --------------------------------------------------
	if (rate.netCents < 0 && rate.incomeCents > 0) {
		insights.push({
			id: 'savings-rate-negative',
			severity: 'critical',
			title: `You spent ${formatCents(Math.abs(rate.netCents))} more than you earned this month.`,
			params: { amount: formatCents(Math.abs(rate.netCents)) },
			valueCents: rate.netCents,
		});
	} else if (rate.basisPoints !== null) {
		if (rate.basisPoints >= HEALTHY_SAVINGS_RATE_BASIS_POINTS) {
			insights.push({
				id: 'savings-rate-healthy',
				severity: 'positive',
				title: `You turned ${percentText(rate.basisPoints)} of your income into savings.`,
				params: { percent: percentText(rate.basisPoints) },
				basisPoints: rate.basisPoints,
				valueCents: rate.netCents,
			});
		} else if (rate.basisPoints < LOW_SAVINGS_RATE_BASIS_POINTS) {
			insights.push({
				id: 'savings-rate-low',
				severity: 'attention',
				title: `Only ${percentText(rate.basisPoints)} of your income became savings this month.`,
				params: { percent: percentText(rate.basisPoints) },
				basisPoints: rate.basisPoints,
				valueCents: rate.netCents,
			});
		}
	}

	if (metrics.consecutiveDrops >= MIN_CONSECUTIVE_DROPS) {
		insights.push({
			id: 'savings-rate-falling',
			severity: 'attention',
			title: `Your savings rate has fallen ${metrics.consecutiveDrops} months in a row.`,
			params: { months: metrics.consecutiveDrops },
			months: metrics.consecutiveDrops,
		});
	}

	// --- Custo fixo e fôlego -----------------------------------------------
	if (
		metrics.fixedCostBasisPoints !== null &&
		metrics.fixedCostBasisPoints >= HEAVY_FIXED_COST_BASIS_POINTS
	) {
		insights.push({
			id: 'fixed-cost-heavy',
			severity: 'attention',
			title: `${percentText(metrics.fixedCostBasisPoints)} of your income is committed to fixed costs before you choose anything.`,
			params: {
				percent: percentText(metrics.fixedCostBasisPoints),
				amount: formatCents(metrics.monthlyFixedCents),
			},
			basisPoints: metrics.fixedCostBasisPoints,
			valueCents: metrics.monthlyFixedCents,
		});
	}

	if (metrics.runwayMonths !== null) {
		if (metrics.runwayMonths < THIN_RUNWAY_MONTHS) {
			insights.push({
				id: 'runway-thin',
				severity: 'critical',
				title: `Your balance covers about ${monthsText(metrics.runwayMonths)} months of fixed costs.`,
				params: { months: monthsText(metrics.runwayMonths) },
				months: metrics.runwayMonths,
			});
		} else if (metrics.runwayMonths >= SOLID_RUNWAY_MONTHS) {
			insights.push({
				id: 'runway-solid',
				severity: 'positive',
				title: `Your balance covers about ${monthsText(metrics.runwayMonths)} months of fixed costs.`,
				params: { months: monthsText(metrics.runwayMonths) },
				months: metrics.runwayMonths,
			});
		}
	}

	// --- Necessidades acima da meta ----------------------------------------
	// Só quando alguém de fato classificou algo: sem a tag tudo cai em "desejos" e a
	// comparação com o 50/30/20 falaria de um dado que não existe.
	if (
		metrics.split.needsBasisPoints !== null &&
		metrics.split.needsCents > 0 &&
		metrics.split.needsBasisPoints > NEEDS_WANTS_SAVINGS_TARGET.needsBasisPoints
	) {
		insights.push({
			id: 'needs-over-target',
			severity: 'neutral',
			title: `Essentials took ${percentText(metrics.split.needsBasisPoints)} of the month, above the 50% reference.`,
			params: { percent: percentText(metrics.split.needsBasisPoints) },
			basisPoints: metrics.split.needsBasisPoints,
			valueCents: metrics.split.needsCents,
		});
	}

	// --- A categoria que explica o mês --------------------------------------
	const jump = metrics.categoryDeltas.find(
		(delta) =>
			delta.pct !== null &&
			delta.pct >= CATEGORY_JUMP_PCT &&
			delta.deltaCents >= CATEGORY_JUMP_MIN_CENTS
	);

	if (jump) {
		const name = snapshot?.categoryNameById?.[jump.categoryId] ?? jump.categoryId;
		const percent = `${Math.round((jump.pct ?? 0) * 100)}%`;

		insights.push({
			id: 'category-jump',
			severity: 'attention',
			title: `You spent ${percent} more on ${name} than last month (${formatCents(jump.deltaCents)}).`,
			params: { category: name, percent, amount: formatCents(jump.deltaCents) },
			valueCents: jump.deltaCents,
			pct: jump.pct ?? undefined,
			categoryId: jump.categoryId,
		});
	}

	// Empate resolvido pela ordem de inserção acima, que já vai do estrutural (poupança,
	// custo fixo) para o episódico (uma categoria que saltou num mês).
	return insights.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
};

// ---------------------------------------------------------------------------
// Insights da meta, da saúde e da renda
// ---------------------------------------------------------------------------

/** O horizonte de referência para "está no ritmo?": chegar em até 20 anos. */
export const GOAL_ON_TRACK_YEARS = 20;

/** Rendimento observado abaixo da metade do esperado merece uma frase. */
export const LOW_REALIZED_YIELD_RATIO = 0.5;

const yearsText = (years: number): string => (Number.isInteger(years) ? String(years) : years.toFixed(1));

const monthText = (key: string): string => `${monthKeyName(key)} ${key.slice(0, 4)}`;

/**
 * As frases sobre a meta de aposentadoria, a grade de saúde e a renda contada duas
 * vezes. Separadas de `buildInsights` porque os insumos vêm de outro lugar (a meta, o
 * histórico de meses, a lista do mês); quem monta a tela junta as duas listas.
 */
export const buildGoalInsights = (retirement: RetirementReadModel | null, health: HealthIndicator[], duplicates: DuplicateIncome[]): Insight[] => {
	const insights: Insight[] = [];

	// --- Receita possivelmente duplicada: antes de tudo, porque distorce o resto ------
	for (const duplicate of duplicates) {
		insights.push({
			id: 'income-possibly-duplicated',
			severity: 'critical',
			title: `${formatCents(duplicate.amountCents)} came in twice (${duplicate.dates[0]} and ${duplicate.dates[1]}). If it is the same money, delete one.`,
			params: { amount: formatCents(duplicate.amountCents), first: duplicate.dates[0], second: duplicate.dates[1] },
			valueCents: duplicate.amountCents,
		});
	}

	// --- A meta -----------------------------------------------------------------------
	if (retirement === null) {
		insights.push({
			id: 'goal-unset',
			severity: 'neutral',
			title: 'Set a retirement goal to see how far you are from living off your investments.',
			params: {},
		});
	} else {
		const { reach } = retirement;
		const horizon = retirement.contributionByHorizon.find((h) => h.years === GOAL_ON_TRACK_YEARS)?.monthlyCents ?? null;
		if (reach.kind === 'reached') {
			insights.push({
				id: 'goal-reached',
				severity: 'positive',
				title: `Your capital already covers ${formatCents(retirement.requiredMonthlyCents)} a month. You are there.`,
				params: { amount: formatCents(retirement.requiredMonthlyCents) },
				valueCents: retirement.capitalCents,
			});
		} else if (reach.kind === 'eta' && reach.years <= GOAL_ON_TRACK_YEARS) {
			insights.push({
				id: 'goal-on-track',
				severity: 'positive',
				title: `Saving ${formatCents(retirement.monthlyContributionCents)} a month, you reach your goal in ${yearsText(reach.years)} years (${monthText(reach.month)}).`,
				params: { amount: formatCents(retirement.monthlyContributionCents), years: yearsText(reach.years), month: monthText(reach.month) },
				valueCents: retirement.monthlyContributionCents,
				months: reach.months,
			});
		} else if (reach.kind === 'never' && reach.reason === 'no-contribution') {
			insights.push({
				id: 'goal-no-contribution',
				severity: 'attention',
				title: 'Nothing has gone into your reserve in the last months, so the goal is not getting closer.',
				params: { amount: horizon === null ? '—' : formatCents(horizon), years: GOAL_ON_TRACK_YEARS },
				valueCents: horizon ?? undefined,
			});
		} else if (reach.kind !== 'never' || reach.reason !== 'no-yield') {
			insights.push({
				id: 'goal-needs-more',
				severity: 'attention',
				title: `To get there in ${GOAL_ON_TRACK_YEARS} years you would need ${horizon === null ? '—' : formatCents(horizon)} a month; you are saving ${formatCents(Math.max(0, retirement.monthlyContributionCents))}.`,
				params: {
					needed: horizon === null ? '—' : formatCents(horizon),
					amount: formatCents(Math.max(0, retirement.monthlyContributionCents)),
					years: GOAL_ON_TRACK_YEARS,
				},
				valueCents: horizon ?? undefined,
			});
		}

		if (retirement.realizedYieldBp !== null && retirement.realizedYieldBp < retirement.expectedYieldBp * LOW_REALIZED_YIELD_RATIO) {
			insights.push({
				id: 'reserve-yield-low',
				severity: 'attention',
				title: `Your reserve yielded ${percentText(retirement.realizedYieldBp)} in the last 12 months, against the ${percentText(retirement.expectedYieldBp)} you expect.`,
				params: { realized: percentText(retirement.realizedYieldBp), expected: percentText(retirement.expectedYieldBp) },
				basisPoints: retirement.realizedYieldBp,
			});
		}
	}

	// --- A grade de saúde: só o que está no vermelho e ainda não tem frase ------------
	for (const indicator of health) {
		if (indicator.status !== 'bad') continue;
		if (indicator.id === 'card-load') {
			insights.push({
				id: 'card-load-heavy',
				severity: 'critical',
				title: `Your card invoices add up to ${indicator.params.percent} of a month's income.`,
				params: indicator.params,
				basisPoints: indicator.value ?? undefined,
			});
		} else if (indicator.id === 'spending-trend') {
			insights.push({
				id: 'spending-above-pace',
				severity: 'attention',
				title: `You are spending ${indicator.params.percent} above your usual pace for this point of the month.`,
				params: indicator.params,
				basisPoints: indicator.value ?? undefined,
			});
		}
	}

	return insights.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
};

/** Junta as duas listas numa só, da mais urgente para a menos. */
export const mergeInsights = (...lists: Insight[][]): Insight[] =>
	lists.flat().sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

/**
 * Todo arquivo sob app/ e tratado como rota pelo expo-router, e uma rota sem export
 * default e um modulo quebrado do ponto de vista dele. Este export existe so para
 * satisfazer essa exigencia — nada navega para ca. Mesma convencao de metrics.ts,
 * money.ts e dos demais utilitarios do projeto.
 */
export default { computeWealthMetrics, buildInsights, buildGoalInsights, mergeInsights };
