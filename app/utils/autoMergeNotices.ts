import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Os avisos "Juntamos X em Y" ainda não vistos (SPD-116).
 *
 * A junção sozinha (`autoMergeAccounts.ts`) roda onde as contas são carregadas, e o usuário
 * pode estar em qualquer tela — ou o app pode fechar antes de ele abrir Contas. O aviso fica
 * guardado aqui até a tela de Contas mostrá-lo uma vez. Guarda os nomes do momento da
 * junção: a ficha que saiu não existe mais para ser lida.
 *
 * Fica **só neste aparelho**, direto no AsyncStorage, como a dispensa do "Saldo não
 * informado" (`balanceUnsetDismissals`): não passa por `setPreference`, não sobe no sync nem
 * vai no backup. Foi este aparelho que juntou, e é nele que o aviso faz sentido.
 */

export const AUTO_MERGE_NOTICES_KEY = '@spendr_auto_merge_notices';

export interface AutoMergeNotice {
	/** O nome da ficha vazia que saiu. */
	from: string;
	/** O nome da conta que ficou. */
	into: string;
}

const isNotice = (value: unknown): value is AutoMergeNotice =>
	typeof value === 'object' &&
	value !== null &&
	typeof (value as AutoMergeNotice).from === 'string' &&
	typeof (value as AutoMergeNotice).into === 'string';

export const getAutoMergeNotices = async (): Promise<AutoMergeNotice[]> => {
	try {
		const stored = await AsyncStorage.getItem(AUTO_MERGE_NOTICES_KEY);
		const parsed: unknown = stored ? JSON.parse(stored) : [];
		return Array.isArray(parsed) ? parsed.filter(isNotice) : [];
	} catch {
		// Valor estragado vale como nenhum aviso: a junção já aconteceu, só o aviso se perde.
		return [];
	}
};

/** Guarda um aviso novo e devolve a lista. O mesmo par de nomes não entra duas vezes. */
export const addAutoMergeNotice = async (notice: AutoMergeNotice): Promise<AutoMergeNotice[]> => {
	const stored = await getAutoMergeNotices();
	if (stored.some((item) => item.from === notice.from && item.into === notice.into)) return stored;
	const next = [...stored, { from: notice.from, into: notice.into }];
	try {
		await AsyncStorage.setItem(AUTO_MERGE_NOTICES_KEY, JSON.stringify(next));
	} catch (error) {
		console.warn('Não foi possível guardar o aviso da junção:', error);
	}
	return next;
};

/** A tela mostrou: os avisos saem. */
export const clearAutoMergeNotices = async (): Promise<void> => {
	try {
		await AsyncStorage.removeItem(AUTO_MERGE_NOTICES_KEY);
	} catch (error) {
		console.warn('Não foi possível apagar os avisos da junção:', error);
	}
};

export default { AUTO_MERGE_NOTICES_KEY, getAutoMergeNotices, addAutoMergeNotice, clearAutoMergeNotices };
