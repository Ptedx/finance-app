/**
 * O diário das decisões da captura (SPD-014): um `capture_decision` por aviso que a
 * ingestão processou, e um evento por resposta do usuário na caixa de revisão.
 *
 * O que se testa é a fronteira da DEC-11 (b): só metadados no `data`, e o texto cru só de
 * app de banco conhecido que o parser descartou ou não entendeu. O banco é o mesmo dublê
 * em Maps de `captureActions.test.ts`; o diário é trocado por um `log` que só anota.
 */

import type { Account, Capture, MerchantRule } from '../../database/schema';

const mockAccounts = new Map<string, Account>();
const mockCaptures = new Map<string, Capture>();
const mockRules = new Map<string, MerchantRule>();
const mockCounter = { value: 0 };
const mockMakeId = (prefix: string): string => {
	mockCounter.value += 1;
	return `${prefix}-${mockCounter.value}`;
};

jest.mock('../log', () => ({ ...jest.requireActual('../log'), log: jest.fn() }));

jest.mock('../../sync/queue', () => ({ schedule: jest.fn() }));

jest.mock('../../utils/notificationUtils', () => ({ scheduleBillReminders: jest.fn(async () => 0) }));

jest.mock('../../database/database', () => ({
	addTransaction: jest.fn(async () => mockMakeId('tx')),
	deleteTransaction: jest.fn(async () => undefined),
	deleteTransactionsInGroup: jest.fn(async () => undefined),
	addTransfer: jest.fn(async () => mockMakeId('tr')),
	updateTransfer: jest.fn(async () => undefined),
	getTransfer: jest.fn(async () => null),
	deleteTransfer: jest.fn(async () => undefined),
	findLiveTransfer: jest.fn(async () => null),
	getAccount: jest.fn(async (id: string) => mockAccounts.get(id) ?? null),
	getAccounts: jest.fn(async () => [...mockAccounts.values()]),
	addAccount: jest.fn(async (draft: Omit<Account, 'id' | 'updatedAt'>) => {
		const id = mockMakeId('acc');
		mockAccounts.set(id, { ...draft, id, updatedAt: '' } as Account);
		return id;
	}),
	updateAccount: jest.fn(async (updated: Account) => {
		mockAccounts.set(updated.id, { ...updated });
	}),
	// A conta já ligada ao app (e ao final, quando há), como no SQL de verdade.
	findAccountBySource: jest.fn(
		async (packageName: string, last4: string | null) =>
			[...mockAccounts.values()].find((item) => item.packageName === packageName && item.last4 === last4) ?? null
	),
	findAccountByKey: jest.fn(async () => null),
	reassignCaptureLedger: jest.fn(async () => undefined),
	getBills: jest.fn(async () => []),
	updateBill: jest.fn(async () => undefined),
}));

jest.mock('../../database/captures', () => ({
	insertCapture: jest.fn(async (row: Omit<Capture, 'id' | 'createdAt' | 'updatedAt'>, explicitId?: string) => {
		const id = explicitId ?? mockMakeId('cap');
		const capture = { ...row, id, createdAt: '', updatedAt: '' } as Capture;
		mockCaptures.set(id, capture);
		return capture;
	}),
	updateCapture: jest.fn(async (id: string, patch: Partial<Capture>) => {
		const found = mockCaptures.get(id);
		if (found) mockCaptures.set(id, { ...found, ...patch });
	}),
	getCapture: jest.fn(async (id: string) => mockCaptures.get(id) ?? null),
	getRecentCaptures: jest.fn(async () => [...mockCaptures.values()]),
	hasCaptureFingerprint: jest.fn(async (fingerprint: string) =>
		[...mockCaptures.values()].some((capture) => capture.fingerprint === fingerprint)
	),
	getMerchantRule: jest.fn(async (key: string) => mockRules.get(key) ?? null),
	saveMerchantRule: jest.fn(async (rule: Omit<MerchantRule, 'updatedAt'>) => {
		mockRules.set(rule.merchantKey, { ...rule, updatedAt: '' });
	}),
	deleteMerchantRule: jest.fn(async (key: string) => {
		mockRules.delete(key);
	}),
	findUnpairedTransferLeg: jest.fn(async () => null),
}));

