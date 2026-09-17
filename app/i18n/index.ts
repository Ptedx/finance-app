import { getLocales } from 'expo-localization';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en';
import it from './locales/it';
import pt from './locales/pt';
import { configureDateLocale } from '../utils/dateUtils';
import { resolveFormatLocale } from '../utils/locale';
import { configureMoney } from '../utils/money';

const resources = {
	en: { translation: en },
	it: { translation: it },
	// Registrado como 'pt': `getLocales()[0].languageCode` devolve 'pt' tanto para pt-BR
	// quanto para pt-PT, e o texto foi escrito em português do Brasil.
	pt: { translation: pt },
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

/**
 * O idioma escolhido, disponível já na carga do módulo. `i18n.language` não serve aqui:
 * o i18next inicializa de forma assíncrona e o valor ainda está vazio neste ponto — era
 * por isso que datas e dinheiro às vezes saíam no formato americano.
 */
export const appLanguage = detectLanguage();

i18n.use(initReactI18next).init({
	// `compatibilityJSON: 'v3'` used to be set here for Hermes builds without
	// Intl.PluralRules. Expo 55's Hermes ships Intl, and i18next v4 rejects the option.
	resources,
	lng: appLanguage,
	fallbackLng: 'en',
	interpolation: {
		escapeValue: false, // React Native doesn't need XSS escaping
	},
});

// Formatação configurada já na carga do módulo: as telas que desenham antes do
// CurrencyProvider terminar de ler a moeda salva também saem no formato do idioma.
try {
	const formatLocale = resolveFormatLocale(getLocales()[0]?.languageTag, appLanguage);
	configureMoney({ locale: formatLocale });
	configureDateLocale(formatLocale);
} catch {
	const formatLocale = resolveFormatLocale(null, appLanguage);
	configureMoney({ locale: formatLocale });
	configureDateLocale(formatLocale);
}

export default i18n;
