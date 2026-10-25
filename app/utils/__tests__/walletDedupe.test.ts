/**
 * Carteira + banco pela ingestão inteira, com o nome da loja escrito diferente (SPD-044).
 *
 * A Samsung Wallet escreve "SUPERMERCADO BOM PRECO LTDA"; o Nubank, 20 s depois,
 * "SUPERM BOM PRECO". É a mesma compra no mesmo cartão (final 1534): o aviso do banco vira
 * duplicata, e com regra aprendida para os dois nomes nada é lançado duas vezes (D3, D3b do
 * sanity). O que não pode regredir: o mesmo nome funde (D1), e horas de diferença perguntam
 * em vez de fundir (D4, achado 7.4).
 *
 * O banco é o mesmo dublê em Maps de `captureRepost.test.ts`, com as contas do usuário
 * semeadas: o cartão Nubank final 1534 e a conta Nubank.
 */

import type { Account, Capture, MerchantRule } from '../../database/schema';

const mockAccounts = new Map<string, Account>();
const mockCaptures = new Map<string, Capture>();
const mockRules = new Map<string, MerchantRule>();
const mockTransactions = new Map<string, { id: string; deleted?: boolean }>();
const mockCounter = { value: 0 };
const mockMakeId = (prefix: string): string => {
	mockCounter.value += 1;
	return `${prefix}-${mockCounter.value}`;
};

jest.mock('../../diagnostics/log', () => ({ ...jest.requireActual('../../diagnostics/log'), log: jest.fn() }));

jest.mock('../../sync/queue', () => ({ schedule: jest.fn() }));

jest.mock('../notificationUtils', () => ({ scheduleBillReminders: jest.fn(async () => 0) }));

