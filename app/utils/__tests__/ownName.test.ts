jest.mock('@react-native-async-storage/async-storage', () =>
	require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('../../database/database', () => ({ setPreference: jest.fn() }));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { setPreference } from '../../database/database';
import { cleanOwnName, isSameName, ownNamesOf } from '../ownName';
import { getOwnBankName, OWN_BANK_NAME_KEY, setOwnBankName } from '../ownNamePreference';
import {
	BACKED_UP_PREFERENCE_KEYS,
	exportPreferences,
	importPreferences,
	STORAGE_KEYS,
	SYNCED_PREFERENCE_KEYS,
} from '../storageUtils';

/**
 * "Seu nome como aparece no banco" (SPD-115). Nomes inventados: nenhum dado real entra aqui.
 */

beforeEach(async () => {
	await AsyncStorage.clear();
	(setPreference as jest.Mock).mockReset();
	(setPreference as jest.Mock).mockImplementation((key: string, value: string | null) =>
		value === null ? AsyncStorage.removeItem(key) : AsyncStorage.setItem(key, value)
	);
});

describe('o mesmo nome, escrito por bancos diferentes', () => {
	it.each([
		['MARIA S OLIVEIRA', 'Maria Souza Oliveira'],
		['MARIA SOUZA OLIVEIRA', 'Maria Souza Oliveira'],
		['MARCIA CONCEICAO ARAUJO', 'Márcia Conceição Araújo'],
		['MARIA S. OLIVEIRA', 'Maria Souza Oliveira'],
		['MARIA S DE OLIVEIRA', 'Maria Souza de Oliveira'],
		['MARIA SOUZA DE OLIVEIRA', 'Maria Souza Oliveira'],
		['  MARIA   S  OLIVEIRA ', 'maria s oliveira'],
		['ANA P R LIMA', 'Ana Paula Rocha Lima'],
		['Ana Paula Rocha Lima', 'ANA P R LIMA'],
	])('"%s" confere com "%s"', (seen, own) => {
		expect(isSameName(seen, own)).toBe(true);
	});
});

describe('na dúvida, não confere (o app pergunta)', () => {
	it.each([
		// Família: sobrenomes iguais, primeiro nome outro.
		['JOANA SOUZA OLIVEIRA', 'Maria Souza Oliveira'],
		// Um nome a menos: pode ser outra pessoa com nome e sobrenome iguais.
		['MARIA OLIVEIRA', 'Maria Souza Oliveira'],
		['MARIA S OLIVEIRA', 'Maria Oliveira'],
		// Um sobrenome a mais (o filho, o "Junior").
		['MARIA SOUZA OLIVEIRA SANTOS', 'Maria Souza Oliveira'],
		['CARLOS LIMA JUNIOR', 'Carlos Lima'],
		// A inicial não é a do nome do meio.
		['MARIA T OLIVEIRA', 'Maria Souza Oliveira'],
		['MARIA S OLIVEIRA', 'Maria T Oliveira'],
		// Sobrenome cortado pelo banco, primeiro nome abreviado.
		['MARIA SOUZA OLIVEI', 'Maria Souza Oliveira'],
		['M SOUZA OLIVEIRA', 'Maria Souza Oliveira'],
		// Último sobrenome trocado.
		['MARIA SOUZA LIMA', 'Maria Souza Oliveira'],
		// Uma palavra só nunca basta.
		['MARIA', 'Maria'],
		['MARIA', 'Maria Souza Oliveira'],
		['', 'Maria Souza Oliveira'],
		['Maria Souza Oliveira', ''],
	])('"%s" não confere com "%s"', (seen, own) => {
		expect(isSameName(seen, own)).toBe(false);
	});
});

describe('os nomes do usuário', () => {
	it('junta o nome da conta e o do banco, sem vazios nem repetidos', () => {
		expect(ownNamesOf([null, 'MARIA S OLIVEIRA'])).toEqual(['MARIA S OLIVEIRA']);
		expect(ownNamesOf(['Maria', undefined, '   '])).toEqual(['Maria']);
		expect(ownNamesOf(['Maria Souza', 'MARIA  SOUZA'])).toEqual(['Maria Souza']);
		expect(ownNamesOf(['Maria', 'MARIA S OLIVEIRA'])).toEqual(['Maria', 'MARIA S OLIVEIRA']);
	});

	it('o nome digitado é guardado sem espaço sobrando; vazio é nenhum', () => {
		expect(cleanOwnName('  MARIA   S  OLIVEIRA ')).toBe('MARIA S OLIVEIRA');
		expect(cleanOwnName('   ')).toBeNull();
	});
});

describe('onde o nome mora', () => {
	it('sem nada salvo, não há nome', async () => {
		expect(await getOwnBankName()).toBeNull();
	});

	it('salva limpo e relê o mesmo', async () => {
		expect(await setOwnBankName('  MARIA  S OLIVEIRA ')).toBe('MARIA S OLIVEIRA');
		expect(setPreference).toHaveBeenCalledWith(OWN_BANK_NAME_KEY, 'MARIA S OLIVEIRA');
		expect(await getOwnBankName()).toBe('MARIA S OLIVEIRA');
	});

	it('salvar vazio apaga', async () => {
		await setOwnBankName('MARIA S OLIVEIRA');
		expect(await setOwnBankName('  ')).toBeNull();
		expect(setPreference).toHaveBeenLastCalledWith(OWN_BANK_NAME_KEY, null);
		expect(await getOwnBankName()).toBeNull();
	});
});

describe('o nome vai com a conta e com o backup', () => {
	it('a chave é uma preferência que sobe no sync e vai no backup', () => {
		expect(STORAGE_KEYS.ownBankName).toBe(OWN_BANK_NAME_KEY);
		expect(SYNCED_PREFERENCE_KEYS).toContain(OWN_BANK_NAME_KEY);
		expect(BACKED_UP_PREFERENCE_KEYS).toContain(OWN_BANK_NAME_KEY);
	});

	it('o backup leva o nome e a restauração o devolve', async () => {
		await setOwnBankName('MARIA S OLIVEIRA');
		const exported = await exportPreferences();
		expect(exported[OWN_BANK_NAME_KEY]).toBe('MARIA S OLIVEIRA');

		await AsyncStorage.clear();
		expect(await getOwnBankName()).toBeNull();

		expect(await importPreferences(exported)).toBe(1);
		expect(await getOwnBankName()).toBe('MARIA S OLIVEIRA');
	});
});
