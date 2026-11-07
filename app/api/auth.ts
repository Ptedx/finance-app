import { apiRequest } from './client';
import { clearTokens, loadTokens, saveTokens } from './tokens';

export interface AccountProfile {
	id: string;
	email: string;
	name: string;
	baseCurrency: string;
	language: string;
}

interface SessionResponse {
	user: AccountProfile;
	accessToken: string;
	refreshToken: string;
}

/** Guarda os tokens e devolve só o perfil: nenhuma tela precisa ver um token. */
const startSession = async (response: SessionResponse): Promise<AccountProfile> => {
	await saveTokens({
		accessToken: response.accessToken,
		refreshToken: response.refreshToken,
	});
	return response.user;
};

export const register = async (params: {
	email: string;
	password: string;
	name: string;
	baseCurrency?: string;
	language?: string;
}): Promise<AccountProfile> =>
	startSession(
		await apiRequest<SessionResponse>('/api/auth/register', { method: 'POST', body: params })
	);

export const login = async (params: {
	email: string;
	password: string;
}): Promise<AccountProfile> =>
	startSession(
		await apiRequest<SessionResponse>('/api/auth/login', { method: 'POST', body: params })
	);

export const fetchProfile = async (): Promise<AccountProfile> =>
	(await apiRequest<{ user: AccountProfile }>('/api/me', { authenticated: true })).user;

export const updateProfile = async (changes: {
	name?: string;
	baseCurrency?: string;
	language?: string;
}): Promise<AccountProfile> =>
	(
		await apiRequest<{ user: AccountProfile }>('/api/me', {
			method: 'PATCH',
			body: changes,
			authenticated: true,
		})
	).user;

/**
 * Encerra a sessão, revogando o refresh token no servidor quando dá.
 *
 * A revogação é tentada mas não é obrigatória: sair tem que funcionar no modo avião.
 * O que não pode falhar é apagar os tokens daqui.
 */
export const logout = async (): Promise<void> => {
	try {
		const stored = await loadTokens();
		if (stored) {
			await apiRequest('/api/auth/logout', {
				method: 'POST',
				body: { refreshToken: stored.refreshToken },
			});
		}
	} catch (error) {
		console.warn('Não foi possível revogar a sessão no servidor:', error);
	} finally {
		await clearTokens();
	}
};

/**
 * Apaga a conta e tudo o que ela tem no servidor, sessões incluídas (SPD-081). A senha vai
 * no corpo: 204 apagou; 403 `wrong_password` e nada aconteceu; 401 `account_gone` a conta
 * já não existia (apagada em outro aparelho). Um servidor sem a rota responde 404.
 *
 * O 401 não derruba a sessão pelo cliente HTTP (`callerEndsSession`): quem apaga o
 * aparelho e encerra a sessão é `utils/accountDeletion.ts`.
 */
export const deleteAccount = async (password: string): Promise<void> => {
	await apiRequest<void>('/api/me', {
		method: 'DELETE',
		body: { password },
		authenticated: true,
		callerEndsSession: true,
	});
};

/**
 * Todo arquivo sob app/ e tratado como rota pelo expo-router, e uma rota sem export
 * default e um modulo quebrado do ponto de vista dele. Este export existe so para
 * satisfazer essa exigencia — nada navega para ca. Mesma convencao de database.ts,
 * money.ts e dos demais utilitarios do projeto.
 */
export default { register, login, logout, fetchProfile, updateProfile, deleteAccount };
