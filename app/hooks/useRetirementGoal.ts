import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { clearRetirementGoal, getRetirementGoal, initDatabase, type RetirementGoalDraft, setRetirementGoal } from '../database/database';
import * as syncQueue from '../sync/queue';
import { useAfterPull } from './useAfterPull';
import type { RetirementGoal } from '../utils/retirement';

/**
 * A meta de aposentadoria, lida do banco e sincronizada.
 *
 * Só a tela de Relatórios lê a meta, então ela não precisa de provider: o hook carrega,
 * salva (e agenda o sync) e recarrega quando o app volta ao primeiro plano — o pull pode
 * ter trazido a meta editada em outro aparelho.
 */
export interface RetirementGoalResult {
	goal: RetirementGoal | null;
	isLoading: boolean;
	save: (draft: RetirementGoalDraft) => Promise<void>;
	clear: () => Promise<void>;
}

export const useRetirementGoal = (): RetirementGoalResult => {
	const [goal, setGoal] = useState<RetirementGoal | null>(null);
	const [isLoading, setIsLoading] = useState(true);

	const load = useCallback(async () => {
		try {
			await initDatabase();
			const row = await getRetirementGoal();
			setGoal(
				row
					? {
							targetMonthlyCents: row.targetMonthlyCents,
							reinvestBp: row.reinvestBp,
							expectedYieldBp: row.expectedYieldBp,
							outsideCapitalCents: row.outsideCapitalCents,
						}
					: null
			);
		} catch (error) {
			console.error('Error loading the retirement goal:', error);
		} finally {
			setIsLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	useEffect(() => {
		const subscription = AppState.addEventListener('change', (state) => {
			if (state === 'active') void load();
		});
		return () => subscription.remove();
	}, [load]);

	const save = useCallback(
		async (draft: RetirementGoalDraft) => {
			await setRetirementGoal(draft);
			syncQueue.schedule();
			await load();
		},
		[load]
	);

	const clear = useCallback(async () => {
		await clearRetirementGoal();
		syncQueue.schedule();
		await load();
	}, [load]);

	// A meta editada em outro aparelho chega pelo pull.
	useAfterPull(load);

	return { goal, isLoading, save, clear };
};

/**
 * Todo arquivo sob app/ é tratado como rota pelo expo-router, e uma rota sem export
 * default é um módulo quebrado do ponto de vista dele. Este export existe só para
 * satisfazer essa exigência — nada navega para cá.
 */
export default useRetirementGoal;
