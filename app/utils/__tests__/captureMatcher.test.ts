import {
	APP_IGNORE_THRESHOLD,
	appRuleKeyOf,
	type Candidate,
	type DecisionContext,
	decide,
	fingerprintOf,
	findTransferCounterpart,
	findWalletDuplicate,
	findWalletSuspect,
	forgetAppDismissal,
	isAppIgnored,
	type KnownCapture,
	learnFromAppDismissal,
	learnFromConfirmation,
	matchesOwnName,
	type MerchantRule,
} from '../captureMatcher';
import { merchantKeyOf } from '../captureParser';

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
	relatedId: null,
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

/**
 * Achado 7.4: a duplicata de carteira casava só por valor e direção, numa janela de 12
 * horas. Duas compras de R$ 20,00 no mesmo dia viravam uma, sem pergunta, e a fatura do
 * app fechava menor que a do banco. Valor redondo e repetido é o caso comum.
 */
describe('duplicata de carteira: a identidade decide, e a dúvida pergunta', () => {
	const walletNoDetails = (overrides: Partial<KnownCapture> = {}): KnownCapture =>
		known({ id: 'sp', packageName: SAMSUNG_PAY, merchantKey: null, cardLast4: null, accountId: null, ...overrides });

	it('duas compras de R$ 20,00 no mesmo dia, uma às 9h pela carteira e outra às 18h no cartão, viram pergunta', () => {
		const wallet = walletNoDetails({ amountCents: 2000, postedAt: T0 });
		const decision = decide(
			candidate({
				packageName: NUBANK,
				postedAt: plus(9 * HOUR),
				amountCents: 2000,
				counterparty: 'PADARIA',
				merchantKey: 'padaria',
			}),
			context({ recent: [wallet] })
		);
		expect(decision).toEqual({ action: 'ask_duplicate', relatedId: 'sp' });
	});

	it('sem nada que confirme a identidade, nem no mesmo minuto decide sozinho', () => {
		const wallet = walletNoDetails();
		const blind = candidate({ counterparty: null, merchantKey: null, cardLast4: null, accountId: null });
		expect(findWalletDuplicate(blind, [wallet])).toBeUndefined();
		expect(decide(blind, context({ recent: [wallet] }))).toEqual({ action: 'ask_duplicate', relatedId: 'sp' });
	});

	it('o final do cartão confirma a identidade mesmo quando a carteira não diz o lugar', () => {
		const wallet = walletNoDetails({ cardLast4: '1534' });
		const decision = decide(
			candidate({ cardLast4: '1534', postedAt: plus(2 * MIN) }),
			context({ recent: [wallet] })
		);
		expect(decision).toEqual({ action: 'duplicate', relatedId: 'sp', reason: 'wallet' });
	});

	it('a conta também confirma: os dois avisos caíram no mesmo cartão', () => {
		const wallet = walletNoDetails({ accountId: 'nu-card' });
		const decision = decide(
			candidate({ counterparty: null, merchantKey: null, accountId: 'nu-card', postedAt: plus(MIN) }),
			context({ recent: [wallet] })
		);
		expect(decision).toEqual({ action: 'duplicate', relatedId: 'sp', reason: 'wallet' });
	});

	it('estabelecimentos diferentes são duas compras, e não há nem o que perguntar', () => {
		const wallet = known({ id: 'sp', packageName: SAMSUNG_PAY, merchantKey: 'posto ipiranga' });
		const other = candidate({ counterparty: 'PADARIA', merchantKey: 'padaria' });
		expect(findWalletDuplicate(other, [wallet])).toBeUndefined();
		expect(findWalletSuspect(other, [wallet])).toBeUndefined();
		expect(decide(other, context({ recent: [wallet] })).action).toBe('pending');
	});

	it('finais de cartão diferentes também separam as duas compras', () => {
		const wallet = walletNoDetails({ cardLast4: '1534' });
		expect(findWalletSuspect(candidate({ cardLast4: '9999', merchantKey: null }), [wallet])).toBeUndefined();
	});

	it('passadas as quatro horas de certeza, o mesmo lugar ainda rende uma pergunta', () => {
		const wallet = known({ id: 'sp', packageName: SAMSUNG_PAY, postedAt: T0 });
		expect(findWalletDuplicate(candidate({ postedAt: plus(5 * HOUR) }), [wallet])).toBeUndefined();
		expect(decide(candidate({ postedAt: plus(5 * HOUR) }), context({ recent: [wallet] }))).toEqual({
			action: 'ask_duplicate',
			relatedId: 'sp',
		});
	});
});

