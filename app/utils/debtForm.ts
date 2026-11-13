/**
 * A conta do formulário de dívida (`DebtEditScreen`), fora do React: com que valores ele abre
 * uma dívida guardada, que taxa vale o que está digitado, o que se deriva do resto e os termos
 * que a prévia mostra — os mesmos que salvar grava. A prévia e a tela da dívida passam pelo
 * mesmo `debtStateOn` de `debt.ts`, então a prévia diz exatamente o que a tela vai dizer.
 *
 * Centavos e pontos-base inteiros. Puro: nada de React Native, nada de banco.
 */

import type { AmortizationSystem, Debt } from '../database/schema';
import {
	annualRateBpOf,
	type DebtTerms,
	debtStateOn,
	impliedRateBp,
	installmentFeeCents,
	monthlyRateBpOf,
	principalFromRateCents,
	termsOf,
} from './debt';
import { type Cents, centsToDisplayInput, parseAmountToCents } from './money';
import { bpToPercentInput, percentInputToBp } from './percent';

export type RatePeriod = 'month' | 'year';

/**
 * A taxa com que o formulário abre uma dívida guardada: o texto do campo, o período e a taxa
 * guardada que o texto representa.
 */
export interface PrefilledRate {
	text: string;
	period: RatePeriod;
	rateBp: number;
}

/** Financiamento se fala ao mês: a taxa abre como no contrato, com duas casas. */
export const prefilledRateOf = (rateBp: number): PrefilledRate => ({ text: bpToPercentInput(monthlyRateBpOf(rateBp)), period: 'month', rateBp });

/**
 * A taxa que o campo diz, sempre ao ano em pontos-base; nula quando o campo não é uma taxa.
 *
 * Enquanto o campo continua com o texto e o período com que abriu, vale a taxa guardada, e
 * não a releitura do texto (SPD-157). O campo mostra a taxa ao mês com duas casas, e a
 * guardada nem sempre cabe nelas: a estimada pela parcela de R$ 20.000 em 24 × R$ 1.000 é
 * 19,75% ao ano, que o campo mostra "1,51" — e "1,51" ao mês relido dá 19,70%. A prévia
 * dizia 19,7% e R$ 3.989,74 de juros onde a tela da dívida diz 19,8% e R$ 4.000,76, e salvar
 * sem mexer regravava a dívida com a taxa arredondada. Mexeu no campo (ou no período), vale
 * o que está escrito.
 */
export const formRateBp = (rate: string, period: RatePeriod, prefilled: PrefilledRate | null): number | null => {
	if (prefilled && rate === prefilled.text && period === prefilled.period) return prefilled.rateBp;
	const bp = percentInputToBp(rate, period === 'month' ? 20 : 1_000);
	if (bp === null) return null;
	return period === 'month' ? annualRateBpOf(bp / 10_000) : bp;
};

/** Os campos numéricos com que o formulário abre uma dívida guardada: o estado dela hoje. */
export interface DebtFormFields {
	installment: string;
	remaining: string;
	total: string;
	dueDay: string;
	balance: string;
	rate: PrefilledRate;
	/** O reajuste do consórcio (nulo nos outros tipos: o campo fica com o padrão). */
	adjustment: string | null;
	adminFee: string;
}

export const debtFormFieldsOf = (debt: Debt, today: string): DebtFormFields => {
	const state = debtStateOn(termsOf(debt), today);
	return {
		installment: centsToDisplayInput(state.next?.installmentCents ?? debt.installmentCents),
		remaining: String(state.remaining),
		total: String(debt.installmentsTotal),
		dueDay: String(debt.dueDay),
		balance: centsToDisplayInput(state.balanceCents),
		rate: prefilledRateOf(debt.rateBp),
		adjustment: debt.kind === 'consortium' ? bpToPercentInput(debt.rateBp) : null,
		adminFee: debt.adminFeeBp !== null ? bpToPercentInput(debt.adminFeeBp) : '',
	};
};

/**
 * O que o formulário deriva: o saldo, a taxa e os encargos que valem, e de onde cada um veio.
 * `rateBp` nulo = os números não fecham (a parcela não paga o saldo nessa taxa).
 */
