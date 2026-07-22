import type {
	PullResponse,
	PushResponse,
	SyncChanges,
	SyncCursor,
	SyncStatusResponse,
} from '../sync/types';
import { apiRequest } from './client';

export const fetchSyncStatus = (): Promise<SyncStatusResponse> =>
	apiRequest<SyncStatusResponse>('/api/sync/status', { authenticated: true });

/** Sem cursor = sync completo, o caso do primeiro login e da mesclagem. */
export const pull = (cursor?: SyncCursor): Promise<PullResponse> => {
	const query = cursor ? `?cursor=${encodeURIComponent(JSON.stringify(cursor))}` : '';
	return apiRequest<PullResponse>(`/api/sync/pull${query}`, { authenticated: true });
};

export const push = (changes: SyncChanges): Promise<PushResponse> =>
	apiRequest<PushResponse>('/api/sync/push', {
		method: 'POST',
		body: { changes },
		authenticated: true,
	});
