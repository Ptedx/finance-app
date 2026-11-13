import { ambiguityOfReason } from '../ambiguityReasons';
import { isBalanceNeverInformed } from '../balanceUnset';
import { billStatus } from '../billReminders';
import { canUndoMonth, homeBills, monthBills, overdueBills, payableMonth } from '../billRules';
import { buildCardSummary } from '../cardMath';
import { debtStateOn, termsOf } from '../debt';
import {
	isSampleId,
	SAMPLE_BILL_VALUES,
	SAMPLE_IDS,
	type SampleCaptureNames,
	type SampleNames,
	sampleAccount,
	sampleBills,
	sampleCaptures,
	sampleDebt,
	sampleTransaction,
	TRAIL_SAMPLE_RECORDS,
} from '../trailSample';
import { planTrail, TRAILS, type TrailLocation, type TrailRecords } from '../trails';

/**
 * O modo exemplo das trilhas (SPD-147): sem o registro que a trilha explica, o plano abre a
 * tela com um exemplo só em memória (o id `exemplo-…`, ou o cadastro com `exemplo=1`), marcado
 * `sample`, em vez de pular o passo ou mostrar o texto sem apontar. Com o registro do usuário,
 * o plano usa o dele, como antes.
 */

const names: SampleNames = {
	account: 'Conta exemplo',
	bank: 'Banco exemplo',
	card: 'Cartão exemplo',
	debt: 'Financiamento exemplo',
	transaction: 'Mercado exemplo',
};
const TODAY = '2026-11-07';

const where = (plan: ReturnType<typeof planTrail>) =>
	plan.map(
		(step) =>
			`${step.id}@${step.location.screen}${step.location.params ? `:${Object.values(step.location.params).join('/')}` : ''}${step.sample ? '*' : ''}`
	);

const nothing: TrailRecords = {};
const cards: TrailLocation = { screen: 'cards' };
const wealth: TrailLocation = { screen: 'wealth' };

