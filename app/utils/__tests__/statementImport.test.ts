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
	runInTransaction: jest.fn(async (body: () => Promise<void>) => body()),
	addAccount: jest.fn(async () => 'nova'),
	updateAccount: jest.fn(async () => {}),
	findAccountBySource: jest.fn(async () => null),
	findAccountByKey: jest.fn(async () => null),
	getAccounts: jest.fn(async () => []),
	assignTransactionAccount: jest.fn(async () => {}),
	getTransactionsByDateRange: jest.fn(async () => []),
	reassignCaptureLedger: jest.fn(async () => {}),
	getAccountTransactions: jest.fn(async () => []),
	addTransaction: jest.fn(async () => 'tx'),
}));

jest.mock('../../sync/queue', () => ({ schedule: jest.fn() }));

jest.mock('../../diagnostics/capture', () => ({ logCaptureDecision: jest.fn() }));

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
	confirmCapture: jest.fn(async (id: string) => ({ id, status: 'confirmed' })),
	resolveCategoryId: (wanted: string | null) => wanted ?? 'other',
	toKnownCapture: (capture: unknown) => capture,
	toMerchantRule: jest.fn(() => undefined),
}));

let mockNextId = 0;
jest.mock('../categoryEditUtils', () => ({ generateUniqueId: () => `id-${++mockNextId}` }));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCapture, getMerchantRule, getRecentCaptures, insertCapture, updateCapture } from '../../database/captures';
import {
	addAccount,
	addTransaction,
	assignTransactionAccount,
	getAccounts,
	getAccountTransactions,
	getTransactionsByDateRange,
} from '../../database/database';
import type { Account, Capture, Transaction } from '../../database/schema';
import { logCaptureDecision } from '../../diagnostics/capture';
import { applyDecision, confirmCapture, toMerchantRule } from '../captureActions';
import { type CaptureChoices, choiceKeyOf } from '../captureChoices';
import { STATEMENT_LEDGER_SUSPECT_REASON } from '../captureMatcher';
import {
	createStatementInstallments,
	importOfxContent,
	walkStatementChoice,
	withStatementAccountChooser,
} from '../statementImport';

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

// ---------------------------------------------------------------------------
// SPD-117: a pendente que o extrato confirmou (AUTO-13) e as parcelas que faltam (AUTO-15)
// ---------------------------------------------------------------------------

/** O mesmo arquivo do cartão final 1111, com outras linhas. */
const cardOfx = (rows: string): string =>
	E2E_CARD_OFX.replace(/<BANKTRANLIST>[\s\S]*<\/BANKTRANLIST>/, `<BANKTRANLIST>${rows}</BANKTRANLIST>`);

const row = (fitid: string, date: string, amount: string, memo: string): string =>
	`<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>${date.replace(/-/g, '')}000000[-3:BRT]<TRNAMT>${amount}<FITID>${fitid}<MEMO>${memo}</STMTTRN>`;

/** A notificação da padaria de R$ 50 em 01/11, ainda na revisão. */
const pendingPadaria = (overrides: Partial<Capture> = {}): Capture => ({
	id: 'cap-padaria',
	fingerprint: 'fp-padaria',
	packageName: 'com.nu.production',
	appLabel: 'Nubank',
	title: 'Compra aprovada',
	text: 'Compra de R$ 50,00 em PADARIA PAO QUENTE',
	// Meio-dia local: o mesmo dia de calendário em qualquer fuso.
	postedAt: '2026-11-01T12:00:00.000',
	amountCents: 5_000,
	direction: 'out',
	kind: 'purchase',
	counterparty: 'PADARIA PAO QUENTE',
	merchantKey: 'padaria pao quente',
	cardLast4: '1111',
	status: 'pending',
	question: null,
	relatedId: null,
	suggestedCategory: 'alimentacao',
	transactionId: null,
	autoConfirmed: false,
	reason: null,
	accountId: 'nubank-teste',
	transferId: null,
	installments: null,
	createdAt: '',
	updatedAt: '',
	...overrides,
});

const PADARIA_OFX = cardOfx(row('e2e-fit-001', '2026-11-01', '-50.00', 'Padaria Pao Quente'));

