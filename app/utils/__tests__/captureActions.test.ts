/**
 * O caminho de escrita das capturas: o que vai para o livro quando o motor decide e
 * quando o usuário responde. Era a parte do app sem teste nenhum, e é onde moram três
 * defeitos de dinheiro: a transferência reaproveitada por engano (1.2 e 7.5), a aplicação
 * que não gerava nada (7.2) e a regra aprendida que o "Desfazer" não removia (7.3).
 *
 * Não há SQLite no jest: `database.ts` e `database/captures.ts` são substituídos por
 * Maps (com o prefixo `mock`, que é o que o jest deixa a fábrica do mock acessar). O que
 * importa é que o dublê de `findLiveTransfer` reproduz o SQL de verdade **com a frouxidão
 * dele** — a consulta devolve qualquer transferência viva daquela conta com aquele valor
 * na janela, inclusive uma que já tem a outra ponta preenchida. Se o dublê fosse estrito,
 * o teste passaria sem exercitar o filtro que foi acrescentado do lado de cá.
 */

import type { Account, Bill, Capture, MerchantRule, Transfer } from '../../database/schema';

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
const mockBills = new Map<string, Bill>();
const mockCounter = { value: 0 };
const mockMakeId = (prefix: string): string => {
	mockCounter.value += 1;
	return `${prefix}-${mockCounter.value}`;
};

jest.mock('../../sync/queue', () => ({ schedule: jest.fn() }));

jest.mock('../notificationUtils', () => ({ scheduleBillReminders: jest.fn(async () => 0) }));

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
	deleteTransactionsInGroup: jest.fn(async (group: string) => {
		for (const [id, row] of mockTransactions) {
			if (row.installmentGroup === group) mockTransactions.set(id, { ...row, deleted: true });
		}
	}),
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
		if (found) mockTransfers.set(id, { ...found, deletedAt: '2026-10-11T00:00:00.000Z' });
	}),
	// O SQL de verdade, frouxidão inclusa: a ponta que o chamador não conhece é ignorada
	// no filtro, e basta a ponta conhecida bater para a linha voltar.
	findLiveTransfer: jest.fn(
		async (match: {
			amountCents: number;
			fromAccountId: string | null;
			toAccountId: string | null;
			dateFrom: string;
			dateTo: string;
		}) => {
			const hits = [...mockTransfers.values()]
				.filter(
					(transfer) =>
						!transfer.deletedAt &&
						transfer.amountCents === match.amountCents &&
						transfer.date >= match.dateFrom &&
						transfer.date <= match.dateTo &&
						(transfer.fromAccountId === null ||
							match.fromAccountId === null ||
							transfer.fromAccountId === match.fromAccountId) &&
						(transfer.toAccountId === null ||
							match.toAccountId === null ||
							transfer.toAccountId === match.toAccountId) &&
						((match.fromAccountId !== null && transfer.fromAccountId === match.fromAccountId) ||
							(match.toAccountId !== null && transfer.toAccountId === match.toAccountId))
				)
				.sort((a, b) => b.date.localeCompare(a.date));
			return hits[0] ?? null;
		}
	),
	getAccount: jest.fn(async (id: string) => mockAccounts.get(id) ?? null),
	getAccounts: jest.fn(async () => [...mockAccounts.values()]),
	addAccount: jest.fn(async () => mockMakeId('acc')),
	updateAccount: jest.fn(async (updated: Account) => {
		mockAccounts.set(updated.id, { ...updated });
	}),
	findAccountBySource: jest.fn(async () => null),
	findAccountByKey: jest.fn(async () => null),
	reassignCaptureLedger: jest.fn(async () => undefined),
	getBills: jest.fn(async () => [...mockBills.values()].filter((bill) => !bill.deletedAt)),
	updateBill: jest.fn(async (id: string, patch: Omit<Bill, 'id' | 'updatedAt' | 'deletedAt'>) => {
		const found = mockBills.get(id);
		if (found) mockBills.set(id, { ...found, ...patch });
	}),
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

import { addAccount, findAccountBySource, getBills, updateBill } from '../../database/database';
import { onBillsChanged } from '../billEvents';
import {
	applyDecision,
	confirmCapture,
	dismissCapture,
	ingestRawCaptures,
	markCaptureTransfer,
	resettleBillPayment,
	revertCapture,
	settleBillPayment,
	stopIgnoringApp,
} from '../captureActions';
import { appRuleKeyOf, candidateFrom } from '../captureMatcher';
import { parseCapture, type RawCapture } from '../captureParser';
import { getISODate } from '../dateUtils';
import { scheduleBillReminders } from '../notificationUtils';

/** O dia civil do aparelho, como `captureActions` o calcula: o teste roda em qualquer fuso. */
const localDay = (postedAt: string): string => getISODate(new Date(postedAt));

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

const CHECKING = account({ id: 'cc', name: 'Nubank', bankName: 'Nubank', packageName: 'com.nu.production' });
const CARD = account({
	id: 'card',
	name: 'Cartão Nubank',
	kind: 'credit_card',
	role: 'card',
	bankName: 'Nubank',
	packageName: 'com.nu.production',
	closingDay: 25,
});
const OTHER_CARD = account({
	id: 'card2',
	name: 'Cartão Nubank PJ',
	kind: 'credit_card',
	role: 'card',
	bankName: 'Nubank',
	packageName: 'com.nu.production',
	closingDay: 10,
});

