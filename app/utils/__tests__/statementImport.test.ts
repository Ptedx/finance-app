/**
 * O import do extrato do cartão de ponta a ponta, com o arquivo do aparelho (E2E-34).
 *
 * Padaria R$ 50 em 01/11 e mercado R$ 100 em 07/11 já estavam lançados à mão no "Nubank
 * Teste" final 1111. O import criou outro cartão e mandou as duas para revisão sem aviso:
 * confirmar dobrava o gasto. Aqui o banco é falso; o plano, a decisão e a conta são reais.
 */

jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('expo-file-system', () => ({ File: jest.fn() }));

jest.mock('../../database/database', () => ({
	db: { withTransactionAsync: jest.fn(async (body: () => Promise<void>) => body()) },
	addAccount: jest.fn(async () => 'nova'),
	updateAccount: jest.fn(async () => {}),
	findAccountBySource: jest.fn(async () => null),
	findAccountByKey: jest.fn(async () => null),
	getAccounts: jest.fn(async () => []),
	assignTransactionAccount: jest.fn(async () => {}),
	getTransactionsByDateRange: jest.fn(async () => []),
	reassignCaptureLedger: jest.fn(async () => {}),
}));

jest.mock('../../database/captures', () => ({
	getCapture: jest.fn(async () => null),
	getLinkedTransactionIds: jest.fn(async () => new Set()),
	getMerchantRule: jest.fn(async () => null),
	getRecentCaptures: jest.fn(async () => []),
	getStatementClaimedCaptureIds: jest.fn(async () => new Set()),
	getStatementFingerprints: jest.fn(async () => new Set()),
	getPendingCaptures: jest.fn(async () => []),
	insertCapture: jest.fn(async () => {}),
	updateCapture: jest.fn(async () => {}),
}));

jest.mock('../captureActions', () => ({
	applyDecision: jest.fn(async () => ({ id: 'x', autoConfirmed: false })),
	toKnownCapture: (capture: unknown) => capture,
	toMerchantRule: jest.fn(() => undefined),
}));

let mockNextId = 0;
jest.mock('../categoryEditUtils', () => ({ generateUniqueId: () => `id-${++mockNextId}` }));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { insertCapture } from '../../database/captures';
import { addAccount, assignTransactionAccount, getAccounts, getTransactionsByDateRange } from '../../database/database';
import type { Account, Transaction } from '../../database/schema';
import { applyDecision } from '../captureActions';
import { STATEMENT_LEDGER_SUSPECT_REASON } from '../captureMatcher';
import { importOfxContent, walkStatementChoice, withStatementAccountChooser } from '../statementImport';

const E2E_CARD_OFX = readFileSync(join(__dirname, 'fixtures', 'e2e-cartao.ofx'), 'latin1');

const card = (overrides: Partial<Account>): Account => ({
	id: 'x',
	name: 'Cartão',
	kind: 'credit_card',
	role: 'card',
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
	openingBalanceDate: '2026-10-20',
	sortOrder: 0,
	archived: false,
	updatedAt: '',
	...overrides,
});

const nubankTeste = card({ id: 'nubank-teste', name: 'Nubank Teste', bankName: 'Nubank', last4: '1111' });
const itauCard = card({ id: 'itau', name: 'Itaú Click', bankName: 'Itaú', last4: '7777' });

const manual = (id: string, amountCents: number, date: string, note: string, accountId: string | null): Transaction =>
	({
		id,
		amountCents,
		category: 'alimentacao',
		date,
		note,
		isIncome: false,
		accountId,
		installmentGroup: null,
		installmentIndex: null,
		installmentCount: null,
		cardLast4: null,
		updatedAt: '',
	}) as Transaction;

const mocked = {
	addAccount: addAccount as jest.Mock,
	getAccounts: getAccounts as jest.Mock,
	getTransactionsByDateRange: getTransactionsByDateRange as jest.Mock,
	assignTransactionAccount: assignTransactionAccount as jest.Mock,
	insertCapture: insertCapture as jest.Mock,
	applyDecision: applyDecision as jest.Mock,
};

const withAccounts = (accounts: Account[]) => {
	let created: Account | null = null;
	mocked.addAccount.mockImplementation(async (draft: Omit<Account, 'id' | 'updatedAt'>) => {
		created = { ...draft, id: 'nova', updatedAt: '' } as Account;
		return 'nova';
	});
	mocked.getAccounts.mockImplementation(async () => (created ? [...accounts, created] : accounts));
};

/** O que cada linha virou: a decisão que foi para `applyDecision`, pelo memo. */
const decisions = () =>
	new Map(
		mocked.applyDecision.mock.calls.map(([base, decision]) => [
			(base.text as string).split('\n')[0],
			{ decision, reason: base.reason, accountId: base.accountId },
		])
	);

const options = { ownNames: [], categories: [] };

beforeEach(() => {
	jest.clearAllMocks();
	mockNextId = 0;
});

describe('extrato do cartão Nubank que já existe (E2E-34)', () => {
	it('as linhas caem no Nubank Teste e as já lançadas à mão são reconhecidas', async () => {
		withAccounts([nubankTeste]);
		mocked.getTransactionsByDateRange.mockResolvedValue([
			manual('padaria', 5_000, '2026-11-01', 'Padaria', 'nubank-teste'),
			manual('mercado', 10_000, '2026-11-07', 'Mercado', 'nubank-teste'),
		]);

		const { summary } = await importOfxContent(E2E_CARD_OFX, options);

		expect(mocked.addAccount).not.toHaveBeenCalled();
		// "4 linhas, 2 já estavam no app, 1 para revisar, 1 de fora".
		expect(summary.total).toBe(4);
		expect(summary.matchedTransactions).toBe(2);
		expect(summary.pending).toBe(1);
		expect(summary.ignored).toBe(1);
		const linked = mocked.insertCapture.mock.calls
			.filter(([draft]) => draft.reason === 'statement_transaction')
			.map(([draft]) => draft.transactionId)
			.sort();
		expect(linked).toEqual(['mercado', 'padaria']);
		expect(decisions().get('Drogasil 1234')?.accountId).toBe('nubank-teste');
	});
});