const more = {
	getCapture: getCapture as jest.Mock,
	getRecentCaptures: getRecentCaptures as jest.Mock,
	getMerchantRule: getMerchantRule as jest.Mock,
	toMerchantRule: toMerchantRule as jest.Mock,
	confirmCapture: confirmCapture as jest.Mock,
	logCaptureDecision: logCaptureDecision as jest.Mock,
	getAccountTransactions: getAccountTransactions as jest.Mock,
	addTransaction: addTransaction as jest.Mock,
	updateCapture: updateCapture as jest.Mock,
};

const withPending = (capture: Capture) => {
	more.getRecentCaptures.mockResolvedValue([capture]);
	more.getCapture.mockImplementation(async (id: string) => (id === capture.id ? capture : null));
};

/** A regra aprendida do estabelecimento, com a categoria dada. */
const learned = (categoryId: string) =>
	more.toMerchantRule.mockImplementation((stored: unknown) =>
		stored ? { merchantKey: 'padaria pao quente', categoryId, treatAs: 'transaction', confirmations: 1 } : undefined
	);

const statementLineDraft = () =>
	mocked.insertCapture.mock.calls.find(([draft]) => draft.reason === 'statement_capture')?.[0];

describe('pendente que o extrato confirmou (SPD-117, AUTO-13)', () => {
	beforeEach(() => {
		withAccounts([nubankTeste]);
		mocked.getTransactionsByDateRange.mockResolvedValue([]);
		more.getMerchantRule.mockImplementation(async (key: string) => ({ merchantKey: key }));
	});
	afterEach(() => {
		more.getRecentCaptures.mockResolvedValue([]);
		more.getCapture.mockImplementation(async () => null);
		more.getMerchantRule.mockImplementation(async () => null);
		more.toMerchantRule.mockImplementation(() => undefined);
	});

	it('categoria da regra aprendida + linha do extrato igual: confirmada sozinha, com a categoria da regra', async () => {
		withPending(pendingPadaria());
		learned('alimentacao');

		const result = await importOfxContent(PADARIA_OFX, options);

		expect(result.summary.matchedCaptures).toBe(1);
		expect(more.confirmCapture).toHaveBeenCalledTimes(1);
		expect(more.confirmCapture).toHaveBeenCalledWith('cap-padaria', 'alimentacao', options.categories, undefined, undefined);
		expect(result.settledCaptures).toEqual([{ captureId: 'cap-padaria', outcome: 'confirmed' }]);
		// A linha do extrato continua "já vista", apontando para a captura.
		expect(statementLineDraft()).toMatchObject({ status: 'duplicate', relatedId: 'cap-padaria' });
		// Diário: a decisão, sem valor, nome nem texto.
		expect(more.logCaptureDecision).toHaveBeenCalledWith({
			raw: { packageName: 'com.nu.production', title: '', text: '' },
			fingerprint: 'fp-padaria',
			outcome: { step: 'statement_match', captureId: 'cap-padaria', confirmed: true, why: 'rule', accountMoved: false },
		});
	});

	it('categoria só sugerida (sem regra): continua pendente, marcada "valor confirmado pelo extrato"', async () => {
		withPending(pendingPadaria());

		const result = await importOfxContent(PADARIA_OFX, options);

		expect(more.confirmCapture).not.toHaveBeenCalled();
		expect(result.settledCaptures).toEqual([{ captureId: 'cap-padaria', outcome: 'marked' }]);
		// A marca é a linha do extrato casada com ela (`reason: statement_capture`), sem coluna nova.
		expect(statementLineDraft()).toMatchObject({ status: 'duplicate', relatedId: 'cap-padaria' });
		expect(more.logCaptureDecision).toHaveBeenCalledWith(
			expect.objectContaining({
				outcome: { step: 'statement_match', captureId: 'cap-padaria', confirmed: false, why: 'suggested', accountMoved: false },
			})
		);
	});

	it('regra aprendida com outra categoria: a sugerida não veio dela, continua pendente', async () => {
		withPending(pendingPadaria());
		learned('lazer');

		const result = await importOfxContent(PADARIA_OFX, options);

		expect(more.confirmCapture).not.toHaveBeenCalled();
		expect(result.settledCaptures).toEqual([{ captureId: 'cap-padaria', outcome: 'marked' }]);
	});

	it('pendente com pergunta ("parece repetido?"): o extrato confirma o valor, não responde a pergunta', async () => {
		withPending(pendingPadaria({ question: 'duplicate', relatedId: 'outra' }));
		learned('alimentacao');

		const result = await importOfxContent(PADARIA_OFX, options);

		expect(more.confirmCapture).not.toHaveBeenCalled();
		expect(result.settledCaptures).toEqual([{ captureId: 'cap-padaria', outcome: 'marked' }]);
	});

	it('o extrato do cartão tira a compra da conta corrente e confirma já no cartão', async () => {
		withPending(pendingPadaria({ accountId: 'nu-conta' }));
		learned('alimentacao');

		const result = await importOfxContent(PADARIA_OFX, options);

		expect(more.updateCapture).toHaveBeenCalledWith('cap-padaria', { accountId: 'nubank-teste' });
		expect(more.confirmCapture).toHaveBeenCalledWith('cap-padaria', 'alimentacao', options.categories, undefined, undefined);
		expect(result.settledCaptures).toEqual([{ captureId: 'cap-padaria', outcome: 'confirmed' }]);
		expect(more.logCaptureDecision.mock.calls[0][0].outcome.accountMoved).toBe(true);
	});

	it('captura que já foi confirmada: nada muda nela', async () => {
		withPending(pendingPadaria({ status: 'confirmed', transactionId: 'tx-padaria' }));
		learned('alimentacao');

		const result = await importOfxContent(PADARIA_OFX, options);

		expect(result.summary.matchedCaptures).toBe(1);
		expect(more.confirmCapture).not.toHaveBeenCalled();
		expect(result.settledCaptures).toEqual([]);
	});
});

