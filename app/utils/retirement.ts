/**
 * A conta da liberdade financeira: quanto capital é preciso para uma renda passiva, quão
 * perto o usuário está e em quanto tempo chega nesse ritmo.
 *
 * A regra que o usuário definiu: a renda que os investimentos precisam gerar é a renda
 * desejada **mais uma margem reinvestida** (25% por padrão) para o capital acompanhar a
 * inflação. R$ 10.000/mês viram R$ 12.500 brutos, e a 10% ao ano isso pede
 * R$ 1.500.000 de capital.
 *
 * Tudo em centavos inteiros e pontos-base; a taxa mensal é a única fração, e vive só
 * dentro das contas. `null` é "não dá para responder" (rendimento zero, sem aporte), nunca
 * zero disfarçado. Puro: nada de React Native, nada de banco.
 */

import { shiftMonthKey } from './dateUtils';
import { FULL_BASIS_POINTS } from './metrics';
import type { Cents } from './money';

/** A margem reinvestida por padrão: +25% sobre a renda desejada. */
export const DEFAULT_REINVEST_BP = 2_500;

/** Rentabilidade esperada por padrão: 10% ao ano, perto do CDI. */
export const DEFAULT_EXPECTED_YIELD_BP = 1_000;

/** Além de 100 anos a meta é, para todo efeito, inalcançável nesse ritmo. */
export const MAX_HORIZON_MONTHS = 1_200;

/** Quantos pontos a projeção devolve, no máximo — o suficiente para um gráfico. */
export const PROJECTION_MAX_POINTS = 120;

/** Horizontes fixos para "quanto guardar por mês para chegar em N anos". */
export const CONTRIBUTION_HORIZONS_YEARS = [5, 10, 15, 20] as const;

/** Quando a meta não chega nunca nesse ritmo, a projeção mostra 30 anos mesmo assim. */
export const NEVER_PROJECTION_MONTHS = 360;

const MONTHS_IN_YEAR = 12;

export interface RetirementGoal {
	/** A renda passiva desejada, líquida, por mês. */
	targetMonthlyCents: Cents;
	/** Margem reinvestida sobre a renda desejada, em pontos-base (2.500 = +25%). */
	reinvestBp: number;
	/** Rentabilidade esperada ao ano, em pontos-base (1.000 = 10%). */
	expectedYieldBp: number;
	/** Investimentos que o app não acompanha (corretora, previdência). */
	outsideCapitalCents: Cents;
}

export interface RetirementInput {
	goal: RetirementGoal;
	/** O que está nas contas de reserva do app hoje. */
	trackedCapitalCents: Cents;
	/** Quanto tem ido para a reserva por mês, em média. Pode ser zero ou negativo. */
	monthlyContributionCents: Cents;
	/** Rendimento captado nas reservas nos últimos 12 meses; nulo sem histórico. */
	realizedYield12mCents: Cents | null;
	/** Saldo médio das reservas nesses 12 meses; nulo sem histórico. */
	averageCapital12mCents: Cents | null;
	/** Mês de hoje, `YYYY-MM`: é daqui que a data de chegada é contada. */
	asOfMonth: string;
}

export type GoalReach =
	| { kind: 'reached' }
	| { kind: 'eta'; months: number; month: string; years: number }
	| { kind: 'never'; reason: 'no-contribution' | 'beyond-horizon' | 'no-yield' };

export interface ProjectionPoint {
	monthOffset: number;
	/** Capital inicial mais os aportes até aqui: o que saiu do bolso. */
	contributedCents: Cents;
	/** Com os juros. */
	totalCents: Cents;
	/** `totalCents − contributedCents`: o que o dinheiro rendeu sozinho. */
	interestCents: Cents;
}

export interface RetirementReadModel {
	/** A renda desejada, líquida. */
	targetMonthlyCents: Cents;
	/** A renda que o capital precisa gerar: desejada mais a margem reinvestida. */
	requiredMonthlyCents: Cents;
	/** Nulo quando o rendimento é zero: não há capital que gere renda a 0%. */
	requiredCapitalCents: Cents | null;
	/** Reservas do app mais o que está fora dele. */
	capitalCents: Cents;
	/** O que o capital de hoje gera por mês no rendimento esperado. */
	passiveIncomeNowCents: Cents;
	/** O rendimento esperado da meta, ao ano, para comparar com o observado. */
	expectedYieldBp: number;
	/** O rendimento de fato observado nas reservas, ao ano; nulo sem histórico. */
	realizedYieldBp: number | null;
	/** Capital de hoje sobre o necessário, 0..10.000; nulo sem capital necessário. */
	progressBp: number | null;
	monthlyContributionCents: Cents;
	reach: GoalReach;
	projection: ProjectionPoint[];
	/** Quanto guardar por mês para chegar em cada horizonte; nulo quando não dá. */
	contributionByHorizon: Array<{ years: number; monthlyCents: Cents | null }>;
}

