/**
 * A conta das dívidas de longo prazo: financiamento (tabela Price ou SAC), empréstimo e
 * consórcio. Quanto se deve hoje, quando quita, quanto ainda vai de juros, quanto se
 * economiza antecipando — e se antecipar rende mais do que investir o mesmo dinheiro.
 *
 * O saldo devedor nunca é guardado desatualizado: como o saldo das contas, ele é uma
 * **âncora** (o saldo logo depois da última parcela paga, numa data) e o resto é
 * projetado mês a mês. As parcelas que vencem até hoje saem do saldo sozinhas.
 *
 * A taxa mensal é a equivalente **composta** da anual — diferente do `monthlyRate` simples
 * de `retirement.ts`, e de propósito: a dívida capitaliza de verdade todo mês, e anual÷12
 * subestimaria os juros. A comparação com o investimento é feita em taxa anual, então
 * continua maçã com maçã.
 *
 * No consórcio não há juros: a "taxa" é o reajuste anual do saldo (INCC, IPCA), que no
 * aniversário sobe o saldo e a parcela juntos. O custo de não antecipar é esse reajuste.
 *
 * Centavos inteiros; `null` é "não dá para responder". Puro: nada de React Native, nada de
 * banco.
 */

import type { AmortizationSystem, Debt } from '../database/schema';
import { buildClampedDate, monthKeyOf, parseISODate } from './dateUtils';
import { FULL_BASIS_POINTS } from './metrics';
import type { Cents } from './money';

export type { AmortizationSystem, DebtKind } from '../database/schema';

/** Um contrato não passa de 50 anos; acima disso o cronograma é tratado como "não quita". */
export const MAX_SCHEDULE_MONTHS = 600;

/** IR mínimo da renda fixa longa (15%): o rendimento a comparar é o líquido. */
export const DEFAULT_INVESTMENT_TAX_BP = 1_500;

/** Diferença de taxa (ao ano) abaixo da qual amortizar e investir dão no mesmo. */
export const VERDICT_TIE_BP = 50;

/** Reajuste anual padrão de um consórcio, quando o usuário não sabe (perto do IPCA). */
export const DEFAULT_CONSORTIUM_ADJUSTMENT_BP = 500;

export interface DebtTerms {
	system: AmortizationSystem;
	/** Saldo devedor logo depois da última parcela paga — a âncora. */
	balanceCents: Cents;
	/** Data da âncora: o que venceu até ela já está descontado do saldo. */
	balanceDate: string;
	/** Parcela a pagar: fixa na Price, a próxima na SAC, a atual no consórcio. */
	installmentCents: Cents;
	/** Parcelas que faltam depois da âncora. */
	remaining: number;
	/** Dia do vencimento, 1-31 (encolhe nos meses curtos). */
	dueDay: number;
	/** Taxa de juros do contrato ao ano, em pontos-base; no consórcio, o reajuste anual. */
	rateBp: number;
	/**
	 * Seguro e tarifas dentro de cada parcela (zero quando não há). A parcela que o banco
	 * cobra é juros + amortização + isto; é por isso que a taxa estimada só pela parcela
	 * sai maior que a do contrato.
	 */
	feeCents?: number;
}

export interface ScheduleEntry {
	/** 1 = a primeira parcela depois da âncora. */
	index: number;
	date: string;
	installmentCents: Cents;
	/** Juros do mês (Price/SAC) ou reajuste aplicado naquele mês (consórcio). */
	interestCents: Cents;
	amortizationCents: Cents;
	/** Saldo depois desta parcela. */
	balanceCents: Cents;
}

export interface DebtSchedule {
	entries: ScheduleEntry[];
	totalPaidCents: Cents;
	/** Juros (ou reajuste) que ainda serão pagos até quitar. */
	totalInterestCents: Cents;
	payoffDate: string | null;
	/** Falso quando a parcela não cobre nem os juros: a dívida cresce e nunca quita. */
	amortizes: boolean;
}

const safe = (value: number): number => (Number.isFinite(value) ? value : 0);

/** Taxa mensal equivalente composta: (1 + anual)^(1/12) − 1. */
export const monthlyRateOf = (rateBp: number): number => {
	const annual = Math.max(0, safe(rateBp)) / FULL_BASIS_POINTS;
	return annual === 0 ? 0 : (1 + annual) ** (1 / 12) - 1;
};