/** O extrato da conta corrente, com as linhas dadas. Banco e conta inventados. */
const checkingOfx = (rows: string): string =>
	[
		'OFXHEADER:100',
		'DATA:OFXSGML',
		'VERSION:102',
		'',
		'<OFX>',
		'<BANKMSGSRSV1><STMTTRNRS><TRNUID>1<STATUS><CODE>0<SEVERITY>INFO</STATUS><STMTRS><CURDEF>BRL',
		'<BANKACCTFROM><BANKID>077<ACCTID>0000-0<ACCTTYPE>CHECKING</BANKACCTFROM>',
		'<BANKTRANLIST><DTSTART>20261101000000[-3:BRT]<DTEND>20261107000000[-3:BRT]',
		rows,
		'</BANKTRANLIST><LEDGERBAL><BALAMT>0.00<DTASOF>20261107000000[-3:BRT]</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
	].join('\n');

/** O Pix com "recebido" e "enviou" e sem dizer para quem, ainda na revisão: a saída é o palpite. */
const pendingPix = (overrides: Partial<Capture> = {}): Capture =>
	pendingPadaria({
		id: 'cap-pix',
		fingerprint: 'fp-pix',
		packageName: 'br.com.intermedium',
		appLabel: 'Inter',
		title: 'Pix recebido',
		text: 'Fulano Exemplo enviou R$ 291,65.',
		amountCents: 29_165,
		direction: 'out',
		kind: 'pix_out',
		counterparty: 'Fulano Exemplo',
		merchantKey: 'fulano exemplo',
		cardLast4: null,
		suggestedCategory: 'outros',
		reason: 'ambiguous_pix_direction',
		accountId: 'nova',
		...overrides,
	});

/** A preferência das respostas, em memória. */
const memoryStore = (data: CaptureChoices = {}) => {
	const store = {
		data,
		read: jest.fn(async (): Promise<CaptureChoices> => store.data),
		write: jest.fn(async (next: CaptureChoices) => {
			store.data = next;
		}),
	};
	return store;
};

const PIX_KEY = choiceKeyOf(pendingPix(), 'pix_direction');
const PIX_OUT_OFX = checkingOfx(row('pix-1', '2026-11-01', '-291.65', 'PIX ENVIADO FULANO EXEMPLO'));

