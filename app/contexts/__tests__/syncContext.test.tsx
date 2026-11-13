/**
 * O SyncProvider liga o envio do diário de diagnóstico (SPD-016) uma vez, ao montar, e
 * desliga ao desmontar. Os gatilhos em si (fim de sync, primeiro plano) estão em
 * `diagnostics/__tests__/upload.test.ts`.
 *
 * Do mesmo jeito, registra quem apaga este aparelho quando a conta foi apagada em outro
 * (SPD-083, `sync/remoteWipe.ts`).
 */

const mockStopUploads = jest.fn();

jest.mock('../../diagnostics/upload', () => ({
	startDiaryUploads: jest.fn(() => mockStopUploads),
}));

const mockStopRemoteWipes = jest.fn();

jest.mock('../../sync/remoteWipe', () => ({
	startRemoteWipes: jest.fn(() => mockStopRemoteWipes),
}));

jest.mock('../../sync/engine', () => ({
	getLastSyncedAt: jest.fn(async () => null),
	syncNow: jest.fn(),
}));

jest.mock('../../api/client', () => ({ ApiError: class ApiError extends Error {} }));

// As duas contagens da conta, lidas do banco: o que falta subir (lápides incluídas) e o
// que só existe neste aparelho.
const mockCounts = { dirty: 0, unsynced: 0 };

jest.mock('../../database/database', () => ({
	countDirtyRows: jest.fn(async () => mockCounts.dirty),
	countUnsyncedRows: jest.fn(async () => mockCounts.unsynced),
}));

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ApiError } from '../../api/client';
import { startDiaryUploads } from '../../diagnostics/upload';
import { syncNow } from '../../sync/engine';
import * as syncQueue from '../../sync/queue';
import { startRemoteWipes } from '../../sync/remoteWipe';
import { describeSync, SyncProvider, useSync } from '../SyncContext';

describe('SyncProvider e o envio do diário', () => {
	it('liga ao montar, uma vez só, e desliga ao desmontar', async () => {
		let tree: ReactTestRenderer | null = null;
		await act(async () => {
			tree = create(<SyncProvider>{null}</SyncProvider>);
		});
		expect(startDiaryUploads).toHaveBeenCalledTimes(1);

		await act(async () => {
			tree?.update(<SyncProvider>{null}</SyncProvider>);
		});
		expect(startDiaryUploads).toHaveBeenCalledTimes(1);
		expect(mockStopUploads).not.toHaveBeenCalled();

		await act(async () => {
			tree?.unmount();
		});
		expect(mockStopUploads).toHaveBeenCalledTimes(1);
	});
});

describe('SyncProvider e o apagar feito em outro aparelho', () => {
	beforeEach(() => jest.clearAllMocks());

	it('registra quem apaga ao montar, uma vez só, e tira ao desmontar', async () => {
		let tree: ReactTestRenderer | null = null;
		await act(async () => {
			tree = create(<SyncProvider>{null}</SyncProvider>);
		});
		expect(startRemoteWipes).toHaveBeenCalledTimes(1);

		await act(async () => {
			tree?.update(<SyncProvider>{null}</SyncProvider>);
		});
		expect(startRemoteWipes).toHaveBeenCalledTimes(1);
		expect(mockStopRemoteWipes).not.toHaveBeenCalled();

		await act(async () => {
			tree?.unmount();
		});
		expect(mockStopRemoteWipes).toHaveBeenCalledTimes(1);
	});
});

/**
 * A linha da conta em Ajustes e a tela da conta leem o mesmo estado (E2E-36).
 *
 * O achado: Ajustes dizia "Tudo salvo" (texto fixo) enquanto a tela da conta dizia
 * "Offline — 3 alterações serão enviadas depois", e a mesma tela mostrava "4 itens ainda
 * só existem neste aparelho" ao lado das "3 alterações". O 3 era o número da última
 * rodada que deu certo; o 4, o banco lido depois de uma edição feita sem rede.
 */
describe('o estado da conta, de um lugar só', () => {
	type Sync = ReturnType<typeof useSync>;
	let seen: Sync | null = null;
	const Probe = () => {
		seen = useSync();
		return null;
	};
	const flush = async () => {
		for (let i = 0; i < 10; i += 1) await Promise.resolve();
	};

	beforeEach(() => {
		jest.clearAllMocks();
		syncQueue.stop();
		seen = null;
	});

	afterEach(() => syncQueue.stop());

	it('sem rede, depois de uma edição: as alterações e os itens só daqui saem do banco, na mesma leitura', async () => {
		let tree: ReactTestRenderer | null = null;
		await act(async () => {
			tree = create(
				<SyncProvider>
					<Probe />
				</SyncProvider>
			);
		});

		// A última rodada com rede deixou 3 pendentes.
		mockCounts.dirty = 3;
		mockCounts.unsynced = 3;
		(syncNow as jest.Mock).mockResolvedValueOnce({ pulled: 0, pushed: 0, pendingAfter: 3 });
		await act(async () => {
			syncQueue.start();
			await flush();
		});
		expect(seen).toMatchObject({ status: 'idle', pending: 3, unsynced: 3 });

		// Sem rede, o usuário grava o orçamento: agora são 4, e a rodada falha por rede.
		mockCounts.dirty = 4;
		mockCounts.unsynced = 4;
		(syncNow as jest.Mock).mockRejectedValueOnce(Object.assign(new ApiError(0, 'offline', 'offline'), { isOffline: true }));
		await act(async () => {
			syncQueue.syncImmediately();
			await flush();
		});

		expect(seen).toMatchObject({ status: 'offline', pending: 4, unsynced: 4 });
		await act(async () => {
			tree?.unmount();
		});
	});

	it('descreve o estado do mesmo jeito para as duas telas: nunca "Tudo salvo" offline ou com pendência', () => {
		expect(describeSync('idle', 0)).toMatchObject({ tone: 'ok', label: { key: 'account.statusSynced' }, short: { key: 'account.statusSynced' } });
		expect(describeSync('idle', 3)).toMatchObject({
			tone: 'pending',
			label: { key: 'account.statusPending', count: 3 },
			short: { key: 'account.rowPending', count: 3 },
		});
		expect(describeSync('offline', 3)).toMatchObject({
			tone: 'offline',
			label: { key: 'account.statusOffline', count: 3 },
			short: { key: 'account.rowOffline' },
		});
		expect(describeSync('offline', 0)).toMatchObject({ tone: 'offline', label: { key: 'account.statusOfflineNone' }, short: { key: 'account.rowOffline' } });
		expect(describeSync('error', 0).short.key).toBe('account.rowError');
		expect(describeSync('syncing', 2).short.key).toBe('account.statusSyncing');
		for (const status of ['offline', 'error', 'syncing'] as const) {
			expect(describeSync(status, 0).short.key).not.toBe('account.statusSynced');
		}
	});
});
