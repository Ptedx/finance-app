import AsyncStorage from '@react-native-async-storage/async-storage';
import { setPreference } from '../database/database';
import { accountPairKey } from './accountBinding';
import { STORAGE_KEYS } from './storageUtils';

/**
 * Pares de contas que o usuário disse serem contas diferentes (SPD-072).
 *
 * O aviso "Duas contas do mesmo banco" acerta quando a mesma conta virou duas fichas, mas
 * PF e PJ do mesmo banco também são duas fichas, e só uma recebe o que o app do banco
 * avisa. Sem esta resposta o aviso ficava na tela para sempre. Ela mora numa preferência
 * que sobe no sync e vai no backup: o aparelho novo não pergunta de novo.
 */

const KEY = STORAGE_KEYS.distinctAccountPairs;

export const getDistinctAccountPairs = async (): Promise<string[]> => {
	try {
		const stored = await AsyncStorage.getItem(KEY);
		const parsed: unknown = stored ? JSON.parse(stored) : [];
		return Array.isArray(parsed) ? parsed.filter((pair): pair is string => typeof pair === 'string') : [];
	} catch {
		// Valor estragado vale como nenhuma resposta: o aviso volta, o que é barato.
		return [];
	}
};

/** Guarda que as duas fichas são contas diferentes e devolve a lista nova. */
export const markAccountsDistinct = async (a: string, b: string): Promise<string[]> => {
	const pairs = await getDistinctAccountPairs();
	const key = accountPairKey(a, b);
	if (pairs.includes(key)) return pairs;

	const next = [...pairs, key];
	await setPreference(KEY, JSON.stringify(next));
	return next;
};

export default { getDistinctAccountPairs, markAccountsDistinct };