describe('aviso "entrou ou saiu?" que o extrato casou (SPD-164)', () => {
	beforeEach(() => {
		withAccounts([]);
		mocked.getTransactionsByDateRange.mockResolvedValue([]);
		more.getMerchantRule.mockImplementation(async (key: string) => ({ merchantKey: key }));
	});
	afterEach(() => {
		more.getRecentCaptures.mockResolvedValue([]);
		more.getCapture.mockImplementation(async () => null);
		more.getMerchantRule.mockImplementation(async () => null);
		more.toMerchantRule.mockImplementation(() => undefined);
	});

	const outcome = () => more.logCaptureDecision.mock.calls[0][0].outcome;

	it('sem resposta e o extrato só com a saída: o extrato responde "saiu", grava a regra como a revisão e confirma', async () => {
		withPending(pendingPix());
		learned('outros');
		const store = memoryStore();

		const result = await importOfxContent(PIX_OUT_OFX, { ...options, choiceStore: store });

		// Antes: ficava pendente, marcada pelo motivo, e a pergunta continuava.
		expect(store.data).toEqual({ [PIX_KEY]: 'out' });
		expect(more.confirmCapture).toHaveBeenCalledWith('cap-pix', 'outros', options.categories, undefined, store);
		expect(result.settledCaptures).toEqual([{ captureId: 'cap-pix', outcome: 'confirmed' }]);
		expect(outcome()).toMatchObject({ confirmed: true, why: 'rule', direction: 'statement' });
	});

	it('o extrato responde, mas a categoria é só palpite: pendente, marcado, já sem a pergunta', async () => {
		withPending(pendingPix());
		const store = memoryStore();

		const result = await importOfxContent(PIX_OUT_OFX, { ...options, choiceStore: store });

		expect(store.data).toEqual({ [PIX_KEY]: 'out' });
		expect(more.confirmCapture).not.toHaveBeenCalled();
		expect(result.settledCaptures).toEqual([{ captureId: 'cap-pix', outcome: 'marked' }]);
		expect(outcome()).toMatchObject({ why: 'suggested', direction: 'statement' });
	});

	it('o extrato se contradiz (uma entrada do mesmo valor na janela): não responde, fica pendente e marcado', async () => {
		withPending(pendingPix());
		learned('outros');
		const store = memoryStore();
		const both = checkingOfx(
			[
				row('pix-1', '2026-11-01', '-291.65', 'PIX ENVIADO FULANO EXEMPLO'),
				row('pix-2', '2026-11-02', '291.65', 'PIX RECEBIDO FULANO EXEMPLO'),
			].join('\n')
		);

		const result = await importOfxContent(both, { ...options, choiceStore: store });

		expect(store.write).not.toHaveBeenCalled();
		expect(more.confirmCapture).not.toHaveBeenCalled();
		expect(result.settledCaptures).toEqual([{ captureId: 'cap-pix', outcome: 'marked' }]);
		expect(outcome()).toMatchObject({ why: 'reason', direction: 'guess' });
	});

	it('já respondida na revisão: confirma como os outros, sem gravar de novo', async () => {
		withPending(pendingPix({ direction: 'in', kind: 'pix_in', suggestedCategory: 'renda' }));
		learned('renda');
		const store = memoryStore({ [PIX_KEY]: 'in' });

		const result = await importOfxContent(
			checkingOfx(row('pix-1', '2026-11-01', '291.65', 'PIX RECEBIDO FULANO EXEMPLO')),
			{ ...options, choiceStore: store }
		);

		// Antes: o motivo "entrou ou saiu?" segurava mesmo respondido.
		expect(store.write).not.toHaveBeenCalled();
		expect(more.confirmCapture).toHaveBeenCalledWith('cap-pix', 'renda', options.categories, undefined, store);
		expect(result.settledCaptures).toEqual([{ captureId: 'cap-pix', outcome: 'confirmed' }]);
		expect(outcome()).toMatchObject({ confirmed: true, direction: 'answered' });
	});

	it('sem o lugar das respostas: continua o palpite, pendente e marcado', async () => {
		withPending(pendingPix());
		learned('outros');

		const result = await importOfxContent(PIX_OUT_OFX, options);

		expect(more.confirmCapture).not.toHaveBeenCalled();
		expect(result.settledCaptures).toEqual([{ captureId: 'cap-pix', outcome: 'marked' }]);
		expect(outcome()).toMatchObject({ why: 'reason', direction: 'guess' });
	});
});

/** O cartão que fecha dia 3: a compra do dia 5 é da fatura do mês seguinte. */
const nubankFecha3 = card({
	id: 'nubank-teste',
	name: 'Nubank Teste',
	bankName: 'Nubank',
	last4: '1111',
	closingDay: 3,
	closingDaysBefore: 7,
	openingBalanceDate: '2026-10-20',
});