describe('o plano com o exemplo', () => {
	it('Trilha 3 sem cartão: anda no cartão de exemplo, os 12 passos — sem o "Nenhum cartão ainda"', () => {
		const plan = planTrail(TRAILS.cardInvoice, nothing, cards, TRAIL_SAMPLE_RECORDS);
		expect(plan).toHaveLength(12);
		expect(plan.every((step) => step.sample && !step.textOnly)).toBe(true);
		expect(
			plan.every(
				(step) => step.location.screen === 'card' && step.location.params?.id === SAMPLE_IDS.card
			)
		).toBe(true);
		expect(plan.map((step) => step.bodyKey)).not.toContain('trails.cardInvoice.steps.noCard.body');
		expect(TRAILS.cardInvoice.fallback).toBeUndefined();
	});

	it('Trilha 3 com cartão: o do usuário, sem exemplo', () => {
		const plan = planTrail(
			TRAILS.cardInvoice,
			{ card: [{ id: 'nubank' }] },
			cards,
			TRAIL_SAMPLE_RECORDS
		);
		expect(plan).toHaveLength(12);
		expect(plan.some((step) => step.sample)).toBe(false);
		expect(plan[0].location).toEqual({ screen: 'card', params: { id: 'nubank' } });
	});

	it('Trilha 9 sem dívida, do Patrimônio: o cadastro com o exemplo (a prévia aparece) e a dívida de exemplo', () => {
		const plan = planTrail(TRAILS.debts, nothing, wealth, TRAIL_SAMPLE_RECORDS);
		expect(where(plan)).toEqual([
			'1@wealth',
			'2@debtNew:1*',
			'3@debtNew:1*',
			'4@debtNew:1*',
			'5@debtNew:1*',
			'6@debtNew:1*',
			'7@debtNew:1*',
			'8@debtNew:1*',
			'9@debt:exemplo-divida*',
			'10@debt:exemplo-divida*',
			'11@debt:exemplo-divida*',
			'12@debtEdit:exemplo-divida*',
		]);
		expect(plan[1].location.params).toEqual({ exemplo: '1' });
		// O texto do [sem dado] ("Na tela de cada dívida…") não é mais usado: há a dívida de exemplo.
		expect(plan[8].bodyKey).toBe('trails.debts.steps.9.body');
	});

	it('Trilha 9 com dívida: a dívida do usuário; o cadastro continua com o exemplo', () => {
		const plan = planTrail(TRAILS.debts, { debt: [{ id: 'carro' }] }, wealth, TRAIL_SAMPLE_RECORDS);
		expect(where(plan).slice(7)).toEqual([
			'8@debtNew:1*',
			'9@debt:carro',
			'10@debt:carro',
			'11@debt:carro',
			'12@debtEdit:carro',
		]);
	});

	it('Trilha 9 aberta pelo "?" da Nova dívida: o formulário é o do usuário, sem exemplo por cima', () => {
		const plan = planTrail(TRAILS.debts, nothing, { screen: 'debtNew' }, TRAIL_SAMPLE_RECORDS);
		expect(where(plan).slice(1, 8)).toEqual([
			'2@debtNew',
			'3@debtNew',
			'4@debtNew',
			'5@debtNew',
			'6@debtNew',
			'7@debtNew',
			'8@debtNew',
		]);
		expect(where(plan)[8]).toBe('9@debt:exemplo-divida*');
	});

	it('Trilha 2: o cadastro com o exemplo (as datas da fatura aparecem); sem cartão sem fechamento, o de exemplo', () => {
		const plan = planTrail(
			TRAILS.cardSetup,
			{ card: [{ id: 'nubank' }] },
			cards,
			TRAIL_SAMPLE_RECORDS
		);
		expect(where(plan)).toEqual([
			'1@cards',
			'2@cards',
			'3@cardNew:1*',
			'4@cardNew:1*',
			'5@cardNew:1*',
			'6@cardNew:1*',
			'7@cardNew:1*',
			'8@cardNew:1*',
			'9@cardNew:1*',
			'10@cardNew:1*',
			'11@card:exemplo-cartao-sem-fechamento*',
		]);
		const own = planTrail(
			TRAILS.cardSetup,
			{ cardNoClosing: [{ id: 'captura' }] },
			cards,
			TRAIL_SAMPLE_RECORDS
		);
		expect(where(own)[10]).toBe('11@card:captura');
	});

	it('Trilha 1 sem conta: a conta de exemplo nos passos 9 e 12, e a "criada pela captura" no 10', () => {
		const plan = planTrail(TRAILS.accounts, nothing, { screen: 'accounts' }, TRAIL_SAMPLE_RECORDS);
		expect(where(plan).slice(8)).toEqual([
			'9@account:exemplo-conta*',
			'10@account:exemplo-conta-captura*',
			'11@accounts',
			'12@account:exemplo-conta*',
		]);
		expect(plan.every((step) => !step.textOnly)).toBe(true);
	});

	it('Trilha 5 sem lançamento: o passo 11 abre o lançamento de exemplo', () => {
		const plan = planTrail(TRAILS.add, nothing, { screen: 'home' }, TRAIL_SAMPLE_RECORDS);
		expect(where(plan)[10]).toBe('11@transaction:exemplo-lancamento*');
	});

	it('condição (`needs`) não vale com exemplo: "Este mês" e Relatórios não ganham cartão nem dívida de mentira', () => {
		expect(
			planTrail(TRAILS.month, nothing, { screen: 'home' }, TRAIL_SAMPLE_RECORDS).map(
				(step) => step.id
			)
		).not.toContain('4');
		expect(
			planTrail(TRAILS.health, nothing, { screen: 'reports' }, TRAIL_SAMPLE_RECORDS).map(
				(step) => step.id
			)
		).not.toContain('8');
		// O débito e o "Juntar" (outro cartão) continuam pulados: não há exemplo para eles.
		expect(
			planTrail(TRAILS.cardExtras, nothing, cards, TRAIL_SAMPLE_RECORDS).map((step) => step.id)
		).toEqual(['1', '2', '3', '4', '6', '8', '9']);
	});

	it('sem os exemplos (o plano de antes), nada muda nos outros passos', () => {
		const plan = planTrail(TRAILS.debts, nothing, wealth);
		expect(plan.some((step) => step.sample)).toBe(false);
		expect(plan[1].location).toEqual({ screen: 'debtNew' });
		expect(plan[8]).toMatchObject({ textOnly: true, bodyKey: 'trails.debts.steps.9.missing' });
	});
});

