/**
 * Criar ou editar um cartão conserta o livro (AUTO-06).
 *
 * A compra que o app do banco avisou antes de o cartão existir caiu na conta corrente.
 * Quando o cartão nasce — ou quando o banco, o final ou o tipo dele mudam — ela vai para
 * o cartão sozinha, com o lançamento junto. O que o usuário editou à mão fica onde está,
 * e um erro no conserto nunca impede salvar o cartão.
 *
 * O banco de dados é um conjunto de listas em memória; `cardLedgerRepair.ts` e
 * `notificationTarget.ts` rodam de verdade.
 */

import type { Account, AccountDraft, Capture, Transaction } from '../../database/schema';

const mockStore: {
	accounts: Account[];
	captures: Capture[];
	transactions: Transaction[];
	nextId: number;
} = {
	accounts: [],
	captures: [],
	transactions: [],
	nextId: 1,
};

jest.mock('../../database/database', () => ({
	db: { withTransactionAsync: jest.fn(async (fn: () => Promise<void>) => fn()) },
	getAccounts: jest.fn(async () => mockStore.accounts.map((account) => ({ ...account }))),
	getAccountBalances: jest.fn(async () => new Map()),
	getUnassignedNet: jest.fn(async () => 0),
	getUnassignedPeriodSummary: jest.fn(async () => ({
		incomeCents: 0,
		expenseCents: 0,
		passThroughCents: 0,
	})),
	getTransfersByDateRange: jest.fn(async () => []),
	getAccountActivity: jest.fn(async () => ({
		incomeCents: 0,
		expenseCents: 0,
		passThroughCents: 0,
		transfersInCents: 0,
		transfersOutCents: 0,
	})),
	getAccountTransactions: jest.fn(async (id: string) =>
		mockStore.transactions.filter((tx) => tx.accountId === id)
	),
	getAccountTransfers: jest.fn(async () => []),
	getCardPurchasesOriginated: jest.fn(async () => 0),
	getTransactions: jest.fn(async () => mockStore.transactions.map((tx) => ({ ...tx }))),
	normalizeAccountDraft: jest.fn((draft: AccountDraft) => draft),
	addAccount: jest.fn(async (draft: AccountDraft) => {
		const id = `novo-${mockStore.nextId++}`;
		mockStore.accounts.push({ ...draft, id, updatedAt: '' });
		return id;
	}),
	updateAccount: jest.fn(async (edit: Account) => {
		mockStore.accounts = mockStore.accounts.map((account) =>
			account.id === edit.id ? { ...account, ...edit } : account
		);
	}),
	reassignCaptureLedger: jest.fn(
		async (transactionId: string | null, group: string, accountId: string | null) => {
			for (const tx of mockStore.transactions) {
				if (tx.id === transactionId || tx.installmentGroup === group) tx.accountId = accountId;
			}
		}
	),
}));

jest.mock('../../database/captures', () => ({
	getPendingCaptures: jest.fn(async () =>
		mockStore.captures.filter((capture) => capture.status === 'pending')
	),
	getAllCaptures: jest.fn(async () => mockStore.captures.map((capture) => ({ ...capture }))),
	updateCapture: jest.fn(async (id: string, patch: Partial<Capture>) => {
		mockStore.captures = mockStore.captures.map((capture) =>
			capture.id === id ? { ...capture, ...patch } : capture
		);
	}),
}));

