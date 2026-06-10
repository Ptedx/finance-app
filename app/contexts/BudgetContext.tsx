import AsyncStorage from '@react-native-async-storage/async-storage';
import type React from 'react';
import { createContext, useContext, useEffect, useState } from 'react';
import { usePeriod } from './PeriodContext';

interface MonthlyBudget {
	year: number;
	month: number; // 1-12
	amount: number;
}

interface BudgetContextType {
	currentBudget: number | null;
	setBudgetForCurrentPeriod: (amount: number) => Promise<void>;
	clearBudgetForCurrentPeriod: () => Promise<void>;
}

const BudgetContext = createContext<BudgetContextType | undefined>(undefined);

export const BudgetProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
	const { selectedMonth, selectedYear } = usePeriod();
	const [budgets, setBudgets] = useState<MonthlyBudget[]>([]);
	const [currentBudget, setCurrentBudget] = useState<number | null>(null);

	// Load all budgets from storage on initial render
	useEffect(() => {
		const loadBudgets = async () => {
			try {
				const storedBudgets = await AsyncStorage.getItem('monthlyBudgets');
				if (storedBudgets) {
					setBudgets(JSON.parse(storedBudgets));
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

		setCurrentBudget(budget ? budget.amount : null);
	}, [selectedMonth, selectedYear, budgets]);

	// Save budget for current period
	const setBudgetForCurrentPeriod = async (amount: number) => {
		try {
			// Remove existing budget for this period if any
			const filteredBudgets = budgets.filter(
				(b) => !(b.year === selectedYear && b.month === selectedMonth)
			);

			// Add new budget
			const newBudgets = [...filteredBudgets, { year: selectedYear, month: selectedMonth, amount }];

			// Save to storage
			await AsyncStorage.setItem('monthlyBudgets', JSON.stringify(newBudgets));

			// Update state
			setBudgets(newBudgets);
		} catch (error) {
			console.error('Failed to save budget:', error);
		}
	};

	// Clear budget for current period
	const clearBudgetForCurrentPeriod = async () => {
		try {
			// Remove budget for this period
			const newBudgets = budgets.filter(
				(b) => !(b.year === selectedYear && b.month === selectedMonth)
			);

			// Save to storage
			await AsyncStorage.setItem('monthlyBudgets', JSON.stringify(newBudgets));

			// Update state
			setBudgets(newBudgets);
		} catch (error) {
			console.error('Failed to clear budget:', error);
		}
	};

	const value = {
		currentBudget,
		setBudgetForCurrentPeriod,
		clearBudgetForCurrentPeriod,
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
