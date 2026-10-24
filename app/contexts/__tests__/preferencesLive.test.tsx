/**
 * A moeda e o idioma que chegam pelo sync valem na hora, sem reiniciar o app.
 *
 * O pull grava a preferência no AsyncStorage e avisa (`sync/preferences.ts`); os dois
 * contexts escutam, releem e aplicam. Aplicar o que veio da conta **não** é uma escrita:
 * nada é marcado para subir de volta, e o perfil não é atualizado de novo.
 *
 * E o caminho contrário: escolher a moeda ou o idioma grava a linha suja e pede um sync.
 */

const mockStorage = new Map<string, string>();
const mockSyncProfile = jest.fn();

jest.mock('@react-native-async-storage/async-storage', () => ({
	getItem: jest.fn(async (key: string) => mockStorage.get(key) ?? null),
	setItem: jest.fn(async (key: string, value: string) => {
		mockStorage.set(key, value);
	}),
	removeItem: jest.fn(async (key: string) => {
		mockStorage.delete(key);
	}),
}));

jest.mock('expo-localization', () => ({
	getLocales: () => [{ currencyCode: 'BRL', languageCode: 'pt', languageTag: 'pt-BR' }],
}));

jest.mock('i18next', () => ({
	__esModule: true,
	default: { changeLanguage: jest.fn(async () => undefined), language: 'pt' },
}));

jest.mock('../../i18n', () => ({
	__esModule: true,
	default: { language: 'pt' },
	appLanguage: 'pt',
}));

jest.mock('../../utils/money', () => ({ configureMoney: jest.fn() }));
jest.mock('../../utils/dateUtils', () => ({ configureDateLocale: jest.fn() }));

jest.mock('../AuthContext', () => ({
	useAuth: () => ({ syncProfilePreferences: mockSyncProfile }),
}));

jest.mock('../../database/database', () => ({
	setPreference: jest.fn(async (key: string, value: string | null) => {
		if (value === null) mockStorage.delete(key);
		else mockStorage.set(key, value);
	}),
}));

jest.mock('../../sync/queue', () => ({ schedule: jest.fn() }));

import i18next from 'i18next';
import { act, create } from 'react-test-renderer';
import { setPreference } from '../../database/database';
import { emitPreferencesChanged } from '../../sync/preferenceEvents';
import * as syncQueue from '../../sync/queue';
import { configureMoney } from '../../utils/money';
import { STORAGE_KEYS } from '../../utils/storageUtils';
import { AVAILABLE_CURRENCIES, CurrencyProvider, useCurrency } from '../CurrencyContext';
import { AVAILABLE_LANGUAGES, LanguageProvider, useLanguage } from '../LanguageContext';

const USD = AVAILABLE_CURRENCIES.find((currency) => currency.code === 'USD');
const ITALIAN = AVAILABLE_LANGUAGES.find((language) => language.code === 'it');

type CurrencyApi = ReturnType<typeof useCurrency>;
type LanguageApi = ReturnType<typeof useLanguage>;

const mount = async (): Promise<{ currency: () => CurrencyApi; language: () => LanguageApi }> => {
	let currency: CurrencyApi | null = null;
	let language: LanguageApi | null = null;
	const Probe = () => {
		currency = useCurrency();
		language = useLanguage();
		return null;
	};

	await act(async () => {
		create(
			<LanguageProvider>
				<CurrencyProvider>
					<Probe />
				</CurrencyProvider>
			</LanguageProvider>
		);
	});

	return {
		currency: () => currency as unknown as CurrencyApi,
		language: () => language as unknown as LanguageApi,
	};
};

/** O que o pull faz: grava no AsyncStorage e avisa quais chaves chegaram. */
const pulled = async (key: string, value: string | null) => {
	if (value === null) mockStorage.delete(key);
	else mockStorage.set(key, value);
	await act(async () => {
		emitPreferencesChanged([key]);
		// Os contexts releem o AsyncStorage, que é assíncrono.
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
};

beforeEach(() => {
	mockStorage.clear();
	jest.clearAllMocks();
});

describe('a moeda que chega da conta', () => {
	it('vale na hora, sem subir de volta nem mexer no perfil', async () => {
		const api = await mount();
		expect(api.currency().currentCurrency.code).toBe('BRL');

		await pulled(STORAGE_KEYS.selectedCurrency, JSON.stringify(USD));

		expect(api.currency().currentCurrency.code).toBe('USD');
		expect(configureMoney).toHaveBeenLastCalledWith({ currencyCode: 'USD', currencySymbol: '$' });
		expect(setPreference).not.toHaveBeenCalled();
		expect(mockSyncProfile).not.toHaveBeenCalled();
	});

	it('a lápide volta para a moeda do aparelho', async () => {
		mockStorage.set(STORAGE_KEYS.selectedCurrency, JSON.stringify(USD));
		const api = await mount();
		expect(api.currency().currentCurrency.code).toBe('USD');

		await pulled(STORAGE_KEYS.selectedCurrency, null);

		expect(api.currency().currentCurrency.code).toBe('BRL');
	});

	it('uma moeda que o app não conhece não vira formatação: fica a do aparelho', async () => {
		const api = await mount();
		await pulled(STORAGE_KEYS.selectedCurrency, '{"code":"XXX","symbol":"<b>"}');
		expect(api.currency().currentCurrency.code).toBe('BRL');
	});

	it('aviso de outra chave não mexe na moeda', async () => {
		const api = await mount();
		mockStorage.set(STORAGE_KEYS.selectedCurrency, JSON.stringify(USD));
		await pulled(STORAGE_KEYS.cdiRate, '{"annualBp":1490}');
		expect(api.currency().currentCurrency.code).toBe('BRL');
	});

	it('escolher a moeda grava a preferência suja e pede um sync', async () => {
		const api = await mount();

		await act(async () => {
			await api.currency().setCurrency(USD as NonNullable<typeof USD>);
		});

		expect(setPreference).toHaveBeenCalledWith(STORAGE_KEYS.selectedCurrency, JSON.stringify(USD));
		expect(syncQueue.schedule).toHaveBeenCalled();
		expect(mockSyncProfile).toHaveBeenCalledWith({ baseCurrency: 'USD' });
	});
});

describe('o idioma que chega da conta', () => {
	it('troca o idioma na hora, sem subir de volta', async () => {
		const api = await mount();
		expect(api.language().currentLanguage.code).toBe('pt');

		await pulled(STORAGE_KEYS.language, JSON.stringify(ITALIAN));

		expect(api.language().currentLanguage.code).toBe('it');
		expect(i18next.changeLanguage).toHaveBeenLastCalledWith('it');
		expect(setPreference).not.toHaveBeenCalled();
	});

	it('escolher o idioma grava a preferência suja e pede um sync', async () => {
		const api = await mount();

		await act(async () => {
			await api.language().setLanguage(ITALIAN as NonNullable<typeof ITALIAN>);
		});

		expect(setPreference).toHaveBeenCalledWith(STORAGE_KEYS.language, JSON.stringify(ITALIAN));
		expect(syncQueue.schedule).toHaveBeenCalled();
	});
});
