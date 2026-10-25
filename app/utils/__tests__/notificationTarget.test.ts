// O caminho completo (SPD-040) passa pelo `accountResolver`, que lê as contas do banco.
jest.mock('../../database/database', () => ({
	addAccount: jest.fn(async () => 'nova'),
	updateAccount: jest.fn(async () => {}),
	findAccountBySource: jest.fn(async () => null),
	findAccountByKey: jest.fn(async () => null),
	getAccounts: jest.fn(async () => []),
}));

import { addAccount, getAccounts, updateAccount } from '../../database/database';
import type { Account, Capture } from '../../database/schema';
import { isNoBankNotice, resolveAccountForNotification } from '../accountResolver';
import type { ParsedCapture, RawCapture } from '../captureParser';
import { bankLabelOf, cardHintOf, pickNotificationTarget, planLedgerRepair } from '../notificationTarget';

const NUBANK = 'com.nu.production';
const INTER = 'br.com.intermedium';
const SAMSUNG = 'com.samsung.android.spay';
const GWALLET = 'com.google.android.apps.walletnfcrel';
const SMS = 'com.google.android.apps.messaging';
const GMAIL = 'com.google.android.gm';
/** C71: SMS do Santander, com o nome de outro banco no estabelecimento. */
const C71_TEXT = 'Santander: compra aprovada de R$ 50,00 em LOJA INTER SHOPPING, cartao final 7890.';

const account = (overrides: Partial<Account>): Account => ({
	id: 'x',
	name: 'Conta',
	kind: 'checking',
	role: 'main',
	envelopeMonthlyCents: null,
	network: null,
	bankName: null,
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
});

const nubankCard = account({ id: 'nu-card', name: 'Cartão 1534', kind: 'credit_card', role: 'card', bankName: 'Nubank', last4: '1534', packageName: NUBANK, closingDay: 25 });
const nubankPF = account({ id: 'nu-pf', name: 'Nubank PF', bankName: 'Nubank', packageName: NUBANK });
const interPF = account({ id: 'inter-pf', name: 'Inter PF', role: 'envelope', bankName: 'Inter', packageName: INTER });
const debitAsCard = account({ id: 'inter-debit', name: 'Débito Inter', kind: 'credit_card', role: 'card', bankName: 'Inter', packageName: INTER });

const nubank = (title: string, text: string) => ({ packageName: NUBANK, appLabel: 'Nubank', title, text, cardLast4: /final (\d{4})/.exec(text)?.[1] ?? null });

describe('cardHintOf', () => {
	it('lê crédito, débito ou nada', () => {
		expect(cardHintOf({ title: 'Compra no crédito aprovada', text: '' })).toBe('credit');
		expect(cardHintOf({ title: 'Compra no débito aprovada', text: '' })).toBe('debit');
		expect(cardHintOf({ title: 'Compra aprovada', text: 'para o cartão com final 2513' })).toBe('unknown');
	});
});

