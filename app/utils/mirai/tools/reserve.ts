import i18next from 'i18next';
import { loadCachedCdi } from '../../../api/cdi';
import { healthSummary } from '../../healthScore';
import { getMoneyConfig } from '../../money';
import type { ReportsToday } from './snapshot';

/**
 * `get_reserve_and_goals`: a reserva de emergência e a meta de aposentadoria do Patrimônio
 * (`reserve` e `retirement` de `useReportsData` ancorado em hoje), com as metas gravadas.
 */
export const getReserveAndGoals = (reports: ReportsToday) => {
	const { reserve, retirement, goal, reserveGoal } = reports;
	return {
		reserve: {
			status: reserve.status,
			/** A parte do guardado que é reserva (a cascata da reserva). */
			currentCents: reserve.split.reserveCents,
			targetCents: reserve.targetCents,
			targetMonths: reserve.targetMonths,
			monthlyCostCents: reserve.monthlyCostCents,
			costSource: reserve.costSource,
			monthsCovered: reserve.monthsCovered,
			progressBp: reserve.progressBp,
			gapCents: reserve.gapCents,
			monthsToFill: reserve.monthsToFill,
			/** O que passa da meta nas contas de reserva, mais as contas "só investimento". */
			investedBeyondReserveCents: reserve.split.investmentCents,
		},
		reserveGoal: {
			targetMonths: reserveGoal.targetMonths,
			customMonthlyCostCents: reserveGoal.customMonthlyCostCents,
		},
		retirementGoal:
			goal === null || retirement === null
				? null
				: {
						targetMonthlyCents: goal.targetMonthlyCents,
						reinvestBp: goal.reinvestBp,
						expectedYieldYearBp: goal.expectedYieldBp,
						outsideCapitalCents: goal.outsideCapitalCents,
						requiredMonthlyCents: retirement.requiredMonthlyCents,
						requiredCapitalCents: retirement.requiredCapitalCents,
						capitalCents: retirement.capitalCents,
						passiveIncomeNowCents: retirement.passiveIncomeNowCents,
						realizedYieldYearBp: retirement.realizedYieldBp,
						progressBp: retirement.progressBp,
						monthlyContributionCents: retirement.monthlyContributionCents,
						reach: retirement.reach,
						contributionByHorizon: retirement.contributionByHorizon,
					},
	};
};

/**
 * `get_health`: a saúde financeira do Patrimônio (`health` de `useReportsData`). O app não dá
 * uma nota única: são cinco fatores, cada um bom, atenção, ruim ou sem dados, e a contagem
 * deles (`healthSummary`) é o resumo.
 */
export const getHealth = (reports: ReportsToday) => ({
	summary: healthSummary(reports.health),
	factors: reports.health.map((item) => ({
		id: item.id,
		status: item.status,
		unit: item.unit,
		value: item.value,
		target: item.target,
		direction: item.direction,
		neededBp: item.neededBp ?? null,
		variant: item.variant ?? null,
		params: item.params,
	})),
});

/**
 * `get_rates`: o CDI que o app usa (o último guardado da consulta ao Banco Central — o app não
 * tem campo para a pessoa digitar a taxa), a moeda e o idioma.
 */
export const getRates = async () => {
	const cdi = await loadCachedCdi();
	return {
		cdiYearBp: cdi?.annualBp ?? null,
		cdiDate: cdi?.date ?? null,
		currency: getMoneyConfig().currencyCode,
		language: i18next.language || null,
	};
};

/** Todo arquivo sob app/ é rota para o expo-router; o export default só satisfaz essa exigência. */
export default { getReserveAndGoals, getHealth, getRates };
