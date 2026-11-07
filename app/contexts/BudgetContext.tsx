import type React from 'react';
import { createContext, useContext, useEffect, useState } from 'react';
import { clearBudget, getBudgets, initDatabase, setBudget } from '../database/database';
import type { Budget } from '../database/schema';
import { useAfterPull } from '../hooks/useAfterPull';
import * as syncQueue from '../sync/queue';
import { usePeriod } from './PeriodContext';

/**
 * O orçamento que vale num mês: o do próprio mês ou, sem ele, o último definido antes.
 *
 * Definir o orçamento em novembro e ver "Nenhum orçamento" em dezembro obrigava a
 * redefinir todo mês. Agora um orçamento vale do mês em que foi definido até o próximo
 * definido, sem gravar nada nos meses do meio: mudar em janeiro muda de janeiro em diante e
 * deixa novembro e dezembro como estavam. Não vale para trás.
 */
export const budgetForMonth = (
	budgets: Budget[],
	year: number,
	month: number
): { amountCents: number; year: number; month: number; inherited: boolean } | null => {
	const target = year * 12 + month;
	let best: Budget | null = null;
	for (const budget of budgets) {
		const key = budget.year * 12 + budget.month;
		if (key > target) continue;
		if (!best || key > best.year * 12 + best.month) best = budget;
	}
	if (!best) return null;
	return {
		amountCents: best.amountCents,
		year: best.year,
		month: best.month,
		inherited: best.year !== year || best.month !== month,
	};
};

interface BudgetContextType {
	/**
	 * Budget for the selected period, in cents, or null when none is set — o do próprio mês
	 * ou o herdado do último mês com orçamento (`budgetForMonth`).
	 */
	currentBudgetCents: number | null;
	/** De que mês vem o orçamento quando o mês escolhido não tem um próprio; null se tem. */
	budgetInheritedFrom: { year: number; month: number } | null;
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
	const [budgetInheritedFrom, setBudgetInheritedFrom] = useState<{ year: number; month: number } | null>(null);

	const reload = async () => {
		try {
			// Mesma razão do `RecurringTransactionsContext`: este provider lê o banco no
			// mount, antes do efeito do pai. `initDatabase` é single-flight.
			await initDatabase();
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
		const budget = budgetForMonth(budgets, selectedYear, selectedMonth);

		setCurrentBudgetCents(budget ? budget.amountCents : null);
		setBudgetInheritedFrom(budget?.inherited ? { year: budget.year, month: budget.month } : null);
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

	// Limpar apaga só o orçamento do próprio mês: se houver um anterior, o mês volta a
	// herdá-lo. Num mês que só herda não há o que apagar (a folha nem oferece).
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
		budgetInheritedFrom,
		setBudgetForCurrentPeriod,
		clearBudgetForCurrentPeriod,
		convertBudgets,
	};

	// O que o sync baixou da conta só aparece se a tela reler o banco.
	useAfterPull(reload);

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