/**
 * SPD-044 (achado NOTIF-12): a carteira e o banco nem sempre escrevem o estabelecimento
 * igual — "SUPERMERCADO BOM PRECO LTDA" na carteira, "SUPERM BOM PRECO" no banco. Nome
 * diferente desmentia a identidade, e a mesma compra entrava duas vezes (com regra
 * aprendida para os dois nomes, lançada duas vezes sozinha).
 */
describe('duplicata de carteira: nome de loja aproximado (SPD-044)', () => {
	const keyOf = (name: string): string | null => merchantKeyOf(name);
	const wallet = (name: string, overrides: Partial<KnownCapture> = {}): KnownCapture =>
		known({ id: 'sp', packageName: SAMSUNG_PAY, merchantKey: keyOf(name), cardLast4: '1534', ...overrides });
	const bank = (name: string, overrides: Partial<Candidate> = {}): Candidate =>
		candidate({ counterparty: name, merchantKey: keyOf(name), cardLast4: '1534', postedAt: plus(20_000), ...overrides });

	it('D3: abreviação e sufixo societário com o mesmo final de cartão é duplicata certa', () => {
		const decision = decide(bank('SUPERM BOM PRECO'), context({ recent: [wallet('SUPERMERCADO BOM PRECO LTDA')] }));
		expect(decision).toEqual({ action: 'duplicate', relatedId: 'sp', reason: 'wallet' });
	});

	it('D3b: com regra que lança sozinho, o aviso do banco continua duplicata', () => {
		const rule: MerchantRule = {
			merchantKey: 'superm bom preco',
			categoryId: 'food',
			treatAs: 'transaction',
			confirmations: 5,
		};
		const decision = decide(
			bank('SUPERM BOM PRECO'),
			context({ recent: [wallet('SUPERMERCADO BOM PRECO LTDA')], rule })
		);
		expect(decision).toEqual({ action: 'duplicate', relatedId: 'sp', reason: 'wallet' });
	});

	it.each([
		['sufixo societário', 'PADARIA CENTRAL LTDA', 'PADARIA CENTRAL'],
		['S/A', 'DROGASIL S/A', 'DROGASIL'],
		['EIRELI', 'BOM PRECO EIRELI', 'BOM PRECO'],
		['prefixo de adquirente', 'PAG*POSTOSHELL', 'POSTO SHELL'],
		['palavra a mais de um lado', 'PADARIA CENTRAL', 'PADARIA CENTRAL VILA MARIANA'],
		['palavra a mais no meio', 'SUPERMERCADO PRECO', 'SUPERMERCADO BOM PRECO'],
		['abreviação de várias palavras', 'DROGARIA SAO PAULO', 'DROG S PAULO'],
	])('%s ("%s" × "%s") com o mesmo final é a mesma compra', (_label, walletName, bankName) => {
		expect(findWalletDuplicate(bank(bankName), [wallet(walletName)])?.id).toBe('sp');
		// Nos dois sentidos: o banco pode avisar primeiro.
		const bankFirst = known({ id: 'nb', merchantKey: keyOf(bankName), cardLast4: '1534' });
		const walletLater = candidate({
			packageName: SAMSUNG_PAY,
			counterparty: walletName,
			merchantKey: keyOf(walletName),
			cardLast4: '1534',
			postedAt: plus(20_000),
		});
		expect(findWalletDuplicate(walletLater, [bankFirst])?.id).toBe('nb');
	});

	it('nome compatível sem outro sinal não decide sozinho: pergunta (achado 7.4)', () => {
		const blindWallet = wallet('SUPERMERCADO BOM PRECO LTDA', { cardLast4: null, accountId: null });
		const blindBank = bank('SUPERM BOM PRECO', { cardLast4: null, accountId: null });
		expect(findWalletDuplicate(blindBank, [blindWallet])).toBeUndefined();
		expect(decide(blindBank, context({ recent: [blindWallet] }))).toEqual({ action: 'ask_duplicate', relatedId: 'sp' });
	});

	it('nome compatível com 9 horas de diferença pergunta, não funde', () => {
		const later = bank('SUPERM BOM PRECO', { postedAt: plus(9 * HOUR) });
		expect(decide(later, context({ recent: [wallet('SUPERMERCADO BOM PRECO LTDA')] }))).toEqual({
			action: 'ask_duplicate',
			relatedId: 'sp',
		});
	});

	it.each([
		['PADARIA CENTRAL', 'POSTO SHELL'],
		['POSTO SHELL', 'POSTO IPIRANGA'],
		['SUPERMERCADO BOM PRECO', 'SUPERMERCADO EXTRA'],
		['PADARIA CENTRAL LTDA', 'FARMACIA CENTRAL LTDA'],
	])('nomes claramente diferentes ("%s" × "%s") continuam desmentindo, mesmo com o mesmo final', (walletName, bankName) => {
		const other = bank(bankName);
		expect(findWalletDuplicate(other, [wallet(walletName)])).toBeUndefined();
		expect(findWalletSuspect(other, [wallet(walletName)])).toBeUndefined();
		expect(decide(other, context({ recent: [wallet(walletName)] })).action).toBe('pending');
	});

	it('nome compatível com outro final de cartão continua sendo outra compra', () => {
		const other = bank('SUPERM BOM PRECO', { cardLast4: '9999' });
		expect(findWalletSuspect(other, [wallet('SUPERMERCADO BOM PRECO LTDA')])).toBeUndefined();
	});

	it('nome compatível com outra conta continua sendo outra compra', () => {
		const inCard = wallet('SUPERMERCADO BOM PRECO LTDA', { cardLast4: null, accountId: 'nu-card' });
		const other = bank('SUPERM BOM PRECO', { cardLast4: null, accountId: 'inter-card' });
		expect(findWalletSuspect(other, [inCard])).toBeUndefined();
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

	it('para a pergunta, o mesmo app não é par de si mesmo', () => {
		const received = known({ id: 'rcv', packageName: NUBANK, direction: 'in', kind: 'pix_in', amountCents: 50_000 });
		expect(findTransferCounterpart(pixOut(), [received])).toBeUndefined();
		expect(decide(pixOut({ counterparty: 'Fulano', merchantKey: 'fulano' }), context({ recent: [received] })).action).toBe(
			'pending'
		);
	});

	// A PJ não é acompanhada: o que ela manda para a conta pessoal é receita, e o aviso
	// "você enviou para VINICIUS" que a PJ dispara pelo mesmo app não pode virar par.
	describe('receita de fonte externa (a PJ do usuário)', () => {
		const pjSentLeg = known({
			id: 'pj-out',
			packageName: NUBANK,
			direction: 'out',
			kind: 'pix_out',
			amountCents: 1_200_000,
			merchantKey: 'vinicius costa nunes',
			status: 'transfer',
			relatedId: null,
		});
		const proLabore = () =>
			candidate({
				packageName: NUBANK,
				direction: 'in',
				kind: 'pix_in',
				amountCents: 1_200_000,
				counterparty: 'EMPRESA DO VINICIUS LTDA',
				merchantKey: 'empresa do vinicius',
			});

		it('com a fonte marcada como receita, o recebimento fica receita mesmo com a saída da PJ na caixa', () => {
			const decision = decide(
				proLabore(),
				context({
					externalIncome: true,
					recent: [pjSentLeg],
					rule: { merchantKey: 'empresa do vinicius', categoryId: 'salary', treatAs: 'transaction', confirmations: 1 },
				})
			);
			expect(decision).toEqual({ action: 'pending', categoryId: 'salary' });
		});

		it('sem a marcação, o mesmo recebimento seria juntado à saída — é o que a marcação evita', () => {
			expect(decide(proLabore(), context({ recent: [pjSentLeg] }))).toEqual({
				action: 'transfer',
				relatedId: 'pj-out',
				reason: 'counterpart',
			});
		});

		it('a marcação não afeta saídas: um Pix enviado continua podendo ser transferência', () => {
			const received = known({ id: 'rcv', packageName: INTER, direction: 'in', kind: 'pix_in', amountCents: 50_000 });
			expect(
				decide(pixOut({ counterparty: 'Fulano', merchantKey: 'fulano' }), context({ externalIncome: true, recent: [received] }))
			).toEqual({ action: 'ask_transfer', relatedId: 'rcv' });
		});
	});

	// Conta pessoal e conta PJ do mesmo banco moram no mesmo app: as duas pontas da
	// mesma transferência chegam com o mesmo packageName.
	describe('conta pessoal e PJ no mesmo app', () => {
		const pjReceived = known({
			id: 'pj',
			packageName: NUBANK,
			direction: 'in',
			kind: 'pix_in',
			amountCents: 50_000,
			merchantKey: 'vinicius costa nunes',
		});
		const toCompany = () =>
			pixOut({ counterparty: 'EMPRESA DO VINICIUS LTDA', merchantKey: 'empresa do vinicius' });

		it('quando o nome é o do usuário, pareia mesmo dentro do mesmo app', () => {
			const decision = decide(
				pixOut({ counterparty: 'VINICIUS COSTA NUNES', merchantKey: 'vinicius costa nunes' }),
				context({ ownNames: ['Vinicius Costa Nunes'], recent: [pjReceived] })
			);
			expect(decision).toEqual({ action: 'transfer', relatedId: 'pj', reason: 'own_name' });
		});

		it('a saída da conta pessoal, chegando depois da entrada já reconhecida, junta-se a ela sem perguntar', () => {
			const decidedLeg = known({ ...pjReceived, status: 'transfer', relatedId: null });
			expect(decide(toCompany(), context({ recent: [decidedLeg] }))).toEqual({
				action: 'transfer',
				relatedId: 'pj',
				reason: 'counterpart',
			});
		});

		it('uma perna já pareada não serve de par de novo', () => {
			const paired = known({ ...pjReceived, status: 'transfer', relatedId: 'outra' });
			expect(decide(toCompany(), context({ recent: [paired] })).action).toBe('pending');
		});

		it('a entrada da PJ chegando depois da saída pendente pareia pelo nome e leva a saída junto', () => {
			const outPending = known({
				id: 'out',
				packageName: NUBANK,
				direction: 'out',
				kind: 'pix_out',
				amountCents: 50_000,
				merchantKey: 'empresa do vinicius',
			});
			const decision = decide(
				candidate({
					packageName: NUBANK,
					direction: 'in',
					kind: 'pix_in',
					amountCents: 50_000,
					counterparty: 'VINICIUS COSTA NUNES',
					merchantKey: 'vinicius costa nunes',
				}),
				context({ ownNames: ['Vinicius Costa Nunes'], recent: [outPending] })
			);
			expect(decision).toEqual({ action: 'transfer', relatedId: 'out', reason: 'own_name' });
		});
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

	// As impressões já gravadas são o id das capturas no sync (v19): sem chave, o formato
	// não muda nem um caractere.
	it('sem chave, a impressão é a de sempre', () => {
		expect(fingerprintOf({ ...base, postedAt: T0 })).toBe('0b626765-e9605672');
		expect(fingerprintOf({ ...base, notificationKey: '', postedAt: T0 })).toBe('0b626765-e9605672');
		expect(fingerprintOf({ ...base, notificationWhen: T0, postedAt: T0 })).toBe('0b626765-e9605672');
	});
});

/**
 * SPD-041: com a chave da notificação do Android (`StatusBarNotification.getKey()`), a
 * impressão deixa de depender do minuto em que o aviso foi publicado.
 */
describe('fingerprintOf com a chave da notificação (SPD-041)', () => {
	const KEY = '0|com.nu.production|1|null|10123';
	const base = {
		packageName: NUBANK,
		appLabel: 'Nubank',
		title: 'Compra no crédito aprovada',
		text: 'Compra de R$ 5,00 APROVADA em CAFE DA ESQUINA para o cartão com final 1534.',
		notificationKey: KEY,
		notificationWhen: T0,
		postedAt: T0,
	};

	it('D8: o Android reposta a mesma notificação minutos ou horas depois: a mesma impressão', () => {
		const first = fingerprintOf(base);
		expect(fingerprintOf({ ...base, postedAt: plus(5 * MIN) })).toBe(first);
		expect(fingerprintOf({ ...base, postedAt: plus(3 * HOUR) })).toBe(first);
	});

	it('sem o `when`, a mesma chave com o mesmo conteúdo também é a mesma em qualquer horário', () => {
		const { notificationWhen: _when, ...withoutWhen } = base;
		expect(fingerprintOf({ ...withoutWhen, postedAt: plus(5 * MIN) })).toBe(fingerprintOf(withoutWhen));
	});

	it('D6: duas compras iguais no mesmo minuto, chaves diferentes: impressões diferentes', () => {
		const second = { ...base, notificationKey: '0|com.nu.production|2|null|10123', postedAt: plus(25_000) };
		expect(fingerprintOf(second)).not.toBe(fingerprintOf(base));
	});

	it('a mesma chave atualizada com outro valor é outra captura', () => {
		expect(
			fingerprintOf({ ...base, text: base.text.replace('R$ 5,00', 'R$ 7,50'), postedAt: plus(2 * MIN) })
		).not.toBe(fingerprintOf(base));
		expect(fingerprintOf({ ...base, title: 'Compra no débito aprovada' })).not.toBe(fingerprintOf(base));
	});

	// O app que reusa sempre o mesmo id: a compra nova, com o mesmo texto, tem a mesma chave,
	// mas o `when` é o dela. Sem isso, o café de amanhã sumiria como repostagem do de hoje.
	it('a mesma chave e o mesmo texto com outro `when` é outra notificação', () => {
		expect(fingerprintOf({ ...base, notificationWhen: plus(HOUR), postedAt: plus(HOUR) })).not.toBe(
			fingerprintOf(base)
		);
	});

	it('o formato com chave é outro, e cabe no id do sync', () => {
		const keyed = fingerprintOf(base);
		expect(keyed).toMatch(/^n:[0-9a-f]{8}-[0-9a-f]{8}$/);
		expect(keyed.length).toBeLessThanOrEqual(64);
		const { notificationKey: _key, notificationWhen: _when, ...legacy } = base;
		expect(fingerprintOf(legacy)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{8}$/);
	});
});

/**
 * SPD-022: depois de 3 descartes do mesmo app que não é banco, os avisos dele passam a
 * ser ignorados. A regra mora em `merchant_rules`, com a chave `app:<pacote>`, e usa a
 * ação `ignore` que o motor já tinha.
 */
describe('app que o usuário descartou 3 vezes (SPD-022)', () => {
	/** E-mail: app que não é banco e que não junta remetentes de SMS. */
	const MAIL = 'com.google.android.gm';
	const SMS = 'com.google.android.apps.messaging';
	const appRule = (confirmations: number): MerchantRule => ({
		merchantKey: appRuleKeyOf(MAIL),
		categoryId: null,
		treatAs: 'ignore',
		confirmations,
	});

	it('a chave do app nunca colide com a de um estabelecimento', () => {
		expect(appRuleKeyOf(MAIL)).toBe(`app:${MAIL}`);
		// `merchantKeyOf` só devolve letras, números e espaços: "app:" não sai dele.
		expect(merchantKeyOf(`app:${MAIL}`)).not.toBe(appRuleKeyOf(MAIL));
	});

	it('cada descarte soma um, e o terceiro liga a regra', () => {
		const first = learnFromAppDismissal(undefined, MAIL);
		expect(first).toEqual(appRule(1));
		expect(isAppIgnored(first)).toBe(false);
		const second = learnFromAppDismissal(first, MAIL);
		expect(isAppIgnored(second)).toBe(false);
		const third = learnFromAppDismissal(second, MAIL);
		expect(third.confirmations).toBe(APP_IGNORE_THRESHOLD);
		expect(isAppIgnored(third)).toBe(true);
	});

	it('reverter um descarte desconta um; o último some com a regra', () => {
		expect(forgetAppDismissal(appRule(3))).toEqual(appRule(2));
		expect(isAppIgnored(forgetAppDismissal(appRule(3)) ?? undefined)).toBe(false);
		expect(forgetAppDismissal(appRule(1))).toBeNull();
	});

	it('com a regra ligada, o aviso daquele app é ignorado antes de qualquer outra pergunta', () => {
		// Uma perna "provável" de transferência na caixa: sem a regra, viraria pergunta.
		const recent = [known({ id: 'in', packageName: INTER, direction: 'in', kind: 'pix_in', merchantKey: null })];
		const mail = candidate({ packageName: MAIL, kind: 'pix_out', counterparty: null, merchantKey: null });
		expect(decide(mail, context({ recent, appRule: appRule(3) }))).toEqual({ action: 'ignore', reason: 'app_rule' });
	});

	it('com menos de 3 descartes, segue como hoje', () => {
		expect(decide(candidate({ packageName: MAIL }), context({ appRule: appRule(2) })).action).toBe('pending');
	});

	it('nunca ignora a carteira nem a linha de extrato por essa regra', () => {
		const wallet = candidate({ packageName: SAMSUNG_PAY });
		expect(
			decide(wallet, context({ appRule: { ...appRule(5), merchantKey: appRuleKeyOf(SAMSUNG_PAY) } })).action
		).toBe('pending');
		const statement = candidate({ packageName: 'ofx:nubank:0001' });
		expect(
			decide(statement, context({ appRule: { ...appRule(5), merchantKey: appRuleKeyOf('ofx:nubank:0001') } })).action
		).toBe('pending');
	});

	it('pacote de SMS nunca é ignorado pela regra do app, nem com uma regra gravada para ele', () => {
		// Um pacote de SMS junta todos os remetentes, inclusive o banco.
		const rule = { ...appRule(5), merchantKey: appRuleKeyOf(SMS) };
		expect(decide(candidate({ packageName: SMS }), context({ appRule: rule })).action).toBe('pending');
	});

	it('uma regra de outro app não vale para este', () => {
		expect(decide(candidate({ packageName: 'com.whatsapp' }), context({ appRule: appRule(3) })).action).toBe('pending');
	});
});

describe('Pix entre a PJ e a PF do mesmo banco (SPD-074, DEC-34)', () => {
	// "Pix de R$ 500,00 da conta Nu Empresas foi realizado": a saída da PJ não diz para quem.
	// A entrada na PF, do mesmo valor e minutos depois, é que diz que foi entre contas suas.
	const pjOut = known({
		id: 'pj-out',
		packageName: NUBANK,
		direction: 'out',
		kind: 'pix_out',
		amountCents: 50_000,
		merchantKey: null,
		accountId: 'pj',
	});
	const pfIn = (overrides: Partial<Candidate> = {}) =>
		candidate({
			packageName: NUBANK,
			postedAt: plus(MIN),
			direction: 'in',
			kind: 'pix_in',
			amountCents: 50_000,
			counterparty: 'EMPRESA DO USUARIO LTDA',
			merchantKey: 'empresa do usuario',
			accountId: 'pf',
			...overrides,
		});

	it('mesmo valor, contas diferentes do mesmo banco, um minuto depois: transferência, sem perguntar', () => {
		expect(decide(pfIn(), context({ recent: [pjOut] }))).toEqual({
			action: 'transfer',
			relatedId: 'pj-out',
			reason: 'same_bank_accounts',
		});
	});

	it('vale nas duas ordens: a saída da PJ depois da entrada na PF', () => {
		const pfInKnown = known({ id: 'pf-in', packageName: NUBANK, direction: 'in', kind: 'pix_in', amountCents: 50_000, accountId: 'pf' });
		const out = candidate({
			packageName: NUBANK,
			postedAt: plus(2 * MIN),
			direction: 'out',
			kind: 'pix_out',
			amountCents: 50_000,
			counterparty: null,
			merchantKey: null,
			accountId: 'pj',
		});
		expect(decide(out, context({ recent: [pfInKnown] }))).toEqual({
			action: 'transfer',
			relatedId: 'pf-in',
			reason: 'same_bank_accounts',
		});
	});

	it('na mesma conta são dois Pix: um enviado e outro recebido', () => {
		expect(decide(pfIn({ accountId: 'pj' }), context({ recent: [pjOut] })).action).toBe('pending');
	});

	it('sem saber a conta de uma das pontas, não junta', () => {
		expect(decide(pfIn({ accountId: null }), context({ recent: [pjOut] })).action).toBe('pending');
	});

	it('longe no tempo não é a mesma transferência', () => {
		expect(decide(pfIn({ postedAt: plus(HOUR) }), context({ recent: [pjOut] })).action).toBe('pending');
	});

	it('compra nunca é perna de transferência', () => {
		const purchase = known({ ...pjOut, kind: 'purchase' });
		expect(decide(pfIn(), context({ recent: [purchase] })).action).toBe('pending');
	});

	it('fonte marcada como receita continua receita', () => {
		expect(decide(pfIn(), context({ recent: [pjOut], externalIncome: true })).action).toBe('pending');
	});
});
