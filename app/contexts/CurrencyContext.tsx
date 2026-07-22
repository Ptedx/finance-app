import AsyncStorage from '@react-native-async-storage/async-storage';
import { getLocales } from 'expo-localization';
import type React from 'react';
import { createContext, useContext, useEffect, useState } from 'react';
import { useAuth } from './AuthContext';
import { configureDateLocale } from '../utils/dateUtils';
import { configureMoney } from '../utils/money';
import { STORAGE_KEYS } from '../utils/storageUtils';

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

const FALLBACK_CURRENCY: Currency = { code: 'USD', symbol: '$', name: 'US Dollar' };

/**
 * The device's own currency, when the app knows it.
 *
 * The previous default was `AVAILABLE_CURRENCIES[0]` — which is Bitcoin, an accident of
 * array order rather than a decision. A Brazilian phone should open the app in reais.
 */
const detectDeviceCurrency = (): Currency => {
	try {
		const deviceCode = getLocales()[0]?.currencyCode;
		return AVAILABLE_CURRENCIES.find((c) => c.code === deviceCode) ?? FALLBACK_CURRENCY;
	} catch {
		return FALLBACK_CURRENCY;
	}
};

/** The device's language tag, which drives number and date formatting. */
const detectDeviceLocale = (): string => {
	try {
		return getLocales()[0]?.languageTag ?? 'en-US';
	} catch {
		return 'en-US';
	}
};

interface CurrencyContextType {
	currentCurrency: Currency;
	setCurrency: (currency: Currency) => Promise<void>;
	availableCurrencies: Currency[];
}

const CurrencyContext = createContext<CurrencyContextType | undefined>(undefined);

export const CurrencyProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
	const { syncProfilePreferences } = useAuth();
	const [currentCurrency, setCurrentCurrency] = useState<Currency>(detectDeviceCurrency);

	const applyCurrency = (currency: Currency) => {
		setCurrentCurrency(currency);
		configureMoney({ currencyCode: currency.code, currencySymbol: currency.symbol });
	};

	// Load saved currency setting
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs once to seed formatting config
	useEffect(() => {
		const loadCurrency = async () => {
			// Number and date formatting follow the device, so a Brazilian phone sees
			// "R$ 1.234,50" and "22 de julho" rather than the hardcoded en-US shapes.
			const deviceLocale = detectDeviceLocale();
			configureMoney({ locale: deviceLocale });
			configureDateLocale(deviceLocale);

			try {
				const savedCurrency = await AsyncStorage.getItem(STORAGE_KEYS.selectedCurrency);
				applyCurrency(savedCurrency ? (JSON.parse(savedCurrency) as Currency) : currentCurrency);
			} catch (error) {
				console.error('Failed to load currency setting:', error);
				applyCurrency(FALLBACK_CURRENCY);
			}
		};

		loadCurrency();
	}, []);

	const setCurrency = async (currency: Currency) => {
		try {
			await AsyncStorage.setItem(STORAGE_KEYS.selectedCurrency, JSON.stringify(currency));
			applyCurrency(currency);

			// A moeda é uma preferência do perfil, não uma linha sincronizável: um único
			// valor, sem histórico e sem conflito de linha. O AsyncStorage segue como
			// cache local para a escolha valer antes mesmo de haver rede.
			syncProfilePreferences({ baseCurrency: currency.code });
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
