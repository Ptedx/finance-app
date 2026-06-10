import type React from 'react';
import { createContext, useContext, useEffect, useState } from 'react';
import { getCurrentMonthRange, getMonthName, getMonthRange } from '../utils/dateUtils';

interface PeriodContextType {
	// Current selected period
	selectedMonth: number;
	selectedYear: number;

	// Period range (for database queries)
	startDate: string;
	endDate: string;

	// Formatted month name
	selectedMonthName: string;

	// Actions
	setSelectedPeriod: (month: number, year: number) => void;
	resetToCurrentMonth: () => void;
}

const PeriodContext = createContext<PeriodContextType | undefined>(undefined);

export const PeriodProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
	// Initialize with current month and year
	const currentDate = new Date();
	const [selectedMonth, setSelectedMonth] = useState(currentDate.getMonth() + 1); // 1-12 format
	const [selectedYear, setSelectedYear] = useState(currentDate.getFullYear());
	const [dateRange, setDateRange] = useState(getCurrentMonthRange());

	// Update date range when month/year changes
	useEffect(() => {
		const range = getMonthRange(selectedMonth, selectedYear);
		setDateRange(range);
	}, [selectedMonth, selectedYear]);

	const setSelectedPeriod = (month: number, year: number) => {
		setSelectedMonth(month);
		setSelectedYear(year);
	};

	const resetToCurrentMonth = () => {
		const now = new Date();
		setSelectedMonth(now.getMonth() + 1);
		setSelectedYear(now.getFullYear());
	};

	const value = {
		selectedMonth,
		selectedYear,
		startDate: dateRange.startDate,
		endDate: dateRange.endDate,
		selectedMonthName: getMonthName(selectedMonth).toUpperCase(),
		setSelectedPeriod,
		resetToCurrentMonth,
	};

	return <PeriodContext.Provider value={value}>{children}</PeriodContext.Provider>;
};

export const usePeriod = () => {
	const context = useContext(PeriodContext);
	if (context === undefined) {
		throw new Error('usePeriod must be used within a PeriodProvider');
	}
	return context;
};

export default PeriodContext;
