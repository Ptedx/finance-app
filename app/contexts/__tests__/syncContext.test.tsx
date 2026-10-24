/**
 * O SyncProvider liga o envio do diário de diagnóstico (SPD-016) uma vez, ao montar, e
 * desliga ao desmontar. Os gatilhos em si (fim de sync, primeiro plano) estão em
 * `diagnostics/__tests__/upload.test.ts`.
 */

const mockStopUploads = jest.fn();

jest.mock('../../diagnostics/upload', () => ({
	startDiaryUploads: jest.fn(() => mockStopUploads),
}));

jest.mock('../../sync/engine', () => ({
	getLastSyncedAt: jest.fn(async () => null),
	syncNow: jest.fn(),
}));

jest.mock('../../api/client', () => ({ ApiError: class ApiError extends Error {} }));

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { startDiaryUploads } from '../../diagnostics/upload';
import { SyncProvider } from '../SyncContext';

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
