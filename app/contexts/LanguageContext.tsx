import AsyncStorage from '@react-native-async-storage/async-storage';
import { getLocales } from 'expo-localization';
import i18next from 'i18next';
import { setPreference } from '../database/database';
import { onPreferencesChanged } from '../sync/preferenceEvents';
import * as syncQueue from '../sync/queue';
import { STORAGE_KEYS } from '../utils/storageUtils';
import type React from 'react';
import { createContext, useContext, useEffect, useState } from 'react';

import { useAuth } from './AuthContext';

export interface Language {
	code: string;
	name: string;
	nativeName: string;
}

export const AVAILABLE_LANGUAGES: Language[] = [
	{ code: 'en', name: 'English', nativeName: 'English' },
	{ code: 'pt', name: 'Portuguese', nativeName: 'Português' },
	{ code: 'it', name: 'Italian', nativeName: 'Italiano' },
];

const LANGUAGE_STORAGE_KEY = STORAGE_KEYS.language;
const DEFAULT_LANGUAGE = AVAILABLE_LANGUAGES[0];

/** Idioma do aparelho, quando o app tem strings para ele; inglês se não tem. */
const detectDeviceLanguage = (): Language => {
	const deviceLocale = getLocales()[0]?.languageCode ?? 'en';
	return AVAILABLE_LANGUAGES.find((language) => language.code === deviceLocale) ?? DEFAULT_LANGUAGE;
};

/**
 * O idioma guardado, se for um que o app tem. Desde o v21 ele também chega pela rede (sync
 * de preferências): só o código conta, e um código sem strings no app não troca nada.
 */
const resolveSavedLanguage = (saved: string | null): Language | null => {
	if (!saved) return null;
	try {
		const code = (JSON.parse(saved) as Partial<Language> | null)?.code;
		return AVAILABLE_LANGUAGES.find((language) => language.code === code) ?? null;
	} catch {
		return null;
	}
};

interface LanguageContextType {
	currentLanguage: Language;
	setLanguage: (lang: Language) => Promise<void>;
	availableLanguages: Language[];
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

export const LanguageProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
	const { syncProfilePreferences } = useAuth();
	const [currentLanguage, setCurrentLanguage] = useState<Language>(DEFAULT_LANGUAGE);

	useEffect(() => {
		const loadLanguage = async () => {
			try {
				const saved = resolveSavedLanguage(await AsyncStorage.getItem(LANGUAGE_STORAGE_KEY));
				const lang = saved ?? detectDeviceLanguage();
				setCurrentLanguage(lang);
				await i18next.changeLanguage(lang.code);
			} catch (error) {
				console.error('Failed to load language setting:', error);
			}
		};
		loadLanguage();
	}, []);

	// O idioma que chegou pelo sync vale na hora, como a moeda (`CurrencyContext`): o pull
	// já gravou no AsyncStorage, e aplicar não é escolher — nada sobe de volta. Lápide = o
	// idioma do aparelho.
	useEffect(
		() =>
			onPreferencesChanged((keys) => {
				if (!keys.includes(LANGUAGE_STORAGE_KEY)) return;
				AsyncStorage.getItem(LANGUAGE_STORAGE_KEY)
					.then(async (saved) => {
						const lang = resolveSavedLanguage(saved) ?? detectDeviceLanguage();
						await i18next.changeLanguage(lang.code);
						setCurrentLanguage(lang);
					})
					.catch((error) => console.warn('Failed to apply the synced language:', error));
			}),
		[]
	);

	const setLanguage = async (lang: Language) => {
		try {
			// AsyncStorage e a linha suja de `preferences` (v21), que leva a escolha para os
			// outros aparelhos da conta.
			await setPreference(LANGUAGE_STORAGE_KEY, JSON.stringify(lang));
			await i18next.changeLanguage(lang.code);
			setCurrentLanguage(lang);
			syncQueue.schedule();

			// O perfil também guarda o idioma, para o servidor saber dele.
			syncProfilePreferences({ language: lang.code });
		} catch (error) {
			console.error('Failed to save language setting:', error);
		}
	};

	return (
		<LanguageContext.Provider
			value={{ currentLanguage, setLanguage, availableLanguages: AVAILABLE_LANGUAGES }}
		>
			{children}
		</LanguageContext.Provider>
	);
};

export const useLanguage = () => {
	const context = useContext(LanguageContext);
	if (context === undefined) {
		throw new Error('useLanguage must be used within a LanguageProvider');
	}
	return context;
};

export default LanguageContext;