import { insertCapture } from '../../database/captures';
import {
	answerCaptureDuplicate,
	answerCaptureTransfer,
	confirmCapture,
	dismissCapture,
	ingestRawCaptures,
	markCaptureTransfer,
	revertCapture,
	stopIgnoringApp,
} from '../../utils/captureActions';
import { appRuleKeyOf, candidateFrom } from '../../utils/captureMatcher';
import { parseCapture, type RawCapture } from '../../utils/captureParser';
import { captureDecisionData, keepsRawText } from '../capture';
import type { DiagnosticValue } from '../contract';
import { log } from '../log';

const logMock = log as jest.Mock;

type Logged = { area: string; event: string; level?: string; data: Record<string, DiagnosticValue>; rawText?: string | null };

const logged = (): Logged[] =>
	logMock.mock.calls.map(([area, event, options]) => ({
		area,
		event,
		level: options?.level,
		data: options?.data ?? {},
		rawText: options?.rawText,
	}));

const decisions = (): Logged[] => logged().filter((entry) => entry.event === 'capture_decision');

/**
 * O `data` sem os ids, para procurar vazamento no texto dele. O `captureId` é um uuid
 * aleatório e a impressão digital é um hash: um "41" ou um "230" no meio deles é
 * coincidência, não o valor do aviso — e era o que fazia este arquivo falhar de vez em
 * quando (SPD-128). Os ids são conferidos à parte, como na varredura do fim do arquivo.
 */
const withoutIds = (data: Record<string, DiagnosticValue>): Record<string, DiagnosticValue> =>
	Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'captureId' && key !== 'fingerprint'));

const categories = [
	{ id: 'other_expense', name: 'Outros', type: 'expense', icon: '', color: '', updatedAt: '' },
	{ id: 'other_income', name: 'Outros', type: 'income', icon: '', color: '', updatedAt: '' },
	{ id: 'food', name: 'Alimentação', type: 'expense', icon: '', color: '', updatedAt: '' },
] as unknown as Parameters<typeof confirmCapture>[2];

let minute = 0;
const raw = (packageName: string, appLabel: string, title: string, text: string): RawCapture => {
	minute += 1;
	return {
		packageName,
		appLabel,
		title,
		text,
		postedAt: new Date(Date.parse('2026-10-20T15:00:00.000Z') + minute * 60_000).toISOString(),
	};
};

const NUBANK = 'com.nu.production';
const ITAU = 'com.itau';
const WHATSAPP = 'com.whatsapp';
const GMAIL = 'com.google.android.gm';
const SMS = 'com.google.android.apps.messaging';

const purchase = () =>
	raw(NUBANK, 'Nubank', 'Compra aprovada', 'Compra de R$ 35,90 APROVADA em PADARIA ESTRELA para o cartão com final 9876.');
const bankPromo = () => raw(NUBANK, 'Nubank', 'Novidade', 'Conheça o novo app do Nubank, com cashback garantido');
const bankUnknown = () => raw(NUBANK, 'Nubank', 'Novo aviso', 'Você recebeu R$ 47,13 de crédito');
const itauPix = () => raw(ITAU, 'Itaú', 'Pix recebido', 'Você recebeu um Pix de R$ 230,00 de JOAO PEREIRA');
const foreign = () =>
	raw(NUBANK, 'Nubank', 'Compra aprovada', 'Compra de US$ 15,99 APROVADA em NETFLIX.COM para o cartão com final 9876.');
