import type { Debt } from '../../database/schema';
import { debtStateOn, monthlyRateBpOf, termsOf } from '../debt';
import { debtFieldsOfTerms, debtFormFieldsOf, deriveDebtForm, formRateBp, formTerms, type PrefilledRate, type RatePeriod } from '../debtForm';
import { configureMoney, formatCents, parseAmountToCents } from '../money';
import { formatPercentBp } from '../percent';
import { sampleDebt } from '../trailSample';

/**
 * SPD-157: a prévia do cadastro de dívida e a tela da dívida contam com a mesma função
 * (`debtStateOn`) a partir da mesma taxa — a que salvar grava. No aparelho, o cadastro de
 * exemplo dizia "1,51% ao mês (19,7% ao ano) … mais R$ 3.989,74 de juros" e a tela da mesma
 * dívida "19,8% ao ano … R$ 4.000,76": o formulário abria a taxa guardada (19,75% ao ano,
 * estimada pela parcela) como "1,51" ao mês, e ler "1,51" de volta dá 19,70% ao ano. Salvar
 * sem mexer regravava a dívida com a taxa arredondada.
 */

const TODAY = '2026-11-12';

beforeAll(() => configureMoney({ locale: 'pt-BR', currencyCode: 'BRL', currencySymbol: 'R$' }));
afterAll(() => configureMoney({ locale: 'en-US', currencyCode: 'USD', currencySymbol: '$' }));

interface Form {
	system: 'price' | 'sac';
	installment: string;
	remaining: string;
	total: string;
	dueDay: string;
	balance: string;
	rate: string;
	ratePeriod: RatePeriod;
	/** A taxa com que o formulário abriu uma dívida guardada (nula no cadastro novo). */
	prefilled: PrefilledRate | null;
}

/** O que as duas telas escrevem: taxa ao mês e ao ano, quitação e juros que faltam. */
interface Shown {
	monthly: string;
	yearly: string;
	payoff: string | null;
	interestCents: number;
	interest: string;
}

const shown = (rateBp: number, state: ReturnType<typeof debtStateOn>): Shown => ({
	monthly: formatPercentBp(monthlyRateBpOf(rateBp), 2),
	yearly: formatPercentBp(rateBp),
	payoff: state.payoffDate,
	interestCents: state.interestAheadCents,
	interest: formatCents(state.interestAheadCents),
});

/** O formulário, como a `DebtEditScreen` faz a conta: a prévia e os termos que salvar grava. */
const preview = (form: Form, today = TODAY) => {
	const installmentCents = parseAmountToCents(form.installment);
	const remaining = Number(form.remaining);
	const derived = deriveDebtForm({
		system: form.system,
		installmentCents,
		remaining,
		validRemaining: Number.isInteger(remaining) && remaining >= 1,
		balance: form.balance,
		typedRateBp: formRateBp(form.rate, form.ratePeriod, form.prefilled),
		adjustment: '',
	});
	const terms = formTerms(derived, { system: form.system, installmentCents, remaining, dueDay: Number(form.dueDay), today });
	if (!terms || !derived) throw new Error('os números não fecham');
	return { terms, derived, shown: shown(terms.rateBp, debtStateOn(terms, today)) };
};

/** Salvar: a dívida como o banco a guarda (os campos que a `DebtEditScreen` grava). */
const save = (form: Form, today = TODAY): Debt => ({
	id: 'divida',
	name: 'Carro',
	kind: 'financing',
	installmentsTotal: Number(form.total),
	adminFeeBp: null,
	accountId: null,
	category: null,
	archived: false,
	sortOrder: 0,
	updatedAt: '',
	...debtFieldsOfTerms(preview(form, today).terms),
});

/** A tela da dívida (`DebtDetailScreen`): a dívida guardada, hoje. */
const detail = (debt: Debt, today = TODAY): Shown => shown(debt.rateBp, debtStateOn(termsOf(debt), today));

/** "Editar dívida": o formulário aberto com a dívida guardada, sem mexer em nada. */
const editForm = (debt: Debt, today = TODAY): Form => {
	const fields = debtFormFieldsOf(debt, today);
	return {
		system: debt.system === 'sac' ? 'sac' : 'price',
		installment: fields.installment,
		remaining: fields.remaining,
		total: fields.total,
		dueDay: fields.dueDay,
		balance: fields.balance,
		rate: fields.rate.text,
		ratePeriod: fields.rate.period,
		prefilled: fields.rate,
	};
};

const newForm = (overrides: Partial<Form>): Form => ({
	system: 'price',
	installment: '1.000,00',
	remaining: '24',
	total: '48',
	dueDay: '10',
	balance: '20.000,00',
	rate: '',
	ratePeriod: 'month',
	prefilled: null,
	...overrides,
});