describe('pickNotificationTarget — a compra chega na fatura certa', () => {
	const accounts = [nubankCard, nubankPF, interPF];

	it('cartão virtual do Nubank (final diferente) cai no único cartão do Nubank', () => {
		const target = pickNotificationTarget(accounts, nubank('Compra no crédito aprovada', 'Compra de R$ 26,90 APROVADA em Google YouTubePremium para o cartão com final 2513.'));
		expect(target).toEqual({ type: 'card', account: nubankCard });
	});

	it('"Compra aprovada" sem a palavra crédito, com final de cartão, também vai para o cartão', () => {
		const target = pickNotificationTarget(accounts, nubank('Compra aprovada', 'Compra de R$ 29,38 APROVADA em IFOOD para o cartão com final 6422.'));
		expect(target).toEqual({ type: 'card', account: nubankCard });
	});

	it('final exato do cartão físico', () => {
		expect(pickNotificationTarget(accounts, nubank('Compra aprovada', 'Compra de R$ 10,00 APROVADA em X para o cartão com final 1534.'))).toEqual({ type: 'card', account: nubankCard });
	});

	it('compra no débito vai para a conta, nunca para a fatura', () => {
		expect(pickNotificationTarget(accounts, nubank('Compra no débito aprovada', 'Compra de R$ 10,00 APROVADA em X para o cartão com final 1534.'))).toEqual({ type: 'checking' });
	});

	it('débito do Inter sem a palavra débito vai para a conta, porque o Inter não tem cartão de crédito', () => {
		const target = pickNotificationTarget(accounts, { packageName: INTER, appLabel: 'Inter', title: 'Compra aprovada', text: 'Compra aprovada no cartão final 5678: R$ 50,00 em PADARIA', cardLast4: '5678' });
		expect(target).toEqual({ type: 'checking' });
	});

	it('um débito cadastrado como cartão ("Débito Inter") não atrai as compras', () => {
		const target = pickNotificationTarget([...accounts, debitAsCard], { packageName: INTER, appLabel: 'Inter', title: 'Compra aprovada', text: 'Compra aprovada no cartão final 5678: R$ 50,00 em PADARIA', cardLast4: '5678' });
		expect(target).toEqual({ type: 'checking' });
	});

	it('sem cartão do banco: "crédito" cria o cartão; sem a palavra, conta corrente', () => {
		const noCard = [nubankPF];
		expect(pickNotificationTarget(noCard, nubank('Compra no crédito aprovada', 'Compra de R$ 1,00 APROVADA em X para o cartão com final 2513.'))).toEqual({ type: 'new_card' });
		expect(pickNotificationTarget(noCard, nubank('Compra aprovada', 'Compra de R$ 1,00 APROVADA em X para o cartão com final 2513.'))).toEqual({ type: 'checking' });
	});

	it('cartão arquivado ou excluído não recebe compras', () => {
		const archived = { ...nubankCard, archived: true };
		expect(pickNotificationTarget([archived, nubankPF], nubank('Compra aprovada', 'Compra de R$ 1,00 APROVADA em X para o cartão com final 2513.'))).toEqual({ type: 'checking' });
	});

	it('dois cartões do mesmo banco: só o final exato decide; senão cria (crédito) ou fica na conta', () => {
		const second = { ...nubankCard, id: 'nu-card-2', last4: '9999' };
		const both = [nubankCard, second, nubankPF];
		expect(pickNotificationTarget(both, nubank('Compra aprovada', 'Compra de R$ 1,00 APROVADA em X para o cartão com final 9999.'))).toEqual({ type: 'card', account: second });
		expect(pickNotificationTarget(both, nubank('Compra aprovada', 'Compra de R$ 1,00 APROVADA em X para o cartão com final 2513.'))).toEqual({ type: 'checking' });
	});

	// Achado 7.6: caía em "conta corrente" e R$ 480 saíam do saldo, fora das duas faturas.
	it('"no crédito" com dois cartões do banco e final desconhecido: não dá para responder', () => {
		const second = { ...nubankCard, id: 'nu-card-2', last4: '9999' };
		const both = [nubankCard, second, nubankPF];
		expect(
			pickNotificationTarget(
				both,
				nubank('Compra no crédito aprovada', 'Compra de R$ 480,00 APROVADA em LOJA para o cartão com final 7777.')
			)
		).toEqual({ type: 'unknown' });
		// Sem a palavra "crédito" nada muda: o débito do Inter não a diz, e vai para a conta.
		expect(
			pickNotificationTarget(
				both,
				nubank('Compra aprovada', 'Compra de R$ 480,00 APROVADA em LOJA para o cartão com final 7777.')
			)
		).toEqual({ type: 'checking' });
		// Com um cartão só, continua sendo a fatura dele: a dúvida é que muda a resposta.
		expect(
			pickNotificationTarget(
				[nubankCard, nubankPF],
				nubank('Compra no crédito aprovada', 'Compra de R$ 480,00 APROVADA em LOJA para o cartão com final 7777.')
			)
		).toEqual({ type: 'card', account: nubankCard });
	});

	it('Samsung Pay: o banco sai do texto e a compra vai para o cartão desse banco', () => {
		const target = pickNotificationTarget(accounts, { packageName: SAMSUNG, appLabel: 'Samsung Wallet', title: 'Samsung Pay', text: 'R$ 35,90 em SUPERMERCADO com Nubank final 1234', cardLast4: '1234' });
		expect(target).toEqual({ type: 'card', account: nubankCard });
	});

	it('cartão cadastrado à mão, sem app, é encontrado pelo nome do banco', () => {
		const manual = { ...nubankCard, packageName: null };
		expect(pickNotificationTarget([manual, nubankPF], nubank('Compra aprovada', 'Compra de R$ 1,00 APROVADA em X para o cartão com final 2513.'))).toEqual({ type: 'card', account: manual });
	});
});