/** O inverso: a taxa anual, em pontos-base, de uma taxa mensal. */
export const annualRateBpOf = (monthlyRate: number): number => Math.round(((1 + Math.max(0, safe(monthlyRate))) ** 12 - 1) * FULL_BASIS_POINTS);

/** Parcela fixa da tabela Price: P·i / (1 − (1+i)^−n). */
export const priceInstallmentCents = (principalCents: Cents, monthlyRate: number, months: number): Cents => {
	if (months <= 0 || principalCents <= 0) return 0;
	if (monthlyRate <= 0) return Math.ceil(principalCents / months);
	return Math.round((principalCents * monthlyRate) / (1 - (1 + monthlyRate) ** -months));
};

/**
 * As datas de vencimento depois da âncora, todas no mesmo dia do mês (encolhido nos meses
 * curtos, sem "escorregar": 31/jan, 28/fev, 31/mar).
 */
export const dueDatesAfter = (balanceDate: string, dueDay: number, count: number): string[] => {
	const anchor = parseISODate(balanceDate);
	let year = anchor.getFullYear();
	let month = anchor.getMonth() + 1;
	// O primeiro vencimento depois da âncora: este mês, se o dia ainda não passou.
	if (buildClampedDate(year, month, dueDay) <= balanceDate) {
		month += 1;
		if (month > 12) {
			month = 1;
			year += 1;
		}
	}
	const dates: string[] = [];
	for (let k = 0; k < count; k += 1) {
		const index = month - 1 + k;
		dates.push(buildClampedDate(year + Math.floor(index / 12), (index % 12) + 1, dueDay));
	}
	return dates;
};

type PaymentRule =
	| { system: 'price'; installmentCents: Cents }
	| { system: 'sac'; amortizationCents: Cents }
	| { system: 'none'; installmentCents: Cents };

/**
 * O motor dos três sistemas: anda mês a mês a partir do saldo até zerar. A última parcela
 * absorve o arredondamento, então o saldo sempre termina em zero exato.
 */
const runSchedule = (balanceCents: Cents, balanceDate: string, dueDay: number, rateBp: number, rule: PaymentRule, feeCents = 0): DebtSchedule => {
	const fee = rule.system === 'none' ? 0 : Math.max(0, Math.round(safe(feeCents)));
	const i = rule.system === 'none' ? 0 : monthlyRateOf(rateBp);
	const adjustment = rule.system === 'none' ? Math.max(0, safe(rateBp)) / FULL_BASIS_POINTS : 0;
	let balance = Math.max(0, Math.round(safe(balanceCents)));
	if (balance === 0) return { entries: [], totalPaidCents: 0, totalInterestCents: 0, payoffDate: balanceDate, amortizes: true };

	// Na Price, parcela que (sem os encargos) não cobre os juros do primeiro mês nunca quita.
	if (rule.system === 'price' && rule.installmentCents - fee <= Math.round(balance * i)) {
		return { entries: [], totalPaidCents: 0, totalInterestCents: 0, payoffDate: null, amortizes: false };
	}
	if ((rule.system === 'price' || rule.system === 'none') && rule.installmentCents <= 0) {
		return { entries: [], totalPaidCents: 0, totalInterestCents: 0, payoffDate: null, amortizes: false };
	}
	if (rule.system === 'sac' && rule.amortizationCents <= 0) {
		return { entries: [], totalPaidCents: 0, totalInterestCents: 0, payoffDate: null, amortizes: false };
	}

	const dates = dueDatesAfter(balanceDate, dueDay, MAX_SCHEDULE_MONTHS);
	const entries: ScheduleEntry[] = [];
	let installment = rule.system === 'sac' ? 0 : rule.installmentCents;
	let totalPaid = 0;
	let totalInterest = 0;

	for (let k = 0; k < MAX_SCHEDULE_MONTHS && balance > 0; k += 1) {
		let interest = 0;
		if (rule.system === 'none') {
			// Aniversário do consórcio: o saldo e a parcela sobem o reajuste juntos.
			if (k > 0 && k % 12 === 0 && adjustment > 0) {
				const raised = Math.round(balance * (1 + adjustment));
				interest = raised - balance;
				balance = raised;
				installment = Math.round(installment * (1 + adjustment));
			}
		} else {
			interest = Math.round(balance * i);
		}

		let payment: Cents = rule.system === 'sac' ? rule.amortizationCents + interest + fee : installment;

		// Os encargos saem de cada parcela e não amortizam nada.
		const owedNow = rule.system === 'none' ? balance : balance + interest + fee;
		// Centavos de arredondamento não viram uma parcela a mais: como faz o banco, o resíduo
		// pequeno entra nesta parcela.
		const residualTolerance = Math.max(100, Math.round(payment * 0.01));
		if (payment >= owedNow || owedNow - payment <= residualTolerance) payment = owedNow;
		const amortization = rule.system === 'none' ? payment : payment - interest - fee;

		balance -= amortization;
		totalPaid += payment;
		totalInterest += interest;
		entries.push({ index: k + 1, date: dates[k], installmentCents: payment, interestCents: interest, amortizationCents: amortization, balanceCents: balance });
	}

	return {
		entries,
		totalPaidCents: totalPaid,
		totalInterestCents: totalInterest,
		payoffDate: balance <= 0 && entries.length > 0 ? entries[entries.length - 1].date : null,
		amortizes: balance <= 0,
	};
};