const whatsappChat = () => raw(WHATSAPP, 'WhatsApp', 'Maria Silva', 'Você recebeu R$ 52,00 meu bem');
const whatsappNoMoney = () => raw(WHATSAPP, 'WhatsApp', 'Maria Silva', 'te mando amanhã, beijos');
const whatsappCitingBank = () => raw(WHATSAPP, 'WhatsApp', 'Maria Silva', 'Você recebeu R$ 64,00 na sua conta Nubank');
const gmailUnknown = () => raw(GMAIL, 'Gmail', 'Nubank', 'Você recebeu R$ 83,21 do Nubank');
const gmailNoMoney = () => raw(GMAIL, 'Gmail', 'Fatura', 'Sua fatura do Nubank fechou');
const smsUnknown = () => raw(SMS, 'Mensagens', '29000', 'Nubank: valor de R$ 72,55 creditado');

const ingest = (...raws: RawCapture[]) => ingestRawCaptures(raws, { ownNames: [], categories });

const manualAccount = (overrides: Partial<Account>): Account => {
	const account = {
		id: mockMakeId('acc'),
		name: 'Conta da casa',
		kind: 'checking',
		role: 'main',
		envelopeMonthlyCents: null,
		network: null,
		bankName: 'Itaú',
		color: '#000',
		last4: null,
		closingDay: null,
		dueDay: null,
		closingDaysBefore: null,
		creditLimitCents: null,
		cardNames: null,
		packageName: null,
		accountKey: null,
		openingBalanceCents: 0,
		openingBalanceDate: '2026-09-01',
		sortOrder: 0,
		archived: false,
		updatedAt: '',
		...overrides,
	} as Account;
	mockAccounts.set(account.id, account);
	return account;
};

/** Regra aprendida que já lança sozinha (três confirmações). */
const learnedRule = (notice: RawCapture, categoryId = 'food'): void => {
	const parsed = parseCapture(notice);
	const key = parsed ? candidateFrom(notice, parsed, null).merchantKey : null;
	if (!key) throw new Error('aviso sem estabelecimento');
	mockRules.set(key, { merchantKey: key, categoryId, treatAs: 'transaction', confirmations: 3, updatedAt: '' });
};

beforeEach(() => {
	mockAccounts.clear();
	mockCaptures.clear();
	mockRules.clear();
	jest.clearAllMocks();
});

