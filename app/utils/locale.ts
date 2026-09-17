/**
 * Qual formato de número e data o app usa, e o plano B quando o `Intl` não ajuda.
 *
 * O formato segue o **idioma do app**, não só a região do aparelho: texto em português
 * com "R$3,832.80" e "Sep 16" é o pior dos mundos. Um aparelho em português com região
 * dos EUA (ou sem região) ainda vê "R$ 3.832,80" e "16/09".
 *
 * Plano B: alguns motores JS no Android vêm com `Intl` reduzido e respondem em inglês
 * qualquer que seja o locale pedido. `intlHonours` detecta isso comparando o separador
 * decimal que o `Intl` devolve com o esperado para o idioma, e quem formata cai para
 * uma formatação manual — que, para os três idiomas do app, é conhecida e fixa.
 */

export type FormatLanguage = 'pt' | 'en' | 'it';

/** O locale de formatação para o idioma do app, preferindo a região do aparelho quando combina. */
export const resolveFormatLocale = (deviceTag: string | null | undefined, appLanguage: string | null | undefined): string => {
	const language = (appLanguage ?? '').slice(0, 2).toLowerCase();
	const tag = deviceTag ?? '';
	const sameLanguage = tag.toLowerCase().startsWith(`${language}-`);

	switch (language) {
		// Português de Portugal só quando o aparelho diz isso; o texto é pt-BR.
		case 'pt':
			return sameLanguage && /^pt-PT\b/i.test(tag) ? 'pt-PT' : 'pt-BR';
		case 'it':
			return sameLanguage ? tag : 'it-IT';
		case 'en':
			return sameLanguage ? tag : 'en-US';
		default:
			return tag || 'en-US';
	}
};

export const languageOf = (locale: string): FormatLanguage => {
	const language = locale.slice(0, 2).toLowerCase();
	return language === 'pt' || language === 'it' ? language : 'en';
};

/** Separadores esperados por idioma: o que o manual usa e o que confere o `Intl`. */
export const SEPARATORS: Record<FormatLanguage, { group: string; decimal: string }> = {
	pt: { group: '.', decimal: ',' },
	it: { group: '.', decimal: ',' },
	en: { group: ',', decimal: '.' },
};

const honoursCache = new Map<string, boolean>();

/**
 * Se o `Intl` deste motor formata mesmo no locale pedido. Só dá para afirmar nos
 * idiomas do app; para os outros confia no `Intl`.
 */
export const intlHonours = (locale: string): boolean => {
	const cached = honoursCache.get(locale);
	if (cached !== undefined) return cached;

	let honours = true;
	const language = locale.slice(0, 2).toLowerCase();
	if (language === 'pt' || language === 'it' || language === 'en') {
		try {
			const decimal = new Intl.NumberFormat(locale).formatToParts(1.5).find((part) => part.type === 'decimal')?.value;
			honours = decimal === SEPARATORS[languageOf(locale)].decimal;
		} catch {
			honours = false;
		}
	}
	honoursCache.set(locale, honours);
	return honours;
};

/** Agrupa dígitos inteiros de três em três com o separador dado. */
export const groupDigits = (digits: string, separator: string): string =>
	digits.replace(/\B(?=(\d{3})+(?!\d))/g, separator);

const MONTHS_LONG: Record<FormatLanguage, string[]> = {
	pt: ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'],
	it: ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'],
	en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
};

/** Nome do mês (1-12) no idioma, sem depender do `Intl`. */
export const monthLong = (language: FormatLanguage, month: number): string => MONTHS_LONG[language][month - 1] ?? '';

/** "set", "Sep", "set": três letras, como os bancos escrevem nas faturas. */
export const monthShort = (language: FormatLanguage, month: number): string => monthLong(language, month).slice(0, 3);