/** A regra de pagamento dos termos: parcela fixa, amortização fixa ou parcela do consórcio. */
const ruleOf = (terms: DebtTerms): PaymentRule => {
	if (terms.system === 'sac') {
		return { system: 'sac', amortizationCents: terms.remaining > 0 ? Math.ceil(terms.balanceCents / terms.remaining) : 0 };
	}
	return { system: terms.system, installmentCents: terms.installmentCents };
};

/** Os termos de uma dívida guardada. */
export const termsOf = (debt: Pick<Debt, 'system' | 'openingBalanceCents' | 'openingBalanceDate' | 'installmentCents' | 'remainingAtOpening' | 'dueDay' | 'rateBp' | 'feeCents'>): DebtTerms => ({
	system: debt.system,
	balanceCents: debt.openingBalanceCents,
	balanceDate: debt.openingBalanceDate,
	installmentCents: debt.installmentCents,
	remaining: debt.remainingAtOpening,
	dueDay: debt.dueDay,
	rateBp: debt.rateBp,
	feeCents: debt.feeCents,
});

/** O cronograma inteiro a partir da âncora. */
export const buildSchedule = (terms: DebtTerms): DebtSchedule =>
	runSchedule(terms.balanceCents, terms.balanceDate, terms.dueDay, terms.rateBp, ruleOf(terms), terms.feeCents);

export interface DebtState {
	/** Saldo devedor hoje: a âncora menos o que venceu até hoje. */
	balanceCents: Cents;
	/** Parcelas que ainda faltam hoje. */
	remaining: number;
	/** Parcelas pagas desde a âncora (as que venceram até hoje). */
	paidSinceAnchor: number;
	next: ScheduleEntry | null;
	payoffDate: string | null;
	/** Juros (ou reajuste) que ainda faltam pagar a partir de hoje. */
	interestAheadCents: Cents;
	/** O cronograma a partir de hoje. */
	upcoming: ScheduleEntry[];
	amortizes: boolean;
}

/** Onde a dívida está hoje: o que venceu até `today` conta como pago. */
export const debtStateOn = (terms: DebtTerms, today: string): DebtState => {
	const schedule = buildSchedule(terms);
	const paid = schedule.entries.filter((entry) => entry.date <= today);
	const upcoming = schedule.entries.filter((entry) => entry.date > today);
	return {
		balanceCents: paid.length > 0 ? paid[paid.length - 1].balanceCents : Math.max(0, terms.balanceCents),
		remaining: upcoming.length,
		paidSinceAnchor: paid.length,
		next: upcoming[0] ?? null,
		payoffDate: schedule.payoffDate,
		interestAheadCents: upcoming.reduce((sum, entry) => sum + entry.interestCents, 0),
		upcoming,
		amortizes: schedule.amortizes,
	};
};

// ---------------------------------------------------------------------------
// Cadastro: derivar o que o usuário não sabe
// ---------------------------------------------------------------------------

/**
 * A taxa anual que a parcela e o saldo implicam. Ninguém sabe o CET de cabeça, mas todo
 * mundo sabe a parcela, quantas faltam e o saldo para quitar — e isso basta.
 *
 * Price: a parcela cresce com a taxa, então uma bissecção acha a taxa exata. SAC: a
 * primeira parcela é amortização + juros do saldo, então a taxa sai direto. Consórcio não
 * tem juros: nulo (o custo dele é o reajuste, que o usuário informa).
 */
