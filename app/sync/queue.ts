import { ApiError } from '../api/client';
import { syncNow, type SyncResult } from './engine';

/**
 * Agenda as rodadas de sync.
 *
 * Existe para garantir três coisas que o motor sozinho não garante: que uma escrita não
 * dispare uma requisição imediata (debounce), que duas rodadas nunca corram juntas
 * (single-flight) e que uma falha de rede não vire um laço de tentativas (backoff).
 *
 * Sem sessão nada disso roda — é o que mantém o modo anônimo idêntico ao app de antes.
 */

/** Tempo para o usuário terminar o que está fazendo antes de gastar rede. */
const DEBOUNCE_MS = 3_000;

/** Espera após uma falha, dobrando até o teto. Uma rede ruim não vira martelada. */
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

export type SyncStatus = 'idle' | 'syncing' | 'offline' | 'error';

interface QueueState {
	status: SyncStatus;
	lastError: string | null;
	pending: number;
}

type Listener = (state: QueueState) => void;

let enabled = false;
let running = false;
/** Uma escrita durante uma rodada: ela sobe na rodada seguinte, não nesta. */
let rerunRequested = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = RETRY_BASE_MS;

let state: QueueState = { status: 'idle', lastError: null, pending: 0 };
const listeners = new Set<Listener>();

const emit = (next: Partial<QueueState>): void => {
	state = { ...state, ...next };
	for (const listener of listeners) listener(state);
};

export const subscribe = (listener: Listener): (() => void) => {
	listeners.add(listener);
	listener(state);
	return () => listeners.delete(listener);
};

export const getState = (): QueueState => state;

const clearTimers = (): void => {
	if (debounceTimer) clearTimeout(debounceTimer);
	if (retryTimer) clearTimeout(retryTimer);
	debounceTimer = null;
	retryTimer = null;
};

const run = async (): Promise<void> => {
	if (!enabled) return;

	// Single-flight: a segunda chamada não espera na fila, apenas pede uma repetição.
	// Duas rodadas simultâneas empurrariam as mesmas linhas duas vezes.
	if (running) {
		rerunRequested = true;
		return;
	}

	running = true;
	emit({ status: 'syncing' });

	try {
		const result: SyncResult = await syncNow();

		retryDelay = RETRY_BASE_MS;
		emit({ status: 'idle', lastError: null, pending: result.pendingAfter });
	} catch (error) {
		const offline = error instanceof ApiError && error.isOffline;

		// Ficar sem rede não é um erro a ser mostrado como falha: as linhas continuam
		// marcadas e sobem sozinhas quando a conexão voltar.
		emit({
			status: offline ? 'offline' : 'error',
			lastError: error instanceof Error ? error.message : String(error),
		});

		if (error instanceof ApiError && error.isAuthExpired) {
			// A sessão caiu; o AuthContext já foi avisado pelo cliente HTTP. Continuar
			// tentando só produziria 401 até o fim dos tempos.
			stop();
			return;
		}

		retryTimer = setTimeout(() => {
			retryTimer = null;
			void run();
		}, retryDelay);

		retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
	} finally {
		running = false;

		if (rerunRequested) {
			rerunRequested = false;
			void run();
		}
	}
};

/** Liga a fila quando há sessão, e dispara uma rodada imediata para alinhar tudo. */
export const start = (): void => {
	enabled = true;
	retryDelay = RETRY_BASE_MS;
	void run();
};

export const stop = (): void => {
	enabled = false;
	clearTimers();
	emit({ status: 'idle', lastError: null, pending: 0 });
};

/**
 * Pede um sync após uma escrita. Chamado pelos contexts, depois de a UI já ter mudado.
 *
 * Cada chamada reinicia o relógio: quem lança cinco despesas seguidas gera uma remessa,
 * não cinco.
 */
export const schedule = (): void => {
	if (!enabled) return;

	if (debounceTimer) clearTimeout(debounceTimer);

	debounceTimer = setTimeout(() => {
		debounceTimer = null;
		void run();
	}, DEBOUNCE_MS);
};

/** Sync imediato: app voltando ao foreground, ou o usuário puxando para atualizar. */
export const syncImmediately = (): void => {
	if (!enabled) return;

	if (debounceTimer) clearTimeout(debounceTimer);
	debounceTimer = null;

	// Uma tentativa manual zera o backoff: o usuário pode saber que a rede voltou
	// antes de nós.
	if (retryTimer) clearTimeout(retryTimer);
	retryTimer = null;
	retryDelay = RETRY_BASE_MS;

	void run();
};
