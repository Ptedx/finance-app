/**
 * A reserva de emergência: quanto ela deve ter, quanto já tem e quanto falta.
 *
 * O tamanho vem do **custo essencial** — o que continua saindo num mês em que tudo dá
 * errado (moradia, mercado, saúde, parcelas), sem o que dá para cortar. Ele sai do gasto
 * do mês como a Home o conta (`totalSpendCents`: fatura que fecha no mês, custo do
 * envelope, repasse fora) vezes a fatia essencial das categorias. Somar "custo fixo +
 * categorias essenciais" contaria duas vezes a recorrência que já virou lançamento.
 *
 * O dinheiro guardado segue uma **cascata**: as contas de reserva enchem primeiro a
 * reserva, até a meta; só o que passa dela é capital de investimento (o que a meta de
 * aposentadoria acompanha). Uma conta marcada "só investimento" fica fora da cascata.
 * Sem custo conhecido não há meta, e tudo continua capital, como antes da reserva existir.
 *
 * Puro: nada de React Native, nada de banco.
 */

import type { CategoryNature } from '../database/schema';
import { FULL_BASIS_POINTS } from './metrics';
import type { Cents } from './money';
import type { MonthPoint } from './reportSeries';

/** Abaixo disto a reserva é fina: é o primeiro degrau da ordem de prioridade. */
export const MIN_RESERVE_MONTHS = 3;

/** Meses fechados que entram na média do custo essencial. */
export const ESSENTIAL_WINDOW_MONTHS = 3;

/** Até onde `monthsToFill` procura (50 anos); além disso, é nulo. */
const MAX_FILL_MONTHS = 600;

export interface CategoryMonthRow {
	month: string;
	categoryId: string | null;
	totalCents: number;
}

/**
 * Fatia essencial do gasto, em pontos-base. O repasse fica fora (não é gasto) e uma
 * categoria desconhecida conta como discricionária — o padrão de toda categoria nova.
 * Nula sem gasto classificável.
 */
export const essentialShareBp = (rows: CategoryMonthRow[], natureById: Map<string, CategoryNature>): number | null => {
	let essential = 0;
	let other = 0;
	for (const row of rows) {
		const cents = Math.max(0, row.totalCents);
		const nature = row.categoryId ? natureById.get(row.categoryId) : undefined;
		if (nature === 'passthrough') continue;
		if (nature === 'essential') essential += cents;
		else other += cents;
	}
	const total = essential + other;
	return total > 0 ? Math.round((essential * FULL_BASIS_POINTS) / total) : null;
};

/**
 * Custo essencial médio dos últimos meses fechados **com gasto**. Um mês fechado vazio é
 * de antes do app estar em uso, não um mês sem custo: entrar na média o puxaria para baixo.
 */
export const essentialMonthlyCostCents = (
	series: MonthPoint[],
	rows: CategoryMonthRow[],
	natureById: Map<string, CategoryNature>,
	k = ESSENTIAL_WINDOW_MONTHS
): Cents | null => {
	const costs: Cents[] = [];
	for (const point of series.filter((p) => !p.isCurrent && p.overview.totalSpendCents > 0).slice(-Math.max(1, k))) {
		const share = essentialShareBp(
			rows.filter((row) => row.month === point.month),
			natureById
		);
		if (share === null) continue;
		costs.push(Math.round((point.overview.totalSpendCents * share) / FULL_BASIS_POINTS));
	}
	if (costs.length === 0) return null;
	return Math.round(costs.reduce((sum, cost) => sum + cost, 0) / costs.length);
};

/** De onde veio o custo mensal que a meta usa. */
export type CostSource = 'custom' | 'history' | 'budget';

export interface MonthlyCostInput {
	/** O custo informado à mão; vence tudo. */
	customCents: Cents | null;
	/** A média dos meses fechados (`essentialMonthlyCostCents`). */
	historyCents: Cents | null;
	/** O orçamento do mês, para quem ainda não tem mês fechado. */
	budgetCents: Cents | null;
	/** Fatia essencial do mês atual, aplicada ao orçamento. */
	currentShareBp: number | null;
}

/** O custo mensal e a fonte, na ordem: à mão → histórico → orçamento. Nulo sem nenhum. */
export const resolveMonthlyCost = (input: MonthlyCostInput): { cents: Cents; source: CostSource } | null => {
	if (input.customCents !== null && input.customCents > 0) return { cents: input.customCents, source: 'custom' };
	if (input.historyCents !== null && input.historyCents > 0) return { cents: input.historyCents, source: 'history' };
	if (input.budgetCents !== null && input.budgetCents > 0 && input.currentShareBp !== null && input.currentShareBp > 0) {
		return { cents: Math.round((input.budgetCents * input.currentShareBp) / FULL_BASIS_POINTS), source: 'budget' };
	}
	return null;
};

export interface ReserveAccount {
	balanceCents: Cents;
	/** `'investment'` fica fora da cascata. */
	purpose: 'investment' | null;
}

export interface SavingsSplit {
	/** O que entra na cascata: as contas de reserva não marcadas. */
	poolCents: Cents;
	/** A parte do pool que é reserva de emergência. */
	reserveCents: Cents;
	/** Capital de investimento: o excedente do pool mais as contas "só investimento". */
	investmentCents: Cents;
}

