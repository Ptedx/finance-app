import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * As contas em que o usuário dispensou o "Saldo não informado" (SPD-114), por id.
 *
 * Fica **só neste aparelho**, direto no AsyncStorage: não passa por `setPreference`, não
 * está em `SYNCED_PREFERENCE_KEYS` nem no backup, e o servidor não muda. No outro aparelho
 * o selo pode voltar, o que é barato — e some sozinho lá quando o saldo é definido, porque a
 * âncora nova viaja no sync. Id de conta apagada fica aqui sem efeito.
 */

export const BALANCE_UNSET_DISMISSED_KEY = '@spendr_balance_unset_dismissed';

export const getDismissedBalanceUnset = async (): Promise<Set<string>> => {
	try {
		const stored = await AsyncStorage.getItem(BALANCE_UNSET_DISMISSED_KEY);
		const parsed: unknown = stored ? JSON.parse(stored) : [];
		return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []);
	} catch {
		// Valor estragado vale como nenhuma dispensa: o selo volta, o que é barato.
		return new Set();
	}
};

/** Guarda a dispensa da conta e devolve o conjunto novo. */
export const dismissBalanceUnset = async (accountId: string): Promise<Set<string>> => {
	const current = await getDismissedBalanceUnset();
	if (current.has(accountId)) return current;
	const next = new Set([...current, accountId]);
	try {
		await AsyncStorage.setItem(BALANCE_UNSET_DISMISSED_KEY, JSON.stringify([...next]));
	} catch (error) {
		console.warn('Não foi possível guardar a dispensa do saldo não informado:', error);
	}
	return next;
};

export default { BALANCE_UNSET_DISMISSED_KEY, getDismissedBalanceUnset, dismissBalanceUnset };