const safe = (value: number): number => (Number.isFinite(value) ? value : 0);

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** A renda bruta que o capital precisa gerar: a desejada mais a margem reinvestida. */
export const requiredMonthlyCents = (targetMonthlyCents: Cents, reinvestBp: number): Cents => {
	const target = safe(targetMonthlyCents);
	if (target <= 0) return 0;
	return Math.round((target * (FULL_BASIS_POINTS + Math.max(0, safe(reinvestBp)))) / FULL_BASIS_POINTS);
};

/**
 * O capital que gera `requiredMonthly` por mês a `yieldBp` ao ano. Nulo quando o
 * rendimento é zero — nenhum capital finito gera renda a 0%.
 */
export const requiredCapitalCents = (requiredMonthly: Cents, yieldBp: number): Cents | null => {
	const monthly = safe(requiredMonthly);
	const yieldRate = safe(yieldBp);
	if (monthly <= 0 || yieldRate <= 0) return null;
	return Math.round((monthly * MONTHS_IN_YEAR * FULL_BASIS_POINTS) / yieldRate);
};

/**
 * Taxa mensal simples: anual ÷ 12. Escolhida de propósito no lugar da equivalente
 * composta, para que "renda passiva hoje = capital × rendimento ÷ 12" e a projeção
 * contem a mesma história.
 */
export const monthlyRate = (yieldBp: number): number => Math.max(0, safe(yieldBp)) / FULL_BASIS_POINTS / MONTHS_IN_YEAR;

/** O que um capital gera por mês, no rendimento esperado. */
export const passiveIncomeCents = (capitalCents: Cents, yieldBp: number): Cents =>
	Math.round(Math.max(0, safe(capitalCents)) * monthlyRate(yieldBp));

/** Capital sobre o necessário, em pontos-base e sem passar de 100%. */
export const progressBp = (capitalCents: Cents, requiredCapital: Cents | null): number | null => {
	if (requiredCapital === null || requiredCapital <= 0) return null;
	return clamp(Math.round((Math.max(0, safe(capitalCents)) * FULL_BASIS_POINTS) / requiredCapital), 0, FULL_BASIS_POINTS);
};

/** Valor futuro de um capital com aportes mensais constantes, `n` meses adiante. */
export const futureValueCents = (capitalCents: Cents, contributionCents: Cents, rate: number, months: number): Cents => {
	const capital = safe(capitalCents);
	const contribution = safe(contributionCents);
	if (rate <= 0) return Math.round(capital + contribution * months);
	const growth = (1 + rate) ** months;
	return Math.round(capital * growth + (contribution * (growth - 1)) / rate);
};

export interface ReachInput {
	capitalCents: Cents;
	contributionCents: Cents;
	monthlyRate: number;
	requiredCapitalCents: Cents | null;
}

/**
 * Em quantos meses o capital chega ao necessário, nesse ritmo. Zero quando já chegou;
 * nulo quando não chega (sem aporte e sem rendimento, ou além de 100 anos).
 *
 * A fórmula fechada dá o ponto de partida e o laço acerta o arredondamento: o log de
 * ponto flutuante erra por um mês nas bordas, e "chega em outubro" tem que ser verdade.
 */
export const monthsToReach = ({ capitalCents, contributionCents, monthlyRate: rate, requiredCapitalCents: required }: ReachInput): number | null => {
	if (required === null || required <= 0) return null;
	const capital = Math.max(0, safe(capitalCents));
	if (capital >= required) return 0;
	const contribution = safe(contributionCents);

	let months: number;
	if (rate <= 0) {
		if (contribution <= 0) return null;
		months = Math.ceil((required - capital) / contribution);
	} else {
		const denominator = capital * rate + contribution;
		if (denominator <= 0) return null;
		months = Math.ceil(Math.log((required * rate + contribution) / denominator) / Math.log(1 + rate));
	}
	if (!Number.isFinite(months)) return null;
	months = Math.max(1, months);

	while (months > 1 && futureValueCents(capital, contribution, rate, months - 1) >= required) months -= 1;
	while (months <= MAX_HORIZON_MONTHS && futureValueCents(capital, contribution, rate, months) < required) months += 1;

	return months > MAX_HORIZON_MONTHS ? null : months;
};

export interface HorizonInput {
	capitalCents: Cents;
	requiredCapitalCents: Cents | null;
	monthlyRate: number;
	months: number;
}

/** O aporte mensal que leva o capital ao necessário em exatamente `months` meses. */
export const contributionForHorizon = ({ capitalCents, requiredCapitalCents: required, monthlyRate: rate, months }: HorizonInput): Cents | null => {
	if (required === null || required <= 0 || months <= 0) return null;
	const capital = Math.max(0, safe(capitalCents));
	if (capital >= required) return 0;
	if (rate <= 0) return Math.ceil((required - capital) / months);
	const growth = (1 + rate) ** months;
	return Math.max(0, Math.ceil(((required - capital * growth) * rate) / (growth - 1)));
};

export interface ProjectionInput {
	capitalCents: Cents;
	contributionCents: Cents;
	monthlyRate: number;
	months: number;
	maxPoints?: number;
}

