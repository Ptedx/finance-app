import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { useSync } from '../contexts/SyncContext';
import { getReserveGoal, initDatabase, type ReserveGoalDraft, setReserveGoal } from '../database/database';
import { DEFAULT_RESERVE_MONTHS } from '../database/schema';
import * as syncQueue from '../sync/queue';

/**
 * A meta da reserva de emergência, lida do banco e sincronizada.
 *
 * Sem linha gravada vale o padrão (12 meses, custo calculado): a reserva existe para todo
 * mundo, a meta só muda o tamanho dela. Patrimônio e Relatórios leem a meta ao mesmo tempo,
 * então salvar numa tela avisa as outras instâncias do hook; um sync terminado e a volta
 * ao primeiro plano também recarregam (outro aparelho pode ter mudado a meta).
 */
export interface ReserveGoal {
	targetMonths: number;
	customMonthlyCostCents: number | null;
}

export const DEFAULT_RESERVE_GOAL: ReserveGoal = { targetMonths: DEFAULT_RESERVE_MONTHS, customMonthlyCostCents: null };

export interface ReserveGoalResult {
	goal: ReserveGoal;
	save: (draft: ReserveGoalDraft) => Promise<void>;
}

const listeners = new Set<() => void>();

export const useReserveGoal = (): ReserveGoalResult => {
	const [goal, setGoal] = useState<ReserveGoal>(DEFAULT_RESERVE_GOAL);
	const { lastSyncedAt } = useSync();

	const load = useCallback(async () => {
		try {
			await initDatabase();
			const row = await getReserveGoal();
			setGoal(row ? { targetMonths: row.targetMonths, customMonthlyCostCents: row.customMonthlyCostCents } : DEFAULT_RESERVE_GOAL);
		} catch (error) {
			console.error('Error loading the reserve goal:', error);
		}
	}, []);

	// `lastSyncedAt` é o gatilho: muda a cada sync terminado.
	useEffect(() => {
		void load();
	}, [load, lastSyncedAt]);

	useEffect(() => {
		listeners.add(load);
		const subscription = AppState.addEventListener('change', (state) => {
			if (state === 'active') void load();
		});
		return () => {
			listeners.delete(load);
			subscription.remove();
		};
	}, [load]);

	const save = useCallback(async (draft: ReserveGoalDraft) => {
		await setReserveGoal(draft);
		syncQueue.schedule();
		await Promise.all([...listeners].map((reload) => reload()));
	}, []);

	return { goal, save };
};

/**
 * Todo arquivo sob app/ é tratado como rota pelo expo-router, e uma rota sem export
 * default é um módulo quebrado do ponto de vista dele. Este export existe só para
 * satisfazer essa exigência — nada navega para cá.
 */
export default useReserveGoal;