describe('possível repetido de um lançamento à mão (E2E-34)', () => {
	it('lançamento noutro cartão com o mesmo valor e dia ±1: a linha pergunta "parece repetido"', async () => {
		withAccounts([nubankTeste, itauCard]);
		mocked.getTransactionsByDateRange.mockResolvedValue([
			// Lançados no cartão errado; o extrato é do Nubank.
			manual('padaria', 5_000, '2026-10-31', 'Padaria', 'itau'),
			manual('mercado', 10_000, '2026-11-08', 'Mercado', 'itau'),
		]);

		const { summary } = await importOfxContent(E2E_CARD_OFX, options);

		const byMemo = decisions();
		expect(byMemo.get('Padaria Pao Quente')).toEqual({
			decision: { action: 'ask_duplicate', relatedId: 'padaria' },
			reason: STATEMENT_LEDGER_SUSPECT_REASON,
			accountId: 'nubank-teste',
		});
		expect(byMemo.get('Supermercado Teste')?.decision).toEqual({ action: 'ask_duplicate', relatedId: 'mercado' });
		expect(byMemo.get('Drogasil 1234')?.decision.action).toBe('pending');
		expect(summary.questions).toBe(2);
		expect(summary.pending).toBe(1);
	});

	it('nem o estabelecimento já aprendido entra sozinho: pergunta antes', async () => {
		withAccounts([nubankTeste, itauCard]);
		mocked.getTransactionsByDateRange.mockResolvedValue([manual('padaria', 5_000, '2026-11-01', 'Padaria', 'itau')]);
		const { toMerchantRule } = jest.requireMock('../captureActions');
		toMerchantRule.mockImplementation(() => ({
			merchantKey: 'x',
			categoryId: 'alimentacao',
			treatAs: 'transaction',
			confirmations: 10,
		}));

		const { summary } = await importOfxContent(E2E_CARD_OFX, options);

		expect(decisions().get('Padaria Pao Quente')?.decision).toEqual({ action: 'ask_duplicate', relatedId: 'padaria' });
		// Drogasil e mercado continuam entrando sozinhos; a padaria virou pergunta.
		expect(summary.autoConfirmed).toBe(2);
		expect(summary.questions).toBe(1);
		toMerchantRule.mockImplementation(() => undefined);
	});

	it('dois dias de diferença não é repetido', async () => {
		withAccounts([nubankTeste, itauCard]);
		mocked.getTransactionsByDateRange.mockResolvedValue([manual('padaria', 5_000, '2026-10-30', 'Padaria', 'itau')]);

		await importOfxContent(E2E_CARD_OFX, options);

		expect(decisions().get('Padaria Pao Quente')?.decision.action).toBe('pending');
	});

	it('o lançamento da conta corrente não é repetido da compra do cartão', async () => {
		const checking = card({ id: 'nu-conta', kind: 'checking', role: 'main', bankName: 'Nubank' });
		withAccounts([nubankTeste, checking]);
		mocked.getTransactionsByDateRange.mockResolvedValue([manual('padaria', 5_000, '2026-11-01', 'Padaria', 'nu-conta')]);

		await importOfxContent(E2E_CARD_OFX, options);

		expect(decisions().get('Padaria Pao Quente')?.decision.action).toBe('pending');
	});

	it('o lançamento já ligado a uma captura não é perguntado', async () => {
		withAccounts([nubankTeste, itauCard]);
		mocked.getTransactionsByDateRange.mockResolvedValue([manual('padaria', 5_000, '2026-11-01', 'Padaria', 'itau')]);
		const { getLinkedTransactionIds } = jest.requireMock('../../database/captures');
		getLinkedTransactionIds.mockResolvedValueOnce(new Set(['padaria']));

		await importOfxContent(E2E_CARD_OFX, options);

		expect(decisions().get('Padaria Pao Quente')?.decision.action).toBe('pending');
	});
});

describe('a pergunta "de qual cartão é este extrato?"', () => {
	it('o import usa quem a tela registrou para perguntar', async () => {
		withAccounts([{ ...nubankTeste, bankName: 'Itaú' }]);
		const chooser = jest.fn(async () => ({ type: 'existing' as const, accountId: 'nubank-teste' }));

		await withStatementAccountChooser(chooser, () => importOfxContent(E2E_CARD_OFX, options));

		expect(chooser).toHaveBeenCalledTimes(1);
		expect(mocked.addAccount).not.toHaveBeenCalled();
		// Fora do bloco, ninguém pergunta.
		await importOfxContent(E2E_CARD_OFX, options);
		expect(chooser).toHaveBeenCalledTimes(1);
	});

	it('anda pelos candidatos e depois pelos outros cartões: este / outro / criar novo', async () => {
		const question = {
			isCard: true,
			bankName: 'Nubank',
			last4: '1111',
			candidates: [nubankTeste],
			others: [itauCard],
		};
		const seen: Array<[string, boolean]> = [];

		const choice = await walkStatementChoice(question, async (candidate, hasMore) => {
			seen.push([candidate.id, hasMore]);
			return candidate.id === 'itau' ? 'this' : 'other';
		});

		expect(seen).toEqual([
			['nubank-teste', true],
			['itau', false],
		]);
		expect(choice).toEqual({ type: 'existing', accountId: 'itau' });
		expect(await walkStatementChoice(question, async () => 'new')).toEqual({ type: 'new' });
	});
});
