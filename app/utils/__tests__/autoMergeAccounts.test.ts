import type { Account } from '../../database/schema';
import { accountPairKey } from '../accountBinding';
import { type AccountLinks, autoMergeCandidates, isEmptyUntouched, looksUntouched, planAutoMerges } from '../autoMergeAccounts';

/**
 * Juntar sozinho a ficha duplicada vazia (SPD-116, DEC-36 Q4): só quando uma das duas fichas
 * do mesmo banco está totalmente vazia e nunca foi editada. Nos outros casos o aviso "Duas
 * contas do mesmo banco" continua perguntando.
 */

/** A conta como a captura cria (`newAccountDraft` em `accountResolver`), de um banco qualquer. */
const fromCapture = (overrides: Partial<Account> = {}): Account => ({
	id: 'captura',
	name: 'Banco Teste',
	kind: 'checking',
	role: 'main',
	envelopeMonthlyCents: null,
	network: null,
	bankName: 'Banco Teste',
	color: '#4CAF50',
	last4: null,
	closingDay: null,
	dueDay: null,
	closingDaysBefore: null,
	creditLimitCents: null,
	cardNames: null,
	yieldCdiBp: null,
	reservePurpose: null,
	packageName: 'br.com.bancoteste',
	accountKey: null,
	openingBalanceCents: 0,
	openingBalanceDate: '2026-11-05',
	sortOrder: 0,
	archived: false,
	updatedAt: '',
	...overrides,
});

/** A cadastrada à mão (`AccountEditScreen`): sem app, com saldo, na posição das que já havia. */
const byHand = (overrides: Partial<Account> = {}): Account =>
	fromCapture({ id: 'mao', name: 'Corrente', packageName: null, openingBalanceCents: 123_456, sortOrder: 1, ...overrides });

const NOTHING: AccountLinks = { transactions: 0, transfers: 0, captures: 0, bills: 0, debts: 0 };

/** Os ids vazios, como quem dispara decide: cada candidata com o que está ligado a ela. */
const emptyOf = (accounts: Account[], links: Record<string, AccountLinks | null> = {}, dismissed: string[] = []) =>
	new Set(
		accounts
			.filter((account) => isEmptyUntouched(account, account.id in links ? links[account.id] : NOTHING, dismissed.includes(account.id)))
			.map((account) => account.id)
	);

describe('ficha totalmente vazia e nunca editada', () => {
	it('a que a captura criou e ficou sem nada é vazia', () => {
		expect(looksUntouched(fromCapture())).toBe(true);
		expect(isEmptyUntouched(fromCapture(), NOTHING, false)).toBe(true);
	});

	it.each<[string, Partial<AccountLinks>]>([
		['um lançamento', { transactions: 1 }],
		['uma parcela (é lançamento)', { transactions: 3 }],
		['uma transferência', { transfers: 1 }],
		['uma captura', { captures: 1 }],
		['uma conta a pagar', { bills: 1 }],
		['uma dívida', { debts: 1 }],
	])('com %s ligado, não é vazia', (_what, links) => {
		expect(isEmptyUntouched(fromCapture(), { ...NOTHING, ...links }, false)).toBe(false);
	});

	it('sem saber o que está ligado (consulta sem resposta), não é vazia', () => {
		expect(isEmptyUntouched(fromCapture(), null, false)).toBe(false);
	});

	it.each<[string, Partial<Account>]>([
		['com saldo de abertura', { openingBalanceCents: 10_000 }],
		['com saldo negativo', { openingBalanceCents: -2_647 }],
		['renomeada', { name: 'Conta do dia a dia' }],
		['com extrato ligado', { accountKey: 'banco-teste:0001' }],
		['sem app ligado (cadastrada à mão)', { packageName: null }],
		['fora da primeira posição', { sortOrder: 3 }],
		['virou poupança', { kind: 'savings', role: 'reserve' }],
		['virou envelope', { role: 'envelope', envelopeMonthlyCents: 50_000 }],
		['com rendimento', { yieldCdiBp: 10_000 }],
		['com final de débito', { last4: '4321' }],
		['com cartão de débito nomeado', { cardNames: '{"4321":"Débito"}' }],
		['arquivada', { archived: true }],
		['apagada', { deletedAt: '2026-11-06T10:00:00.000Z' }],
	])('%s, não é "nunca editada"', (_what, overrides) => {
		expect(isEmptyUntouched(fromCapture(overrides), NOTHING, false)).toBe(false);
	});

	it('com o "Saldo não informado" dispensado neste aparelho, não é "nunca editada"', () => {
		expect(isEmptyUntouched(fromCapture(), NOTHING, true)).toBe(false);
	});

	it('cartão de crédito nunca é ficha vazia para juntar', () => {
		const card = fromCapture({ kind: 'credit_card', role: 'card', name: 'Banco Teste', last4: '1111' });
		expect(isEmptyUntouched(card, NOTHING, false)).toBe(false);
	});
});