jest.mock('../../database/database', () => ({
	addTransaction: jest.fn(async () => {
		const id = mockMakeId('tx');
		mockTransactions.set(id, { id });
		return id;
	}),
	deleteTransaction: jest.fn(async (id: string) => {
		mockTransactions.set(id, { id, deleted: true });
	}),
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
	// Como o SQL: com final, o cartão daquele app; sem final, a conta que não é cartão.
	findAccountBySource: jest.fn(
		async (packageName: string, last4: string | null) =>
			[...mockAccounts.values()].find((item) =>
				last4
					? item.packageName === packageName && item.last4 === last4
					: item.packageName === packageName && item.last4 === null && item.kind !== 'credit_card'
			) ?? null
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
	getRecentCaptures: jest.fn(async (since: string) =>
		[...mockCaptures.values()].filter((capture) => capture.postedAt >= since && !capture.deletedAt)
	),
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

import { log } from '../../diagnostics/log';
import { ingestRawCaptures } from '../captureActions';
import { merchantKeyOf, type RawCapture } from '../captureParser';

const NUBANK = 'com.nu.production';
const SAMSUNG = 'com.samsung.android.spay';
const T0 = '2026-10-23T15:00:00.000Z';
const HOUR = 60 * 60_000;
const at = (offsetMs: number): string => new Date(Date.parse(T0) + offsetMs).toISOString();

const categories = [
	{ id: 'other_expense', name: 'Outros', type: 'expense', icon: '', color: '', updatedAt: '' },
	{ id: 'other_income', name: 'Outros', type: 'income', icon: '', color: '', updatedAt: '' },
	{ id: 'food', name: 'Alimentação', type: 'expense', icon: '', color: '', updatedAt: '' },
] as unknown as Parameters<typeof ingestRawCaptures>[1]['categories'];

const account = (overrides: Partial<Account>): Account =>
	({
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
	}) as Account;

const wallet = (text: string, postedAt: string): RawCapture => ({
	packageName: SAMSUNG,
	appLabel: 'Samsung Wallet',
	title: 'Pagamento aprovado',
	text,
	postedAt,
});

const nubank = (text: string, postedAt: string): RawCapture => ({
	packageName: NUBANK,
	appLabel: 'Nubank',
	title: 'Compra no crédito aprovada',
	text,
	postedAt,
});

const WALLET_TEXT = 'R$ 35,90 em SUPERMERCADO BOM PRECO LTDA com Nubank final 1534';
const BANK_TEXT = 'Compra de R$ 35,90 APROVADA em SUPERM BOM PRECO para o cartão com final 1534.';

const ingest = (...raws: RawCapture[]) => ingestRawCaptures(raws, { ownNames: [], categories });

/** Regra aprendida que já lança sozinha (três confirmações). */
const learnedRule = (name: string): void => {
	const key = merchantKeyOf(name);
	if (!key) throw new Error('nome sem chave');
	mockRules.set(key, { merchantKey: key, categoryId: 'food', treatAs: 'transaction', confirmations: 3, updatedAt: '' });
};

const captures = (): Capture[] => [...mockCaptures.values()];
const fromPackage = (packageName: string): Capture | undefined =>
	captures().find((capture) => capture.packageName === packageName);
const liveTransactions = () => [...mockTransactions.values()].filter((row) => !row.deleted);
const decisions = () =>
	(log as jest.Mock).mock.calls
		.filter(([, event]) => event === 'capture_decision')
		.map(([, , options]) => options.data as Record<string, unknown>);

beforeEach(() => {
	mockAccounts.clear();
	mockCaptures.clear();
	mockRules.clear();
	mockTransactions.clear();
	jest.clearAllMocks();
	for (const item of [
		account({ id: 'nu-pf', name: 'Nubank PF', bankName: 'Nubank', packageName: NUBANK }),
		account({
			id: 'nu-cc',
			name: 'Cartão Nubank',
			kind: 'credit_card',
			role: 'card',
			bankName: 'Nubank',
			packageName: NUBANK,
			last4: '1534',
			closingDay: 3,
		}),
	]) {
		mockAccounts.set(item.id, item);
	}
});

describe('carteira + banco com o nome da loja escrito diferente (SPD-044)', () => {
	it('D3: o aviso do banco 20 s depois vira duplicata do da carteira', async () => {
		await ingest(wallet(WALLET_TEXT, T0), nubank(BANK_TEXT, at(20_000)));

		expect(fromPackage(SAMSUNG)?.status).toBe('pending');
		expect(fromPackage(NUBANK)?.status).toBe('duplicate');
		expect(fromPackage(NUBANK)?.relatedId).toBe(fromPackage(SAMSUNG)?.id);
		// O diário registra o desfecho de sempre, sem nome de loja.
		const bankDecision = decisions()[1];
		expect(bankDecision).toMatchObject({ outcome: 'duplicate' });
		expect(JSON.stringify(decisions())).not.toMatch(/superm/i);
	});

	it('D3b: com regra aprendida para os dois nomes, a compra é lançada uma vez só', async () => {
		learnedRule('SUPERMERCADO BOM PRECO LTDA');
		learnedRule('SUPERM BOM PRECO');
		await ingest(wallet(WALLET_TEXT, T0), nubank(BANK_TEXT, at(20_000)));

		expect(liveTransactions()).toHaveLength(1);
		expect(fromPackage(NUBANK)?.status).toBe('duplicate');
	});

	it('D1 (não regride): o mesmo nome nos dois avisos continua fundindo', async () => {
		await ingest(
			wallet('R$ 35,90 em SUPERMERCADO BOM PRECO com Nubank final 1534', T0),
			nubank('Compra de R$ 35,90 APROVADA em SUPERMERCADO BOM PRECO para o cartão com final 1534.', at(20_000))
		);

		expect(fromPackage(NUBANK)?.status).toBe('duplicate');
	});

	it('D4 (não regride): nome aproximado com 9 h de diferença pergunta, não funde', async () => {
		await ingest(wallet(WALLET_TEXT, T0), nubank(BANK_TEXT, at(9 * HOUR)));

		expect(fromPackage(NUBANK)?.status).toBe('pending');
		expect(fromPackage(NUBANK)?.question).toBe('duplicate');
	});

	it('lojas claramente diferentes no mesmo cartão são duas compras, sem pergunta', async () => {
		await ingest(
			wallet('R$ 35,90 em PADARIA CENTRAL com Nubank final 1534', T0),
			nubank('Compra de R$ 35,90 APROVADA em POSTO SHELL para o cartão com final 1534.', at(20_000))
		);

		expect(fromPackage(NUBANK)?.status).toBe('pending');
		expect(fromPackage(NUBANK)?.question ?? null).toBeNull();
	});
});
