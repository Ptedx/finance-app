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

/**
 * `knownWipeAt`: o último "Apagar todos os dados" que este aparelho conhece (`null` se
 * nunca apagou), sempre presente no corpo. Ver `KNOWN_WIPE_AT_KEY` em `sync/types.ts`.
 * O servidor que não conhece o campo o descarta, então mandá-lo é inofensivo lá.
 */
export const push = (changes: SyncChanges, knownWipeAt: string | null): Promise<PushResponse> =>
	apiRequest<PushResponse>('/api/sync/push', {
		method: 'POST',
		body: { changes, knownWipeAt },
		authenticated: true,
	});

/**
 * "Apagar todos os dados" na conta (SPD-080): o servidor apaga tudo menos categorias,
 * regras aprendidas e a configuração, e devolve o instante do apagar. Um servidor sem a
 * rota responde 404 — e aí nada pode ser apagado aqui (`utils/dataWipe.ts`).
 */
export const wipeAccountData = (): Promise<{ dataWipedAt: string }> =>
	apiRequest<{ dataWipedAt: string }>('/api/me/wipe', { method: 'POST', authenticated: true });

/**
 * Todo arquivo sob app/ e tratado como rota pelo expo-router, e uma rota sem export
 * default e um modulo quebrado do ponto de vista dele. Este export existe so para
 * satisfazer essa exigencia — nada navega para ca. Mesma convencao de database.ts,
 * money.ts e dos demais utilitarios do projeto.
 */
export default { pull, push, fetchSyncStatus, wipeAccountData };
