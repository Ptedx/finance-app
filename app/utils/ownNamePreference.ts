import AsyncStorage from '@react-native-async-storage/async-storage';
import { setPreference } from '../database/database';
import { cleanOwnName } from './ownName';
import { STORAGE_KEYS } from './storageUtils';

/**
 * Onde mora o "seu nome como aparece no banco" (SPD-115): uma preferência que sobe no sync e
 * vai no backup, sem coluna nova nem mudança no servidor — o celular novo já abre com ele. O
 * "Apagar todos os dados" o mantém, como a configuração e o nome da conta (DEC-35). As regras
 * da comparação ficam em `ownName.ts`.
 */

export const OWN_BANK_NAME_KEY = STORAGE_KEYS.ownBankName;

export const getOwnBankName = async (): Promise<string | null> => {
	try {
		const stored = await AsyncStorage.getItem(OWN_BANK_NAME_KEY);
		return stored ? cleanOwnName(stored) : null;
	} catch {
		// Sem leitura, sem nome: o Pix entre bancos volta a perguntar, que é o seguro.
		return null;
	}
};

/** Grava o nome digitado, limpo. Vazio apaga. Devolve o que ficou guardado. */
export const setOwnBankName = async (value: string): Promise<string | null> => {
	const clean = cleanOwnName(value);
	await setPreference(OWN_BANK_NAME_KEY, clean);
	return clean;
};

export default { getOwnBankName, setOwnBankName };
