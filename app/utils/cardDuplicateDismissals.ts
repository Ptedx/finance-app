import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Pares de lançamentos do cartão que o dono disse **não** serem repetidos (SPD-098): duas
 * compras iguais no mesmo dia existem de verdade, e sem esta resposta o aviso de "provável
 * repetido" ficava na tela do cartão para sempre. Chaves de `accountPairKey`.
 *
 * Mora só neste aparelho, de propósito por enquanto: não vai no backup nem no sync (para
 * isso a chave teria de entrar em `STORAGE_KEYS` e nas listas de `storageUtils.ts`, como
 * `distinctAccountPairs`). Noutro aparelho o aviso volta, o que é barato. Par de lançamento
 * já apagado fica aqui sem efeito.
 */

export const CARD_DUPLICATE_DISMISSED_KEY = '@spendr_card_duplicate_dismissed';

export const getDismissedCardDuplicates = async (): Promise<Set<string>> => {
	try {
		const stored = await AsyncStorage.getItem(CARD_DUPLICATE_DISMISSED_KEY);
		const parsed: unknown = stored ? JSON.parse(stored) : [];
		return new Set(Array.isArray(parsed) ? parsed.filter((pair): pair is string => typeof pair === 'string') : []);
	} catch {
		// Valor estragado vale como nenhuma resposta: o aviso volta, o que é barato.
		return new Set();
	}
};

/** Guarda que os pares não são repetidos e devolve o conjunto novo. */
export const dismissCardDuplicates = async (keys: readonly string[]): Promise<Set<string>> => {
	const current = await getDismissedCardDuplicates();
	const next = new Set([...current, ...keys]);
	if (next.size !== current.size) await AsyncStorage.setItem(CARD_DUPLICATE_DISMISSED_KEY, JSON.stringify([...next]));
	return next;
};

export default { getDismissedCardDuplicates, dismissCardDuplicates };
