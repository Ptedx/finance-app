import {
	type Candidate,
	type DecisionContext,
	decide,
	fingerprintOf,
	findTransferCounterpart,
	findWalletDuplicate,
	type KnownCapture,
	learnFromConfirmation,
	matchesOwnName,
} from '../captureMatcher';

const T0 = '2026-09-14T15:00:00.000Z';
const plus = (ms: number): string => new Date(new Date(T0).getTime() + ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

const NUBANK = 'com.nu.production';
const INTER = 'br.com.intermedium';
const SAMSUNG_PAY = 'com.samsung.android.spay';

const known = (overrides: Partial<KnownCapture>): KnownCapture => ({
	id: 'k1',
	packageName: NUBANK,
	postedAt: T0,
	amountCents: 3590,
	direction: 'out',
	kind: 'purchase',
	merchantKey: 'ifood',
	status: 'pending',
	transactionId: null,
	...overrides,
});

const candidate = (overrides: Partial<Candidate>): Candidate => ({
	packageName: NUBANK,
	postedAt: T0,
	amountCents: 3590,
	direction: 'out',
	kind: 'purchase',
	counterparty: 'IFOOD',
	merchantKey: 'ifood',
	neutral: false,
	...overrides,
});

const context = (overrides: Partial<DecisionContext> = {}): DecisionContext => ({
	recent: [],
	rule: undefined,
	ownNames: [],
	autoConfirmThreshold: 3,
	fallbackCategoryId: 'other_expense',
	...overrides,
});

describe('duplicata carteira + banco (Samsung Pay)', () => {
	it('o aviso do banco depois do Samsung Pay é duplicata certa, sem pergunta', () => {
		const samsung = known({ id: 'sp', packageName: SAMSUNG_PAY, postedAt: T0 });
		const decision = decide(
			candidate({ packageName: NUBANK, postedAt: plus(40_000) }),
			context({ recent: [samsung] })
		);
		expect(decision).toEqual({ action: 'duplicate', relatedId: 'sp', reason: 'wallet' });
	});

	it('o Samsung Pay depois do banco também é duplicata', () => {
		const bank = known({ id: 'nb', packageName: NUBANK, postedAt: T0 });
		const decision = decide(
			candidate({ packageName: SAMSUNG_PAY, postedAt: plus(5_000) }),
			context({ recent: [bank] })
		);
		expect(decision).toEqual({ action: 'duplicate', relatedId: 'nb', reason: 'wallet' });
	});

	it('continua duplicata mesmo que o usuário já tenha confirmado o primeiro aviso', () => {
		const confirmed = known({ id: 'sp', packageName: SAMSUNG_PAY, status: 'confirmed', transactionId: 'tx' });
		const decision = decide(candidate({ postedAt: plus(3 * HOUR) }), context({ recent: [confirmed] }));
		expect(decision).toEqual({ action: 'duplicate', relatedId: 'sp', reason: 'wallet' });
	});

	it('valores diferentes nunca são a mesma compra', () => {
		const samsung = known({ id: 'sp', packageName: SAMSUNG_PAY, amountCents: 3591 });
		expect(findWalletDuplicate(candidate({ amountCents: 3590 }), [samsung])).toBeUndefined();
	});

	it('fora da janela de 12 horas são duas compras', () => {
		const samsung = known({ id: 'sp', packageName: SAMSUNG_PAY, postedAt: T0 });
		expect(findWalletDuplicate(candidate({ postedAt: plus(13 * HOUR) }), [samsung])).toBeUndefined();
	});

	it('um aviso da carteira já descartado não segura o do banco', () => {
		const dismissed = known({ id: 'sp', packageName: SAMSUNG_PAY, status: 'dismissed' });
		expect(decide(candidate({}), context({ recent: [dismissed] })).action).toBe('pending');
	});

	it('dois avisos de carteira não são par um do outro', () => {
		const first = known({ id: 'sp1', packageName: SAMSUNG_PAY });
		expect(findWalletDuplicate(candidate({ packageName: SAMSUNG_PAY }), [first])).toBeUndefined();
	});
});

describe('duplicata provável entre bancos: pergunta, não decide', () => {
	it('mesmo valor em dois bancos com um minuto de diferença vira pergunta', () => {
		const inter = known({ id: 'in', packageName: INTER, postedAt: T0 });
		const decision = decide(
			candidate({ packageName: NUBANK, postedAt: plus(MIN) }),
			context({ recent: [inter] })
		);
		expect(decision).toEqual({ action: 'ask_duplicate', relatedId: 'in' });
	});

	it('dez minutos depois já são duas compras', () => {
		const inter = known({ id: 'in', packageName: INTER, postedAt: T0 });
		expect(decide(candidate({ postedAt: plus(10 * MIN) }), context({ recent: [inter] })).action).toBe(
			'pending'
		);
	});
});

describe('transferência entre contas próprias', () => {
	const pixOut = (overrides: Partial<Candidate> = {}): Candidate =>
		candidate({
			packageName: NUBANK,
			kind: 'pix_out',
			direction: 'out',
			amountCents: 50_000,
			counterparty: 'Vinicius Costa',
			merchantKey: 'vinicius costa',
			...overrides,
		});

	it('saída num banco e entrada do mesmo valor noutro no mesmo dia: pergunta', () => {
		const received = known({
			id: 'rcv',
			packageName: INTER,
			direction: 'in',
			kind: 'transfer_in',
			amountCents: 50_000,
			postedAt: T0,
		});
		const decision = decide(
			pixOut({ counterparty: 'Fulano', merchantKey: 'fulano', postedAt: plus(2 * HOUR) }),
			context({ recent: [received] })
		);
		expect(decision).toEqual({ action: 'ask_transfer', relatedId: 'rcv' });
	});

	it('quando o nome é o do usuário, é transferência certa — com ou sem a outra perna', () => {
		const alone = decide(pixOut(), context({ ownNames: ['Vinicius Costa'] }));
		expect(alone).toEqual({ action: 'transfer', relatedId: null, reason: 'own_name' });

		const received = known({
			id: 'rcv',
			packageName: INTER,
			direction: 'in',
			kind: 'pix_in',
			amountCents: 50_000,
		});
		const paired = decide(pixOut(), context({ ownNames: ['Vinicius Costa'], recent: [received] }));
		expect(paired).toEqual({ action: 'transfer', relatedId: 'rcv', reason: 'own_name' });
	});

	it('o nome do usuário bate por palavras, sem acento e sem caixa', () => {
		expect(matchesOwnName('VINICIUS COSTA', ['Vinícius Costa'])).toBe(true);
		expect(matchesOwnName('Vinicius A Costa', ['Vinicius Costa'])).toBe(true);
		expect(matchesOwnName('Vinicius Silva', ['Vinicius Costa'])).toBe(false);
		expect(matchesOwnName('Maria Costa', ['Vinicius Costa'])).toBe(false);
		expect(matchesOwnName(null, ['Vinicius Costa'])).toBe(false);
	});

	it('uma regra aprendida ("é transferência") decide sozinha da próxima vez', () => {
		const decision = decide(
			pixOut({ counterparty: 'Conta Inter', merchantKey: 'conta inter' }),
			context({
				rule: { merchantKey: 'conta inter', categoryId: null, treatAs: 'transfer', confirmations: 1 },
			})
		);
		expect(decision).toEqual({ action: 'transfer', relatedId: null, reason: 'rule' });
	});

	it('compra e estorno do mesmo valor não são transferência', () => {
		const refund = known({ id: 'rf', packageName: INTER, direction: 'in', kind: 'refund', amountCents: 3590 });
		expect(findTransferCounterpart(candidate({ kind: 'purchase' }), [refund])).toBeUndefined();
	});

	it('o mesmo app não é par de si mesmo', () => {
		const received = known({ id: 'rcv', packageName: NUBANK, direction: 'in', kind: 'pix_in', amountCents: 50_000 });
		expect(findTransferCounterpart(pixOut(), [received])).toBeUndefined();
	});

	it('mais de um dia de diferença não é transferência', () => {
		const received = known({ id: 'rcv', packageName: INTER, direction: 'in', kind: 'pix_in', amountCents: 50_000, postedAt: T0 });
		expect(findTransferCounterpart(pixOut({ postedAt: plus(25 * HOUR) }), [received])).toBeUndefined();
	});
});

describe('neutros e regras', () => {
	it('pagamento de fatura e investimento nunca viram lançamento', () => {
		expect(decide(candidate({ kind: 'invoice_payment', neutral: true }), context())).toEqual({
			action: 'neutral',
			reason: 'invoice_payment',
		});
		expect(decide(candidate({ kind: 'investment', neutral: true }), context())).toEqual({
			action: 'neutral',
			reason: 'investment',
		});
	});

	it('a duplicata de carteira vence até o neutro: fatura paga pela carteira não entra duas vezes', () => {
		const samsung = known({ id: 'sp', packageName: SAMSUNG_PAY, amountCents: 100_000 });
		expect(
			decide(candidate({ kind: 'invoice_payment', neutral: true, amountCents: 100_000 }), context({ recent: [samsung] }))
		).toEqual({ action: 'duplicate', relatedId: 'sp', reason: 'wallet' });
	});

	it('regra de ignorar', () => {
		expect(
			decide(candidate({}), context({ rule: { merchantKey: 'ifood', categoryId: null, treatAs: 'ignore', confirmations: 0 } }))
		).toEqual({ action: 'ignore', reason: 'rule' });
	});
});

describe('aprender por estabelecimento', () => {
	it('sem regra, fica pendente com o palpite', () => {
		expect(decide(candidate({}), context({ fallbackCategoryId: 'food' }))).toEqual({
			action: 'pending',
			categoryId: 'food',
		});
	});

	it('com regra abaixo do limite, sugere; no limite, lança sozinho', () => {
		const rule = { merchantKey: 'ifood', categoryId: 'food', treatAs: 'transaction' as const, confirmations: 2 };
		expect(decide(candidate({}), context({ rule }))).toEqual({ action: 'pending', categoryId: 'food' });
		expect(decide(candidate({}), context({ rule: { ...rule, confirmations: 3 } }))).toEqual({
			action: 'auto_confirm',
			categoryId: 'food',
		});
	});

	it('três confirmações iguais liberam o automático; mudar de categoria recomeça', () => {
		let rule = learnFromConfirmation(undefined, 'ifood', 'food');
		expect(rule.confirmations).toBe(1);
		rule = learnFromConfirmation(rule, 'ifood', 'food');
		rule = learnFromConfirmation(rule, 'ifood', 'food');
		expect(rule.confirmations).toBe(3);

		rule = learnFromConfirmation(rule, 'ifood', 'entertainment');
		expect(rule).toEqual({ merchantKey: 'ifood', categoryId: 'entertainment', treatAs: 'transaction', confirmations: 1 });
	});

	it('o automático não passa na frente de duplicata nem de transferência', () => {
		const rule = { merchantKey: 'ifood', categoryId: 'food', treatAs: 'transaction' as const, confirmations: 5 };
		const samsung = known({ id: 'sp', packageName: SAMSUNG_PAY });
		expect(decide(candidate({}), context({ rule, recent: [samsung] })).action).toBe('duplicate');
	});
});

describe('fingerprintOf', () => {
	const base = { packageName: NUBANK, appLabel: 'Nubank', title: 'Compra aprovada', text: 'R$ 1,00 em X' };

	it('a mesma notificação reentregue no mesmo minuto tem a mesma impressão', () => {
		expect(fingerprintOf({ ...base, postedAt: '2026-09-14T15:00:01.000Z' })).toBe(
			fingerprintOf({ ...base, postedAt: '2026-09-14T15:00:59.000Z' })
		);
	});

	it('texto ou app diferentes mudam a impressão', () => {
		const a = fingerprintOf({ ...base, postedAt: T0 });
		expect(fingerprintOf({ ...base, text: 'R$ 2,00 em X', postedAt: T0 })).not.toBe(a);
		expect(fingerprintOf({ ...base, packageName: INTER, postedAt: T0 })).not.toBe(a);
	});
});