describe('capture_decision: um por aviso, com o que o parser entendeu e o que o app decidiu', () => {
	it('compra nova do banco: pendente, cartão criado, sem texto cru', async () => {
		await ingest(purchase());

		const [entry] = decisions();
		expect(decisions()).toHaveLength(1);
		expect(entry).toMatchObject({ area: 'capture', level: 'info', rawText: null });
		expect(entry.data).toMatchObject({
			pkg: NUBANK,
			knownBank: true,
			parse: 'ok',
			kind: 'purchase',
			direction: 'out',
			hasCounterparty: true,
			hasCardLast4: true,
			action: 'pending',
			outcome: 'pending',
			reason: null,
			question: null,
			account: 'created',
		});
		const [stored] = [...mockCaptures.values()];
		expect(entry.data.captureId).toBe(stored.id);
		expect(entry.data.fingerprint).toBe(stored.fingerprint);
	});

	it('a mesma notificação de novo: pulada, com a mesma impressão digital', async () => {
		const notice = purchase();
		await ingest(notice);
		await ingest(notice);

		const [first, second] = decisions();
		expect(second.data).toMatchObject({ outcome: 'skipped', reason: 'already_seen', fingerprint: first.data.fingerprint });
		expect(second.data.parse).toBeUndefined();
	});

	it('a segunda compra do mesmo cartão acha a conta que existe', async () => {
		await ingest(purchase(), purchase());

		expect(decisions().map((entry) => entry.data.account)).toEqual(['created', 'existing']);
	});

	it('conta cadastrada à mão do mesmo banco é adotada', async () => {
		manualAccount({ bankName: 'Itaú' });
		await ingest(itauPix());

		expect(decisions()[0].data).toMatchObject({ kind: 'pix_in', direction: 'in', account: 'adopted' });
	});

	// SPD-112: o banco veio do pacote, porque o nome na tela não é um que o app reconheça.
	it('app de banco conhecido com outro nome na tela: a conta sai do pacote, e o diário diz isso', async () => {
		await ingest(raw('com.picpay', 'Carteira digital', 'Pix enviado', 'Você enviou um Pix de R$ 41,70 para JOAO PEREIRA'));

		expect(decisions()[0].data).toMatchObject({ pkg: 'com.picpay', knownBank: true, bankFromPackage: true, account: 'created' });
		expect(JSON.stringify(withoutIds(decisions()[0].data))).not.toMatch(/Carteira|PicPay|JOAO|41/);
	});

	it('com o nome de sempre na tela, o diário não marca nada', async () => {
		await ingest(purchase());

		expect(decisions()[0].data.bankFromPackage).toBeUndefined();
	});

	// SPD-112 (NOTIF-20): o SMS do banco e, 8 minutos depois, o app do banco são a mesma compra.
	it('SMS citando o banco + o aviso do banco minutos depois: duplicata, com o par no diário', async () => {
		manualAccount({ name: 'Conta Nubank', bankName: 'Nubank' });
		const sms = raw(SMS, 'Mensagens', 'Nubank', 'Compra de R$ 35,90 APROVADA em PADARIA ESTRELA para o cartão com final 9876.');
		const bank = { ...purchase(), postedAt: new Date(Date.parse(sms.postedAt) + 8 * 60_000).toISOString() };
		await ingest(sms, bank);

		expect(decisions()[1].data).toMatchObject({ pkg: NUBANK, action: 'duplicate', outcome: 'duplicate', pair: 'third_party' });
		expect(decisions()[0].data.pair).toBeUndefined();
	});

	it('regra aprendida: confirmado sozinho', async () => {
		learnedRule(purchase());
		await ingest(purchase());

		expect(decisions()[0].data).toMatchObject({ action: 'auto_confirm', outcome: 'confirmed', reason: 'rule' });
	});

	it('moeda estrangeira sem o valor em reais: a regra mandava confirmar, fica pendente pela moeda', async () => {
		learnedRule(foreign());
		await ingest(foreign());

		expect(decisions()[0].data).toMatchObject({
			action: 'pending',
			outcome: 'pending',
			reason: 'foreign_currency',
			overridden: 'foreign_currency',
			currency: 'USD',
			currencyInBrl: false,
		});
	});

	it('app que não é banco e não cita banco: ignorado por no_bank, sem item', async () => {
		await ingest(whatsappChat());

		expect(mockCaptures.size).toBe(0);
		expect(decisions()[0].data).toMatchObject({ pkg: WHATSAPP, knownBank: false, outcome: 'ignored', reason: 'no_bank' });
	});

	it('app que o usuário mandou calar: ignorado pela regra do app', async () => {
		mockRules.set(appRuleKeyOf(WHATSAPP), {
			merchantKey: appRuleKeyOf(WHATSAPP),
			categoryId: null,
			treatAs: 'ignore',
			confirmations: 3,
			updatedAt: '',
		});
		await ingest(whatsappCitingBank());

		expect(decisions()[0].data).toMatchObject({ action: 'ignore', outcome: 'ignored', reason: 'app_rule', account: 'none' });
	});

	it('sem dinheiro no texto: descartado, parse falhou', async () => {
		await ingest(gmailNoMoney());

		expect(decisions()[0].data).toMatchObject({ pkg: GMAIL, parse: 'failed', outcome: 'discarded', reason: 'not_money' });
	});

	it('a ingestão que falha no meio vira capture_ingest_failed, com a etapa', async () => {
		(insertCapture as jest.Mock).mockRejectedValueOnce(new TypeError('disco cheio: PADARIA ESTRELA'));
		const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
		await ingest(purchase());
		errorSpy.mockRestore();

		const failure = logged().find((entry) => entry.event === 'capture_ingest_failed');
		expect(failure).toMatchObject({ level: 'error', data: { pkg: NUBANK, stage: 'write', error: 'TypeError' } });
		// A mensagem da exceção não entra: pode trazer o dado.
		expect(JSON.stringify(failure)).not.toContain('PADARIA');
		expect(decisions()).toHaveLength(0);
	});

	it('aplicação, resgate e fatura dizem como o destino foi achado, sem qual conta (SPD-023)', async () => {
		manualAccount({ name: 'Nubank', bankName: 'Nubank', packageName: NUBANK });
		const reserve = manualAccount({ name: 'Caixinha da viagem', kind: 'savings', role: 'reserve', bankName: 'Nubank' });
		await ingest(
			raw(NUBANK, 'Nubank', 'Aplicação', 'Aplicação de R$ 500,00 realizada com sucesso.'),
			raw(NUBANK, 'Nubank', 'Fatura', 'Pagamento da fatura de R$ 1.500,00 realizado.'),
			purchase()
		);

		const [investment, invoice, bought] = decisions();
		expect(investment.data).toMatchObject({ kind: 'investment', reason: 'investment', destination: 'single_reserve' });
		// Nenhum cartão para escolher: o destino fica em branco, e o diário diz.
		expect(invoice.data).toMatchObject({ kind: 'invoice_payment', reason: 'invoice_payment', destination: 'none' });
		expect(bought.data.destination).toBeUndefined();
		expect(JSON.stringify(decisions().map((entry) => ({ ...entry, data: withoutIds(entry.data) })))).not.toMatch(
			new RegExp(`${reserve.id}|Caixinha|50000|150000`)
		);
	});
});

