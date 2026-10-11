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

import { applyDecision, markCaptureTransfer, revertCapture } from '../captureActions';
import { getISODate } from '../dateUtils';

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
