import AsyncStorage from '@react-native-async-storage/async-storage';
import { getLocales } from 'expo-localization';
import i18next from 'i18next';
import type React from 'react';
import { createContext, useContext, useEffect, useState } from 'react';

export interface Language {
	code: string;
	name: string;
	nativeName: string;
}

export const AVAILABLE_LANGUAGES: Language[] = [
	{ code: 'en', name: 'English', nativeName: 'English' },
	{ code: 'it', name: 'Italian', nativeName: 'Italiano' },
];

const LANGUAGE_STORAGE_KEY = '@spendr_language';
const DEFAULT_LANGUAGE = AVAILABLE_LANGUAGES[0];

interface LanguageContextType {
	currentLanguage: Language;
	setLanguage: (lang: Language) => Promise<void>;
	availableLanguages: Language[];
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

export const LanguageProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
	const [currentLanguage, setCurrentLanguage] = useState<Language>(DEFAULT_LANGUAGE);

	useEffect(() => {
		const loadLanguage = async () => {
			try {
				const saved = await AsyncStorage.getItem(LANGUAGE_STORAGE_KEY);
				if (saved) {
					const lang = JSON.parse(saved) as Language;
					setCurrentLanguage(lang);
					await i18next.changeLanguage(lang.code);
				} else {
					// Auto-detect OS locale — only Italian is explicitly supported
					const deviceLocale = getLocales()[0]?.languageCode ?? 'en';
					const detected = deviceLocale === 'it' ? AVAILABLE_LANGUAGES[1] : DEFAULT_LANGUAGE;
					setCurrentLanguage(detected);
					await i18next.changeLanguage(detected.code);
				}
			} catch (error) {
				console.error('Failed to load language setting:', error);
			}
		};
		loadLanguage();
	}, []);

	const setLanguage = async (lang: Language) => {
		try {
			await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, JSON.stringify(lang));
			await i18next.changeLanguage(lang.code);
			setCurrentLanguage(lang);
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
