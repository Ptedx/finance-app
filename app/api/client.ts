import { log } from '../diagnostics/log';
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
		readonly code: string,
		/**
		 * O corpo JSON da resposta de erro, para quem precisa de mais que a mensagem: o 409
		 * `data_wiped` do push traz o `dataWipedAt` da conta (SPD-083). Vazio quando a
		 * resposta não era da API.
		 */
		readonly details: Readonly<Record<string, unknown>> = {}
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

	/**
	 * A sessão morreu porque a conta não existe mais (SPD-081): apagada noutro aparelho, ou
	 * neste com o app fechado antes de terminar. Além de sair, este aparelho apaga os dados
	 * dela (`leaveDeletedAccount` em `utils/accountDeletion.ts`).
	 */
	get isAccountGone(): boolean {
		return this.status === 401 && this.code === 'account_gone';
	}
}

export const isApiConfigured = (): boolean => BASE_URL.length > 0;

interface RequestOptions {
	method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
	body?: unknown;
	/** Anexa o access token e renova uma vez se ele tiver expirado. */
	authenticated?: boolean;
	/**
	 * O 401 deste pedido não derruba a sessão: sobe como erro, e quem chamou decide. É o
	 * "Apagar a conta" (`utils/accountDeletion.ts`): o 401 `account_gone` ali é o fim
	 * esperado, e quem apaga o aparelho e encerra a sessão, na ordem certa, é ele — o aviso
	 * daqui faria a tela voltar ao modo anônimo no meio do apagar.
	 *
	 * Não vale para a renovação recusada: ela é compartilhada com os outros pedidos, e a
	 * sessão cai do mesmo jeito.
	 */
	callerEndsSession?: boolean;
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

/**
 * Por que a sessão caiu. `account_gone`: a conta foi apagada, e quem trata apaga também os
 * dados deste aparelho; o `accessToken` é o do pedido recusado, para quem trata saber que
 * a sessão daqui ainda é aquela (nunca vai para o diário). Qualquer outro 401 — token
 * inválido, renovação recusada — é `session_lost`: só sai, e os dados ficam.
 */
export type SessionLoss =
	| { reason: 'session_lost' }
	| { reason: 'account_gone'; accessToken: string };

/**
 * Chamado quando a sessão cai de vez, para o AuthContext limpar o estado da UI.
 *
 * Sem `await`, de propósito: o pedido que recebeu o 401 pode ser de uma rodada da fila de
 * sync, e quem trata a conta apagada espera a fila parar (`runExclusive`) — que espera a
 * rodada terminar. Esperar aqui seria a rodada esperar a si mesma.
 *
 * Entra por registro, e não por import: o AuthContext importa quase tudo que importa este
 * cliente.
 */
let onSessionLost: ((loss: SessionLoss) => void) | null = null;

export const setSessionLostHandler = (handler: ((loss: SessionLoss) => void) | null): void => {
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
			? new ApiError(response.status, body.error, body.code ?? 'error', body)
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

	let response: Response;
	try {
		response = await rawFetch('/api/auth/refresh', {
			method: 'POST',
			body: { refreshToken: stored.refreshToken },
		});
	} catch (error) {
		// Sem rede a sessão continua: o próximo pedido tenta renovar de novo.
		log('session', 'session_refresh_failed', {
			level: 'warn',
			data: { status: error instanceof ApiError ? error.status : null, offline: true, loggedOut: false },
		});
		throw error;
	}

	if (!response.ok) {
		// Só o status: o corpo da recusa não é lido aqui, e o token nunca vai para o diário.
		log('session', 'session_refresh_failed', {
			level: 'warn',
			data: { status: response.status, offline: false, loggedOut: true },
		});
		await clearTokens();
		onSessionLost?.({ reason: 'session_lost' });
		return null;
	}

	const body = (await response.json()) as StoredTokens;
	await saveTokens({ accessToken: body.accessToken, refreshToken: body.refreshToken });
	log('session', 'session_refresh_ok');
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

			token = renewed.accessToken;
			response = await rawFetch(path, options, token);
		}
	}

	if (!response.ok) {
		const error = await parseError(response);
		if (error.isAuthExpired && !options.callerEndsSession) {
			// O 401 que desloga: o status e o código, nunca o pedido nem o token.
			log('session', 'session_lost', { level: 'warn', data: { status: error.status, code: error.code } });
			onSessionLost?.(
				error.isAccountGone && token
					? { reason: 'account_gone', accessToken: token }
					: { reason: 'session_lost' }
			);
		}
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
