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

/**
 * Todo arquivo sob app/ e tratado como rota pelo expo-router, e uma rota sem export
 * default e um modulo quebrado do ponto de vista dele. Este export existe so para
 * satisfazer essa exigencia — nada navega para ca. Mesma convencao de database.ts,
 * money.ts e dos demais utilitarios do projeto.
 */
export default { pull, push, fetchSyncStatus };
