import AsyncStorage from '@react-native-async-storage/async-storage';
import { setPreference } from '../database/database';
import type { BusinessFeeds } from './businessFeed';
import { STORAGE_KEYS } from './storageUtils';

/**
 * Onde mora a escolha "Avisos da Nu Empresas entram aqui" (SPD-074): uma preferência que
 * sobe no sync e vai no backup, sem coluna nova nem mudança no servidor. As regras ficam
 * em `businessFeed.ts`.
 */

const KEY = STORAGE_KEYS.businessFeeds;

export const getBusinessFeeds = async (): Promise<BusinessFeeds> => {
	try {
		const stored = await AsyncStorage.getItem(KEY);
		const parsed: unknown = stored ? JSON.parse(stored) : {};
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
		return Object.fromEntries(
			Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
		);
	} catch {
		// Valor estragado vale como nenhuma resposta: o aviso volta à conta ligada ao app.
		return {};
	}
};

export const setBusinessFeed = async (packageName: string, accountId: string): Promise<BusinessFeeds> => {
	const next = { ...(await getBusinessFeeds()), [packageName]: accountId };
	await setPreference(KEY, JSON.stringify(next));
	return next;
};

export default { getBusinessFeeds, setBusinessFeed };
