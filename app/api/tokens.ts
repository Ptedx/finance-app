import * as SecureStore from 'expo-secure-store';

/**
 * Tokens ficam no SecureStore (Keychain no iOS, Keystore no Android), nunca no
 * AsyncStorage — que é um arquivo em claro no sandbox do app e vira texto legível em
 * qualquer backup ou aparelho com root.
 */
const ACCESS_TOKEN_KEY = 'spendr.accessToken';
const REFRESH_TOKEN_KEY = 'spendr.refreshToken';

export interface StoredTokens {
	accessToken: string;
	refreshToken: string;
}

/**
 * Lê a sessão guardada, tratando qualquer falha como "não há sessão".
 *
 * Isso não é um `catch` preguiçoso: numa restauração de backup do Android, o banco do
 * app volta mas as chaves do Keystore não migram, então o token restaurado é
 * indecifrável. O certo nesse caso é abrir deslogado — travar na abertura seria o
 * pior desfecho para quem acabou de trocar de aparelho.
 */
export const loadTokens = async (): Promise<StoredTokens | null> => {
	try {
		const [accessToken, refreshToken] = await Promise.all([
			SecureStore.getItemAsync(ACCESS_TOKEN_KEY),
			SecureStore.getItemAsync(REFRESH_TOKEN_KEY),
		]);

		return accessToken && refreshToken ? { accessToken, refreshToken } : null;
	} catch (error) {
		console.warn('Sessão guardada ilegível, abrindo deslogado:', error);
		await clearTokens();
		return null;
	}
};

export const saveTokens = async (tokens: StoredTokens): Promise<void> => {
	await Promise.all([
		SecureStore.setItemAsync(ACCESS_TOKEN_KEY, tokens.accessToken),
		SecureStore.setItemAsync(REFRESH_TOKEN_KEY, tokens.refreshToken),
	]);
};

export const clearTokens = async (): Promise<void> => {
	try {
		await Promise.all([
			SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY),
			SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY),
		]);
	} catch (error) {
		// Sair não pode falhar: o estado em memória já foi limpo de qualquer jeito.
		console.warn('Falha ao apagar tokens:', error);
	}
};