describe('os registros de exemplo', () => {
	it('ids próprios, que nenhum registro de verdade tem', () => {
		for (const id of Object.values(SAMPLE_IDS)) expect(isSampleId(id)).toBe(true);
		expect(isSampleId('6f1c2e9a-0b1d-4c3e-9f00-000000000000')).toBe(false);
		expect(isSampleId(undefined)).toBe(false);
		expect(sampleAccount('nubank', names, TODAY)).toBeNull();
		expect(sampleDebt(SAMPLE_IDS.card, names, TODAY)).toBeNull();
	});

	it('o cartão de exemplo: final 0000, limite R$ 5.000, fatura informada de R$ 500, fecha dia 5 e vence dia 15', () => {
		const card = sampleAccount(SAMPLE_IDS.card, names, TODAY);
		expect(card).toMatchObject({
			name: 'Cartão exemplo',
			kind: 'credit_card',
			last4: '0000',
			creditLimitCents: 500_000,
			closingDay: 5,
			dueDay: 15,
			openingBalanceCents: -50_000,
			openingBalanceDate: '2026-11-06',
		});
		const summary = buildCardSummary(card as NonNullable<typeof card>, [], [], TODAY);
		expect(summary.configured).toBe(true);
		expect(summary.owedCents).toBe(50_000);
		expect(summary.limitAvailableCents).toBe(450_000);
		const noClosing = sampleAccount(SAMPLE_IDS.cardNoClosing, names, TODAY);
		expect(
			buildCardSummary(noClosing as NonNullable<typeof noClosing>, [], [], TODAY).configured
		).toBe(false);
	});

	it('a conta "criada pela captura" de exemplo mostra o "Saldo não informado"; a outra, não', () => {
		const captured = sampleAccount(SAMPLE_IDS.capturedAccount, names, TODAY);
		expect(captured && isBalanceNeverInformed(captured)).toBe(true);
		const plain = sampleAccount(SAMPLE_IDS.account, names, TODAY);
		expect(plain).toMatchObject({
			name: 'Conta exemplo',
			openingBalanceCents: 100_000,
			role: 'main',
		});
		expect(plain && isBalanceNeverInformed(plain)).toBe(false);
	});

	it('a dívida de exemplo: R$ 20.000, 24 parcelas de R$ 1.000, em dia e amortizando', () => {
		const debt = sampleDebt(SAMPLE_IDS.debt, names, TODAY);
		expect(debt).toMatchObject({
			name: 'Financiamento exemplo',
			openingBalanceCents: 2_000_000,
			installmentCents: 100_000,
			remainingAtOpening: 24,
		});
		const state = debtStateOn(termsOf(debt as NonNullable<typeof debt>), TODAY);
		expect(state.balanceCents).toBe(2_000_000);
		expect(state.amortizes).toBe(true);
		expect(state.settled).toBe(false);
		// 24 × R$ 1.000 pagam R$ 20.000: uns 1,5% ao mês.
		expect(debt?.rateBp).toBeGreaterThan(1_900);
		expect(debt?.rateBp).toBeLessThan(2_000);
	});

	it('o lançamento de exemplo: R$ 100 de hoje, sem conta', () => {
		expect(sampleTransaction(SAMPLE_IDS.transaction, names, TODAY)).toMatchObject({
			amountCents: 10_000,
			date: TODAY,
			note: 'Mercado exemplo',
			isIncome: false,
			accountId: null,
		});
	});
});