const draft = (overrides: Partial<Capture>): Omit<Capture, 'id' | 'createdAt' | 'updatedAt'> => ({
	fingerprint: mockMakeId('fp'),
	packageName: 'com.nu.production',
	appLabel: 'Nubank',
	title: 'Aviso',
	text: 'Aviso',
	postedAt: '2026-10-06T12:00:00.000Z',
	amountCents: 20_000,
	direction: 'out',
	kind: 'pix_out',
	counterparty: 'CONTA RESERVA',
	merchantKey: 'conta reserva',
	cardLast4: null,
	status: 'pending',
	question: null,
	relatedId: null,
	suggestedCategory: 'other_expense',
	transactionId: null,
	autoConfirmed: false,
	reason: null,
	accountId: CHECKING.id,
	transferId: null,
	installments: null,
	...overrides,
});

/** Grava uma captura pendente direto no "banco", como a ingestão faria. */
const seedCapture = (overrides: Partial<Capture>): Capture => {
	const id = mockMakeId('cap');
	const capture = { ...draft(overrides), id, createdAt: '', updatedAt: '' } as Capture;
	mockCaptures.set(id, capture);
	return capture;
};

const seedTransfer = (overrides: Partial<Transfer>): Transfer => {
	const id = mockMakeId('tr');
	const transfer = {
		id,
		fromAccountId: CHECKING.id,
		toAccountId: null,
		amountCents: 20_000,
		date: '2026-10-03',
		note: 'aporte',
		updatedAt: '',
		...overrides,
	} as Transfer;
	mockTransfers.set(id, transfer);
	return transfer;
};

const liveTransfers = (): Transfer[] => [...mockTransfers.values()].filter((transfer) => !transfer.deletedAt);

beforeEach(() => {
	mockAccounts.clear();
	mockTransfers.clear();
	mockTransactions.clear();
	mockCaptures.clear();
	mockRules.clear();
	mockBills.clear();
	jest.clearAllMocks();
	for (const item of [CHECKING, CARD, OTHER_CARD]) mockAccounts.set(item.id, item);
});

describe('transferência não engole transferência (achados 1.2 e 7.5)', () => {
	it('dois aportes iguais no mesmo mês continuam sendo dois', async () => {
		seedTransfer({ date: '2026-10-03', amountCents: 20_000 });
		const second = seedCapture({ postedAt: '2026-10-06T12:00:00.000Z', amountCents: 20_000 });

		await markCaptureTransfer(second.id);

		expect(liveTransfers()).toHaveLength(2);
		// O aporte do dia 3 fica intacto: ninguém lhe atribuiu um destino de palpite.
		expect(liveTransfers()[0].toAccountId).toBeNull();
	});

	it('um Pix não é casado com o pagamento da fatura de dois dias antes', async () => {
		const invoice = seedTransfer({
			date: '2026-10-01',
			amountCents: 150_000,
			toAccountId: CARD.id,
			note: 'pagamento da fatura',
		});
		const pix = seedCapture({
			postedAt: '2026-10-03T12:00:00.000Z',
			amountCents: 150_000,
			counterparty: 'JOAO SILVA',
			merchantKey: 'joao silva',
		});

		await markCaptureTransfer(pix.id);

		expect(liveTransfers()).toHaveLength(2);
		expect(mockTransfers.get(invoice.id)).toMatchObject({ toAccountId: CARD.id, fromAccountId: CHECKING.id });

		// E reverter o Pix apaga só o Pix: era isto que apagava o pagamento da fatura.
		const pixTransferId = mockCaptures.get(pix.id)?.transferId as string;
		await revertCapture(pix.id);
		expect(mockTransfers.get(invoice.id)?.deletedAt).toBeUndefined();
		expect(mockTransfers.get(pixTransferId)?.deletedAt).toBeDefined();
	});

	it('no mesmo dia, mesma origem e destino em branco: o aviso do cartão completa a que já existe', async () => {
		seedTransfer({ date: '2026-10-06', amountCents: 150_000, fromAccountId: CHECKING.id, toAccountId: null });

		// Visto pelo cartão: "pagamento recebido". A origem é a única conta corrente do banco.
		await applyDecision(
			draft({
				amountCents: 150_000,
				kind: 'invoice_payment',
				accountId: CARD.id,
				postedAt: '2026-10-06T18:00:00.000Z',
			}),
			{ action: 'neutral', reason: 'invoice_payment' },
			[]
		);

		expect(liveTransfers()).toHaveLength(1);
		expect(liveTransfers()[0]).toMatchObject({ fromAccountId: CHECKING.id, toAccountId: CARD.id });
	});

	it('com dois cartões no banco, o pagamento avisado pelos dois lados não debita a conta duas vezes', async () => {
		// Visto pelo cartão primeiro: destino conhecido (é ele), origem a única corrente.
		await applyDecision(
			draft({ amountCents: 150_000, kind: 'invoice_payment', accountId: CARD.id, postedAt: '2026-10-06T18:00:00.000Z' }),
			{ action: 'neutral', reason: 'invoice_payment' },
			[]
		);
		// Depois pela conta: com dois cartões não se sabe qual fatura foi paga, e o destino
		// ficaria em branco — mas é o mesmo pagamento.
		await applyDecision(
			draft({
				amountCents: 150_000,
				kind: 'invoice_payment',
				accountId: CHECKING.id,
				postedAt: '2026-10-06T19:00:00.000Z',
			}),
			{ action: 'neutral', reason: 'invoice_payment' },
			[]
		);

		expect(liveTransfers()).toHaveLength(1);
		expect(liveTransfers()[0]).toMatchObject({ fromAccountId: CHECKING.id, toAccountId: CARD.id });
	});
});

