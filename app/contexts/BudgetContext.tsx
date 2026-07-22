import type React from 'react';
import { createContext, useContext, useEffect, useState } from 'react';
import { clearBudget, getBudgets, setBudget } from '../database/database';
import type { Budget } from '../database/schema';
import * as syncQueue from '../sync/queue';
import { usePeriod } from './PeriodContext';

interface BudgetContextType {
	/** Budget for the selected period, in cents, or null when none is set. */
	currentBudgetCents: number | null;
	setBudgetForCurrentPeriod: (amountCents: number) => Promise<void>;
	clearBudgetForCurrentPeriod: () => Promise<void>;
	/**
	 * Rescales every stored budget when the ledger's currency changes.
	 *
	 * The rescaling itself now happens in SQL, alongside the transactions', so the two
	 * cannot end up converted at different rates. This only refreshes what is on screen.
	 */
	convertBudgets: (rate: number) => Promise<void>;
}

const BudgetContext = createContext<BudgetContextType | undefined>(undefined);

export const BudgetProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
	const { selectedMonth, selectedYear } = usePeriod();
	const [budgets, setBudgets] = useState<Budget[]>([]);
	const [currentBudgetCents, setCurrentBudgetCents] = useState<number | null>(null);

	const reload = async () => {
		try {
			setBudgets(await getBudgets());
		} catch (error) {
			console.error('Failed to load budgets:', error);
		}
	};

	// Budgets live in SQLite from schema v4 on; the migration imports whatever was in
	// AsyncStorage, so an upgrading install finds its months already here.
	useEffect(() => {
		reload();
	}, []);

	// Update current budget when period or budgets change
	useEffect(() => {
		const budget = budgets.find((b) => b.year === selectedYear && b.month === selectedMonth);

		setCurrentBudgetCents(budget ? budget.amountCents : null);
	}, [selectedMonth, selectedYear, budgets]);

	const setBudgetForCurrentPeriod = async (amountCents: number) => {
		try {
			await setBudget(selectedYear, selectedMonth, amountCents);
			await reload();
			syncQueue.schedule();
		} catch (error) {
			console.error('Failed to save budget:', error);
		}
	};

	const convertBudgets = async (_rate: number) => {
		await reload();
	};

	const clearBudgetForCurrentPeriod = async () => {
		try {
			await clearBudget(selectedYear, selectedMonth);
			await reload();
			syncQueue.schedule();
		} catch (error) {
			console.error('Failed to clear budget:', error);
		}
	};

	const value = {
		currentBudgetCents,
		setBudgetForCurrentPeriod,
		clearBudgetForCurrentPeriod,
		convertBudgets,
	};

	return <BudgetContext.Provider value={value}>{children}</BudgetContext.Provider>;
};

export const useBudget = () => {
	const context = useContext(BudgetContext);
	if (context === undefined) {
		throw new Error('useBudget must be used within a BudgetProvider');
	}
	return context;
};

export default BudgetContext;
