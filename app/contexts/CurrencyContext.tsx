import AsyncStorage from '@react-native-async-storage/async-storage';
import type React from 'react';
import { createContext, useContext, useEffect, useState } from 'react';
import { setCurrencyForFormatting } from '../utils/currencyUtils';

// Define currency interface
export interface Currency {
	code: string;
	symbol: string;
	name: string;
}

// Available currencies
export const AVAILABLE_CURRENCIES: Currency[] = [
	{ code: 'BTC', symbol: '₿', name: 'Bitcoin' },
	{ code: 'USD', symbol: '$', name: 'US Dollar' },
	{ code: 'EUR', symbol: '€', name: 'Euro' },
	{ code: 'GBP', symbol: '£', name: 'British Pound' },
	{ code: 'JPY', symbol: '¥', name: 'Japanese Yen' },
	{ code: 'CAD', symbol: 'C$', name: 'Canadian Dollar' },
	{ code: 'AUD', symbol: 'A$', name: 'Australian Dollar' },
	{ code: 'CHF', symbol: 'Fr', name: 'Swiss Franc' },
	{ code: 'CNY', symbol: '¥', name: 'Chinese Yuan' },
	{ code: 'INR', symbol: '₹', name: 'Indian Rupee' },
	{ code: 'BRL', symbol: 'R$', name: 'Brazilian Real' },
];

// Default to BTC
const DEFAULT_CURRENCY = AVAILABLE_CURRENCIES[0];

interface CurrencyContextType {
	currentCurrency: Currency;
	setCurrency: (currency: Currency) => Promise<void>;
	availableCurrencies: Currency[];
}

const CurrencyContext = createContext<CurrencyContextType | undefined>(undefined);

export const CurrencyProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
	const [currentCurrency, setCurrentCurrency] = useState<Currency>(DEFAULT_CURRENCY);

	// Load saved currency setting
	useEffect(() => {
		const loadCurrency = async () => {
			try {
				const savedCurrency = await AsyncStorage.getItem('selectedCurrency');
				if (savedCurrency) {
					const currency = JSON.parse(savedCurrency);
					setCurrentCurrency(currency);
					// Update currency utils
					setCurrencyForFormatting(currency.code, currency.symbol);
				} else {
					// Set default currency in utils
					setCurrencyForFormatting(DEFAULT_CURRENCY.code, DEFAULT_CURRENCY.symbol);
				}
			} catch (error) {
				console.error('Failed to load currency setting:', error);
			}
		};

		loadCurrency();
	}, []);

	const setCurrency = async (currency: Currency) => {
		try {
			await AsyncStorage.setItem('selectedCurrency', JSON.stringify(currency));
			setCurrentCurrency(currency);
			// Update currency utils when currency changes
			setCurrencyForFormatting(currency.code, currency.symbol);
		} catch (error) {
			console.error('Failed to save currency setting:', error);
		}
	};

	const value = {
		currentCurrency,
		setCurrency,
		availableCurrencies: AVAILABLE_CURRENCIES,
	};

	return <CurrencyContext.Provider value={value}>{children}</CurrencyContext.Provider>;
};

export const useCurrency = () => {
	const context = useContext(CurrencyContext);
	if (context === undefined) {
		throw new Error('useCurrency must be used within a CurrencyProvider');
	}
	return context;
};

export default CurrencyContext;