describe('aplicação e resgate viram transferência (achado 7.2)', () => {
	it('a aplicação sai da conta que avisou, com o destino em branco', async () => {
		const { id } = await applyDecision(
			draft({ amountCents: 500_000, kind: 'investment', direction: 'out', counterparty: null, merchantKey: null }),
			{ action: 'neutral', reason: 'investment' },
			[]
		);

		expect(liveTransfers()).toHaveLength(1);
		expect(liveTransfers()[0]).toMatchObject({
			fromAccountId: CHECKING.id,
			toAccountId: null,
			amountCents: 500_000,
			date: localDay('2026-10-06T12:00:00.000Z'),
		});
		// Continua fora das receitas e despesas: nenhum lançamento foi criado.
		expect(mockTransactions.size).toBe(0);
		expect(mockCaptures.get(id)).toMatchObject({ status: 'ignored', reason: 'investment' });
		expect(mockCaptures.get(id)?.transferId).toBe(liveTransfers()[0].id);
	});

	it('o resgate entra na conta que avisou', async () => {
		await applyDecision(
			draft({ amountCents: 30_000, kind: 'investment', direction: 'in', counterparty: null, merchantKey: null }),
			{ action: 'neutral', reason: 'investment' },
			[]
		);

		expect(liveTransfers()[0]).toMatchObject({ fromAccountId: null, toAccountId: CHECKING.id, amountCents: 30_000 });
	});

	it('sem conta de origem não há o que gravar: fica ignorada e o usuário atribui', async () => {
		const { id } = await applyDecision(
			draft({ amountCents: 500_000, kind: 'investment', accountId: null }),
			{ action: 'neutral', reason: 'investment' },
			[]
		);

		expect(liveTransfers()).toHaveLength(0);
		expect(mockCaptures.get(id)).toMatchObject({ status: 'ignored', transferId: null });
	});

	it('reverter a aplicação apaga a transferência que ela criou', async () => {
		const { id } = await applyDecision(
			draft({ amountCents: 500_000, kind: 'investment' }),
			{ action: 'neutral', reason: 'investment' },
			[]
		);
		await revertCapture(id);

		expect(liveTransfers()).toHaveLength(0);
		expect(mockCaptures.get(id)).toMatchObject({ status: 'pending', transferId: null });
	});
});

describe('"Desfazer" remove a regra que o toque criou (achado 7.3)', () => {
	it('o toque em "Transferência" aprende a contraparte, e desfazer desaprende', async () => {
		const capture = seedCapture({ counterparty: 'CONTA RESERVA', merchantKey: 'conta reserva' });

		await markCaptureTransfer(capture.id);
		expect(mockRules.get('conta reserva')).toMatchObject({ treatAs: 'transfer', confirmations: 1 });

		await revertCapture(capture.id);
		// Sem isto, o estabelecimento desaparecia das despesas para sempre: a regra de
		// transferência não tem limiar de confirmação e nenhuma tela a mostra.
		expect(mockRules.get('conta reserva')).toBeUndefined();
		expect(mockCaptures.get(capture.id)).toMatchObject({ status: 'pending', transferId: null });
	});

	it('uma regra de categoria (que exige três confirmações) não é apagada por engano', async () => {
		mockRules.set('ifood', {
			merchantKey: 'ifood',
			categoryId: 'food',
			treatAs: 'transaction',
			confirmations: 3,
			updatedAt: '',
		});
		const capture = seedCapture({ status: 'confirmed', reason: 'rule', merchantKey: 'ifood', transactionId: 'tx-antigo' });

		await revertCapture(capture.id);

		expect(mockRules.get('ifood')).toMatchObject({ treatAs: 'transaction', confirmations: 3 });
	});

	it('transferência decidida pelo app (o nome é o seu) não aprendeu nada, e desfazer não apaga regra alheia', async () => {
		mockRules.set('conta reserva', {
			merchantKey: 'conta reserva',
			categoryId: null,
			treatAs: 'transfer',
			confirmations: 1,
			updatedAt: '',
		});
		const capture = seedCapture({ status: 'transfer', reason: 'own_name', merchantKey: 'conta reserva' });

		await revertCapture(capture.id);

		expect(mockRules.get('conta reserva')).toMatchObject({ treatAs: 'transfer' });
	});
});