export interface DerivedDebt {
	balanceCents: Cents;
	rateBp: number | null;
	feeCents: Cents;
	estimated: 'rate' | 'balance' | null;
}

export interface DebtFormValues {
	/** O sistema que vale: `none` no consórcio. */
	system: AmortizationSystem;
	installmentCents: Cents | null;
	remaining: number;
	validRemaining: boolean;
	/** O texto do campo de saldo (vazio = não sabe). */
	balance: string;
	/** A taxa de `formRateBp`. */
	typedRateBp: number | null;
	/** O texto do campo de reajuste do consórcio. */
	adjustment: string;
}

export const deriveDebtForm = ({ system, installmentCents, remaining, validRemaining, balance, typedRateBp, adjustment }: DebtFormValues): DerivedDebt | null => {
	if (installmentCents === null || installmentCents <= 0 || !validRemaining) return null;
	if (system === 'none') {
		const rateBp = percentInputToBp(adjustment, 100) ?? 0;
		const typed = balance.trim() === '' ? null : parseAmountToCents(balance);
		return { balanceCents: typed ?? installmentCents * remaining, rateBp, feeCents: 0, estimated: null };
	}
	const balanceCents = balance.trim() === '' ? null : parseAmountToCents(balance);
	const hasBalance = balanceCents !== null && balanceCents > 0;

	if (hasBalance && typedRateBp !== null) {
		// Os dois: o que a parcela cobra além da taxa é seguro e tarifa.
		const fee = installmentFeeCents({ system, balanceCents, installmentCents, remaining, rateBp: typedRateBp });
		const tolerance = Math.max(100, Math.round(installmentCents * 0.005));
		if (fee < -tolerance) return { balanceCents, rateBp: null, feeCents: 0, estimated: null };
		return { balanceCents, rateBp: typedRateBp, feeCents: fee > tolerance ? fee : 0, estimated: null };
	}
	if (hasBalance) {
		const rateBp = impliedRateBp({ system, balanceCents, installmentCents, remaining });
		return { balanceCents, rateBp, feeCents: 0, estimated: 'rate' };
	}
	if (typedRateBp === null) return null;
	return {
		balanceCents: principalFromRateCents({ system, installmentCents, remaining, rateBp: typedRateBp }),
		rateBp: typedRateBp,
		feeCents: 0,
		estimated: 'balance',
	};
};

/**
 * Os termos que salvar grava, ancorados em hoje — e os mesmos da prévia. Nulo enquanto falta
 * algo ou os números não fecham.
 */
export const formTerms = (
	derived: DerivedDebt | null,
	{ system, installmentCents, remaining, dueDay, today }: { system: AmortizationSystem; installmentCents: Cents | null; remaining: number; dueDay: number; today: string }
): (DebtTerms & { rateBp: number }) | null => {
	if (!derived || derived.rateBp === null || installmentCents === null) return null;
	return {
		system,
		balanceCents: derived.balanceCents,
		balanceDate: today,
		installmentCents,
		remaining,
		dueDay,
		rateBp: derived.rateBp,
		feeCents: derived.feeCents,
	};
};

/** Os campos da dívida que salvar grava a partir dos termos da prévia. */
export const debtFieldsOfTerms = (
	terms: DebtTerms
): Pick<Debt, 'system' | 'openingBalanceCents' | 'openingBalanceDate' | 'installmentCents' | 'remainingAtOpening' | 'dueDay' | 'rateBp' | 'feeCents'> => ({
	system: terms.system,
	openingBalanceCents: terms.balanceCents,
	openingBalanceDate: terms.balanceDate,
	installmentCents: terms.installmentCents,
	remainingAtOpening: terms.remaining,
	dueDay: terms.dueDay,
	rateBp: terms.rateBp,
	feeCents: terms.feeCents ?? 0,
});

/**
 * Todo arquivo sob app/ é tratado como rota pelo expo-router, e uma rota sem export
 * default é um módulo quebrado do ponto de vista dele. Este export existe só para
 * satisfazer essa exigência — nada navega para cá.
 */
export default { prefilledRateOf, formRateBp, debtFormFieldsOf, deriveDebtForm, formTerms, debtFieldsOfTerms };