export const impliedRateBp = ({ system, balanceCents, installmentCents, remaining }: { system: AmortizationSystem; balanceCents: Cents; installmentCents: Cents; remaining: number }): number | null => {
	if (system === 'none' || balanceCents <= 0 || installmentCents <= 0 || remaining <= 0) return null;

	if (system === 'sac') {
		const amortization = balanceCents / remaining;
		const monthly = (installmentCents - amortization) / balanceCents;
		return monthly < 0 ? null : annualRateBpOf(monthly);
	}

	// Pagar menos que o saldo no total não fecha a conta com juros positivos.
	if (installmentCents * remaining < balanceCents) return null;
	if (installmentCents * remaining === balanceCents) return 0;

	const pmt = (i: number) => (balanceCents * i) / (1 - (1 + i) ** -remaining);
	let low = 0;
	let high = 1;
	for (let step = 0; step < 200; step += 1) {
		const mid = (low + high) / 2;
		if (pmt(mid) > installmentCents) high = mid;
		else low = mid;
	}
	return annualRateBpOf((low + high) / 2);
};

/** O saldo devedor que uma taxa implica (o caminho inverso de `impliedRateBp`). */
export const principalFromRateCents = ({ system, installmentCents, remaining, rateBp }: { system: AmortizationSystem; installmentCents: Cents; remaining: number; rateBp: number }): Cents => {
	if (installmentCents <= 0 || remaining <= 0) return 0;
	const i = monthlyRateOf(rateBp);
	if (system === 'none' || i === 0) return installmentCents * remaining;
	if (system === 'sac') return Math.round(installmentCents / (1 / remaining + i));
	return Math.round((installmentCents * (1 - (1 + i) ** -remaining)) / i);
};

/**
 * Os encargos da parcela: o que ela cobra além do que a taxa do contrato pede. Price: a
 * parcela menos a parcela pura da taxa. SAC: a primeira parcela menos amortização e juros.
 * Negativo quando a parcela é menor do que a taxa exigiria — os números não fecham.
 */
export const installmentFeeCents = ({ system, balanceCents, installmentCents, remaining, rateBp }: { system: AmortizationSystem; balanceCents: Cents; installmentCents: Cents; remaining: number; rateBp: number }): Cents => {
	if (system === 'none' || balanceCents <= 0 || remaining <= 0) return 0;
	const i = monthlyRateOf(rateBp);
	if (system === 'sac') return installmentCents - Math.ceil(balanceCents / remaining) - Math.round(balanceCents * i);
	return installmentCents - priceInstallmentCents(balanceCents, i, remaining);
};

/**
 * O custo efetivo da dívida hoje, ao ano: a taxa que iguala o saldo de hoje às parcelas
 * que faltam, **com os encargos**. É o que antecipar deixa de pagar, então é contra ele
 * que o investimento é comparado. Sem encargos, é a própria taxa do contrato; no consórcio,
 * o reajuste.
 */
export const effectiveRateBp = (terms: DebtTerms, today: string): number => {
	if (terms.system === 'none' || !terms.feeCents) return terms.rateBp;
	const state = debtStateOn(terms, today);
	if (!state.next || state.remaining <= 0) return terms.rateBp;
	return impliedRateBp({ system: terms.system, balanceCents: state.balanceCents, installmentCents: state.next.installmentCents, remaining: state.remaining }) ?? terms.rateBp;
};

// ---------------------------------------------------------------------------
// Amortizar: quanto se economiza
// ---------------------------------------------------------------------------

export type ExtraPaymentMode = 'shorten' | 'lower';

export interface ExtraPaymentResult {
	/** Quantas parcelas a menos (só em "reduzir prazo"). */
	monthsSaved: number;
	/** Juros (ou reajuste) que deixam de ser pagos: total pago antes − (total depois + extra). */
	savedCents: Cents;
	/** A próxima parcela depois de amortizar. */
	newInstallmentCents: Cents;
	newRemaining: number;
	newPayoffDate: string | null;
	/** O novo saldo devedor, para mover a âncora se o usuário confirmar. */
	newBalanceCents: Cents;
}

/**
 * Antecipar `extraCents` hoje. "Reduzir prazo" mantém a parcela e corta parcelas do fim;
 * "reduzir parcela" mantém o prazo e recalcula a parcela. A economia é medida do mesmo jeito
 * nos dois: quanto sai do bolso até quitar, antes e depois.
 */