const capture = (overrides: Partial<Capture>): Capture => ({
	id: 'c',
	fingerprint: 'f',
	packageName: NUBANK,
	appLabel: 'Nubank',
	title: 'Compra aprovada',
	text: 'Compra de R$ 29,38 APROVADA em IFOOD para o cartão com final 6422.',
	postedAt: '2026-09-17T15:30:00.000Z',
	amountCents: 2938,
	direction: 'out',
	kind: 'purchase',
	counterparty: 'IFOOD',
	merchantKey: 'ifood',
	cardLast4: '6422',
	status: 'confirmed',
	question: null,
	relatedId: null,
	suggestedCategory: 'food',
	transactionId: 'tx-ifood',
	autoConfirmed: false,
	reason: null,
	accountId: 'nu-pf',
	transferId: null,
	installments: null,
	createdAt: '',
	updatedAt: '',
	...overrides,
});

describe('planLedgerRepair — conserta compras registradas pelas regras antigas', () => {
	const virtual = account({ id: 'nu-2513', name: 'Nubank · final 2513', kind: 'credit_card', role: 'card', bankName: 'Nubank', last4: '2513', packageName: NUBANK });

	it('junta o cartão criado por final virtual no cartão de verdade e move a compra que foi para a conta', () => {
		const plan = planLedgerRepair([nubankCard, nubankPF, interPF, virtual], [capture({})]);
		expect(plan).toEqual({
			mergeCards: [{ fromId: 'nu-2513', toId: 'nu-card' }],
			moveCaptures: [{ captureId: 'c', transactionId: 'tx-ifood', toId: 'nu-card' }],
		});
	});

	it('não mexe em débito, em compra já no cartão, em descartada nem em cartão configurado pelo usuário', () => {
		const debit = capture({ id: 'debito', title: 'Compra no débito aprovada' });
		const onCard = capture({ id: 'no-cartao', accountId: 'nu-card' });
		const dismissed = capture({ id: 'descartada', status: 'dismissed' });
		const interDebit = capture({ id: 'inter', packageName: INTER, appLabel: 'Inter', text: 'Compra aprovada no cartão final 5678: R$ 50,00 em PADARIA', cardLast4: '5678', accountId: 'inter-pf' });
		const configured = { ...virtual, closingDay: 10 };
		expect(planLedgerRepair([nubankCard, nubankPF, interPF, configured], [debit, onCard, dismissed, interDebit])).toEqual({ mergeCards: [], moveCaptures: [] });
	});

	it('é idempotente: depois de aplicado, não acha mais nada', () => {
		const repaired = planLedgerRepair([nubankCard, nubankPF, { ...virtual, deletedAt: '2026-09-17' }], [capture({ accountId: 'nu-card' })]);
		expect(repaired).toEqual({ mergeCards: [], moveCaptures: [] });
	});
});