describe('capture_decision: o nome salvo em Ajustes (SPD-115)', () => {
	// Nome inventado. O da conta logada é curto ("Maria") e não basta sozinho.
	const pixFromSelf = () => raw(ITAU, 'Itaú', 'Pix recebido', 'Você recebeu um Pix de R$ 230,00 de MARIA S OLIVEIRA');

	it('o Pix com o nome salvo vira transferência, e o diário diz só que foi esse nome', async () => {
		await ingestRawCaptures([pixFromSelf()], { ownNames: ['Maria'], bankName: 'Maria Souza Oliveira', categories });

		const [entry] = decisions();
		expect(entry.data).toMatchObject({ action: 'transfer', outcome: 'transfer', reason: 'own_bank_name' });
		expect(JSON.stringify(withoutIds(entry.data)).toLowerCase()).not.toMatch(/maria|souza|oliveira|230/);
	});

	it('sem nome salvo, o mesmo Pix fica para a revisão, sem o motivo do nome', async () => {
		await ingestRawCaptures([pixFromSelf()], { ownNames: ['Maria'], categories });

		const [entry] = decisions();
		expect(entry.data.outcome).toBe('pending');
		expect(entry.data.reason).not.toBe('own_bank_name');
	});
});

describe('DEC-11 (b): texto cru só de banco conhecido que o parser não entendeu', () => {
	it('banco conhecido, aviso descartado pelo parser: leva o texto, em warn', async () => {
		const notice = bankPromo();
		await ingest(notice);

		expect(decisions()[0]).toMatchObject({
			level: 'warn',
			rawText: `${notice.title}\n${notice.text}`,
			data: { pkg: NUBANK, knownBank: true, parse: 'failed', outcome: 'discarded' },
		});
	});

	it('banco conhecido, tipo unknown: leva o texto', async () => {
		const notice = bankUnknown();
		await ingest(notice);

		expect(decisions()[0].data).toMatchObject({ kind: 'unknown', outcome: 'pending' });
		expect(decisions()[0].rawText).toBe(`${notice.title}\n${notice.text}`);
	});

	it('banco conhecido que o parser entendeu: sem texto', async () => {
		await ingest(purchase(), itauPix());

		expect(decisions().map((entry) => entry.rawText)).toEqual([null, null]);
	});

	it('WhatsApp, Gmail e SMS nunca levam o texto, entendidos ou não', async () => {
		await ingest(whatsappChat(), whatsappNoMoney(), whatsappCitingBank(), gmailUnknown(), gmailNoMoney(), smsUnknown());

		const entries = decisions();
		expect(entries).toHaveLength(6);
		// O que o parser não entendeu está aí — e mesmo assim, nada de texto.
		expect(entries.filter((entry) => entry.data.parse === 'failed' || entry.data.kind === 'unknown').length).toBeGreaterThanOrEqual(4);
		for (const entry of entries) expect(entry.rawText ?? null).toBeNull();
	});

	it('a regra sozinha', () => {
		const unknown = parseCapture(bankUnknown());
		expect(keepsRawText(NUBANK, null)).toBe(true);
		expect(keepsRawText(NUBANK, unknown)).toBe(true);
		expect(keepsRawText(NUBANK, parseCapture(purchase()))).toBe(false);
		expect(keepsRawText(NUBANK, undefined)).toBe(false);
		for (const pkg of [WHATSAPP, GMAIL, SMS, 'com.samsung.android.spay']) {
			expect(keepsRawText(pkg, null)).toBe(false);
			expect(keepsRawText(pkg, unknown)).toBe(false);
		}
	});
});