describe('baixa automática da conta a pagar (REM-04)', () => {
	const seedBill = (overrides: Partial<Bill> = {}): Bill => {
		const bill: Bill = {
			id: 'tim',
			name: 'Celular',
			dueDay: 15,
			amountCents: null,
			accountId: CHECKING.id,
			category: null,
			matchHint: 'tim',
			debtId: null,
			paidThrough: '2026-09',
			paidByRef: null,
			active: true,
			sortOrder: 0,
			updatedAt: '',
			...overrides,
		};
		mockBills.set(bill.id, bill);
		return bill;
	};

	/** Pagamento da TIM no dia 14, meio-dia UTC: dia 14 ou 15 no fuso do aparelho, outubro em todos. */
	const timPayment = (overrides: Partial<Capture> = {}): Capture =>
		seedCapture({
			postedAt: '2026-10-14T12:00:00.000Z',
			amountCents: 13_517,
			kind: 'purchase',
			counterparty: 'TIM S.A.',
			merchantKey: 'tim s a',
			...overrides,
		});

	/** Quem assina o aviso de "as contas mudaram", ligado a cada teste. */
	const changed = jest.fn();
	let stopListening: () => void = () => undefined;
	beforeEach(() => {
		stopListening = onBillsChanged(changed);
	});
	afterEach(() => stopListening());

	const categories = [
		{ id: 'other_expense', name: 'Outros', type: 'expense', icon: '', color: '', updatedAt: '' },
		{ id: 'other_income', name: 'Outros', type: 'income', icon: '', color: '', updatedAt: '' },
	] as unknown as Parameters<typeof confirmCapture>[2];

	it('confirmar a captura do pagamento dá baixa no mês, remarca os lembretes e avisa', async () => {
		seedBill();
		const capture = timPayment();

		const result = await confirmCapture(capture.id, 'other_expense', categories);

		expect(result?.transactionId).toBeTruthy();
		expect(mockBills.get('tim')).toMatchObject({ paidThrough: '2026-10', paidByRef: result?.transactionId });
		// Os lembretes são remarcados com as contas já relidas, com outubro pago.
		expect(scheduleBillReminders).toHaveBeenCalledTimes(1);
		expect((scheduleBillReminders as jest.Mock).mock.calls[0][0][0]).toMatchObject({ paidThrough: '2026-10' });
		expect(changed).toHaveBeenCalledTimes(1);
	});

	it('o lançamento confirmado sozinho pela regra também dá baixa', async () => {
		seedBill();
		const base = draft({
			postedAt: '2026-10-14T12:00:00.000Z',
			amountCents: 13_517,
			kind: 'purchase',
			counterparty: 'TIM S.A.',
			merchantKey: 'tim s a',
		});

		await applyDecision(base, { action: 'auto_confirm', categoryId: 'other_expense' }, categories);

		const posted = [...mockTransactions.values()][0];
		expect(mockBills.get('tim')).toMatchObject({ paidThrough: '2026-10', paidByRef: posted.id });
		expect(changed).toHaveBeenCalledTimes(1);
	});

	it('o que não casa não grava nada nem avisa', async () => {
		seedBill();
		const capture = timPayment({ counterparty: 'PADARIA', merchantKey: 'padaria' });

		await confirmCapture(capture.id, 'other_expense', categories);

		expect(updateBill).not.toHaveBeenCalled();
		expect(scheduleBillReminders).not.toHaveBeenCalled();
		expect(changed).not.toHaveBeenCalled();
		expect(mockBills.get('tim')).toMatchObject({ paidThrough: '2026-09', paidByRef: null });
	});

	it('recebimento e compra parcelada não pagam conta', async () => {
		seedBill();
		const income = timPayment({ direction: 'in', kind: 'pix_in' });
		const parcelled = timPayment({ installments: 3 });

		await confirmCapture(income.id, 'other_income', categories);
		await confirmCapture(parcelled.id, 'other_expense', categories);

		expect(updateBill).not.toHaveBeenCalled();
		expect(mockBills.get('tim')?.paidThrough).toBe('2026-09');
	});

	it('falha da baixa não quebra a gravação do lançamento', async () => {
		seedBill();
		(getBills as jest.Mock).mockRejectedValueOnce(new Error('banco ocupado'));
		const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
		const capture = timPayment();

		const result = await confirmCapture(capture.id, 'other_expense', categories);

		expect(result?.status).toBe('confirmed');
		expect(mockCaptures.get(capture.id)?.status).toBe('confirmed');
		expect(mockTransactions.get(result?.transactionId as string)).toBeDefined();
		expect(errors).toHaveBeenCalled();
		errors.mockRestore();
	});

	it('lembrete que não remarca não desfaz a baixa nem cala o aviso', async () => {
		seedBill();
		(scheduleBillReminders as jest.Mock).mockRejectedValueOnce(new Error('sem permissão'));
		const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);

		const match = await settleBillPayment({
			id: 'tx-tim',
			amountCents: 13_517,
			date: '2026-10-14',
			accountId: CHECKING.id,
			text: 'TIM',
			isExpense: true,
		});

		expect(match).toMatchObject({ month: '2026-10' });
		expect(mockBills.get('tim')).toMatchObject({ paidThrough: '2026-10', paidByRef: 'tx-tim' });
		expect(changed).toHaveBeenCalledTimes(1);
		errors.mockRestore();
	});

	it('o mesmo lançamento não dá baixa duas vezes', async () => {
		seedBill({ paidThrough: '2026-09', paidByRef: 'tx-repetido' });

		const match = await settleBillPayment({
			id: 'tx-repetido',
			amountCents: 13_517,
			date: '2026-10-14',
			accountId: CHECKING.id,
			text: 'TIM',
			isExpense: true,
		});

		expect(match).toBeNull();
		expect(updateBill).not.toHaveBeenCalled();
	});

	it('desfazer a captura que deu a baixa desfaz a baixa', async () => {
		seedBill();
		const capture = timPayment();
		await confirmCapture(capture.id, 'other_expense', categories);
		changed.mockClear();
		(scheduleBillReminders as jest.Mock).mockClear();

		await revertCapture(capture.id);

		expect(mockBills.get('tim')).toMatchObject({ paidThrough: '2026-09', paidByRef: null });
		expect(scheduleBillReminders).toHaveBeenCalledTimes(1);
		expect(changed).toHaveBeenCalledTimes(1);
	});

	it('desfazer uma captura que não deu a última baixa não mexe na conta', async () => {
		seedBill({ paidThrough: '2026-10', paidByRef: 'tx-outro' });
		const capture = seedCapture({
			status: 'confirmed',
			postedAt: '2026-10-14T12:00:00.000Z',
			transactionId: 'tx-meu',
			counterparty: 'TIM S.A.',
		});

		await revertCapture(capture.id);

		expect(updateBill).not.toHaveBeenCalled();
		expect(mockBills.get('tim')).toMatchObject({ paidThrough: '2026-10', paidByRef: 'tx-outro' });
		expect(changed).not.toHaveBeenCalled();
	});

	it('a outra perna confirmada que vira transferência também desfaz a baixa que deu', async () => {
		seedBill();
		const confirmed = timPayment();
		await confirmCapture(confirmed.id, 'other_expense', categories);
		expect(mockBills.get('tim')?.paidThrough).toBe('2026-10');
		const other = seedCapture({ postedAt: '2026-10-14T12:05:00.000Z', amountCents: 13_517, relatedId: confirmed.id });

		await markCaptureTransfer(other.id);

		expect(mockBills.get('tim')).toMatchObject({ paidThrough: '2026-09', paidByRef: null });
	});
});

