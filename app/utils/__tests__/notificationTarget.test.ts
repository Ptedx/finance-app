import type { Account, Capture } from '../../database/schema';
import { cardHintOf, pickNotificationTarget, planLedgerRepair } from '../notificationTarget';

const NUBANK = 'com.nu.production';
const INTER = 'br.com.intermedium';
const SAMSUNG = 'com.samsung.android.spay';

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
