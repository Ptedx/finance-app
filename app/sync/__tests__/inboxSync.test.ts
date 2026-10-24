/**
 * O motor com as coleções do v19: a caixa de entrada sobe, e o reparo das contas
 * fantasma roda depois do pull.
 *
 * Os dois defeitos reais que isto cobre:
 *
 *  - `countChanges` (o contrato, `sync/types.ts`) não conta `captures` nem
 *    `merchantRules`. Com só a caixa de entrada suja ele devolve zero, o laço do push
 *    parava na primeira volta e a caixa nunca subia — exatamente o dado que o v19 existe
 *    para salvar.
 *  - a limpeza das contas inventadas por um app que não é banco era só a migração v18,
 *    que roda antes de as tabelas existirem; o login em seguida baixava as contas de
 *    volta. O dono está na 1.2.7 com seis delas ("WhatsApp", "Gmail", "Messages",
 *    "Google", "99", "OnlineBanking").
 */

jest.mock('../../api/sync', () => ({
	pull: jest.fn(),
	push: jest.fn(),
	fetchSyncStatus: jest.fn(),
}));

jest.mock('../../database/database', () => ({
	applyPulledChanges: jest.fn(async () => undefined),
	countDirtyRows: jest.fn(async () => 0),
	getDirtyChanges: jest.fn(async () => ({ categories: [], transactions: [], recurringTransactions: [], budgets: [] })),
	getSyncedIds: jest.fn(async () => new Set<string>()),
	getSyncState: jest.fn(async () => null),
	hasCategory: jest.fn(async () => false),
	markCategoryDirty: jest.fn(async () => undefined),
	markChangesClean: jest.fn(async () => undefined),
	reassignToUncategorized: jest.fn(async () => undefined),
	repairPhantomAppAccounts: jest.fn(async () => 0),
	setSyncState: jest.fn(async () => undefined),
	stampEverything: jest.fn(async () => undefined),
}));

import * as api from '../../api/sync';
import { applyPulledChanges, getDirtyChanges, markChangesClean, repairPhantomAppAccounts } from '../../database/database';
import { pullAll, pushAll } from '../engine';
import { EMPTY_CURSOR, type SyncChanges, type WireCapture, type WireMerchantRule } from '../types';

const emptyChanges = (overrides: Partial<SyncChanges> = {}): SyncChanges => ({
	categories: [],
	transactions: [],
	recurringTransactions: [],
	budgets: [],
	...overrides,
});

const capture = (id: string): WireCapture => ({
	id,
	packageName: 'com.nu.production',
	appLabel: 'Nubank',
	title: 'Compra aprovada',
	text: 'Compra de R$ 52,90 na PADARIA',
	postedAt: '2026-10-05T12:00:00.000Z',
	amountCents: 5_290,
	direction: 'out',
	kind: 'purchase',
	counterparty: 'PADARIA',
	merchantKey: 'padaria',
	cardLast4: '6422',
	status: 'pending',
	question: null,
	relatedFingerprint: null,
	suggestedCategory: 'food',
	transactionId: null,
	autoConfirmed: false,
	reason: null,
	accountId: null,
	transferId: null,
	installments: null,
	createdAt: '2026-10-05T12:00:01.000Z',
	updatedAt: '2026-10-05T12:00:01.000Z',
	deletedAt: null,
});

const rule: WireMerchantRule = {
	id: 'padaria',
	categoryId: 'food',
	treatAs: 'transaction',
	confirmations: 3,
	updatedAt: '2026-10-05T12:00:01.000Z',
	deletedAt: null,
};

const pullOnce = (changes: SyncChanges) => {
	(api.pull as jest.Mock).mockResolvedValue({
		serverTime: '2026-10-13T00:00:00.000Z',
		cursor: { ...EMPTY_CURSOR, captures: 3 },
		hasMore: false,
		changes,
	});
};

beforeEach(() => {
	jest.clearAllMocks();
	(api.push as jest.Mock).mockResolvedValue({ serverTime: '2026-10-13T00:00:00.000Z', applied: 1, rejected: [] });
	(getDirtyChanges as jest.Mock).mockResolvedValue(emptyChanges());
});

describe('o push com as coleções do v19', () => {
	it('sobe a caixa de entrada mesmo quando é a única coisa suja', async () => {
		(getDirtyChanges as jest.Mock)
			.mockResolvedValueOnce(emptyChanges({ captures: [capture('fp-1')], merchantRules: [rule] }))
			.mockResolvedValue(emptyChanges());

		await pushAll();

		expect(api.push).toHaveBeenCalledTimes(1);
		const sent = (api.push as jest.Mock).mock.calls[0][0] as SyncChanges;
		expect(sent.captures).toHaveLength(1);
		expect(sent.merchantRules).toHaveLength(1);
	});

	it('o que o servidor aceitou deixa de estar pendente, pelo fingerprint', async () => {
		(getDirtyChanges as jest.Mock)
			.mockResolvedValueOnce(emptyChanges({ captures: [capture('fp-1')] }))
			.mockResolvedValue(emptyChanges());

		await pushAll();

		const cleaned = (markChangesClean as jest.Mock).mock.calls[0][0] as SyncChanges;
		expect(cleaned.captures).toEqual([capture('fp-1')]);
	});

	it('a captura que o servidor recusou continua pendente', async () => {
		(getDirtyChanges as jest.Mock)
			.mockResolvedValueOnce(emptyChanges({ captures: [capture('fp-1'), capture('fp-2')] }))
			.mockResolvedValue(emptyChanges());
		(api.push as jest.Mock).mockResolvedValue({
			serverTime: '2026-10-13T00:00:00.000Z',
			applied: 1,
			rejected: [{ collection: 'captures', id: 'fp-2', reason: 'invalid', message: 'valor acima do teto' }],
		});

		await pushAll();

		const cleaned = (markChangesClean as jest.Mock).mock.calls[0][0] as SyncChanges;
		expect(cleaned.captures?.map((row) => row.id)).toEqual(['fp-1']);
	});

	it('nada sujo, nada enviado', async () => {
		await pushAll();
		expect(api.push).not.toHaveBeenCalled();
	});
});

describe('o reparo das contas fantasma depois do pull', () => {
	it('roda quando a foto da conta chegou inteira, e depois de aplicar', async () => {
		pullOnce(emptyChanges({ captures: [capture('fp-1')] }));

		await pullAll();

		expect(repairPhantomAppAccounts).toHaveBeenCalledTimes(1);
		// Depois de gravar, nunca antes: o reparo exige conta vazia, e ele precisa ver o
		// que a página acabou de trazer.
		const applied = (applyPulledChanges as jest.Mock).mock.invocationCallOrder[0];
		const repaired = (repairPhantomAppAccounts as jest.Mock).mock.invocationCallOrder[0];
		expect(repaired).toBeGreaterThan(applied);
	});

	it('espera a próxima rodada enquanto o servidor ainda tem páginas', async () => {
		(api.pull as jest.Mock).mockResolvedValue({
			serverTime: '2026-10-13T00:00:00.000Z',
			cursor: { ...EMPTY_CURSOR },
			hasMore: true,
			changes: emptyChanges(),
		});

		await pullAll();

		// Uma conta cujos lançamentos ainda estão numa página por vir **parece** vazia:
		// apagá-la agora seria apagar conta de verdade.
		expect(repairPhantomAppAccounts).not.toHaveBeenCalled();
	});

	it('conta as linhas das coleções novas no total recebido', async () => {
		pullOnce(emptyChanges({ captures: [capture('fp-1'), capture('fp-2')], merchantRules: [rule] }));

		expect(await pullAll()).toBe(3);
	});
});
