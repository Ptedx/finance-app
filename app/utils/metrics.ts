/**
 * Métricas de riqueza do Spendr.
 *
 * O livro-caixa responde "quanto sobrou?". Este módulo responde as duas perguntas que
 * de fato movem patrimônio: *que fração da renda vira poupança* e *por quantos meses a
 * reserva sustenta o custo fixo*. São contas simples — o valor está em serem feitas num
 * lugar só, sobre centavos inteiros, com as bordas (renda zero, sem recorrência, mês
 * vazio) decididas explicitamente em vez de virarem `NaN` ou `Infinity` na tela.
 *
 * Duas regras atravessam o arquivo:
 *
 *  1. **Funções puras.** Nada de React Native, nada de banco. Todo insumo chega por
 *     argumento — os agregados que `getPeriodSummary`, `getBalanceAsOf` e
 *     `getRecurringTransactions` já produzem. É o que permite testar tudo direto e é o
 *     que vai permitir expor estas funções como ferramentas de leitura do chatbot: o
 *     modelo raciocina sobre números pré-computados e confiáveis, não sobre linhas cruas.
 *
 *  2. **Razões nunca são guardadas como dinheiro.** Percentuais saem em *pontos-base*
 *     (1% = 100), inteiros, pelo mesmo motivo que dinheiro sai em centavos: para que
 *     comparar, somar e exibir deem sempre o mesmo resultado. `ratio` existe ao lado
 *     como conveniência de cálculo, nunca como valor a ser persistido.
 */

import { type Cents, sumCents } from './money';
import { monthlyEquivalentCents, type RecurrenceRule } from './recurrence';

/** Um por cento, em pontos-base. Ter o nome evita `* 100` solto pelo código. */
export const BASIS_POINTS_PER_PERCENT = 100;

/** Cem por cento, em pontos-base. */
export const FULL_BASIS_POINTS = 10_000;

const MONTHS_IN_YEAR = 12;

/** Zero para qualquer coisa que não seja um número utilizável. */
const safeCents = (value: number): Cents =>
	Number.isFinite(value) ? Math.round(value) : 0;

/**
 * Uma razão em pontos-base, calculada direto dos centavos inteiros.
 *
 * Passar pelo float intermediário (`part / whole * 10000`) introduz um erro que às vezes
 * muda o arredondamento no último ponto-base; multiplicar primeiro mantém a conta inteira
 * até o arredondamento final.
 */
const toBasisPoints = (partCents: Cents, wholeCents: Cents): number =>
	Math.round((partCents * FULL_BASIS_POINTS) / wholeCents);

// ---------------------------------------------------------------------------
// Taxa de poupança
// ---------------------------------------------------------------------------

/** O que `getPeriodSummary` entrega, reduzido ao que a taxa de poupança precisa. */
export interface PeriodTotals {
	incomeCents: Cents;
	expenseCents: Cents;
}

export interface SavingsRate {
	incomeCents: Cents;
	expenseCents: Cents;
	/** Renda menos despesa **no período**. Negativo quando o mês fechou no vermelho. */
	netCents: Cents;
	/**
	 * `(renda − despesa) / renda`. `null` quando não houve renda: um mês sem entrada não
	 * tem taxa de poupança ruim, ele simplesmente não tem taxa — e mostrar 0% ou −100%
	 * seria afirmar algo que os dados não dizem.
	 */
	ratio: number | null;
	/** A mesma razão em pontos-base (1% = 100). `null` pelo mesmo motivo. */
	basisPoints: number | null;
}

export const savingsRate = ({ incomeCents, expenseCents }: PeriodTotals): SavingsRate => {
	const income = safeCents(incomeCents);
	const expense = safeCents(expenseCents);
	const netCents = income - expense;

	if (income <= 0) {
		return { incomeCents: income, expenseCents: expense, netCents, ratio: null, basisPoints: null };
	}

	return {
		incomeCents: income,
		expenseCents: expense,
		netCents,
		ratio: netCents / income,
		basisPoints: toBasisPoints(netCents, income),
	};
};