jest.mock('../../sync/queue', () => ({ schedule: jest.fn() }));
jest.mock('../../hooks/useAfterPull', () => ({ useAfterPull: jest.fn() }));
// Os lembretes de conta (captureActions → notificationUtils) leem o AsyncStorage ao carregar.
jest.mock('@react-native-async-storage/async-storage', () =>
	require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('../../api/cdi', () => ({
	loadCachedCdi: jest.fn(async () => null),
	refreshCdi: jest.fn(async () => null),
}));

// A mesma lista a cada render: uma nova dispararia a recarga sem parar.
const mockLedger = {
	transactions: [],
	categories: [],
	refreshData: jest.fn(async () => undefined),
};
jest.mock('../TransactionsContext', () => ({ useTransactions: () => mockLedger }));
const mockPeriod = { startDate: '2026-09-01', endDate: '2026-09-30' };
jest.mock('../PeriodContext', () => ({ usePeriod: () => mockPeriod }));

import { act, create } from 'react-test-renderer';
import { getAllCaptures } from '../../database/captures';
import { reassignCaptureLedger } from '../../database/database';
import { AccountsProvider, useAccounts } from '../AccountsContext';

const NUBANK = 'com.nu.production';

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

const POSTED = new Date(2026, 8, 17, 12, 0).toISOString();

const capture = (overrides: Partial<Capture>): Capture => ({
	id: 'c',
	fingerprint: 'f',
	packageName: NUBANK,
	appLabel: 'Nubank',
	title: 'Compra aprovada',
	text: 'Compra de R$ 29,38 APROVADA em IFOOD para o cartão com final 6422.',
	postedAt: POSTED,
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
	transactionId: 'tx-c',
	autoConfirmed: false,
	reason: null,
	accountId: 'nu-pf',
	transferId: null,
	installments: null,
	createdAt: '',
	updatedAt: '',
	...overrides,
});

const posted = (overrides: Partial<Transaction>): Transaction => ({
	id: 'tx-c',
	amountCents: 2938,
	category: 'food',
	date: '2026-09-17',
	note: 'IFOOD',
	isIncome: false,
	accountId: 'nu-pf',
	installmentGroup: null,
	installmentIndex: null,
	installmentCount: null,
	cardLast4: '6422',
	updatedAt: '',
	...overrides,
});

/** O cartão como a tela de cartão manda: banco escolhido, sem app ligado. */
const cardDraft = (overrides: Partial<AccountDraft> = {}): AccountDraft => {
	const {
		id: _id,
		updatedAt: _updatedAt,
		...draft
	} = account({
		name: 'Nubank',
		kind: 'credit_card',
		role: 'card',
		bankName: 'Nubank',
		last4: '1534',
		closingDay: 25,
		closingDaysBefore: 7,
		openingBalanceDate: '2026-09-30',
	});
	return { ...draft, ...overrides };
};

type Api = ReturnType<typeof useAccounts>;

const mount = async (): Promise<() => Api> => {
	let latest: Api | null = null;
	const Probe = () => {
		latest = useAccounts();
		return null;
	};
	await act(async () => {
		create(
			<AccountsProvider>
				<Probe />
			</AccountsProvider>
		);
	});
	return () => {
		if (!latest) throw new Error('provider não montou');
		return latest;
	};
};

const captureById = (id: string) => mockStore.captures.find((item) => item.id === id);
const txById = (id: string) => mockStore.transactions.find((item) => item.id === id);

beforeEach(() => {
	jest.clearAllMocks();
	mockStore.nextId = 1;
	mockStore.accounts = [
		account({ id: 'nu-pf', name: 'Nubank PF', bankName: 'Nubank', packageName: NUBANK }),
	];
	// Duas compras do cartão que caíram na conta: uma intacta, outra com o valor corrigido à mão.
	mockStore.captures = [capture({}), capture({ id: 'mexida', transactionId: 'tx-mexida' })];
	mockStore.transactions = [posted({}), posted({ id: 'tx-mexida', amountCents: 3100 })];
});

describe('AccountsContext — criar ou editar cartão conserta o livro', () => {
	it('criar o cartão leva para ele a compra intacta; a editada à mão fica na conta', async () => {
		const api = await mount();
		let id = '';
		await act(async () => {
			id = await api().createAccount(cardDraft());
		});

		expect(captureById('c')?.accountId).toBe(id);
		expect(txById('tx-c')?.accountId).toBe(id);
		expect(captureById('mexida')?.accountId).toBe('nu-pf');
		expect(txById('tx-mexida')?.accountId).toBe('nu-pf');
		expect(api().cardLedgerRepair).toEqual({ cardId: id, movedCount: 1, keptCount: 1 });
		// A lista de lançamentos precisa saber que a compra mudou de conta.
		expect(mockLedger.refreshData).toHaveBeenCalled();

		act(() => api().dismissCardLedgerRepair());
		expect(api().cardLedgerRepair).toBeNull();
	});

	it('criar uma conta (não cartão) não mexe em compra nenhuma', async () => {
		const api = await mount();
		await act(async () => {
			await api().createAccount({
				...cardDraft(),
				name: 'Nubank PJ',
				kind: 'checking',
				role: 'main',
				last4: null,
				closingDay: null,
				closingDaysBefore: null,
			});
		});
		expect(captureById('c')?.accountId).toBe('nu-pf');
		expect(reassignCaptureLedger).not.toHaveBeenCalled();
		expect(api().cardLedgerRepair).toBeNull();
	});

	it('o conserto falhar não impede criar o cartão', async () => {
		(getAllCaptures as jest.Mock).mockRejectedValueOnce(new Error('disco cheio'));
		const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
		const api = await mount();
		let id = '';
		await act(async () => {
			id = await api().createAccount(cardDraft());
		});
		expect(spy).toHaveBeenCalledWith('Error repairing card ledger:', expect.any(Error));
		spy.mockRestore();

		expect(id).toBe('novo-1');
		expect(mockStore.accounts.map((item) => item.id)).toContain('novo-1');
		expect(captureById('c')?.accountId).toBe('nu-pf');
		expect(api().cardLedgerRepair).toBeNull();
	});

	it('falha no meio da gravação também não impede salvar a edição', async () => {
		mockStore.accounts.push(
			account({
				id: 'card',
				name: 'Inter',
				kind: 'credit_card',
				role: 'card',
				bankName: 'Inter',
				closingDay: 5,
			})
		);
		(reassignCaptureLedger as jest.Mock).mockRejectedValueOnce(new Error('travou'));
		const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
		const api = await mount();
		const card = mockStore.accounts.find((item) => item.id === 'card') as Account;
		await act(async () => {
			await api().saveAccount({ ...card, bankName: 'Nubank', name: 'Nubank' });
		});
		expect(spy).toHaveBeenCalledWith('Error repairing card ledger:', expect.any(Error));
		spy.mockRestore();
		expect(mockStore.accounts.find((item) => item.id === 'card')?.bankName).toBe('Nubank');
	});

	it('editar só o nome ou o limite não move nada; trocar o final move', async () => {
		// Um cartão do Nubank de antes do conserto: as compras ainda estão na conta.
		mockStore.accounts.push(
			account({
				id: 'card',
				name: 'Nubank',
				kind: 'credit_card',
				role: 'card',
				bankName: 'Nubank',
				last4: '1534',
				closingDay: 5,
			})
		);
		const api = await mount();
		const card = () => mockStore.accounts.find((item) => item.id === 'card') as Account;

		await act(async () => {
			await api().saveAccount({ ...card(), name: 'Roxinho', creditLimitCents: 500000 });
		});
		expect(captureById('c')?.accountId).toBe('nu-pf');
		expect(reassignCaptureLedger).not.toHaveBeenCalled();
		expect(api().cardLedgerRepair).toBeNull();

		await act(async () => {
			await api().saveAccount({ ...card(), last4: '6422' });
		});
		expect(captureById('c')?.accountId).toBe('card');
		expect(txById('tx-c')?.accountId).toBe('card');
		expect(txById('tx-mexida')?.accountId).toBe('nu-pf');
		expect(api().cardLedgerRepair).toEqual({ cardId: 'card', movedCount: 1, keptCount: 1 });
	});
});
