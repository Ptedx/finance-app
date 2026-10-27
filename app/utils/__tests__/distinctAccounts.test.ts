jest.mock('@react-native-async-storage/async-storage', () =>
	require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('../../database/database', () => ({ setPreference: jest.fn() }));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { setPreference } from '../../database/database';
import { accountPairKey } from '../accountBinding';
import { getDistinctAccountPairs, markAccountsDistinct } from '../distinctAccounts';
import { BACKED_UP_PREFERENCE_KEYS, STORAGE_KEYS, SYNCED_PREFERENCE_KEYS } from '../storageUtils';

/**
 * A resposta "são contas diferentes" do aviso de contas duplicadas (SPD-072). Sem ela, PF e
 * PJ do mesmo banco ficavam com o aviso de juntar para sempre.
 */

const KEY = STORAGE_KEYS.distinctAccountPairs;

beforeEach(async () => {
	await AsyncStorage.clear();
	(setPreference as jest.Mock).mockReset();
	(setPreference as jest.Mock).mockImplementation((key: string, value: string) => AsyncStorage.setItem(key, value));
});

describe('contas que o usuário disse serem diferentes', () => {
	it('começa sem nenhuma', async () => {
		expect(await getDistinctAccountPairs()).toEqual([]);
	});

	it('valor estragado conta como nenhuma, em vez de quebrar a tela', async () => {
		await AsyncStorage.setItem(KEY, '{não é json');
		expect(await getDistinctAccountPairs()).toEqual([]);
		await AsyncStorage.setItem(KEY, JSON.stringify([1, 'a|b', null]));
		expect(await getDistinctAccountPairs()).toEqual(['a|b']);
	});

	it('guarda o par pela preferência, que sobe no sync, e devolve a lista nova', async () => {
		const pairs = await markAccountsDistinct('nubank-pf', 'nu');

		expect(pairs).toEqual([accountPairKey('nu', 'nubank-pf')]);
		expect(setPreference).toHaveBeenCalledWith(KEY, JSON.stringify(pairs));
		expect(await getDistinctAccountPairs()).toEqual(pairs);
	});

	it('o mesmo par duas vezes não grava de novo', async () => {
		await markAccountsDistinct('nu', 'nubank-pf');
		await markAccountsDistinct('nubank-pf', 'nu');

		expect(setPreference).toHaveBeenCalledTimes(1);
	});

	it('viaja no sync e no backup: o aparelho novo não pergunta de novo', () => {
		expect(SYNCED_PREFERENCE_KEYS).toContain(KEY);
		expect(BACKED_UP_PREFERENCE_KEYS).toContain(KEY);
		expect(KEY.length).toBeLessThanOrEqual(64);
	});
});
