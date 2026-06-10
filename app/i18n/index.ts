import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en';
import it from './locales/it';

i18n.use(initReactI18next).init({
	compatibilityJSON: 'v3', // required for Hermes / React Native
	resources: {
		en: { translation: en },
		it: { translation: it },
	},
	lng: 'en',
	fallbackLng: 'en',
	interpolation: {
		escapeValue: false, // React Native doesn't need XSS escaping
	},
});

export default i18n;