describe('a revisão de exemplo (SPD-159)', () => {
	const captureNames: SampleCaptureNames = {
		bank: 'Banco exemplo',
		wallet: 'Carteira exemplo',
		merchant: 'Mercado exemplo',
		store: 'Farmácia exemplo',
		purchaseTitle: 'Compra aprovada',
		purchaseText: 'Compra de R$ 100,00 aprovada em Mercado exemplo no débito.',
		walletTitle: 'Pagamento feito',
		walletText: 'R$ 100,00 em Mercado exemplo',
		creditTitle: 'Compra no crédito',
		creditText: 'Compra de R$ 50,00 no crédito aprovada em Farmácia exemplo.',
	};
	const NOW = new Date('2026-11-07T15:00:00.000Z');

	it('Trilha 7 sem nada para revisar: os 11 passos, os dos avisos (2 a 8) no exemplo, sem sair da revisão', () => {
		const plan = planTrail(TRAILS.review, nothing, { screen: 'inbox' }, TRAIL_SAMPLE_RECORDS);
		expect(where(plan)).toEqual([
			'1@home',
			'2@inbox:*',
			'3@inbox:*',
			'4@inbox:*',
			'5@inbox:*',
			'6@inbox:*',
			'7@inbox:*',
			'8@inbox:*',
			'9@inbox',
			'10@inbox',
			'11@inbox',
		]);
		expect(plan.some((step) => step.textOnly)).toBe(false);
		// A revisão de exemplo é a revisão de sempre: `{}` e sem parâmetro são a mesma tela.
		expect(plan[1].location).toEqual({ screen: 'inbox', params: {} });
	});

	it('Trilha 7 com aviso de verdade: os do usuário, sem exemplo', () => {
		const plan = planTrail(TRAILS.review, { pending: [{}] }, { screen: 'home' }, TRAIL_SAMPLE_RECORDS);
		expect(plan).toHaveLength(11);
		expect(plan.some((step) => step.sample)).toBe(false);
	});

	it('três avisos de exemplo, com ids de exemplo, pendentes e em nenhum app de verdade', () => {
		const captures = sampleCaptures(captureNames, NOW);
		expect(captures.map((capture) => capture.id)).toEqual([
			SAMPLE_IDS.capture,
			SAMPLE_IDS.captureDuplicate,
			SAMPLE_IDS.captureIncomplete,
		]);
		for (const capture of captures) {
			expect(isSampleId(capture.id)).toBe(true);
			expect(isSampleId(capture.packageName)).toBe(true);
			expect(capture).toMatchObject({ status: 'pending', transactionId: null, autoConfirmed: false });
			expect(capture.amountCents % 1_000).toBe(0);
		}
	});

	it('a compra (passos 2 a 6), o mesmo valor pela carteira (passo 7) e o crédito sem cartão (passo 8)', () => {
		const [purchase, duplicate, incomplete] = sampleCaptures(captureNames, NOW);
		expect(purchase).toMatchObject({
			kind: 'purchase',
			direction: 'out',
			amountCents: 10_000,
			appLabel: 'Banco exemplo',
			counterparty: 'Mercado exemplo',
			accountId: SAMPLE_IDS.account,
			question: null,
			reason: null,
			title: 'Compra aprovada',
			text: 'Compra de R$ 100,00 aprovada em Mercado exemplo no débito.',
		});
		expect(duplicate).toMatchObject({
			amountCents: purchase.amountCents,
			appLabel: 'Carteira exemplo',
			question: 'duplicate',
			relatedId: purchase.id,
		});
		expect(new Date(duplicate.postedAt).getTime() - new Date(purchase.postedAt).getTime()).toBe(60_000);
		expect(incomplete).toMatchObject({ amountCents: 5_000, accountId: null, cardLast4: null });
		expect(ambiguityOfReason(incomplete.reason)).toEqual({ case: 'credit_no_last4', learned: false });
		// Todos chegaram antes de agora.
		for (const capture of [purchase, duplicate, incomplete])
			expect(new Date(capture.postedAt).getTime()).toBeLessThan(NOW.getTime());
	});
});

describe('as contas a pagar de exemplo (SPD-160)', () => {
	const billNames = { bill: 'Aluguel exemplo', billPaid: 'Internet exemplo' };

	it('ids de exemplo; "Aluguel exemplo" em aberto, R$ 1.500, na conta de exemplo; "Internet exemplo" paga neste mês', () => {
		const [open, paid] = sampleBills(billNames, TODAY);
		expect([open.id, paid.id]).toEqual([SAMPLE_IDS.bill, SAMPLE_IDS.billPaid]);
		expect([open.id, paid.id].every(isSampleId)).toBe(true);
		expect(open).toMatchObject({
			name: 'Aluguel exemplo',
			dueDay: 10,
			amountCents: 150_000,
			accountId: SAMPLE_IDS.account,
			debtId: null,
			active: true,
			paidThrough: '2026-10',
		});
		expect(paid).toMatchObject({
			name: 'Internet exemplo',
			amountCents: 10_000,
			paidThrough: '2026-11',
		});
		expect(TRAIL_SAMPLE_RECORDS.bill).toEqual([{ id: SAMPLE_IDS.bill }]);
	});

	it.each([
		'2026-11-07',
		'2026-11-28',
		'2026-11-29',
		'2026-11-30',
		'2026-12-31',
		'2026-02-27',
		'2028-02-29',
		'2027-01-01',
	])('em %s: o aluguel tem "Já paguei" neste mês, nunca atrasado, e está no card da tela inicial; a internet tem "Desfazer"', (today) => {
		const month = today.slice(0, 7);
		const [open, paid] = sampleBills(billNames, today);
		expect(['upcoming', 'due_today']).toContain(billStatus(open, month, today));
		expect(payableMonth(open, month)).toBe(month);
		expect(billStatus(paid, month, today)).toBe('paid');
		expect(canUndoMonth(paid, month)).toBe(true);
		expect(homeBills([open, paid], today).rows.map((row) => row.bill.id)).toContain(
			SAMPLE_IDS.bill
		);
		// O "Falta pagar" do exemplo é só o aluguel; nada em atraso.
		const shown = monthBills([open, paid], today);
		expect(shown).toMatchObject({
			dueCents: SAMPLE_BILL_VALUES.openCents,
			lateCount: 0,
			variableCount: 0,
		});
		expect(overdueBills([open, paid], month).billCount).toBe(0);
	});
});