export const simulateExtraPayment = (terms: DebtTerms, today: string, extraCents: Cents, mode: ExtraPaymentMode): ExtraPaymentResult | null => {
	const state = debtStateOn(terms, today);
	if (!state.amortizes || state.balanceCents <= 0 || extraCents <= 0) return null;

	const extra = Math.min(Math.round(extraCents), state.balanceCents);
	const fee = terms.feeCents ?? 0;
	const before = runSchedule(state.balanceCents, today, terms.dueDay, terms.rateBp, currentRule(terms, state), fee);
	const newBalance = state.balanceCents - extra;
	const n = before.entries.length;

	let rule: PaymentRule;
	if (terms.system === 'sac') {
		const amortization = (currentRule(terms, state) as { amortizationCents: Cents }).amortizationCents;
		rule = { system: 'sac', amortizationCents: mode === 'shorten' ? amortization : Math.ceil(newBalance / Math.max(1, n)) };
	} else if (terms.system === 'price') {
		rule = { system: 'price', installmentCents: mode === 'shorten' ? terms.installmentCents : priceInstallmentCents(newBalance, monthlyRateOf(terms.rateBp), n) + fee };
	} else {
		const current = state.next?.installmentCents ?? terms.installmentCents;
		rule = { system: 'none', installmentCents: mode === 'shorten' ? current : Math.ceil(newBalance / Math.max(1, n)) };
	}

	const after = runSchedule(newBalance, today, terms.dueDay, terms.rateBp, rule, fee);
	return {
		monthsSaved: Math.max(0, n - after.entries.length),
		savedCents: Math.max(0, before.totalPaidCents - (after.totalPaidCents + extra)),
		newInstallmentCents: after.entries[0]?.installmentCents ?? 0,
		newRemaining: after.entries.length,
		newPayoffDate: after.payoffDate,
		newBalanceCents: newBalance,
	};
};

/**
 * A regra de hoje, a partir do estado projetado. Na SAC a amortização fixa sai da âncora;
 * no consórcio a parcela de hoje já inclui os reajustes que passaram.
 */
const currentRule = (terms: DebtTerms, state: DebtState): PaymentRule => {
	if (terms.system === 'sac') return ruleOf(terms);
	if (terms.system === 'none') return { system: 'none', installmentCents: state.next?.installmentCents ?? terms.installmentCents };
	return { system: 'price', installmentCents: terms.installmentCents };
};

/**
 * Os termos novos depois de uma amortização confirmada: a âncora vai para hoje, com o
 * saldo, a parcela e o prazo que a simulação calculou.
 */
export const termsAfterExtraPayment = (terms: DebtTerms, today: string, result: ExtraPaymentResult): DebtTerms => ({
	...terms,
	balanceCents: result.newBalanceCents,
	balanceDate: today,
	installmentCents: result.newInstallmentCents,
	remaining: result.newRemaining,
});

// ---------------------------------------------------------------------------
// O veredito: amortizar ou investir?
// ---------------------------------------------------------------------------

export type DebtVerdict = 'pay' | 'invest' | 'tie';

export interface VerdictResult {
	verdict: DebtVerdict;
	/** O rendimento do investimento, depois do IR. */
	netYieldBp: number;
	/** Custo da dívida menos o rendimento líquido; positivo = amortizar rende mais. */
	spreadBp: number;
	/** Quanto cada R$ 1.000 antecipados rendem a mais (ou a menos) por ano do que investidos. */
	perThousandCents: Cents;
}

/**
 * Antecipar uma dívida "rende" exatamente o custo dela, e sem imposto. Investir rende o
 * esperado menos o IR. Quem for maior ganha; perto demais, tanto faz.
 */
export const worthPayingOff = ({ debtRateBp, investmentYieldBp, investmentTaxBp = DEFAULT_INVESTMENT_TAX_BP }: { debtRateBp: number; investmentYieldBp: number; investmentTaxBp?: number }): VerdictResult => {
	const netYieldBp = Math.round(Math.max(0, investmentYieldBp) * (1 - Math.max(0, investmentTaxBp) / FULL_BASIS_POINTS));
	const spreadBp = Math.max(0, debtRateBp) - netYieldBp;
	return {
		verdict: spreadBp > VERDICT_TIE_BP ? 'pay' : spreadBp < -VERDICT_TIE_BP ? 'invest' : 'tie',
		netYieldBp,
		spreadBp,
		perThousandCents: Math.round((100_000 * spreadBp) / FULL_BASIS_POINTS),
	};
};

// ---------------------------------------------------------------------------
// Efeito no mês e no futuro
// ---------------------------------------------------------------------------

