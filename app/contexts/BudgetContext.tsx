import AsyncStorage from '@react-native-async-storage/async-storage';
import type React from 'react';
import { createContext, useContext, useEffect, useState } from 'react';
import { convertCents } from '../utils/money';
import { STORAGE_KEYS } from '../utils/storageUtils';
import { usePeriod } from './PeriodContext';

const STORAGE_KEY = STORAGE_KEYS.budgets;

interface MonthlyBudget {
	year: number;
	month: number; // 1-12
	/** Integer cents, matching every other monetary value in the app. */
	amountCents: number;
}

/** Shape written before budgets moved to integer cents. */
interface LegacyMonthlyBudget {
	year: number;
	month: number;
	amount: number;
}

interface BudgetContextType {
	/** Budget for the selected period, in cents, or null when none is set. */
	currentBudgetCents: number | null;
	setBudgetForCurrentPeriod: (amountCents: number) => Promise<void>;
	clearBudgetForCurrentPeriod: () => Promise<void>;
	/** Rescales every stored budget when the ledger's currency changes. */
	convertBudgets: (rate: number) => Promise<void>;
}

/** Reads stored budgets, upgrading any entry still holding a float major-unit amount. */
const parseStoredBudgets = (raw: string): MonthlyBudget[] => {
	const parsed = JSON.parse(raw) as Array<MonthlyBudget | LegacyMonthlyBudget>;

	if (!Array.isArray(parsed)) return [];

	return parsed.map((budget) =>
		'amountCents' in budget
			? budget
			: {
					year: budget.year,
					month: budget.month,
					amountCents: Math.round(budget.amount * 100),
				}
	);
};

const BudgetContext = createContext<BudgetContextType | undefined>(undefined);

export const BudgetProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
	const { selectedMonth, selectedYear } = usePeriod();
	const [budgets, setBudgets] = useState<MonthlyBudget[]>([]);
	const [currentBudgetCents, setCurrentBudgetCents] = useState<number | null>(null);

	// Load all budgets from storage on initial render
	useEffect(() => {
		const loadBudgets = async () => {
			try {
				const storedBudgets = await AsyncStorage.getItem(STORAGE_KEY);
				if (storedBudgets) {
					setBudgets(parseStoredBudgets(storedBudgets));
				}
			} catch (error) {
				console.error('Failed to load budgets:', error);
			}
		};

		loadBudgets();
	}, []);

	// Update current budget when period or budgets change
	useEffect(() => {
		const budget = budgets.find((b) => b.year === selectedYear && b.month === selectedMonth);

		setCurrentBudgetCents(budget ? budget.amountCents : null);
	}, [selectedMonth, selectedYear, budgets]);

	const persist = async (nextBudgets: MonthlyBudget[]) => {
		await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(nextBudgets));
		setBudgets(nextBudgets);
	};

	const withoutCurrentPeriod = () =>
		budgets.filter((b) => !(b.year === selectedYear && b.month === selectedMonth));

	const setBudgetForCurrentPeriod = async (amountCents: number) => {
		try {
			await persist([
				...withoutCurrentPeriod(),
				{ year: selectedYear, month: selectedMonth, amountCents },
			]);
		} catch (error) {
			console.error('Failed to save budget:', error);
		}
	};

	const convertBudgets = async (rate: number) => {
		if (budgets.length === 0) return;
		await persist(budgets.map((b) => ({ ...b, amountCents: convertCents(b.amountCents, rate) })));
	};

	const clearBudgetForCurrentPeriod = async () => {
		try {
			await persist(withoutCurrentPeriod());
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