describe('Price, taxa estimada pela parcela (o caso do aparelho)', () => {
	// R$ 20.000 de saldo, parcela R$ 1.000, 24 de 48, dia 10, campo de taxa vazio.
	const form = newForm({});
	const expected = { monthly: '1,51%', yearly: '19,8%', payoff: '2028-11-10', interestCents: 400_076 };

	it('a prévia do cadastro e a tela depois de salvar mostram os mesmos números', () => {
		const before = preview(form);
		expect(before.derived.estimated).toBe('rate');
		expect(before.terms.rateBp).toBe(1_975);
		expect(before.shown).toMatchObject(expected);
		const debt = save(form);
		expect(debt.rateBp).toBe(1_975);
		expect(detail(debt)).toEqual(before.shown);
	});

	it('"Editar dívida" mostra o que a tela da dívida mostra (antes: 19,7% e R$ 3.989,74)', () => {
		const debt = save(form);
		const edit = preview(editForm(debt));
		expect(editForm(debt).rate).toBe('1,51');
		expect(edit.shown).toEqual(detail(debt));
		expect(edit.shown).toMatchObject(expected);
		expect(edit.derived.feeCents).toBe(0);
	});

	it('salvar a edição sem mexer não muda a taxa nem os juros da dívida', () => {
		const debt = save(form);
		const again = save(editForm(debt));
		expect(again.rateBp).toBe(debt.rateBp);
		expect(again.feeCents).toBe(0);
		expect(detail(again)).toEqual(detail(debt));
	});

	it('editada um mês e meio depois, a prévia ainda bate com a tela', () => {
		const debt = save(form);
		const later = '2027-01-15';
		const shownLater = detail(debt, later);
		expect(shownLater.payoff).toBe('2028-11-10');
		expect(preview(editForm(debt, later), later).shown).toEqual(shownLater);
		expect(detail(save(editForm(debt, later), later), later)).toEqual(shownLater);
	});

	it('a dívida de exemplo das trilhas: "Nova dívida" preenchida com ela mostra o que a tela dela mostra', () => {
		const sample = sampleDebt('exemplo-divida', { account: 'Conta', bank: 'Banco', card: 'Cartão', debt: 'Financiamento exemplo', transaction: 'Café' }, TODAY);
		if (!sample) throw new Error('sem exemplo');
		const form = editForm(sample);
		expect(form.rate).toBe('1,51');
		expect(preview(form).shown).toEqual(detail(sample));
		expect(detail(sample)).toMatchObject(expected);
	});

	it('mexer na taxa ainda vale: "1,40" ao mês é 1,40% ao mês', () => {
		const debt = save(form);
		const edited = preview({ ...editForm(debt), rate: '1,40' });
		expect(edited.terms.rateBp).toBe(1_816);
		expect(edited.shown.monthly).toBe('1,40%');
	});
});

describe('SAC, taxa estimada pela parcela', () => {
	// R$ 20.000 de saldo, próxima parcela R$ 1.130, 24 de 48, dia 10.
	const form = newForm({ system: 'sac', installment: '1.130,00' });

	it('a prévia, a tela depois de salvar e "Editar dívida" mostram os mesmos números', () => {
		const before = preview(form);
		expect(before.terms.rateBp).toBe(1_933);
		expect(before.shown).toMatchObject({ monthly: '1,48%', yearly: '19,3%', payoff: '2028-11-10', interestCents: 370_892 });
		const debt = save(form);
		expect(detail(debt)).toEqual(before.shown);
		expect(preview(editForm(debt)).shown).toEqual(detail(debt));
	});

	it('salvar a edição sem mexer não muda a taxa nem os juros', () => {
		const debt = save(form);
		const again = save(editForm(debt));
		expect(again.rateBp).toBe(1_933);
		expect(detail(again)).toEqual(detail(debt));
	});
});

describe('taxa digitada', () => {
	it('19,75% ao ano: a prévia, a tela e "Editar dívida" mostram os mesmos números', () => {
		const form = newForm({ rate: '19,75', ratePeriod: 'year' });
		const before = preview(form);
		expect(before.derived.estimated).toBeNull();
		expect(before.derived.feeCents).toBe(0);
		expect(before.shown).toMatchObject({ monthly: '1,51%', yearly: '19,8%', interestCents: 400_076 });
		const debt = save(form);
		expect(detail(debt)).toEqual(before.shown);
		expect(preview(editForm(debt)).shown).toEqual(detail(debt));
		expect(save(editForm(debt)).rateBp).toBe(1_975);
	});

	it('1,51% ao mês fica 1,51% ao mês (19,7% ao ano) em todo lugar', () => {
		const form = newForm({ rate: '1,51' });
		const before = preview(form);
		expect(before.terms.rateBp).toBe(1_970);
		expect(before.shown).toMatchObject({ monthly: '1,51%', yearly: '19,7%', payoff: '2028-11-10', interestCents: 398_974 });
		const debt = save(form);
		expect(detail(debt)).toEqual(before.shown);
		expect(preview(editForm(debt)).shown).toEqual(detail(debt));
		expect(save(editForm(debt)).rateBp).toBe(1_970);
	});
});