/**
 * SPD-040 (NOTIF-07, C71): num aviso de quem não é o app do banco, o banco só conta como
 * citado pelo remetente ou por um padrão de banco no texto. O nome da loja não conta:
 * "LOJA INTER SHOPPING" num SMS do Santander punha a compra no cartão Inter.
 */
describe('bankLabelOf — o banco citado num aviso de terceiro (SPD-040)', () => {
	const sms = (title: string, text: string) => ({ packageName: SMS, appLabel: 'Mensagens', title, text });

	it('o nome da loja não é o banco: o SMS do Santander com "LOJA INTER SHOPPING" é do Santander (C71)', () => {
		expect(bankLabelOf(sms('Santander', C71_TEXT))).toBe('Santander');
	});

	it('banco só dentro do estabelecimento ("em", "no", "na"): nenhum banco citado', () => {
		for (const text of [
			'Compra aprovada de R$ 50,00 em LOJA INTER SHOPPING, cartao final 7890.',
			'Compra de R$ 12,00 no NUBANK BURGUER aprovada.',
			'Compra de R$ 80,00 na ITAU MODAS, cartao final 1234.',
			'Você comprou R$ 30,00 em BRADESCO SEGUROS.',
		]) {
			expect(bankLabelOf(sms('29290', text))).toBeNull();
		}
	});

	it('o remetente cita o banco: SMS e e-mail', () => {
		expect(bankLabelOf(sms('Bradesco', 'COMPRA APROVADA NO CARTAO FINAL 3456 DE R$ 45,00'))).toBe('Bradesco');
		expect(bankLabelOf(sms('NUBANK', 'Compra de R$ 10,00 aprovada em LOJA X'))).toBe('Nubank');
		expect(bankLabelOf(sms('Banco Inter', 'Pix recebido de R$ 10,00'))).toBe('Inter');
		expect(bankLabelOf({ packageName: GMAIL, appLabel: 'Gmail', title: 'Santander', text: 'Compra no cartão final 7890 aprovada: R$ 199,90 em LOJA ABC.' })).toBe('Santander');
	});

	it('remetente que só tem o nome de um banco no meio não é o banco', () => {
		expect(bankLabelOf(sms('Joao Inter', 'me passa os R$ 20,00 do almoço'))).toBeNull();
	});

	it('padrões de banco no texto: começo da mensagem, "cartão <banco>", "banco <banco>", "<banco> informa"', () => {
		expect(bankLabelOf(sms('27888', 'BRADESCO CARTOES: COMPRA APROVADA NO CARTAO FINAL 3456 DE R$ 45,00'))).toBe('Bradesco');
		expect(bankLabelOf(sms('27888', 'Itaú: compra aprovada de R$ 89,90 em POSTO SHELL, cartão final 9012.'))).toBe('Itaú');
		expect(bankLabelOf(sms('27888', 'Compra aprovada no cartão Nubank final 1534: R$ 10,00 em LOJA'))).toBe('Nubank');
		expect(bankLabelOf(sms('27888', 'Compra aprovada no Banco Inter: R$ 10,00 em LOJA'))).toBe('Inter');
		expect(bankLabelOf(sms('27888', 'Santander informa: compra de R$ 10,00 em LOJA'))).toBe('Santander');
	});

	it('dois bancos citados: vale o remetente', () => {
		expect(bankLabelOf(sms('Santander', 'Compra de R$ 10,00 aprovada no cartão Inter final 1234'))).toBe('Santander');
	});

	it('carteira: o banco do "com <banco> final", nunca o da loja nem o do título', () => {
		expect(bankLabelOf({ packageName: SAMSUNG, appLabel: 'Samsung Wallet', title: 'Pagamento aprovado', text: 'R$ 35,90 em INTER SHOPPING com Nubank final 1534' })).toBe('Nubank');
		expect(bankLabelOf({ packageName: GWALLET, appLabel: 'Google Wallet', title: 'INTER SHOPPING', text: 'R$ 35,90 com Mastercard •••• 1534' })).toBeNull();
	});

	it('o app do banco continua sendo o banco, cite o texto a loja que citar', () => {
		expect(bankLabelOf({ packageName: INTER, appLabel: 'Inter', title: 'Compra aprovada', text: 'Compra aprovada no cartão final 5678: R$ 50,00 em LOJA NUBANK' })).toBe('Inter');
	});
});

