import { clearTokens, loadTokens, saveTokens, type StoredTokens } from './tokens';

/**
 * Cliente HTTP da API do Spendr.
 *
 * Duas responsabilidades além de um `fetch` cru: renovar o access token quando ele
 * expira, sem que a tela perceba, e transformar qualquer falha num `ApiError` que o
 * chamador consiga distinguir — "sem rede" e "senha errada" pedem reações opostas.
 */

/** Injetada pelo Expo em tempo de build. ngrok em dev, api-finance em produção. */
const BASE_URL = process.env.EXPO_PUBLIC_API_URL?.replace(/\/+$/, '') ?? '';

/**
 * Uma requisição que não respondeu em 20s foi engolida por uma rede ruim.
 *
 * Sem isso o `fetch` do React Native fica pendurado indefinidamente e a fila de sync
 * trava para sempre no primeiro túnel do metrô.
 */
const TIMEOUT_MS = 20_000;

/**
 * Respostas de um intermediário — ngrok, nginx — que não conseguiu falar com a API.
 *
 * Do ponto de vista do app são idênticas a estar sem rede: a requisição nunca chegou,
 * nada foi processado, e tentar de novo mais tarde é a reação certa. O que não pode
 * acontecer é o usuário ver "Erro 502", que não significa nada para ele.
 */
const GATEWAY_STATUSES = new Set([502, 503, 504]);

export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly code: string
	) {
		super(message);
		this.name = 'ApiError';
	}

	/**
	 * A requisição não chegou ao servidor: sem rede, timeout, ou um gateway que não
	 * alcançou a API. Dá para tentar de novo — e a fila de sync faz exatamente isso.
	 */
	get isOffline(): boolean {
		return this.status === 0 || GATEWAY_STATUSES.has(this.status);
	}

	/** A sessão morreu de vez; renovar não adianta e o app precisa deslogar. */
	get isAuthExpired(): boolean {
		return this.status === 401 && this.code !== 'token_expired';
	}
}

export const isApiConfigured = (): boolean => BASE_URL.length > 0;

interface RequestOptions {
	method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
	body?: unknown;
	/** Anexa o access token e renova uma vez se ele tiver expirado. */
	authenticated?: boolean;
}

/**
 * Renovação única e compartilhada.
 *
 * Quando o token expira, o push e o pull costumam falhar no mesmo instante. Sem esta
 * promessa compartilhada, cada um chamaria `/auth/refresh` com o mesmo refresh token —
 * e como o servidor rotaciona a cada uso, o segundo receberia 401 e derrubaria uma
 * sessão perfeitamente válida.
 */
let refreshInFlight: Promise<StoredTokens | null> | null = null;

/** Chamado quando a sessão cai de vez, para o AuthContext limpar o estado da UI. */
let onSessionLost: (() => void) | null = null;

export const setSessionLostHandler = (handler: (() => void) | null): void => {
	onSessionLost = handler;
};

/**
 * Mensagem legível para quem não faz ideia do que é um código HTTP.
 *
 * Um gateway fora do ar responde HTML, não JSON, então não há mensagem da API para
 * mostrar — e "Erro 502" na tela não ajuda ninguém a decidir o que fazer.
 */
const fallbackMessage = (status: number): string => {
	if (GATEWAY_STATUSES.has(status)) return 'O servidor não está respondendo. Tente novamente em instantes.';
	if (status === 429) return 'Muitas tentativas. Aguarde alguns minutos.';
	if (status >= 500) return 'Erro no servidor. Tente novamente em instantes.';
	return 'Não foi possível completar a operação.';
};

const parseError = async (response: Response): Promise<ApiError> => {
	const fallback = () =>
		new ApiError(
			response.status,
			fallbackMessage(response.status),
			GATEWAY_STATUSES.has(response.status) ? 'gateway_unreachable' : 'error'
		);

	try {
		const body = (await response.json()) as { error?: string; code?: string };
		return body.error
			? new ApiError(response.status, body.error, body.code ?? 'error')
			: fallback();
	} catch {
		// Corpo não era JSON: veio de um proxy, não da API.
		return fallback();
	}
};

const rawFetch = async (path: string, options: RequestOptions, token?: string) => {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

	try {
		return await fetch(`${BASE_URL}${path}`, {
			method: options.method ?? 'GET',
			headers: {
				'Content-Type': 'application/json',
				...(token ? { Authorization: `Bearer ${token}` } : {}),
			},
			...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
			signal: controller.signal,
		});
	} catch (error) {
		// Rede fora, DNS, timeout: tudo vira status 0, que a fila de sync trata como
		// "tente de novo" em vez de "deu erro de verdade".
		throw new ApiError(
			0,
			error instanceof Error && error.name === 'AbortError'
				? 'A conexão demorou demais.'
				: 'Sem conexão com o servidor.',
			'offline'
		);
	} finally {
		clearTimeout(timer);
	}
};

const refreshSession = async (): Promise<StoredTokens | null> => {
	const stored = await loadTokens();
	if (!stored) return null;

	const response = await rawFetch('/api/auth/refresh', {
		method: 'POST',
		body: { refreshToken: stored.refreshToken },
	});

	if (!response.ok) {
		await clearTokens();
		onSessionLost?.();
		return null;
	}

	const body = (await response.json()) as StoredTokens;
	await saveTokens({ accessToken: body.accessToken, refreshToken: body.refreshToken });
	return body;
};

export const apiRequest = async <T>(path: string, options: RequestOptions = {}): Promise<T> => {
	if (!isApiConfigured()) {
		throw new ApiError(0, 'API não configurada (EXPO_PUBLIC_API_URL).', 'not_configured');
	}

	let token: string | undefined;

	if (options.authenticated) {
		const stored = await loadTokens();
		if (!stored) throw new ApiError(401, 'Não autenticado.', 'no_session');
		token = stored.accessToken;
	}

	let response = await rawFetch(path, options, token);

	// Uma única tentativa de renovação. Se o token novo também for recusado, o problema
	// não é validade — insistir só geraria um laço.
	if (response.status === 401 && options.authenticated) {
		const error = await parseError(response.clone());

		if (error.code === 'token_expired') {
			refreshInFlight ??= refreshSession().finally(() => {
				refreshInFlight = null;
			});

			const renewed = await refreshInFlight;
			if (!renewed) throw new ApiError(401, 'Sessão expirada.', 'session_lost');

			response = await rawFetch(path, options, renewed.accessToken);
		}
	}

	if (!response.ok) {
		const error = await parseError(response);
		if (error.isAuthExpired) onSessionLost?.();
		throw error;
	}

	if (response.status === 204) return undefined as T;

	return (await response.json()) as T;
};

/**
 * Todo arquivo sob app/ e tratado como rota pelo expo-router, e uma rota sem export
 * default e um modulo quebrado do ponto de vista dele. Este export existe so para
 * satisfazer essa exigencia — nada navega para ca. Mesma convencao de database.ts,
 * money.ts e dos demais utilitarios do projeto.
 */
export default { apiRequest, isApiConfigured, setSessionLostHandler, ApiError };