/**
 * A curva do capital mês a mês, separando o que saiu do bolso do que os juros fizeram.
 * Aporte negativo (a reserva vem encolhendo) projeta como zero: a curva mostra o que o
 * capital de hoje faria sozinho, não uma sangria.
 */
export const projectCapital = ({ capitalCents, contributionCents, monthlyRate: rate, months, maxPoints = PROJECTION_MAX_POINTS }: ProjectionInput): ProjectionPoint[] => {
	const capital = Math.max(0, safe(capitalCents));
	const contribution = Math.max(0, safe(contributionCents));
	const total = Math.max(0, Math.floor(months));
	const step = Math.max(1, Math.ceil(total / Math.max(1, maxPoints)));

	const points: ProjectionPoint[] = [];
	const push = (offset: number) => {
		const totalCents = futureValueCents(capital, contribution, rate, offset);
		const contributedCents = Math.round(capital + contribution * offset);
		points.push({ monthOffset: offset, contributedCents, totalCents, interestCents: totalCents - contributedCents });
	};
	for (let offset = 0; offset < total; offset += step) push(offset);
	push(total);
	return points;
};

/** Média dos últimos `k` meses (ou dos que houver); zero sem nenhum. */
export const averageContributionCents = (savedByMonth: Cents[], k: number): Cents => {
	const window = savedByMonth.slice(-Math.max(1, k));
	if (window.length === 0) return 0;
	return Math.round(window.reduce((sum, value) => sum + safe(value), 0) / window.length);
};

/** Rendimento observado ao ano, em pontos-base; nulo sem capital médio. */
export const realizedYieldBp = (yield12mCents: Cents | null, averageCapitalCents: Cents | null): number | null => {
	if (yield12mCents === null || averageCapitalCents === null || averageCapitalCents <= 0) return null;
	return Math.round((safe(yield12mCents) * FULL_BASIS_POINTS) / averageCapitalCents);
};

const reachOf = (input: ReachInput, asOfMonth: string): GoalReach => {
	if (input.requiredCapitalCents === null) return { kind: 'never', reason: 'no-yield' };
	const months = monthsToReach(input);
	if (months === 0) return { kind: 'reached' };
	if (months === null) {
		const growsAlone = input.contributionCents > 0 || (Math.max(0, input.capitalCents) > 0 && input.monthlyRate > 0);
		return { kind: 'never', reason: growsAlone ? 'beyond-horizon' : 'no-contribution' };
	}
	return { kind: 'eta', months, month: shiftMonthKey(asOfMonth, months), years: Math.round((months / MONTHS_IN_YEAR) * 10) / 10 };
};

/** Tudo o que a tela mostra, calculado de uma vez a partir da meta e do que o app sabe. */
export const buildRetirementReadModel = (input: RetirementInput): RetirementReadModel => {
	const { goal } = input;
	const requiredMonthly = requiredMonthlyCents(goal.targetMonthlyCents, goal.reinvestBp);
	const requiredCapital = requiredCapitalCents(requiredMonthly, goal.expectedYieldBp);
	const capitalCents = Math.max(0, safe(input.trackedCapitalCents)) + Math.max(0, safe(goal.outsideCapitalCents));
	const rate = monthlyRate(goal.expectedYieldBp);
	const contribution = safe(input.monthlyContributionCents);

	const reachInput: ReachInput = { capitalCents, contributionCents: contribution, monthlyRate: rate, requiredCapitalCents: requiredCapital };
	const reach = reachOf(reachInput, input.asOfMonth);

	const projectionMonths = reach.kind === 'eta' ? reach.months : reach.kind === 'reached' ? 0 : NEVER_PROJECTION_MONTHS;

	return {
		targetMonthlyCents: Math.max(0, safe(goal.targetMonthlyCents)),
		requiredMonthlyCents: requiredMonthly,
		requiredCapitalCents: requiredCapital,
		capitalCents,
		passiveIncomeNowCents: passiveIncomeCents(capitalCents, goal.expectedYieldBp),
		expectedYieldBp: Math.max(0, safe(goal.expectedYieldBp)),
		realizedYieldBp: realizedYieldBp(input.realizedYield12mCents, input.averageCapital12mCents),
		progressBp: progressBp(capitalCents, requiredCapital),
		monthlyContributionCents: contribution,
		reach,
		projection: projectCapital({ capitalCents, contributionCents: contribution, monthlyRate: rate, months: projectionMonths }),
		contributionByHorizon: CONTRIBUTION_HORIZONS_YEARS.map((years) => ({
			years,
			monthlyCents: contributionForHorizon({ capitalCents, requiredCapitalCents: requiredCapital, monthlyRate: rate, months: years * MONTHS_IN_YEAR }),
		})),
	};
};

/**
 * Todo arquivo sob app/ é tratado como rota pelo expo-router, e uma rota sem export
 * default é um módulo quebrado do ponto de vista dele. Este export existe só para
 * satisfazer essa exigência — nada navega para cá.
 */
export default { buildRetirementReadModel, monthsToReach, contributionForHorizon, projectCapital };
