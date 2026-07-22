import { getLocales } from 'expo-localization';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en';
import it from './locales/it';

const resources = {
	en: { translation: en },
	it: { translation: it },
};

/**
 * The device's language, when the app has strings for it.
 *
 * `lng` was pinned to 'en', so the Italian bundle could never be reached. Languages
 * without a bundle fall back to English rather than showing raw keys.
 */
const detectLanguage = (): string => {
	try {
		const languageCode = getLocales()[0]?.languageCode;
		return languageCode && languageCode in resources ? languageCode : 'en';
	} catch {
		return 'en';
	}
};

i18n.use(initReactI18next).init({
	// `compatibilityJSON: 'v3'` used to be set here for Hermes builds without
	// Intl.PluralRules. Expo 55's Hermes ships Intl, and i18next v4 rejects the option.
	resources,
	lng: detectLanguage(),
	fallbackLng: 'en',
	interpolation: {
		escapeValue: false, // React Native doesn't need XSS escaping
	},
});

export default i18n;
