import AsyncStorage from '@react-native-async-storage/async-storage';
import { getLocales } from 'expo-localization';
import type React from 'react';
import { createContext, useContext, useEffect, useState } from 'react';
import { useAuth } from './AuthContext';
import { setPreference } from '../database/database';
import i18n, { appLanguage } from '../i18n';
import { onPreferencesChanged } from '../sync/preferenceEvents';
import * as syncQueue from '../sync/queue';
import { configureDateLocale } from '../utils/dateUtils';
import { resolveFormatLocale } from '../utils/locale';
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

/**
 * A moeda guardada no AsyncStorage, se for uma que o app conhece.
 *
 * O texto guardado é o objeto inteiro em JSON, mas só o código é levado a sério: desde o
 * v21 ele também chega pela rede (sync de preferências), e um símbolo vindo de fora não
 * pode virar a formatação de todo valor na tela. Código desconhecido ou JSON ilegível
 * contam como "nenhuma escolha".
 */
const resolveSavedCurrency = (saved: string | null): Currency | null => {
	if (!saved) return null;
	try {
		const code = (JSON.parse(saved) as Partial<Currency> | null)?.code;
		return AVAILABLE_CURRENCIES.find((currency) => currency.code === code) ?? null;
	} catch {
		return null;
	}
};

/**
 * O locale de números e datas: o idioma do app com a região do aparelho quando combina.
 * Um aparelho em português sempre vê "R$ 1.234,50" e "22/07", mesmo com região dos EUA.
 */
const detectFormatLocale = (): string => {
	try {
		return resolveFormatLocale(getLocales()[0]?.languageTag, i18n.language || appLanguage);
	} catch {
		return resolveFormatLocale(null, i18n.language || appLanguage);
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
			const formatLocale = detectFormatLocale();
			configureMoney({ locale: formatLocale });
			configureDateLocale(formatLocale);

			try {
				const savedCurrency = await AsyncStorage.getItem(STORAGE_KEYS.selectedCurrency);
				applyCurrency(resolveSavedCurrency(savedCurrency) ?? currentCurrency);
			} catch (error) {
				console.error('Failed to load currency setting:', error);
				applyCurrency(FALLBACK_CURRENCY);
			}
		};

		loadCurrency();
	}, []);

	// A moeda que chegou pelo sync (outro aparelho escolheu depois) vale na hora. O pull
	// já gravou no AsyncStorage; aqui só se relê e aplica — não é uma escolha nova, então
	// nada sobe de volta nem vai para o perfil. Lápide = a moeda do aparelho.
	// biome-ignore lint/correctness/useExhaustiveDependencies: applyCurrency só usa setters estáveis
	useEffect(
		() =>
			onPreferencesChanged((keys) => {
				if (!keys.includes(STORAGE_KEYS.selectedCurrency)) return;
				AsyncStorage.getItem(STORAGE_KEYS.selectedCurrency)
					.then((saved) => applyCurrency(resolveSavedCurrency(saved) ?? detectDeviceCurrency()))
					.catch((error) => console.warn('Failed to apply the synced currency:', error));
			}),
		[]
	);

	const setCurrency = async (currency: Currency) => {
		try {
			// AsyncStorage (de onde se lê) e a linha suja da coleção `preferences`, que leva
			// a escolha para os outros aparelhos da conta (v21).
			await setPreference(STORAGE_KEYS.selectedCurrency, JSON.stringify(currency));
			applyCurrency(currency);
			syncQueue.schedule();

			// O perfil também guarda a moeda (`baseCurrency`), para o servidor saber dela.
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