describe('as respostas do usuário na caixa de revisão', () => {
	const ingestOne = async (notice: RawCapture): Promise<Capture> => {
		await ingest(notice);
		const stored = [...mockCaptures.values()].find((capture) => capture.postedAt === notice.postedAt);
		if (!stored) throw new Error('não entrou');
		logMock.mockClear();
		return stored;
	};

	it('confirmar: tipo, de onde saiu e se a categoria mudou', async () => {
		const capture = await ingestOne(purchase());
		expect(capture.suggestedCategory).toBe('food');
		await confirmCapture(capture.id, 'other_expense', categories);

		expect(logged()).toEqual([
			expect.objectContaining({
				event: 'capture_confirmed',
				data: expect.objectContaining({
					captureId: capture.id,
					pkg: NUBANK,
					kind: 'purchase',
					from: 'pending',
					direction: 'out',
					categoryChanged: true,
					categoryFallback: false,
					learned: true,
					accountChoice: 'kept',
				}),
			}),
		]);
	});

	it('confirmar escolhendo a conta (SPD-111): se trocou e se havia conta, nunca qual', async () => {
		const capture = await ingestOne(purchase());
		await confirmCapture(capture.id, 'food', categories, 'conta-escolhida');

		const [entry] = logged();
		expect(entry).toEqual(
			expect.objectContaining({
				event: 'capture_confirmed',
				data: expect.objectContaining({ accountChoice: 'chosen', hadAccount: capture.accountId !== null }),
			})
		);
		expect(JSON.stringify(entry.data)).not.toContain('conta-escolhida');
	});

	it('confirmar o que já saiu da fila não faz nada, e o diário diz', async () => {
		const capture = await ingestOne(purchase());
		await confirmCapture(capture.id, 'food', categories);
		logMock.mockClear();
		await confirmCapture(capture.id, 'food', categories);

		expect(logged()).toEqual([
			expect.objectContaining({
				event: 'capture_review_skipped',
				data: { action: 'confirm', captureId: capture.id, from: 'confirmed' },
			}),
		]);
	});

	it('descartar três vezes o mesmo app: o terceiro aprende a regra app:', async () => {
		for (let index = 0; index < 3; index += 1) {
			const capture = await ingestOne(whatsappCitingBank());
			await dismissCapture(capture.id);
		}

		const events = logged().map((entry) => [entry.event, entry.data.appDismissals ?? entry.data.dismissals]);
		expect(events).toEqual([
			['capture_dismissed', 3],
			['capture_app_rule_learned', 3],
		]);
		expect(logged()[1].data).toEqual({ pkg: WHATSAPP, dismissals: 3 });
	});

	it('desfazer o "ignorar" do app', async () => {
		await stopIgnoringApp(WHATSAPP);

		expect(logged()).toEqual([
			expect.objectContaining({ event: 'capture_app_rule_removed', data: { pkg: WHATSAPP } }),
		]);
	});

	it('reverter um confirmado: de onde voltou e o que foi desfeito', async () => {
		const capture = await ingestOne(purchase());
		await confirmCapture(capture.id, 'food', categories);
		logMock.mockClear();
		await revertCapture(capture.id);

		expect(logged()).toEqual([
			expect.objectContaining({
				event: 'capture_reverted',
				data: expect.objectContaining({
					captureId: capture.id,
					from: 'confirmed',
					removedLedger: true,
					removedTransfer: false,
					ruleRemoved: false,
					appRule: null,
				}),
			}),
		]);
	});

	it('reverter um descarte de app que não é banco desconta a regra', async () => {
		const capture = await ingestOne(whatsappCitingBank());
		await dismissCapture(capture.id);
		logMock.mockClear();
		await revertCapture(capture.id);

		expect(logged()[0]).toMatchObject({
			event: 'capture_reverted',
			data: { from: 'dismissed', fromReason: 'manual', appRule: 'removed' },
		});
	});

	it('marcar como transferência e responder às perguntas', async () => {
		const capture = await ingestOne(itauPix());
		await answerCaptureDuplicate(capture.id, false);
		await answerCaptureTransfer(capture.id, true);

		expect(logged().map((entry) => entry.event)).toEqual([
			'capture_answered',
			'capture_answered',
			'capture_marked_transfer',
		]);
		expect(logged()[0].data).toEqual({ captureId: capture.id, question: 'duplicate', answer: false });
		expect(logged()[1].data).toEqual({ captureId: capture.id, question: 'transfer', answer: true });
		expect(logged()[2].data).toMatchObject({ captureId: capture.id, kind: 'pix_in', paired: false, learned: true });

		logMock.mockClear();
		await markCaptureTransfer('nao-existe');
		expect(logged()[0]).toMatchObject({ event: 'capture_review_skipped', data: { action: 'transfer', from: 'missing' } });
	});
});

