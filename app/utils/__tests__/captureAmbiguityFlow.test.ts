/**
 * O ciclo do aviso ambíguo (SPD-123): revisão → a escolha vira regra → o próximo aviso igual
 * entra sozinho → a conta da regra some e o aviso volta para a revisão. E corrigir o que a
 * regra fez atualiza a regra.
 *
 * Mesmo dublê de `captureActions.test.ts`: o banco de dados é um punhado de Maps. Os textos
 * de aviso são inventados, no formato plausível de cada banco.
 */

import type { Account, Capture, MerchantRule, Transfer } from '../../database/schema';

interface TransactionRow {
	id: string;
	amountCents: number;
	category: string;
	date: string;
	note: string;
	isIncome: boolean;
	accountId: string | null;
	installmentGroup?: string;
	deleted?: boolean;
}

const mockAccounts = new Map<string, Account>();
const mockTransfers = new Map<string, Transfer>();
const mockTransactions = new Map<string, TransactionRow>();
const mockCaptures = new Map<string, Capture>();
const mockRules = new Map<string, MerchantRule>();
const mockCounter = { value: 0 };
const mockMakeId = (prefix: string): string => {
	mockCounter.value += 1;
	return `${prefix}-${mockCounter.value}`;
};

jest.mock('../../sync/queue', () => ({ schedule: jest.fn() }));
jest.mock('../notificationUtils', () => ({ scheduleBillReminders: jest.fn(async () => 0) }));
jest.mock('../../diagnostics/log', () => ({ log: jest.fn() }));