/**
 * A cascata. Sem meta (`targetCents` nulo), nada é reserva: tudo é capital, como antes.
 * Um saldo negativo não vira reserva negativa — conta como zero dos dois lados.
 */
export const splitSavings = (accounts: ReserveAccount[], targetCents: Cents | null): SavingsSplit => {
	let pool = 0;
	let investmentOnly = 0;
	for (const account of accounts) {
		const balance = Math.max(0, account.balanceCents);
		if (account.purpose === 'investment') investmentOnly += balance;
		else pool += balance;
	}
	const reserve = targetCents === null ? 0 : Math.min(pool, Math.max(0, targetCents));
	return { poolCents: pool, reserveCents: reserve, investmentCents: pool - reserve + investmentOnly };
};

export type ReserveStatus = 'unknown' | 'thin' | 'building' | 'ready';

export interface ReserveInput {
	accounts: ReserveAccount[];
	targetMonths: number;
	cost: { cents: Cents; source: CostSource } | null;
	/** Aporte médio nas reservas por mês (o mesmo da meta de aposentadoria). */
	monthlyContributionCents: Cents;
	/** Rendimento mensal esperado, fração (0,008 = 0,8% ao mês). */
	monthlyRate: number;
}

export interface ReserveReadModel {
	status: ReserveStatus;
	monthlyCostCents: Cents | null;
	costSource: CostSource | null;
	targetMonths: number;
	/** Nulo sem custo conhecido. */
	targetCents: Cents | null;
	split: SavingsSplit;
	/** Reserva ÷ meta, em pontos-base, até 10.000. */
	progressBp: number;
	/** Quantos meses de custo essencial a reserva cobre, com uma casa. */
	monthsCovered: number | null;
	/** Quanto falta para a meta. */
	gapCents: Cents;
	/** Em quantos meses enche no ritmo de hoje; 0 cheia; nulo sem aporte (ou além de 50 anos). */
	monthsToFill: number | null;
	/** O que falta para o mínimo de três meses. */
	minimumGapCents: Cents;
}

/** Meses até `from` chegar a `target` com aporte no fim de cada mês. */
const monthsUntil = (from: Cents, target: Cents, contribution: Cents, rate: number): number | null => {
	if (from >= target) return 0;
	if (contribution <= 0 && !(rate > 0 && from > 0)) return null;
	let value = from;
	for (let month = 1; month <= MAX_FILL_MONTHS; month += 1) {
		value = value * (1 + Math.max(0, rate)) + Math.max(0, contribution);
		if (Math.round(value) >= target) return month;
	}
	return null;
};

export const buildReserveReadModel = (input: ReserveInput): ReserveReadModel => {
	const targetMonths = Math.max(1, Math.round(input.targetMonths));
	const cost = input.cost && input.cost.cents > 0 ? input.cost : null;
	const targetCents = cost ? cost.cents * targetMonths : null;
	const split = splitSavings(input.accounts, targetCents);

	if (!cost || targetCents === null) {
		return {
			status: 'unknown',
			monthlyCostCents: null,
			costSource: null,
			targetMonths,
			targetCents: null,
			split,
			progressBp: 0,
			monthsCovered: null,
			gapCents: 0,
			monthsToFill: null,
			minimumGapCents: 0,
		};
	}

	const monthsCovered = Math.round((split.reserveCents / cost.cents) * 10) / 10;
	const minimumCents = cost.cents * Math.min(MIN_RESERVE_MONTHS, targetMonths);
	const status: ReserveStatus = split.poolCents >= targetCents ? 'ready' : split.poolCents < minimumCents ? 'thin' : 'building';

	return {
		status,
		monthlyCostCents: cost.cents,
		costSource: cost.source,
		targetMonths,
		targetCents,
		split,
		progressBp: Math.min(FULL_BASIS_POINTS, Math.round((split.reserveCents * FULL_BASIS_POINTS) / targetCents)),
		monthsCovered,
		gapCents: Math.max(0, targetCents - split.poolCents),
		monthsToFill: monthsUntil(split.poolCents, targetCents, input.monthlyContributionCents, input.monthlyRate),
		minimumGapCents: Math.max(0, minimumCents - split.poolCents),
	};
};

/**
 * Por quantos meses o aporte vai para a reserva antes de ir para a aposentadoria. É o
 * atraso da projeção da meta: "reserva primeiro". Zero com a reserva cheia ou sem meta de
 * reserva; nulo se ela nunca enche no ritmo de hoje (então a aposentadoria não recebe aporte).
 */
export const contributionDelayMonths = (reserve: ReserveReadModel): number | null => {
	if (reserve.status === 'unknown' || reserve.status === 'ready') return 0;
	return reserve.monthsToFill;
};

/**
 * Todo arquivo sob app/ é tratado como rota pelo expo-router, e uma rota sem export
 * default é um módulo quebrado do ponto de vista dele. Este export existe só para
 * satisfazer essa exigência — nada navega para cá.
 */
export default { essentialShareBp, essentialMonthlyCostCents, resolveMonthlyCost, splitSavings, buildReserveReadModel, contributionDelayMonths };