const parcel = (id: string, index: number, date: string): Transaction =>
	({
		...manual(id, 5_000, date, `PADARIA (${index}/10)`, 'nubank-teste'),
		installmentGroup: 'plano',
		installmentIndex: index,
		installmentCount: 10,
	}) as Transaction;

const PARCELA_OFX = cardOfx(row('parc-3', '2026-11-05', '-50.00', 'PADARIA 3/10'));

describe('parcela "k/N" do extrato sem plano no app (SPD-117, AUTO-15)', () => {
	beforeEach(() => {
		withAccounts([nubankFecha3]);
		mocked.getTransactionsByDateRange.mockResolvedValue([]);
		more.getAccountTransactions.mockResolvedValue([]);
	});

	it('"PADARIA 3/10 R$ 50,00" sem plano: o resultado oferece as 7 parcelas que faltam, 4 a 10, uma por fatura', async () => {
		const result = await importOfxContent(PARCELA_OFX, options);

		expect(result.installmentOffers).toHaveLength(1);
		const [offer] = result.installmentOffers;
		expect(offer).toMatchObject({
			accountId: 'nubank-teste',
			accountName: 'Nubank Teste',
			description: 'PADARIA',
			parcelCents: 5_000,
			index: 3,
			count: 10,
		});
		expect(offer.parcels).toEqual([
			{ index: 4, date: '2026-12-05' },
			{ index: 5, date: '2027-01-05' },
			{ index: 6, date: '2027-02-05' },
			{ index: 7, date: '2027-03-05' },
			{ index: 8, date: '2027-04-05' },
			{ index: 9, date: '2027-05-05' },
			{ index: 10, date: '2027-06-05' },
		]);
		// Nunca sozinho: o import não lança parcela nenhuma.
		expect(more.addTransaction).not.toHaveBeenCalled();
	});

	it('aceitar cria as parcelas 4 a 10 no cartão, nas datas da oferta, num plano só', async () => {
		const { installmentOffers } = await importOfxContent(PARCELA_OFX, options);

		const created = await createStatementInstallments(installmentOffers[0]);

		expect(created).toBe(7);
		const drafts = more.addTransaction.mock.calls.map(([draft]) => draft);
		expect(drafts.map((draft) => [draft.installmentIndex, draft.date])).toEqual([
			[4, '2026-12-05'],
			[5, '2027-01-05'],
			[6, '2027-02-05'],
			[7, '2027-03-05'],
			[8, '2027-04-05'],
			[9, '2027-05-05'],
			[10, '2027-06-05'],
		]);
		expect(new Set(drafts.map((draft) => draft.installmentGroup)).size).toBe(1);
		expect(drafts[0]).toMatchObject({
			amountCents: 5_000,
			isIncome: false,
			accountId: 'nubank-teste',
			installmentCount: 10,
			note: 'PADARIA (4/10)',
		});
		expect(drafts.reduce((sum, draft) => sum + draft.amountCents, 0)).toBe(35_000);
	});

	it('parcela que já tem plano no app: a linha casa com a parcela 3/10 e não há oferta', async () => {
		mocked.getTransactionsByDateRange.mockResolvedValue([parcel('p3', 3, '2026-11-05')]);

		const result = await importOfxContent(PARCELA_OFX, options);

		expect(result.summary.matchedTransactions).toBe(1);
		expect(result.installmentOffers).toEqual([]);
	});

	it('as seguintes já lançadas ("Parcela antiga" de 4 a 10): sem oferta', async () => {
		const dates = ['2026-12-04', '2027-01-04', '2027-02-04', '2027-03-04', '2027-04-04', '2027-05-04', '2027-06-04'];
		more.getAccountTransactions.mockResolvedValue(dates.map((date, offset) => parcel(`p${offset + 4}`, offset + 4, date)));

		const result = await importOfxContent(PARCELA_OFX, options);

		expect(result.installmentOffers).toEqual([]);
	});

	it('última parcela (10/10) e compra à vista: nada a oferecer', async () => {
		const result = await importOfxContent(
			cardOfx(
				[row('parc-10', '2026-11-05', '-50.00', 'PADARIA 10/10'), row('vista', '2026-11-06', '-80.00', 'MERCADO')].join('')
			),
			options
		);

		expect(result.installmentOffers).toEqual([]);
	});
});