export interface RecurringLike {
	amountCents: Cents;
	isIncome: boolean;
	active: boolean;
	recurrenceType: string;
}

/**
 * A parcela já está no custo fixo? Quando existe uma recorrência mensal de despesa com o
 * mesmo valor (1% ou R$ 1 de folga), ela já entra no "custo fixo" e somar a dívida de novo
 * seria dupla contagem.
 */
export const installmentInRecurring = (installmentCents: Cents, recurring: RecurringLike[]): boolean => {
	const tolerance = Math.max(100, Math.round(installmentCents * 0.01));
	return recurring.some(
		(rule) => rule.active && !rule.isIncome && rule.recurrenceType === 'monthly' && Math.abs(rule.amountCents - installmentCents) <= tolerance
	);
};

export interface DebtMonthLine {
	debtId: string;
	name: string;
	/** `YYYY-MM`. */
	month: string;
	cents: Cents;
	/** Já contada no custo fixo por uma recorrência: aparece como detalhe, não soma. */
	inFixedCost: boolean;
}

/** As parcelas de cada dívida nos meses pedidos, a partir do cronograma de hoje. */
export const debtMonthLines = (
	debts: Array<{ id: string; name: string; terms: DebtTerms }>,
	months: string[],
	today: string,
	recurring: RecurringLike[]
): DebtMonthLine[] => {
	const wanted = new Set(months);
	const lines: DebtMonthLine[] = [];
	for (const debt of debts) {
		const state = debtStateOn(debt.terms, today);
		const inFixedCost = installmentInRecurring(state.next?.installmentCents ?? debt.terms.installmentCents, recurring);
		const byMonth = new Map<string, Cents>();
		for (const entry of state.upcoming) {
			const month = monthKeyOf(entry.date);
			if (wanted.has(month)) byMonth.set(month, (byMonth.get(month) ?? 0) + entry.installmentCents);
		}
		for (const [month, cents] of byMonth) lines.push({ debtId: debt.id, name: debt.name, month, cents, inFixedCost });
	}
	return lines;
};

export interface DebtsSummary {
	balanceCents: Cents;
	/** Soma das próximas parcelas. */
	monthlyCents: Cents;
	/** Custo médio ponderado pelo saldo, ao ano; nulo sem saldo. */
	weightedRateBp: number | null;
	/** A última quitação entre todas as dívidas. */
	lastPayoffDate: string | null;
	/** Quando cada parcela deixa de sair, na ordem: `fromMonth` é o primeiro mês sem ela. */
	releases: Array<{ debtId: string; name: string; fromMonth: string; cents: Cents }>;
}

/** O quadro de todas as dívidas vivas hoje. */
export const summarizeDebts = (debts: Array<{ id: string; name: string; terms: DebtTerms }>, today: string): DebtsSummary => {
	let balanceCents = 0;
	let monthlyCents = 0;
	let weighted = 0;
	let lastPayoffDate: string | null = null;
	const releases: DebtsSummary['releases'] = [];

	for (const debt of debts) {
		const state = debtStateOn(debt.terms, today);
		if (state.balanceCents <= 0) continue;
		balanceCents += state.balanceCents;
		monthlyCents += state.next?.installmentCents ?? 0;
		weighted += state.balanceCents * Math.max(0, debt.terms.rateBp);
		if (state.payoffDate && (lastPayoffDate === null || state.payoffDate > lastPayoffDate)) lastPayoffDate = state.payoffDate;
		if (state.payoffDate) {
			const last = state.upcoming[state.upcoming.length - 1];
			releases.push({ debtId: debt.id, name: debt.name, fromMonth: nextMonthKey(monthKeyOf(state.payoffDate)), cents: last?.installmentCents ?? 0 });
		}
	}

	releases.sort((a, b) => a.fromMonth.localeCompare(b.fromMonth));
	return { balanceCents, monthlyCents, weightedRateBp: balanceCents > 0 ? Math.round(weighted / balanceCents) : null, lastPayoffDate, releases };
};

const nextMonthKey = (key: string): string => {
	const [year, month] = key.split('-').map(Number);
	return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
};

/**
 * Todo arquivo sob app/ é tratado como rota pelo expo-router, e uma rota sem export
 * default é um módulo quebrado do ponto de vista dele. Este export existe só para
 * satisfazer essa exigência — nada navega para cá.
 */
export default { buildSchedule, debtStateOn, impliedRateBp, simulateExtraPayment, worthPayingOff, summarizeDebts };