describe('compra em moeda estrangeira vai para revisão (SPD-037)', () => {
	const categories = [
		{ id: 'other_expense', name: 'Outros', type: 'expense', icon: '', color: '', updatedAt: '' },
		{ id: 'other_income', name: 'Outros', type: 'income', icon: '', color: '', updatedAt: '' },
		{ id: 'subscriptions', name: 'Assinaturas', type: 'expense', icon: '', color: '', updatedAt: '' },
	] as unknown as Parameters<typeof confirmCapture>[2];

	const notification = (text: string): RawCapture => ({
		packageName: 'com.nu.production',
		appLabel: 'Nubank',
		title: 'Compra no crédito aprovada',
		text,
		postedAt: '2026-10-14T12:00:00.000Z',
	});

	const ONLY_DOLLAR = notification('Compra de US$ 15,99 APROVADA em NETFLIX.COM para o cartão com final 1534.');
	const WITH_REAIS = notification('Compra de US$ 15,99 (R$ 87,10) APROVADA em NETFLIX.COM para o cartão com final 1534.');

	/** A regra que confirmaria sozinha: o estabelecimento já foi confirmado cinco vezes. */
	const learnNetflix = (raw: RawCapture): void => {
		const parsed = parseCapture(raw);
		const key = parsed ? candidateFrom(raw, parsed, null).merchantKey : null;
		if (!key) throw new Error('o aviso de teste não tem estabelecimento');
		mockRules.set(key, {
			merchantKey: key,
			categoryId: 'subscriptions',
			treatAs: 'transaction',
			confirmations: 5,
			updatedAt: '',
		});
	};

	const ingest = (raw: RawCapture) => ingestRawCaptures([raw], { ownNames: [], categories });

	const only = (): Capture => {
		const all = [...mockCaptures.values()];
		expect(all).toHaveLength(1);
		return all[0];
	};

	it('com regra aprendida, só o valor em dólar não confirma sozinha: fica pendente com o porquê', async () => {
		learnNetflix(ONLY_DOLLAR);

		const summary = await ingest(ONLY_DOLLAR);

		expect(summary).toEqual({ inserted: 1, autoConfirmed: 0 });
		expect(only()).toMatchObject({
			status: 'pending',
			reason: 'foreign_currency',
			// A categoria que a regra sugeriu continua sugerida: só a confirmação é do usuário.
			suggestedCategory: 'subscriptions',
			transactionId: null,
			autoConfirmed: false,
		});
		expect(mockTransactions.size).toBe(0);
	});

	it('sem regra, fica pendente também com o porquê', async () => {
		await ingest(ONLY_DOLLAR);

		expect(only()).toMatchObject({ status: 'pending', reason: 'foreign_currency', transactionId: null });
		expect(mockTransactions.size).toBe(0);
	});

	it('com o valor em reais no aviso, segue o fluxo normal: a regra confirma sozinha, em reais', async () => {
		learnNetflix(WITH_REAIS);

		const summary = await ingest(WITH_REAIS);

		expect(summary).toEqual({ inserted: 1, autoConfirmed: 1 });
		expect(only()).toMatchObject({ status: 'confirmed', reason: 'rule', autoConfirmed: true });
		expect([...mockTransactions.values()][0]).toMatchObject({ amountCents: 8710, category: 'subscriptions' });
	});

	it('com o valor em reais e sem regra, é a pendência de sempre, sem aviso', async () => {
		await ingest(WITH_REAIS);

		expect(only()).toMatchObject({ status: 'pending', reason: null, amountCents: 8710 });
	});
});