jest.mock('../../database/database', () => ({
	addTransaction: jest.fn(async (row: Omit<TransactionRow, 'id'>) => {
		const id = mockMakeId('tx');
		mockTransactions.set(id, { ...row, id });
		return id;
	}),
	deleteTransaction: jest.fn(async (id: string) => {
		const row = mockTransactions.get(id);
		if (row) mockTransactions.set(id, { ...row, deleted: true });
	}),
	deleteTransactionsInGroup: jest.fn(async () => undefined),
	addTransfer: jest.fn(async (row: Omit<Transfer, 'id' | 'updatedAt'>) => {
		const id = mockMakeId('tr');
		mockTransfers.set(id, { ...row, id, updatedAt: '' } as Transfer);
		return id;
	}),
	updateTransfer: jest.fn(async (transfer: Transfer) => {
		mockTransfers.set(transfer.id, { ...transfer });
	}),
	getTransfer: jest.fn(async (id: string) => mockTransfers.get(id) ?? null),
	deleteTransfer: jest.fn(async (id: string) => {
		const found = mockTransfers.get(id);
		if (found) mockTransfers.set(id, { ...found, deletedAt: '2026-11-06T00:00:00.000Z' });
	}),
	findLiveTransfer: jest.fn(async () => null),
	getAccount: jest.fn(async (id: string) => mockAccounts.get(id) ?? null),
	getAccounts: jest.fn(async () => [...mockAccounts.values()]),
	getAccountTransactions: jest.fn(async () => []),
	getAccountTransfers: jest.fn(async () => []),
	addAccount: jest.fn(async () => mockMakeId('acc')),
	updateAccount: jest.fn(async (updated: Account) => {
		mockAccounts.set(updated.id, { ...updated });
	}),
	// O SQL de verdade: a conta viva, sem arquivar, ligada ao app (e ao final, no cartão).
	findAccountBySource: jest.fn(async (packageName: string, last4: string | null) => {
		const found = [...mockAccounts.values()].find(
			(account) =>
				account.packageName === packageName &&
				!account.archived &&
				!account.deletedAt &&
				(last4 ? account.last4 === last4 : account.last4 === null && account.kind !== 'credit_card')
		);
		return found ?? null;
	}),
	findAccountByKey: jest.fn(async () => null),
	reassignCaptureLedger: jest.fn(async () => undefined),
	getBills: jest.fn(async () => []),
	getBillPayments: jest.fn(async () => []),
	saveBillPayments: jest.fn(async () => undefined),
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
		if (!found) return;
		const defined = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
		mockCaptures.set(id, { ...found, ...defined });
	}),
	getCapture: jest.fn(async (id: string) => mockCaptures.get(id) ?? null),
	// Cada aviso de teste é de um dia diferente: nada vira duplicata de nada.
	getRecentCaptures: jest.fn(async () => []),
	getPendingCaptures: jest.fn(async () => [...mockCaptures.values()].filter((capture) => capture.status === 'pending')),
	hasCaptureFingerprint: jest.fn(async () => false),
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
import {
	answerCaptureDirection,
	answerCaptureTransfer,
	confirmCapture,
	ingestRawCaptures,
	markCaptureTransfer,
	resolveInvoicePaymentCapture,
	revertCapture,
} from '../captureActions';
import type { CaptureChoiceStore, CaptureChoices } from '../captureChoices';
import type { RawCapture } from '../captureParser';

const NUBANK = 'com.nu.production';
const INTER = 'br.com.intermedium';
const PICPAY = 'com.picpay';

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

const interPF = account({ id: 'inter-pf', name: 'Inter', bankName: 'Inter', packageName: INTER });
const interCard = account({ id: 'inter-cc', name: 'Cartão Inter', kind: 'credit_card', role: 'card', bankName: 'Inter', packageName: INTER, last4: '5678', closingDay: 25 });
const interEnvelope = account({ id: 'inter-env', name: 'Inter Envelope', role: 'envelope', bankName: 'Inter' });
const interCard2 =account({ id: 'inter-cc2', name: 'Cartão Inter PJ', kind: 'credit_card', role: 'card', bankName: 'Inter', packageName: INTER, last4: '1111', closingDay: 5 });
const nuPF = account({ id: 'nu-pf', name: 'Nubank', bankName: 'Nubank', packageName: NUBANK });
const nuCard = account({ id: 'nu-cc', name: 'Cartão Nubank', kind: 'credit_card', role: 'card', bankName: 'Nubank', packageName: NUBANK, last4: '1534', closingDay: 25 });
const picpay = account({ id: 'picpay', name: 'PicPay', bankName: 'PicPay', packageName: PICPAY });

const CATEGORIES = [
	{ id: 'food', name: 'Alimentação', type: 'expense' },
	{ id: 'other_expense', name: 'Outros', type: 'expense' },
	{ id: 'other_income', name: 'Outras receitas', type: 'income' },
	{ id: 'refund', name: 'Estorno', type: 'income' },
	{ id: 'transport', name: 'Transporte', type: 'expense' },
	{ id: 'health', name: 'Saúde', type: 'expense' },
] as never[];

/** A preferência em memória: o que o `CapturesContext` lê a cada lote e grava a cada escolha. */
const memoryStore = (): CaptureChoiceStore & { data: CaptureChoices } => {
	const store = {
		data: {} as CaptureChoices,
		read: async () => store.data,
		write: async (next: CaptureChoices) => {
			store.data = next;
		},
	};
	return store;
};

let day = 0;
/** Um aviso por dia: nunca duplicata do anterior. */
const notice = (packageName: string, appLabel: string, title: string, text: string): RawCapture => {
	day += 1;
	return { packageName, appLabel, title, text, postedAt: `2026-11-${String(day).padStart(2, '0')}T15:00:00.000Z` };
};

/** Ingere um aviso com as regras de agora e devolve o item que ele virou. */
const ingest = async (raw: RawCapture, store: { data: CaptureChoices }): Promise<Capture> => {
	const before = new Set(mockCaptures.keys());
	await ingestRawCaptures([raw], { ownNames: [], categories: CATEGORIES, captureChoices: store.data });
	const created = [...mockCaptures.values()].filter((capture) => !before.has(capture.id));
	expect(created).toHaveLength(1);
	return created[0];
};

const decisionLogs = (): Record<string, unknown>[] =>
	(log as jest.Mock).mock.calls.filter(([, event]) => event === 'capture_decision').map(([, , payload]) => payload.data);

const liveTransfers = (): Transfer[] => [...mockTransfers.values()].filter((transfer) => !transfer.deletedAt);
const liveTransactions = (): TransactionRow[] => [...mockTransactions.values()].filter((row) => !row.deleted);

beforeEach(() => {
	mockAccounts.clear();
	mockTransfers.clear();
	mockTransactions.clear();
	mockCaptures.clear();
	mockRules.clear();
	jest.clearAllMocks();
	day = 0;
});

const seed = (...accounts: Account[]) => {
	for (const item of accounts) mockAccounts.set(item.id, item);
};

const interDebit = (final: string, store: string) =>
	notice(INTER, 'Inter', 'Compra aprovada', `Compra aprovada no cartão final ${final}: R$ 50,00 em ${store}`);

describe('NOTIF-16: débito do Inter com final desconhecido', () => {
	it('revisão → regra → o próximo igual entra sozinho → conta apagada, volta para a revisão', async () => {
		// Duas contas do Inter (a de todo dia e a do envelope): apagar uma deixa o caso ambíguo.
		seed(interPF, interEnvelope, interCard);
		const store = memoryStore();

		// 1. Antes ia para a fatura do cartão. Agora fica sem conta, com o motivo do caso.
		const first = await ingest(interDebit('0443', 'PADARIA EXEMPLO'), store);
		expect(first).toMatchObject({ status: 'pending', accountId: null, reason: 'ambiguous_debit_unknown_last4' });
		expect(decisionLogs().at(-1)).toMatchObject({ ambiguity: 'debit_unknown_last4', choice: 'asked' });

		// 2. O usuário escolhe a conta corrente e confirma: vira regra.
		await confirmCapture(first.id, 'food', CATEGORIES, 'inter-pf', store);
		expect(mockCaptures.get(first.id)).toMatchObject({ status: 'confirmed', accountId: 'inter-pf' });
		expect(Object.values(store.data)).toEqual(['inter-pf']);
		const [key] = Object.keys(store.data);
		expect(key).not.toMatch(/padaria|exemplo|50/);

		// 3. O mesmo final, outra loja: a regra decide, e o item diz que foi ela.
		const second = await ingest(interDebit('0443', 'MERCADO EXEMPLO'), store);
		expect(second).toMatchObject({ status: 'pending', accountId: 'inter-pf', reason: 'learned_debit_unknown_last4' });
		expect(decisionLogs().at(-1)).toMatchObject({ ambiguity: 'debit_unknown_last4', choice: 'learned' });

		// Com a loja já aprendida (3 confirmações), entra sozinho no livro — na conta da regra.
		mockRules.set('padaria exemplo', { merchantKey: 'padaria exemplo', categoryId: 'food', treatAs: 'transaction', confirmations: 3, updatedAt: '' });
		const third = await ingest(interDebit('0443', 'PADARIA EXEMPLO'), store);
		expect(third).toMatchObject({ status: 'confirmed', autoConfirmed: true, accountId: 'inter-pf', reason: 'learned_debit_unknown_last4' });
		expect(liveTransactions().at(-1)?.accountId).toBe('inter-pf');

		// 4. A conta da regra foi apagada (ou juntada): a regra não vale, o aviso volta à revisão.
		mockAccounts.set('inter-pf', { ...interPF, deletedAt: '2026-11-10T00:00:00.000Z' });
		const fourth = await ingest(interDebit('0443', 'PADARIA EXEMPLO'), store);
		expect(fourth).toMatchObject({ status: 'pending', accountId: null, reason: 'ambiguous_debit_unknown_last4' });
		expect(fourth.transactionId).toBeNull();
		expect(decisionLogs().at(-1)).toMatchObject({ ambiguity: 'debit_unknown_last4', choice: 'asked', staleChoice: true });
	});

	it('corrigir o que a regra fez: reverter devolve a pergunta, e a nova escolha atualiza a regra', async () => {
		seed(interPF, interCard);
		const store = memoryStore();
		const first = await ingest(interDebit('0443', 'PADARIA EXEMPLO'), store);
		await confirmCapture(first.id, 'food', CATEGORIES, 'inter-pf', store);

		mockRules.set('padaria exemplo', { merchantKey: 'padaria exemplo', categoryId: 'food', treatAs: 'transaction', confirmations: 3, updatedAt: '' });
		const wrong = await ingest(interDebit('0443', 'PADARIA EXEMPLO'), store);
		expect(wrong.status).toBe('confirmed');

		await revertCapture(wrong.id);
		expect(mockCaptures.get(wrong.id)).toMatchObject({ status: 'pending', reason: 'ambiguous_debit_unknown_last4', transactionId: null });

		// Era do cartão: confirmar lá troca a regra.
		await confirmCapture(wrong.id, 'food', CATEGORIES, 'inter-cc', store);
		expect(Object.values(store.data)).toEqual(['inter-cc']);
		const next = await ingest(interDebit('0443', 'PADARIA EXEMPLO'), store);
		expect(next).toMatchObject({ accountId: 'inter-cc', reason: 'learned_debit_unknown_last4' });
	});

	it('confirmar sem escolher conta ("Sem conta") não ensina nada', async () => {
		seed(interPF, interCard);
		const store = memoryStore();
		const first = await ingest(interDebit('0443', 'PADARIA EXEMPLO'), store);
		await confirmCapture(first.id, 'food', CATEGORIES, undefined, store);
		expect(store.data).toEqual({});
	});
});

describe('NOTIF-06 e NOTIF-15: qual cartão', () => {
	it('"no crédito" sem final com dois cartões: pergunta uma vez, depois vai para o cartão escolhido', async () => {
		seed(interPF, interCard, interCard2);
		const store = memoryStore();
		const credit = () => notice(INTER, 'Inter', 'Inter', 'Olá, você acaba de comprar no crédito em POSTO EXEMPLO o valor de R$ 200,00.');

		const first = await ingest(credit(), store);
		expect(first).toMatchObject({ status: 'pending', accountId: null, reason: 'ambiguous_credit_no_last4' });
		await confirmCapture(first.id, 'transport', CATEGORIES, 'inter-cc2', store);

		expect(await ingest(credit(), store)).toMatchObject({ accountId: 'inter-cc2', reason: 'learned_credit_no_last4' });
	});

	it('"no crédito" sem final com um cartão só: direto nele, sem pergunta (antes: conta corrente)', async () => {
		seed(interPF, interCard);
		const store = memoryStore();
		const only = await ingest(notice(INTER, 'Inter', 'Inter', 'Olá, você acaba de comprar no crédito em POSTO EXEMPLO o valor de R$ 200,00.'), store);
		expect(only).toMatchObject({ accountId: 'inter-cc', reason: null });
	});

	it('dois cartões, "Compra aprovada" sem "crédito" e final novo: revisão em vez da conta corrente', async () => {
		const nuPJ = account({ ...nuCard, id: 'nu-cc-pj', name: 'Cartão PJ', last4: '9999' });
		seed(nuPF, nuCard, nuPJ);
		const store = memoryStore();
		const raw = () => notice(NUBANK, 'Nubank', 'Compra aprovada', 'Compra de R$ 480,00 APROVADA em LOJA EXEMPLO para o cartão com final 6422.');

		const first = await ingest(raw(), store);
		expect(first).toMatchObject({ status: 'pending', accountId: null, reason: 'ambiguous_purchase_no_kind' });
		await confirmCapture(first.id, 'other_expense', CATEGORIES, 'nu-cc-pj', store);
		expect(await ingest(raw(), store)).toMatchObject({ accountId: 'nu-cc-pj', reason: 'learned_purchase_no_kind' });
	});
});

describe('NOTIF-11: entrou ou saiu', () => {
	it('pergunta a direção, aprende, e o próximo "enviou" igual entra como entrada', async () => {
		seed(picpay);
		const store = memoryStore();
		// "recebido" e "enviou" sem dizer para quem: a dúvida de verdade. O "te enviou" é entrada
		// sem dúvida desde o SPD-162.
		const sent = (who: string, amount: string) => notice(PICPAY, 'PicPay', 'Pix recebido', `${who} enviou R$ ${amount}.`);

		// Antes: saída, pendente e sem pergunta nenhuma.
		const first = await ingest(sent('Ana Exemplo', '20,00'), store);
		expect(first).toMatchObject({ status: 'pending', direction: 'out', accountId: 'picpay', reason: 'ambiguous_pix_direction' });

		await answerCaptureDirection(first.id, 'in', store);
		expect(mockCaptures.get(first.id)).toMatchObject({ direction: 'in', kind: 'pix_in', suggestedCategory: 'other_income', status: 'pending' });
		expect(Object.values(store.data)).toEqual(['in']);
		expect(Object.keys(store.data)[0]).not.toMatch(/ana|exemplo|20/);

		const second = await ingest(sent('Bruno Exemplo', '35,00'), store);
		expect(second).toMatchObject({ direction: 'in', kind: 'pix_in', reason: 'learned_pix_direction' });

		// Confirmar sem responder não grava nada (SPD-162): a saída da tela era só o palpite.
		// Antes: virava despesa e ensinava "saiu" como regra.
		const other = memoryStore();
		const third = await ingest(sent('Carla Exemplo', '10,00'), other);
		expect(await confirmCapture(third.id, 'other_expense', CATEGORIES, undefined, other)).toBeNull();
		expect(other.data).toEqual({});
		expect(liveTransactions()).toHaveLength(0);
		expect(mockCaptures.get(third.id)).toMatchObject({ status: 'pending', direction: 'out' });

		// Respondida, a confirmação passa, e a resposta (não o palpite) é a regra.
		await answerCaptureDirection(third.id, 'out', other);
		expect(await confirmCapture(third.id, 'other_expense', CATEGORIES, undefined, other)).not.toBeNull();
		expect(Object.values(other.data)).toEqual(['out']);
		expect(liveTransactions().at(-1)).toMatchObject({ isIncome: false });
	});
});

describe('SPD-162: a revisão não grava a direção chutada', () => {
	const fromInter = () =>
		notice(
			INTER,
			'Inter',
			'Pix recebido',
			'Fulano Exemplo te enviou um Pix de R$ 291,65 creditado na sua conta final ***0000-0.'
		);
	// "recebido" e "enviou" sem dizer para quem: continua em dúvida.
	const doubtful = () => notice(INTER, 'Inter', 'Pix recebido', 'Fulano Exemplo enviou R$ 291,65.');

	it('o aviso do Inter de 12/11 (inventado): entrada, e "minhas contas" põe a conta do aviso como destino', async () => {
		seed(interPF, nuPF);
		const store = memoryStore();

		const item = await ingest(fromInter(), store);
		// Antes: saída com a dúvida "recebido/enviou", e a transferência saía do Inter.
		expect(item).toMatchObject({ status: 'pending', direction: 'in', kind: 'pix_in', accountId: 'inter-pf', amountCents: 29_165 });
		expect(item.reason).not.toBe('ambiguous_pix_direction');

		await markCaptureTransfer(item.id, store);
		expect(mockCaptures.get(item.id)).toMatchObject({ status: 'transfer', reason: 'manual' });
		expect(liveTransfers()).toEqual([
			expect.objectContaining({ fromAccountId: null, toAccountId: 'inter-pf', amountCents: 29_165 }),
		]);
	});

	it('sem resposta, "minhas contas" não grava; respondido "entrou", a conta do aviso é o destino', async () => {
		seed(interPF, nuPF);
		const store = memoryStore();
		const item = await ingest(doubtful(), store);
		expect(item).toMatchObject({ status: 'pending', direction: 'out', reason: 'ambiguous_pix_direction' });

		// Antes: transferência DO Inter para nada, com o palpite "saiu".
		await markCaptureTransfer(item.id, store);
		await answerCaptureTransfer(item.id, true, store);
		expect(mockCaptures.get(item.id)).toMatchObject({ status: 'pending', transferId: null });
		expect(liveTransfers()).toHaveLength(0);

		await answerCaptureDirection(item.id, 'in', store);
		await markCaptureTransfer(item.id, store);
		expect(mockCaptures.get(item.id)).toMatchObject({ status: 'transfer' });
		expect(liveTransfers()).toEqual([
			expect.objectContaining({ fromAccountId: null, toAccountId: 'inter-pf', amountCents: 29_165 }),
		]);
	});

	it('respondido "saiu", a conta do aviso é a origem', async () => {
		seed(interPF, nuPF);
		const store = memoryStore();
		const item = await ingest(doubtful(), store);

		await answerCaptureDirection(item.id, 'out', store);
		await markCaptureTransfer(item.id, store);
		expect(liveTransfers()).toEqual([
			expect.objectContaining({ fromAccountId: 'inter-pf', toAccountId: null, amountCents: 29_165 }),
		]);
	});

	it('sem a preferência das respostas, a dúvida conta como não respondida', async () => {
		seed(interPF);
		const item = await ingest(doubtful(), memoryStore());
		expect(await confirmCapture(item.id, 'other_income', CATEGORIES)).toBeNull();
		await markCaptureTransfer(item.id);
		expect(liveTransactions()).toHaveLength(0);
		expect(liveTransfers()).toHaveLength(0);
	});

	it('o item que a regra aprendida decidiu não é palpite: confirma direto', async () => {
		seed(interPF);
		const store = memoryStore();
		const first = await ingest(doubtful(), store);
		await answerCaptureDirection(first.id, 'in', store);

		const second = await ingest(doubtful(), store);
		expect(second).toMatchObject({ direction: 'in', reason: 'learned_pix_direction' });
		if (second.status === 'pending') {
			expect(await confirmCapture(second.id, 'other_income', CATEGORIES, undefined, store)).not.toBeNull();
		}
	});
});

describe('X-2: o pagamento da fatura recebido pelo cartão', () => {
	const received = () =>
		notice(NUBANK, 'Nubank', 'Pagamento recebido', 'Recebemos o pagamento da sua fatura no valor de R$ 1.500,00.');

	it('pergunta de qual conta saiu; a escolha vira regra; conta apagada, pergunta de novo', async () => {
		seed(nuPF, nuCard, interPF);
		const store = memoryStore();

		// Antes: transferência da conta Nubank para o cartão, sozinha, mesmo pago pelo Inter.
		const first = await ingest(received(), store);
		expect(first).toMatchObject({ status: 'pending', accountId: null, reason: 'ambiguous_invoice_payment', transferId: null });
		expect(liveTransfers()).toHaveLength(0);

		await resolveInvoicePaymentCapture(first.id, 'inter-pf', store);
		expect(mockCaptures.get(first.id)).toMatchObject({ status: 'ignored', accountId: 'inter-pf', reason: 'ambiguous_invoice_payment' });
		expect(liveTransfers()).toEqual([expect.objectContaining({ fromAccountId: 'inter-pf', toAccountId: 'nu-cc', amountCents: 150_000 })]);
		expect(Object.values(store.data)).toEqual(['inter-pf']);

		const second = await ingest(received(), store);
		expect(second).toMatchObject({ status: 'ignored', accountId: 'inter-pf', reason: 'learned_invoice_payment' });
		expect(liveTransfers()).toHaveLength(2);
		expect(liveTransfers()[1]).toMatchObject({ fromAccountId: 'inter-pf', toAccountId: 'nu-cc' });

		// Reverter o que a regra fez: a transferência sai, e o item volta à pergunta.
		await revertCapture(second.id);
		expect(mockCaptures.get(second.id)).toMatchObject({ status: 'pending', accountId: null, reason: 'ambiguous_invoice_payment' });
		expect(liveTransfers()).toHaveLength(1);

		mockAccounts.set('inter-pf', { ...interPF, archived: true });
		const third = await ingest(received(), store);
		expect(third).toMatchObject({ status: 'pending', accountId: null, reason: 'ambiguous_invoice_payment' });
	});

	it('"não lançar" também é uma escolha: o próximo fica guardado sem mexer em saldo', async () => {
		seed(nuPF, nuCard, interPF);
		const store = memoryStore();
		const first = await ingest(received(), store);
		await resolveInvoicePaymentCapture(first.id, null, store);
		expect(mockCaptures.get(first.id)).toMatchObject({ status: 'ignored', transferId: null });
		expect(Object.values(store.data)).toEqual(['skip']);

		const second = await ingest(received(), store);
		expect(second).toMatchObject({ status: 'ignored', reason: 'learned_invoice_payment', transferId: null });
		expect(liveTransfers()).toHaveLength(0);
	});

	it('o aviso da conta que pagou continua automático', async () => {
		seed(interPF, interCard);
		const store = memoryStore();
		const paid = await ingest(notice(INTER, 'Inter', 'Pagamento de fatura', 'Você pagou R$ 1.500,00 da fatura do cartão.'), store);
		expect(paid).toMatchObject({ status: 'ignored', reason: 'invoice_payment' });
		expect(liveTransfers()).toEqual([expect.objectContaining({ fromAccountId: 'inter-pf', toAccountId: 'inter-cc' })]);
	});
});

describe('AUTO-07: fatura fechada não vira item nem gasto', () => {
	it('descartado como "não é dinheiro"', async () => {
		seed(nuPF, nuCard);
		const summary = await ingestRawCaptures(
			[notice(NUBANK, 'Nubank', 'Fatura fechada', 'A fatura do seu cartão fechou em R$ 1.234,56 e vence em 10/12.')],
			{ ownNames: [], categories: CATEGORIES, captureChoices: {} }
		);
		expect(summary.inserted).toBe(0);
		expect(liveTransactions()).toHaveLength(0);
		expect(decisionLogs().at(-1)).toMatchObject({ outcome: 'discarded', reason: 'not_money' });
	});
});