describe('quais pares juntam sozinhos', () => {
	it('a vazia vai para a outra, e só ela', () => {
		const accounts = [fromCapture(), byHand()];
		const plan = planAutoMerges(accounts, emptyOf(accounts));
		expect(plan).toHaveLength(1);
		expect(plan[0].from.id).toBe('captura');
		expect(plan[0].into.id).toBe('mao');
	});

	it('a ficha à mão, mesmo sem saldo nem nada, não some sozinha: o nome foi o usuário que deu', () => {
		// A da captura tem lançamento; a à mão está zerada (a PJ recém-cadastrada, por exemplo).
		const accounts = [fromCapture(), byHand({ openingBalanceCents: 0, name: 'Banco Teste PJ' })];
		const empty = emptyOf(accounts, { captura: { ...NOTHING, transactions: 4 } });
		expect(empty.size).toBe(0);
		expect(planAutoMerges(accounts, empty)).toEqual([]);
	});

	it('com lançamento na ficha da captura, fica o aviso de sempre', () => {
		const accounts = [fromCapture(), byHand()];
		expect(planAutoMerges(accounts, emptyOf(accounts, { captura: { ...NOTHING, transactions: 1 } }))).toEqual([]);
	});

	it('com saldo informado na ficha da captura, fica o aviso de sempre', () => {
		const accounts = [fromCapture({ openingBalanceCents: 98_765 }), byHand()];
		expect(planAutoMerges(accounts, emptyOf(accounts))).toEqual([]);
	});

	it('renomeada, fica o aviso de sempre', () => {
		const accounts = [fromCapture({ name: 'Banco Teste PF' }), byHand()];
		expect(planAutoMerges(accounts, emptyOf(accounts))).toEqual([]);
	});

	it('o par marcado como contas diferentes (PF e PJ) nunca junta sozinho', () => {
		const accounts = [fromCapture(), byHand()];
		expect(planAutoMerges(accounts, emptyOf(accounts), [accountPairKey('mao', 'captura')])).toEqual([]);
	});

	it('o par com a conta escolhida para os avisos da PJ nunca junta sozinho', () => {
		const accounts = [fromCapture(), byHand()];
		// A da captura também recebe os avisos da PJ.
		expect(planAutoMerges(accounts, emptyOf(accounts), [], ['captura'])).toEqual([]);
		// A à mão é a da PJ: as duas recebem avisos, e não há par.
		expect(planAutoMerges(accounts, emptyOf(accounts), [], ['mao'])).toEqual([]);
	});

	it('cartão de crédito nunca junta sozinho, nem com o id marcado como vazio', () => {
		const card = fromCapture({ id: 'cartao', kind: 'credit_card', role: 'card', name: 'Banco Teste · final 1111', last4: '1111' });
		const handCard = byHand({ id: 'cartao-mao', kind: 'credit_card', role: 'card', name: 'Meu cartão', last4: '2222' });
		expect(planAutoMerges([card, handCard], new Set(['cartao']))).toEqual([]);
	});

	it('as duas marcadas como vazias: não há critério para escolher, e não junta', () => {
		const accounts = [fromCapture(), byHand()];
		expect(planAutoMerges(accounts, new Set(['captura', 'mao']))).toEqual([]);
	});

	it('com três fichas do banco não há par, e nada junta', () => {
		const accounts = [fromCapture(), byHand(), byHand({ id: 'mao2', name: 'Reserva', sortOrder: 2 })];
		expect(planAutoMerges(accounts, emptyOf(accounts))).toEqual([]);
	});

	it('bancos diferentes não são par', () => {
		const accounts = [fromCapture(), byHand({ bankName: 'Outro Banco' })];
		expect(planAutoMerges(accounts, emptyOf(accounts))).toEqual([]);
	});
});

describe('quem vale contar no banco', () => {
	it('só a ficha com a assinatura que está num par', () => {
		expect(autoMergeCandidates([fromCapture(), byHand()]).map((account) => account.id)).toEqual(['captura']);
	});

	it('sozinha no banco, nada a contar', () => {
		expect(autoMergeCandidates([fromCapture(), byHand({ bankName: 'Outro Banco' })])).toEqual([]);
	});

	it('renomeada, nada a contar', () => {
		expect(autoMergeCandidates([fromCapture({ name: 'Minha conta' }), byHand()])).toEqual([]);
	});
});
