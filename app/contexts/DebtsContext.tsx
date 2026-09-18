import type React from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';
import { addDebt, deleteDebt, getDebts, initDatabase, updateDebt } from '../database/database';
import type { Debt, DebtDraft } from '../database/schema';
import * as syncQueue from '../sync/queue';
import { todayISO } from '../utils/dateUtils';
import { type DebtsSummary, type ExtraPaymentResult, summarizeDebts, termsAfterExtraPayment, termsOf } from '../utils/debt';
import { useSync } from './SyncContext';

/**
 * As dívidas de longo prazo: a lista, o resumo e as ações.
 *
 * Fino de propósito: guarda as linhas e o resto sai de `utils/debt.ts`. Recarrega quando
 * o app volta ao primeiro plano (o dia pode ter virado e uma parcela vencido) e quando um
 * sync termina (outro aparelho pode ter cadastrado ou amortizado uma dívida).
 */

interface DebtsContextType {
	/** Todas as vivas, quitadas inclusive. */
	debts: Debt[];
	/** Só as que ainda estão sendo pagas. */
	activeDebts: Debt[];
	summary: DebtsSummary;
	isLoading: boolean;
	createDebt: (draft: DebtDraft) => Promise<string>;
	saveDebt: (id: string, draft: DebtDraft) => Promise<void>;
	removeDebt: (id: string) => Promise<void>;
	/** Confirma uma amortização: a âncora vai para hoje com o saldo, a parcela e o prazo novos. */
	recordExtraPayment: (id: string, result: ExtraPaymentResult) => Promise<void>;
	refresh: () => Promise<void>;
}

const DebtsContext = createContext<DebtsContextType | undefined>(undefined);

/** Os campos editáveis de uma dívida guardada, para regravar só o que muda. */
export const draftOf = (debt: Debt): DebtDraft => ({
	name: debt.name,
	kind: debt.kind,
	system: debt.system,
	openingBalanceCents: debt.openingBalanceCents,
	openingBalanceDate: debt.openingBalanceDate,
	installmentCents: debt.installmentCents,
	remainingAtOpening: debt.remainingAtOpening,
	installmentsTotal: debt.installmentsTotal,
	dueDay: debt.dueDay,
	rateBp: debt.rateBp,
	feeCents: debt.feeCents,
	adminFeeBp: debt.adminFeeBp,
	accountId: debt.accountId,
	category: debt.category,
	archived: debt.archived,
	sortOrder: debt.sortOrder,
});

export const DebtsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
	const [debts, setDebts] = useState<Debt[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const { lastSyncedAt } = useSync();

	const refresh = useCallback(async () => {
		try {
			await initDatabase();
			setDebts(await getDebts());
		} catch (error) {
			console.error('Error loading debts:', error);
		} finally {
			setIsLoading(false);
		}
	}, []);

	// `lastSyncedAt` é o gatilho: muda a cada sync terminado.
	useEffect(() => {
		void refresh();
	}, [refresh, lastSyncedAt]);

	useEffect(() => {
		const subscription = AppState.addEventListener('change', (state) => {
			if (state === 'active') void refresh();
		});
		return () => subscription.remove();
	}, [refresh]);

	const createDebt = useCallback(
		async (draft: DebtDraft) => {
			const id = await addDebt(draft);
			syncQueue.schedule();
			await refresh();
			return id;
		},
		[refresh]
	);

	const saveDebt = useCallback(
		async (id: string, draft: DebtDraft) => {
			await updateDebt(id, draft);
			syncQueue.schedule();
			await refresh();
		},
		[refresh]
	);

	const removeDebt = useCallback(
		async (id: string) => {
			await deleteDebt(id);
			syncQueue.schedule();
			await refresh();
		},
		[refresh]
	);

	const recordExtraPayment = useCallback(
		async (id: string, result: ExtraPaymentResult) => {
			const debt = debts.find((item) => item.id === id);
			if (!debt) return;
			const today = todayISO();
			const next = termsAfterExtraPayment(termsOf(debt), today, result);
			await updateDebt(id, {
				...draftOf(debt),
				openingBalanceCents: next.balanceCents,
				openingBalanceDate: next.balanceDate,
				installmentCents: next.installmentCents,
				remainingAtOpening: next.remaining,
				// Amortizou tudo: está quitada.
				archived: next.balanceCents <= 0 ? true : debt.archived,
			});
			syncQueue.schedule();
			await refresh();
		},
		[debts, refresh]
	);

	const activeDebts = useMemo(() => debts.filter((debt) => !debt.archived), [debts]);
	const summary = useMemo(
		() => summarizeDebts(activeDebts.map((debt) => ({ id: debt.id, name: debt.name, terms: termsOf(debt) })), todayISO()),
		[activeDebts]
	);

	const value = useMemo<DebtsContextType>(
		() => ({ debts, activeDebts, summary, isLoading, createDebt, saveDebt, removeDebt, recordExtraPayment, refresh }),
		[debts, activeDebts, summary, isLoading, createDebt, saveDebt, removeDebt, recordExtraPayment, refresh]
	);

	return <DebtsContext.Provider value={value}>{children}</DebtsContext.Provider>;
};

export const useDebts = (): DebtsContextType => {
	const context = useContext(DebtsContext);
	if (!context) throw new Error('useDebts must be used within a DebtsProvider');
	return context;
};

export default DebtsContext;