describe('editar o lançamento que deu a baixa refaz a baixa (SPD-067)', () => {
	const seedBill = (overrides: Partial<Bill> = {}): Bill => {
		const bill: Bill = {
			id: 'tim',
			name: 'Celular',
			dueDay: 15,
			amountCents: 13_517,
			accountId: CHECKING.id,
			category: null,
			matchHint: 'tim',
			debtId: null,
			paidThrough: '2026-09',
			paidByRef: null,
			active: true,
			sortOrder: 0,
			updatedAt: '',
			...overrides,
		};
		mockBills.set(bill.id, bill);
		return bill;
	};

	/** O lançamento da TIM como estava gravado antes da edição. */
	const TIM = {
		id: 'tx-tim',
		amountCents: 13_517,
		date: '2026-10-14',
		accountId: CHECKING.id,
		text: 'TIM celular',
		isExpense: true,
	};

	const changed = jest.fn();
	let stopListening: () => void = () => undefined;
	beforeEach(() => {
		stopListening = onBillsChanged(changed);
	});
	afterEach(() => stopListening());

	it('o valor editado para longe do da conta desfaz a baixa que ele tinha dado', async () => {
		seedBill({ paidThrough: '2026-10', paidByRef: 'tx-tim' });

		await resettleBillPayment(TIM, { ...TIM, amountCents: 50_000, text: 'Mercado' });

		expect(mockBills.get('tim')).toMatchObject({ paidThrough: '2026-09', paidByRef: null });
		expect(changed).toHaveBeenCalledTimes(1);
	});

	it('a data editada para fora da janela do vencimento desfaz a baixa', async () => {
		seedBill({ paidThrough: '2026-10', paidByRef: 'tx-tim' });

		await resettleBillPayment(TIM, { ...TIM, date: '2026-10-30' });

		expect(mockBills.get('tim')).toMatchObject({ paidThrough: '2026-09', paidByRef: null });
	});

	it('a data editada para o mês seguinte tira a baixa de outubro e dá a de novembro', async () => {
		seedBill({ paidThrough: '2026-10', paidByRef: 'tx-tim' });

		const match = await resettleBillPayment(TIM, { ...TIM, date: '2026-11-13' });

		expect(match).toMatchObject({ month: '2026-11' });
		expect(mockBills.get('tim')).toMatchObject({ paidThrough: '2026-11', paidByRef: 'tx-tim' });
		// Uma remarcação de lembretes e um aviso pela edição inteira, não um por gravação.
		expect(scheduleBillReminders).toHaveBeenCalledTimes(1);
		expect(changed).toHaveBeenCalledTimes(1);
	});

	it('o lançamento que não pagava nada e passou a casar dá a baixa', async () => {
		seedBill();

		const match = await resettleBillPayment(
			{ ...TIM, amountCents: 4_000, text: 'Padaria' },
			{ ...TIM, amountCents: 13_517, text: 'TIM celular' }
		);

		expect(match).toMatchObject({ month: '2026-10' });
		expect(mockBills.get('tim')).toMatchObject({ paidThrough: '2026-10', paidByRef: 'tx-tim' });
	});

	it('a edição que não muda nada do que decide a baixa não mexe na conta', async () => {
		seedBill({ paidThrough: '2026-10', paidByRef: 'tx-tim' });

		const match = await resettleBillPayment(TIM, { ...TIM });

		expect(match).toBeNull();
		expect(updateBill).not.toHaveBeenCalled();
		expect(scheduleBillReminders).not.toHaveBeenCalled();
		expect(changed).not.toHaveBeenCalled();
		expect(mockBills.get('tim')).toMatchObject({ paidThrough: '2026-10', paidByRef: 'tx-tim' });
	});

	it('nem dá baixa nova num lançamento antigo que casaria (trocar a categoria não é pagar a conta)', async () => {
		// A conta foi cadastrada depois do lançamento: ele casa, mas a edição não mudou nada
		// do que decide a baixa, e não é ela que deve marcar outubro pago.
		seedBill();

		const match = await resettleBillPayment(TIM, { ...TIM });

		expect(match).toBeNull();
		expect(updateBill).not.toHaveBeenCalled();
	});

	it('um mês pago à mão depois da baixa não volta para trás', async () => {
		// A baixa de outubro foi deste lançamento; novembro foi marcado pago à mão depois,
		// e a marcação à mão mantém a referência.
		seedBill({ paidThrough: '2026-11', paidByRef: 'tx-tim' });

		await resettleBillPayment(TIM, { ...TIM, amountCents: 50_000, text: 'Mercado' });

		expect(mockBills.get('tim')).toMatchObject({ paidThrough: '2026-11', paidByRef: null });
	});

	it('a edição que vira receita desfaz a baixa e não dá outra', async () => {
		seedBill({ paidThrough: '2026-10', paidByRef: 'tx-tim' });

		await resettleBillPayment(TIM, { ...TIM, isExpense: false });

		expect(mockBills.get('tim')).toMatchObject({ paidThrough: '2026-09', paidByRef: null });
	});

	it('lançamento que a tela não conhecia: não desfaz sem a data antiga, só procura a baixa nova', async () => {
		seedBill({ paidThrough: '2026-11', paidByRef: 'tx-tim' });

		await resettleBillPayment(null, { ...TIM, amountCents: 50_000 });

		expect(mockBills.get('tim')).toMatchObject({ paidThrough: '2026-11', paidByRef: 'tx-tim' });
	});

	it('falha da baixa não quebra a edição', async () => {
		seedBill({ paidThrough: '2026-10', paidByRef: 'tx-tim' });
		(getBills as jest.Mock).mockRejectedValueOnce(new Error('banco ocupado'));
		const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);

		await expect(resettleBillPayment(TIM, { ...TIM, amountCents: 50_000 })).resolves.toBeNull();

		expect(errors).toHaveBeenCalled();
		errors.mockRestore();
	});
});