/**
 * Quanto a taxa andou de um período para o outro, em pontos-base.
 *
 * `null` quando falta base de comparação — qualquer um dos dois períodos sem renda. É a
 * seta ao lado do número na Home, e uma seta que aponta para um período inexistente
 * mentiria mais do que a ausência dela.
 */
export const savingsRateDelta = (current: SavingsRate, previous: SavingsRate): number | null => {
	if (current.basisPoints === null || previous.basisPoints === null) return null;
	return current.basisPoints - previous.basisPoints;
};

// ---------------------------------------------------------------------------
// Custo fixo e fôlego
// ---------------------------------------------------------------------------

/**
 * Um compromisso recorrente, na forma mínima que o cálculo precisa.
 *
 * Estrutural de propósito: `RecurringTransaction` do banco satisfaz esta interface sem
 * conversão nenhuma, e um teste pode montar o objeto à mão sem arrastar o schema junto.
 */
export interface RecurringCommitment extends RecurrenceRule {
	amountCents: Cents;
	isIncome: boolean;
	active: boolean;
}

/**
 * Custo fixo mensal: a soma das recorrências de despesa ativas, normalizadas.
 *
 * A normalização é a parte que importa. Somar os valores crus trataria um seguro anual de
 * R$ 3.000 como R$ 3.000 de custo mensal — `monthlyEquivalentCents` já resolve isso e é
 * de onde a conta vem, para que a Home e esta métrica nunca discordem.
 *
 * Recorrências inativas ficam de fora: elas descrevem um compromisso suspenso, não um que
 * a reserva precise cobrir.
 */
export const monthlyFixedCostCents = (recurring: RecurringCommitment[]): Cents =>
	sumCents(
		recurring
			.filter((rule) => !rule.isIncome && rule.active)
			.map((rule) => safeCents(monthlyEquivalentCents(rule, safeCents(rule.amountCents))))
	);

/** Renda recorrente mensal, mesma normalização — o outro lado do mesmo cálculo. */
export const monthlyRecurringIncomeCents = (recurring: RecurringCommitment[]): Cents =>
	sumCents(
		recurring
			.filter((rule) => rule.isIncome && rule.active)
			.map((rule) => safeCents(monthlyEquivalentCents(rule, safeCents(rule.amountCents))))
	);

export interface RunwayInput {
	/**
	 * O que a reserva tem hoje.
	 *
	 * **v1 usa o saldo de caixa acumulado** (`getBalanceAsOf`), que é a melhor
	 * aproximação disponível enquanto o app não tem Ativos/Passivos. Fica honestamente
	 * aproximado: quando o Pilar 1 existir, o numerador passa a ser o ativo líquido real
	 * e só este argumento muda — a função continua a mesma.
	 */
	liquidCents: Cents;
	monthlyFixedCents: Cents;
}

/**
 * Meses de fôlego: por quanto tempo a reserva paga o custo fixo sem nenhuma entrada.
 *
 * `null` quando não há custo fixo cadastrado — a divisão seria `Infinity`, e "sua reserva
 * dura infinitos meses" é uma afirmação sobre a ausência de dados, não sobre a reserva.
 * Saldo negativo devolve 0: quem está no vermelho não tem fôlego, tem dívida.
 */
export const runwayMonths = ({ liquidCents, monthlyFixedCents }: RunwayInput): number | null => {
	const fixed = safeCents(monthlyFixedCents);
	if (fixed <= 0) return null;

	const liquid = safeCents(liquidCents);
	if (liquid <= 0) return 0;

	return liquid / fixed;
};

/**
 * Que fatia da renda já está comprometida com custo fixo, em pontos-base.
 *
 * É o número que antecede o aperto: quanto mais alto, menos a taxa de poupança depende de
 * escolha e mais depende de renegociar contrato. `null` sem renda no período.
 */
export const fixedCostShare = ({
	monthlyFixedCents,
	incomeCents,
}: {
	monthlyFixedCents: Cents;
	incomeCents: Cents;
}): number | null => {
	const income = safeCents(incomeCents);
	if (income <= 0) return null;

	return toBasisPoints(safeCents(monthlyFixedCents), income);
};

