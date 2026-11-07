import AsyncStorage from '@react-native-async-storage/async-storage';
import { setPreference } from '../database/database';
import { STORAGE_KEYS } from './storageUtils';

/**
 * Pares de lançamentos do cartão que o dono disse **não** serem repetidos (SPD-098): duas
 * compras iguais no mesmo dia existem de verdade, e sem esta resposta o aviso de "provável
 * repetido" ficava na tela do cartão para sempre. Chaves de `accountPairKey`.
 *
 * Mora numa preferência que sobe no sync e vai no backup (SPD-100), como
 * `distinctAccountPairs`: noutro aparelho da conta o aviso não volta. Par de lançamento já
 * apagado fica aqui sem efeito, até sair pelo teto (abaixo).
 */

export const CARD_DUPLICATE_DISMISSED_KEY = STORAGE_KEYS.cardDuplicateDismissed;

/**
 * O maior valor de preferência que o servidor aceita (`preferenceSchema`, `value` até 2.000
 * caracteres). Acima disso o push recusa a linha como `invalid`, e ela fica pendente para
 * sempre. Cada par de ids (UUID) ocupa 76 caracteres no JSON, então cabem 26: os mais
 * velhos saem primeiro — o aviso deles volta, o que é barato —, e com eles os pares de
 * lançamentos que já foram apagados.
 */
export const CARD_DUPLICATE_DISMISSED_MAX_LENGTH = 2_000;

/** Tira os pares mais velhos (os do começo) até o JSON caber no teto. */
const fitToLimit = (pairs: string[]): string[] => {
	let start = 0;
	while (start < pairs.length && JSON.stringify(pairs.slice(start)).length > CARD_DUPLICATE_DISMISSED_MAX_LENGTH) {
		start += 1;
	}
	return pairs.slice(start);
};

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

/**
 * Guarda que os pares não são repetidos e devolve o conjunto novo. Os novos vão para o fim;
 * se não couber tudo no teto, saem os mais velhos.
 */
export const dismissCardDuplicates = async (keys: readonly string[]): Promise<Set<string>> => {
	const current = [...(await getDismissedCardDuplicates())];
	const next = fitToLimit([...new Set([...current, ...keys])]);
	const value = JSON.stringify(next);
	if (value !== JSON.stringify(current)) await setPreference(CARD_DUPLICATE_DISMISSED_KEY, value);
	return new Set(next);
};

export default { getDismissedCardDuplicates, dismissCardDuplicates };