/**
 * SPD-022 (DEC-08 a): o app capturava aviso de qualquer app que parecesse ter valor —
 * WhatsApp, Gmail, Messages, app de corrida — e em produção isso criou seis contas
 * fantasma. O aviso de app que não é banco e não cita banco nenhum virava "Sem conta" na
 * revisão, e o usuário descartava à mão todas as vezes (C66, C67; NOTIF-10, AUTO-04).
 */
describe('avisos de apps que não são banco (SPD-022)', () => {
	const SMS = 'com.google.android.apps.messaging';
	/** E-mail: app que não é banco e que não junta remetentes de SMS. É nele que se aprende. */
	const MAIL = 'com.google.android.gm';
	const MERCADO_PAGO = 'com.mercadopago.wallet';
	const SAMSUNG = 'com.samsung.android.spay';
	const categories = [
		{ id: 'other_expense', name: 'Outros', type: 'expense', icon: '', color: '', updatedAt: '' },
		{ id: 'other_income', name: 'Outros', type: 'income', icon: '', color: '', updatedAt: '' },
	] as unknown as Parameters<typeof confirmCapture>[2];

	const raw = (packageName: string, appLabel: string, title: string, text: string, step = 0): RawCapture => ({
		packageName,
		appLabel,
		title,
		text,
		postedAt: new Date(Date.parse('2026-10-23T15:00:00.000Z') + step * 10 * 60_000).toISOString(),
	});
	/** O SMS do Bradesco: app que não é banco, mas o texto cita o banco. Um valor por aviso. */
	const bradescoSms = (index: number): RawCapture =>
		raw(SMS, 'Mensagens', 'Bradesco', `BRADESCO CARTOES: COMPRA APROVADA NO CARTAO FINAL 3456 DE R$ ${40 + index},00 EM DROGASIL.`, index);
	/** O e-mail do Santander: também não é banco, também cita o banco. */
	const santanderMail = (index: number): RawCapture =>
		raw(MAIL, 'Gmail', 'Santander', `Compra no cartão final 7890 aprovada: R$ ${40 + index},00 em LOJA ABC.`, index);
	const ingest = (...raws: RawCapture[]) => ingestRawCaptures(raws, { ownNames: [], categories });
	const ofPackage = (packageName: string): Capture[] =>
		[...mockCaptures.values()].filter((capture) => capture.packageName === packageName);
	const seedFrom = (packageName: string, appLabel: string): Capture =>
		seedCapture({ packageName, appLabel, accountId: null, counterparty: null, merchantKey: null, kind: 'purchase' });
	const dismissThree = async (packageName: string, appLabel: string): Promise<Capture[]> => {
		const seeded = [seedFrom(packageName, appLabel), seedFrom(packageName, appLabel), seedFrom(packageName, appLabel)];
		for (const capture of seeded) await dismissCapture(capture.id);
		return seeded;
	};

	// A conta já ligada ao app vem direto, como no SQL de verdade.
	beforeEach(() => {
		(findAccountBySource as jest.Mock).mockImplementation(
			async (packageName: string) => [...mockAccounts.values()].find((item) => item.packageName === packageName) ?? null
		);
	});
	afterEach(() => {
		(findAccountBySource as jest.Mock).mockImplementation(async () => null);
	});

	it('conversa no WhatsApp citando Pix é ignorada direto: nenhum item, nenhuma conta (C67)', async () => {
		const summary = await ingest(raw('com.whatsapp', 'WhatsApp', 'Maria', 'Pix enviado! R$ 50,00, confere aí'));

		expect(summary.inserted).toBe(0);
		expect(mockCaptures.size).toBe(0);
		expect(addAccount).not.toHaveBeenCalled();
	});

	it('"pedido enviado" do app de compras também (C66)', async () => {
		await ingest(raw('com.amazon.mShop.android.shopping', 'Amazon', 'Pedido enviado', 'Seu pedido de R$ 129,90 foi enviado.'));

		expect(mockCaptures.size).toBe(0);
		expect(addAccount).not.toHaveBeenCalled();
	});

	it('o SMS que cita o banco segue como hoje: vai para a revisão, sem conta criada', async () => {
		await ingest(bradescoSms(1));

		expect(ofPackage(SMS)).toEqual([expect.objectContaining({ status: 'pending', accountId: null })]);
		expect(addAccount).not.toHaveBeenCalled();
	});

	it('depois de 3 descartes do mesmo app, o aviso seguinte dele é ignorado e fica no histórico', async () => {
		await dismissThree(MAIL, 'Gmail');
		expect(mockRules.get(appRuleKeyOf(MAIL))).toMatchObject({ treatAs: 'ignore', confirmations: 3 });

		await ingest(santanderMail(4));

		const next = ofPackage(MAIL).find((capture) => capture.status !== 'dismissed');
		expect(next).toMatchObject({ status: 'ignored', reason: 'app_rule' });
	});

	it('com 2 descartes ainda pergunta', async () => {
		await dismissCapture(seedFrom(MAIL, 'Gmail').id);
		await dismissCapture(seedFrom(MAIL, 'Gmail').id);

		await ingest(santanderMail(3));

		expect(ofPackage(MAIL).find((capture) => capture.status !== 'dismissed')?.status).toBe('pending');
	});

	it('descartar de novo o que já estava descartado não conta duas vezes', async () => {
		const capture = seedFrom(MAIL, 'Gmail');
		await dismissCapture(capture.id);
		await dismissCapture(capture.id);

		expect(mockRules.get(appRuleKeyOf(MAIL))?.confirmations).toBe(1);
	});

	it('desfazer o aprendizado volta a perguntar, e a contagem recomeça do zero', async () => {
		await dismissThree(MAIL, 'Gmail');

		await stopIgnoringApp(MAIL);
		expect(mockRules.has(appRuleKeyOf(MAIL))).toBe(false);

		await ingest(santanderMail(4));
		const next = ofPackage(MAIL).find((capture) => capture.status !== 'dismissed');
		expect(next?.status).toBe('pending');

		await dismissCapture(next?.id as string);
		expect(mockRules.get(appRuleKeyOf(MAIL))?.confirmations).toBe(1);
	});

	it('reverter um dos descartes desconta: o app volta a perguntar', async () => {
		const [, , third] = await dismissThree(MAIL, 'Gmail');

		await revertCapture(third.id);
		expect(mockRules.get(appRuleKeyOf(MAIL))?.confirmations).toBe(2);

		await ingest(santanderMail(4));
		const next = ofPackage(MAIL).find((capture) => capture.status !== 'dismissed' && capture.id !== third.id);
		expect(next?.status).toBe('pending');
	});

	// Um pacote de SMS junta todos os remetentes: calar "Mensagens" calaria também o SMS do
	// banco. Em produção há uma conta fantasma "Messages", então SMS com valor chega.
	it('3 descartes de SMS que cita banco não ensinam nada: o SMS seguinte ainda pergunta', async () => {
		await dismissThree(SMS, 'Mensagens');
		expect(mockRules.has(appRuleKeyOf(SMS))).toBe(false);

		await ingest(bradescoSms(4));

		expect(ofPackage(SMS).find((capture) => capture.status !== 'dismissed')?.status).toBe('pending');
	});

	it('nem uma regra "ignorar" do SMS vinda de outro aparelho cala o SMS', async () => {
		mockRules.set(appRuleKeyOf(SMS), {
			merchantKey: appRuleKeyOf(SMS),
			categoryId: null,
			treatAs: 'ignore',
			confirmations: 5,
			updatedAt: '',
		});

		await ingest(bradescoSms(1));

		expect(ofPackage(SMS)).toEqual([expect.objectContaining({ status: 'pending' })]);
	});

	it('o SMS que não cita banco continua ignorado direto (regra 1)', async () => {
		await ingest(raw(SMS, 'Mensagens', 'Loja', 'Seu pedido de R$ 129,90 foi enviado.'));

		expect(mockCaptures.size).toBe(0);
	});

	it('descartar avisos do app do banco nunca ensina a ignorar o banco', async () => {
		await dismissThree('com.nu.production', 'Nubank');

		expect([...mockRules.keys()].some((key) => key.startsWith('app:'))).toBe(false);
	});

	it('nem da carteira, que tem tratamento próprio', async () => {
		await dismissThree(SAMSUNG, 'Samsung Wallet');

		expect([...mockRules.keys()].some((key) => key.startsWith('app:'))).toBe(false);
	});

	it('o Mercado Pago é banco: o aviso dele entra na conta dele, e descartá-lo não ensina a ignorá-lo', async () => {
		const reserve = account({ id: 'mp', name: 'Reserva', role: 'reserve', bankName: 'Mercado Pago' });
		mockAccounts.set(reserve.id, reserve);

		await ingest(raw(MERCADO_PAGO, 'Mercado Pago', 'Pagamento aprovado', 'Você pagou R$ 32,50 para LOJA DO ZE.'));
		expect(ofPackage(MERCADO_PAGO)).toEqual([expect.objectContaining({ status: 'pending', accountId: 'mp' })]);

		await dismissThree(MERCADO_PAGO, 'Mercado Pago');
		expect(mockRules.has(appRuleKeyOf(MERCADO_PAGO))).toBe(false);

		// Mesmo com uma regra "ignorar" gravada para ele (vinda de outro aparelho, por
		// exemplo), o aviso do Mercado Pago nunca é ignorado por ela.
		mockRules.set(appRuleKeyOf(MERCADO_PAGO), {
			merchantKey: appRuleKeyOf(MERCADO_PAGO),
			categoryId: null,
			treatAs: 'ignore',
			confirmations: 9,
			updatedAt: '',
		});
		await ingest(raw(MERCADO_PAGO, 'Mercado Pago', 'Pix recebido', 'Você recebeu R$ 100,00 de FULANO.', 2));
		const received = ofPackage(MERCADO_PAGO).find((capture) => capture.amountCents === 10_000);
		expect(received).toMatchObject({ status: 'pending', accountId: 'mp' });
	});
});