// ---------------------------------------------------------------------------
// Variação por categoria
// ---------------------------------------------------------------------------

/** O formato que `getTotalByCategory` devolve. */
export interface CategoryTotal {
	categoryId: string;
	totalCents: Cents;
}

export interface CategoryDelta {
	categoryId: string;
	currentCents: Cents;
	previousCents: Cents;
	/** Positivo = gastou mais que no período anterior. */
	deltaCents: Cents;
	/**
	 * Variação relativa. `null` quando o período anterior era zero: sair de nada para
	 * alguma coisa não é "aumento de X%", é uma categoria nova, e é assim que a UI e o
	 * bot devem contar a história.
	 */
	pct: number | null;
}

/**
 * Compara duas fotos de totais por categoria, período a período.
 *
 * Cobre a união das duas listas, não a interseção: uma categoria que sumiu do mês atual é
 * exatamente o tipo de mudança que interessa relatar. A ordenação é pela magnitude da
 * variação — o topo da lista é o que explica o mês — com desempate pelo id para que a
 * saída seja estável entre execuções.
 */
export const categoryDeltas = (
	currentTotals: CategoryTotal[],
	previousTotals: CategoryTotal[]
): CategoryDelta[] => {
	const previousById = new Map(previousTotals.map((row) => [row.categoryId, safeCents(row.totalCents)]));
	const currentById = new Map(currentTotals.map((row) => [row.categoryId, safeCents(row.totalCents)]));

	const categoryIds = new Set([...currentById.keys(), ...previousById.keys()]);

	return [...categoryIds]
		.map((categoryId) => {
			const currentCents = currentById.get(categoryId) ?? 0;
			const previousCents = previousById.get(categoryId) ?? 0;
			const deltaCents = currentCents - previousCents;

			return {
				categoryId,
				currentCents,
				previousCents,
				deltaCents,
				pct: previousCents > 0 ? deltaCents / previousCents : null,
			};
		})
		.sort(
			(a, b) =>
				Math.abs(b.deltaCents) - Math.abs(a.deltaCents) || a.categoryId.localeCompare(b.categoryId)
		);
};

// ---------------------------------------------------------------------------
// Necessidades / Desejos / Poupança (50-30-20)
// ---------------------------------------------------------------------------

/** As metas clássicas do 50/30/20, em pontos-base. Referência, não regra do app. */
export const NEEDS_WANTS_SAVINGS_TARGET = {
	needsBasisPoints: 5_000,
	wantsBasisPoints: 3_000,
	savingsBasisPoints: 2_000,
} as const;

export interface ExpenseTotalsByNature {
	essentialCents: Cents;
	discretionaryCents: Cents;
}

export interface NeedsWantsSavings {
	needsCents: Cents;
	wantsCents: Cents;
	savingsCents: Cents;
	/** Soma dos três. Igual à renda do período quando `savingsCents` é o resultado dele. */
	baseCents: Cents;
	needsBasisPoints: number | null;
	wantsBasisPoints: number | null;
	savingsBasisPoints: number | null;
}

/**
 * Reparte o período em necessidades, desejos e poupança.
 *
 * As despesas chegam já separadas pela natureza da categoria (`essential` /
 * `discretionary`); a poupança é o resultado do período. Enquanto o usuário não tiver
 * classificado nada, tudo cai em `discretionaryCents` e o resultado continua correto —
 * degrada para "100% desejos", que é uma leitura verdadeira de um app sem a tag, não um
 * erro.
 *
 * As três fatias somam exatamente 10.000 pontos-base por construção: a última é o resto,
 * não um terceiro arredondamento independente, senão a barra empilhada da tela sobraria
 * ou faltaria um ponto-base conforme o mês.
 */
