import type React from 'react';
import { createContext, useContext, useEffect, useState } from 'react';
import { getLastSyncedAt } from '../sync/engine';
import * as syncQueue from '../sync/queue';

interface SyncContextType {
	status: syncQueue.SyncStatus;
	/** Quantas linhas ainda não subiram. Zero com status 'idle' significa tudo salvo. */
	pending: number;
	lastError: string | null;
	lastSyncedAt: string | null;
	/** Sync manual, do botão nas Configurações e do puxar-para-atualizar. */
	syncNow: () => void;
}

const SyncContext = createContext<SyncContextType | undefined>(undefined);

export const SyncProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
	const [state, setState] = useState(syncQueue.getState);
	const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);

	useEffect(() => {
		// A fila é um módulo, não um hook: ela precisa sobreviver a remontagens e ser
		// chamada de dentro dos contexts de dados, que não podem depender de React.
		const unsubscribe = syncQueue.subscribe((next) => {
			setState(next);
			if (next.status === 'idle') {
				getLastSyncedAt().then(setLastSyncedAt).catch(() => {});
			}
		});

		return () => {
			unsubscribe();
		};
	}, []);

	const value: SyncContextType = {
		status: state.status,
		pending: state.pending,
		lastError: state.lastError,
		lastSyncedAt,
		syncNow: syncQueue.syncImmediately,
	};

	return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
};

export const useSync = () => {
	const context = useContext(SyncContext);
	if (context === undefined) {
		throw new Error('useSync must be used within a SyncProvider');
	}
	return context;
};

export default SyncContext;