describe('pickNotificationTarget — o banco da loja não puxa a compra (SPD-040)', () => {
	const interCard = account({ id: 'inter-cc', name: 'Cartão Inter', kind: 'credit_card', role: 'card', bankName: 'Inter', packageName: INTER, last4: '5678', closingDay: 25 });
	const santanderCard = account({ id: 'santander-cc', name: 'Cartão Santander', kind: 'credit_card', role: 'card', bankName: 'Santander', last4: '1111' });
	const accounts = [interCard, nubankCard, interPF, nubankPF];
	const c71 = { packageName: SMS, appLabel: 'Mensagens', title: 'Santander', text: C71_TEXT, cardLast4: '7890' };

	it('C71: a compra do SMS do Santander não cai no cartão Inter', () => {
		expect(pickNotificationTarget(accounts, c71)).toEqual({ type: 'checking' });
	});

	it('com um cartão Santander cadastrado, é dele', () => {
		expect(pickNotificationTarget([...accounts, santanderCard], c71)).toEqual({ type: 'card', account: santanderCard });
	});

	it('carteira com banco no nome da loja: vale o banco do "com <banco> final"', () => {
		const wallet = { packageName: SAMSUNG, appLabel: 'Samsung Wallet', title: 'Pagamento aprovado', text: 'R$ 35,90 em INTER SHOPPING com Nubank final 2513', cardLast4: '2513' };
		expect(pickNotificationTarget(accounts, wallet)).toEqual({ type: 'card', account: nubankCard });
	});
});

/**
 * O caminho completo: o mesmo "banco citado" decide se o aviso é ignorado direto
 * (`isNoBankNotice`, SPD-022) e para qual conta ele vai (`resolveAccountForNotification`).
 */
describe('banco citado no caminho completo (SPD-040 com SPD-022)', () => {
	const interCard = account({ id: 'inter-cc', name: 'Cartão Inter', kind: 'credit_card', role: 'card', bankName: 'Inter', packageName: INTER, last4: '5678', closingDay: 25 });
	const raw = (title: string, text: string): RawCapture => ({ packageName: SMS, appLabel: 'Mensagens', title, text, postedAt: '2026-10-23T15:00:00.000Z' });
	const parsed: ParsedCapture = { amountCents: 5000, direction: 'out', kind: 'purchase', counterparty: 'LOJA INTER SHOPPING', cardLast4: '7890', neutral: false, installments: null };

	beforeEach(() => {
		jest.clearAllMocks();
		(getAccounts as jest.Mock).mockResolvedValue([interCard, nubankCard, interPF, nubankPF]);
	});

	it('SMS do Santander (C71): não é ignorado, e fica sem conta em vez de ir para o cartão Inter', async () => {
		const notice = raw('Santander', C71_TEXT);
		expect(isNoBankNotice(notice)).toBe(false);
		expect(await resolveAccountForNotification(notice, parsed)).toBeNull();
		expect(addAccount).not.toHaveBeenCalled();
		expect(updateAccount).not.toHaveBeenCalled();
	});

	it('SMS sem banco no remetente nem em padrão, só na loja: sem banco citado, ignorado direto', () => {
		expect(isNoBankNotice(raw('29290', 'Compra aprovada de R$ 50,00 em LOJA INTER SHOPPING, cartao final 7890.'))).toBe(true);
	});

	it('SMS com padrão de banco no texto segue citando o banco', () => {
		expect(isNoBankNotice(raw('27888', 'BRADESCO CARTOES: COMPRA APROVADA NO CARTAO FINAL 3456 DE R$ 45,00 EM DROGASIL.'))).toBe(false);
	});
});