export const needsWantsSavingsSplit = (
	{ essentialCents, discretionaryCents }: ExpenseTotalsByNature,
	savingsCents: Cents
): NeedsWantsSavings => {
	const needs = safeCents(essentialCents);
	const wants = safeCents(discretionaryCents);
	const savings = safeCents(savingsCents);
	const baseCents = needs + wants + savings;

	if (baseCents <= 0) {
		return {
			needsCents: needs,
			wantsCents: wants,
			savingsCents: savings,
			baseCents,
			needsBasisPoints: null,
			wantsBasisPoints: null,
			savingsBasisPoints: null,
		};
	}

	const needsBasisPoints = toBasisPoints(needs, baseCents);
	const wantsBasisPoints = toBasisPoints(wants, baseCents);

	return {
		needsCents: needs,
		wantsCents: wants,
		savingsCents: savings,
		baseCents,
		needsBasisPoints,
		wantsBasisPoints,
		savingsBasisPoints: FULL_BASIS_POINTS - needsBasisPoints - wantsBasisPoints,
	};
};

// ---------------------------------------------------------------------------
// Série anual
// ---------------------------------------------------------------------------

/** O formato que `getMonthlyTransactions` devolve. */
export interface MonthlyTotal {
	/** 1-12. */
	month: number;
	totalCents: Cents;
}

export interface MonthlySavingsRate {
	month: number;
	rate: SavingsRate;
}

/**
 * A taxa de poupança mês a mês, sempre com doze entradas.
 *
 * Meses sem movimento entram como zero em vez de serem omitidos — mesma correção que o
 * gráfico de tendências precisou: com listas de tamanhos diferentes, o ponto N da renda
 * e o ponto N da despesa passam a se referir a meses diferentes, e a série inteira mente.
 */
export const savingsRateTrend = (
	monthlyIncome: MonthlyTotal[],
	monthlyExpense: MonthlyTotal[]
): MonthlySavingsRate[] => {
	const incomeByMonth = new Map(monthlyIncome.map((row) => [row.month, safeCents(row.totalCents)]));
	const expenseByMonth = new Map(monthlyExpense.map((row) => [row.month, safeCents(row.totalCents)]));

	return Array.from({ length: MONTHS_IN_YEAR }, (_, index) => {
		const month = index + 1;
		return {
			month,
			rate: savingsRate({
				incomeCents: incomeByMonth.get(month) ?? 0,
				expenseCents: expenseByMonth.get(month) ?? 0,
			}),
		};
	});
};

/**
 * Há quantos meses seguidos, terminando em `throughMonth`, a taxa está caindo.
 *
 * Meses sem renda cortam a sequência em vez de valerem como queda: não se sabe se a taxa
 * caiu ou se aquele mês simplesmente não tem taxa. É o substrato do insight "sua taxa de
 * poupança cai há três meses", que só vale a pena mostrar quando o dado sustenta.
 */
export const consecutiveSavingsRateDrops = (
	trend: MonthlySavingsRate[],
	throughMonth: number
): number => {
	const upTo = trend.filter((entry) => entry.month <= throughMonth).sort((a, b) => a.month - b.month);

	let drops = 0;

	for (let index = upTo.length - 1; index > 0; index -= 1) {
		const current = upTo[index].rate.basisPoints;
		const previous = upTo[index - 1].rate.basisPoints;

		if (current === null || previous === null || current >= previous) break;
		drops += 1;
	}

	return drops;
};

/**
 * Todo arquivo sob app/ e tratado como rota pelo expo-router, e uma rota sem export
 * default e um modulo quebrado do ponto de vista dele. Este export existe so para
 * satisfazer essa exigencia — nada navega para ca. Mesma convencao de money.ts,
 * recurrence.ts e dos demais utilitarios do projeto.
 */
export default {
	BASIS_POINTS_PER_PERCENT,
	FULL_BASIS_POINTS,
	NEEDS_WANTS_SAVINGS_TARGET,
	savingsRate,
	savingsRateDelta,
	monthlyFixedCostCents,
	monthlyRecurringIncomeCents,
	runwayMonths,
	fixedCostShare,
	categoryDeltas,
	needsWantsSavingsSplit,
	savingsRateTrend,
	consecutiveSavingsRateDrops,
};