describe('nenhum data carrega valor, nome nem texto', () => {
	/** Valores em centavos e em reais, nomes, finais e palavras dos avisos. */
	const forbiddenIn = (notices: RawCapture[]) => {
		const numbers = new Set<number>();
		const words = new Set<string>(['9876', 'conta da casa']);
		for (const notice of notices) {
			const parsed = parseCapture(notice);
			if (parsed) {
				numbers.add(parsed.amountCents);
				numbers.add(parsed.amountCents / 100);
				if (parsed.foreign) numbers.add(parsed.foreign.amountCents);
				if (parsed.counterparty) words.add(parsed.counterparty.toLowerCase());
				if (parsed.cardLast4) words.add(parsed.cardLast4);
			}
			for (const word of `${notice.title} ${notice.text}`.toLowerCase().split(/[^\p{L}\p{N},.$]+/u)) {
				if (word.length >= 4) words.add(word);
			}
			for (const amount of `${notice.title} ${notice.text}`.match(/\d+,\d{2}/g) ?? []) words.add(amount);
		}
		return { numbers, words };
	};

	it('varre os eventos de uma ingestão variada e das respostas', async () => {
		manualAccount({ bankName: 'Itaú', name: 'Conta da casa' });
		learnedRule(foreign());
		const notices = [
			purchase(),
			purchase(),
			bankPromo(),
			bankUnknown(),
			itauPix(),
			foreign(),
			whatsappChat(),
			whatsappNoMoney(),
			whatsappCitingBank(),
			gmailUnknown(),
			gmailNoMoney(),
			smsUnknown(),
		];
		await ingest(...notices);
		for (const capture of [...mockCaptures.values()]) {
			if (capture.status !== 'pending') continue;
			if (capture.kind === 'purchase') {
				await confirmCapture(capture.id, 'food', categories);
				await revertCapture(capture.id);
			} else if (capture.kind === 'pix_in') await markCaptureTransfer(capture.id);
			else await dismissCapture(capture.id);
		}

		const { numbers, words } = forbiddenIn(notices);
		const entries = logged();
		expect(entries.length).toBeGreaterThan(notices.length);

		// Os ids podem: o da captura e a impressão digital (um hash). São aleatórios ou hexa, e
		// um "9876" no meio deles seria coincidência, então eles são conferidos à parte.
		const ids = new Set(['nao-existe']);
		for (const capture of mockCaptures.values()) {
			ids.add(capture.id);
			ids.add(capture.fingerprint);
		}
		for (const entry of entries) {
			for (const [key, value] of Object.entries(entry.data)) {
				const where = `${entry.event}.${key} = ${String(value)}`;
				if (key === 'captureId' || key === 'fingerprint') {
					// O aviso que nem virou item (descartado, no_bank) só tem a impressão digital.
					if (key === 'captureId') expect([where, ids.has(String(value))]).toEqual([where, true]);
					else expect(String(value)).toMatch(/^[0-9a-f]+-[0-9a-f]+$/);
					continue;
				}
				if (typeof value === 'number') expect([where, numbers.has(value)]).toEqual([where, false]);
				if (typeof value === 'string') {
					const lower = value.toLowerCase();
					for (const word of words) expect([where, word, lower.includes(word)]).toEqual([where, word, false]);
				}
			}
		}

		// O texto cru existe, mas só nos dois avisos do Nubank que o parser não entendeu.
		const withText = entries.filter((entry) => entry.rawText);
		expect(withText.map((entry) => entry.data.pkg)).toEqual([NUBANK, NUBANK]);
	});

	it('a função que monta o data, sozinha, também não', () => {
		const notice = purchase();
		const parsed = parseCapture(notice);
		const data = captureDecisionData({
			raw: notice,
			fingerprint: 'fp',
			parsed,
			outcome: {
				step: 'decided',
				decision: { action: 'pending', categoryId: 'food' },
				account: 'existing',
				captureId: 'cap',
			},
		});
		expect(Object.keys(data).length).toBeLessThanOrEqual(20);
		expect(JSON.stringify(data)).not.toMatch(/PADARIA|9876|35,90|3590/);
	});

	it('a pendente que o extrato confirmou (SPD-117): confirmada pela regra, ou pendente e marcada', () => {
		const confirmed = captureDecisionData({
			raw: { packageName: NUBANK },
			fingerprint: 'fp',
			outcome: { step: 'statement_match', captureId: 'cap', confirmed: true, why: 'rule', accountMoved: true },
		});
		expect(confirmed).toEqual({
			pkg: NUBANK,
			knownBank: true,
			fingerprint: 'fp',
			captureId: 'cap',
			outcome: 'confirmed',
			reason: 'statement',
			why: 'rule',
			accountMoved: true,
		});
		const marked = captureDecisionData({
			raw: { packageName: NUBANK },
			fingerprint: 'fp',
			outcome: { step: 'statement_match', captureId: 'cap', confirmed: false, why: 'suggested', accountMoved: false },
		});
		expect(marked).toMatchObject({ outcome: 'pending', reason: 'statement', why: 'suggested', accountMoved: false });
		expect(marked.parse).toBeUndefined();
	});
});
