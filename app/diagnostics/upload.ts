/**
 * Envio do diário de diagnóstico ao servidor (SPD-016, DEC-03 opção B).
 *
 * O diário (`diary.ts`) guarda no aparelho; isto sobe o que ainda não subiu para
 * `POST /api/diagnostics`, pelo mesmo cliente HTTP do sync — token, renovação e endereço
 * da API são os dele.
 *
 * Quando: só com sessão (a fila de sync ligada), só com o app na frente, depois de um sync
 * que deu certo ou ao voltar ao primeiro plano, e no máximo uma vez a cada 6 h. Não tem
 * fila nem relógio próprios: cada gatilho tenta uma vez, e o que falhou espera o próximo.
 *
 * - Rede fora, 5xx, 429: nada é marcado; o próximo gatilho tenta de novo.
 * - 401: o cliente HTTP já avisou a sessão (renova ou derruba); o envio volta com ela.
 * - 404/405: servidor de antes da rota. Não tenta mais até o app abrir de novo.
 * - Outro 4xx: o lote inteiro foi recusado. O status vai para o diário e o envio espera o
 *   intervalo, para não martelar o servidor a cada sync com o mesmo lote.
 *
 * O conteúdo dos eventos nunca vai para o console: `rawText` é texto de aviso de banco.
 */

import { AppState } from 'react-native';
import { ApiError, apiRequest } from '../api/client';
import * as syncQueue from '../sync/queue';
import {
	DIAGNOSTIC_LIMITS,
	DIAGNOSTIC_SCHEMA_VERSION,
	type DiagnosticBatch,
	type DiagnosticBatchResult,
	type DiagnosticEvent,
} from './contract';
import {
	logEvent,
	markUploaded,
	readEvents,
	readUploadStamp,
	utf8Length,
	writeUploadStamp,
} from './diary';

export const DIAGNOSTICS_PATH = '/api/diagnostics';

/**
 * Limites do envio.
 *
 * - 500 eventos: o teto do servidor por lote.
 * - ~450 KB de corpo: o servidor aceita 512 KB; a folga cobre a diferença entre o que se
 *   mede aqui e o que chega lá (um evento sozinho pode passar de 7 KB).
 * - 6 h entre envios: o diário serve para "a captura parou ontem", não é telemetria ao
 *   vivo; ler e subir os arquivos a cada sync gastaria bateria à toa.
 */
export const UPLOAD_LIMITS = {
	maxEventsPerBatch: DIAGNOSTIC_LIMITS.maxEventsPerBatch,
	maxBatchBytes: 450 * 1024,
	intervalMs: 6 * 60 * 60 * 1000,
} as const;

export interface BatchLimits {
	maxEventsPerBatch: number;
	maxBatchBytes: number;
}

/** O corpo sem eventos: `{"schemaVersion":1,"events":[]}`. */
const envelopeBytes = (): number =>
	utf8Length(JSON.stringify({ schemaVersion: DIAGNOSTIC_SCHEMA_VERSION, events: [] }));

/**
 * Corta os eventos em lotes, na ordem, cada um com no máximo `maxEventsPerBatch` eventos e
 * um corpo de no máximo `maxBatchBytes` em UTF-8 (medido como o `JSON.stringify` do
 * cliente HTTP). Um evento maior que o teto vai sozinho: o servidor decide, e os outros
 * não ficam presos atrás dele.
 */
export const buildBatches = (
	events: DiagnosticEvent[],
	limits: BatchLimits = UPLOAD_LIMITS
): DiagnosticEvent[][] => {
	const envelope = envelopeBytes();
	const batches: DiagnosticEvent[][] = [];
	let current: DiagnosticEvent[] = [];
	let bytes = envelope;

	for (const event of events) {
		const size = utf8Length(JSON.stringify(event));
		// A vírgula entre um evento e outro também conta.
		const full =
			current.length >= limits.maxEventsPerBatch || bytes + size + 1 > limits.maxBatchBytes;
		if (current.length > 0 && full) {
			batches.push(current);
			current = [];
			bytes = envelope;
		}
		bytes += current.length > 0 ? size + 1 : size;
		current.push(event);
	}
	if (current.length > 0) batches.push(current);
	return batches;
};

/**
 * Como terminou um envio.
 *
 * - `sent`: tudo o que estava pendente subiu (ou foi recusado, que conta como subido).
 * - `empty`: não havia nada pendente.
 * - `retry`: rede, 5xx ou 429; o próximo gatilho tenta.
 * - `auth`: 401; fica para a sessão.
 * - `unsupported`: 404/405; servidor sem a rota.
 * - `failed`: outro 4xx; o lote inteiro foi recusado.
 * - `paused`: o app foi para o fundo entre um lote e outro.
 */
export type UploadOutcome = 'sent' | 'empty' | 'retry' | 'auth' | 'unsupported' | 'failed' | 'paused';

export interface UploadReport {
	outcome: UploadOutcome;
	/** Eventos marcados como enviados (aceitos, repetidos e recusados). */
	sent: number;
	/** Quantos o servidor recusou. */
	rejected: number;
}

const failureOf = (error: unknown): UploadOutcome => {
	// Erro que não é do cliente HTTP: algo quebrou no caminho, não no servidor. Tentar no
	// próximo gatilho é o mais seguro — nada foi marcado.
	if (!(error instanceof ApiError)) return 'retry';
	const { status } = error;
	if (status === 0 || status === 429 || status >= 500) return 'retry';
	if (status === 401) return 'auth';
	if (status === 404 || status === 405) return 'unsupported';
	return 'failed';
};

/** Só o status: a mensagem do servidor não entra no console, e o evento muito menos. */
const reportFailure = (outcome: UploadOutcome, error: unknown): void => {
	const status = error instanceof ApiError ? error.status : null;
	switch (outcome) {
		case 'retry':
			// Sem rede (ou gateway sem a API) é o normal no celular: não vale aviso.
			if (status === 0 || status === 502 || status === 503 || status === 504) return;
			console.warn(
				status === null
					? `Diagnóstico: envio do diário falhou (${error instanceof Error ? error.name : typeof error}).`
					: `Diagnóstico: envio do diário falhou (status ${status}); tenta no próximo sync.`
			);
			return;
		case 'unsupported':
			console.warn(
				`Diagnóstico: o servidor não tem a rota do diário (status ${status}); só na próxima abertura.`
			);
			return;
		case 'failed':
			console.warn(`Diagnóstico: o servidor recusou o lote do diário (status ${status}).`);
			logEvent('app', 'diary_upload_failed', { level: 'warn', data: { status } });
			return;
		default:
			return;
	}
};

/**
 * Sobe o que está pendente no diário, em lotes, um de cada vez. Cada lote aceito é
 * marcado até o seu último id antes do próximo, para uma falha no meio não reenviar o que
 * já subiu (e, se reenviar, o servidor ignora id repetido). Não confere sessão nem
 * intervalo — isso é do `maybeUploadDiary`. Nunca lança.
 */
export const uploadPendingDiary = async (): Promise<UploadReport> => {
	let sent = 0;
	let rejected = 0;

	try {
		const batches = buildBatches(await readEvents({ pendingOnly: true }));
		if (batches.length === 0) return { outcome: 'empty', sent, rejected };

		for (const events of batches) {
			if (AppState.currentState !== 'active') return { outcome: 'paused', sent, rejected };

			const body: DiagnosticBatch = { schemaVersion: DIAGNOSTIC_SCHEMA_VERSION, events };
			let result: DiagnosticBatchResult | undefined;
			try {
				result = await apiRequest<DiagnosticBatchResult>(DIAGNOSTICS_PATH, {
					method: 'POST',
					body,
					authenticated: true,
				});
			} catch (error) {
				const outcome = failureOf(error);
				reportFailure(outcome, error);
				return { outcome, sent, rejected };
			}

			// Recusado também é marcado: reenviar daria a mesma recusa. Se a marca não
			// gravar, o próximo envio repete o lote e o servidor ignora os ids repetidos.
			await markUploaded(events[events.length - 1].id);
			sent += events.length;

			const refused = Array.isArray(result?.rejected) ? result.rejected.length : 0;
			if (refused > 0) {
				rejected += refused;
				// Só a contagem: o motivo pode citar o campo, e o evento pode ter texto de banco.
				logEvent('app', 'diary_upload_rejected', {
					level: 'warn',
					data: { rejected: refused, batch: events.length },
				});
			}
		}
		return { outcome: 'sent', sent, rejected };
	} catch (error) {
		reportFailure('retry', error);
		return { outcome: 'retry', sent, rejected };
	}
};

// ---------------------------------------------------------------------------
// Quando enviar
// ---------------------------------------------------------------------------

/** O servidor respondeu 404/405 nesta execução do app: só a próxima abertura tenta. */
let unsupportedThisRun = false;
let inFlight: Promise<UploadReport | null> | null = null;
/** Instante do último envio feito; `undefined` = ainda não lido do disco. */
let lastUploadAt: number | null | undefined;

const canUpload = (): boolean => syncQueue.isEnabled() && AppState.currentState === 'active';

const due = (now: number): boolean =>
	lastUploadAt == null ||
	// Relógio que voltou para antes do último envio: espera não teria fim.
	now < lastUploadAt ||
	now - lastUploadAt >= UPLOAD_LIMITS.intervalMs;

const run = async (now: number): Promise<UploadReport | null> => {
	if (lastUploadAt === undefined) lastUploadAt = await readUploadStamp();
	if (!due(now) || !canUpload()) return null;

	const report = await uploadPendingDiary();
	if (report.outcome === 'unsupported') unsupportedThisRun = true;
	if (report.outcome === 'sent' || report.outcome === 'empty' || report.outcome === 'failed') {
		lastUploadAt = now;
		await writeUploadStamp(now);
	}
	return report;
};

/**
 * Envia se pode: com sessão, com o app na frente, sem outro envio em curso, com o
 * servidor conhecendo a rota e passado o intervalo. Devolve `null` quando não tentou.
 * Nunca rejeita.
 */
export const maybeUploadDiary = (now: number = Date.now()): Promise<UploadReport | null> => {
	if (unsupportedThisRun || inFlight || !canUpload()) return Promise.resolve(null);

	const current = run(now)
		.catch(() => null)
		.finally(() => {
			if (inFlight === current) inFlight = null;
		});
	inFlight = current;
	return current;
};

/**
 * Liga os gatilhos: fim de um sync que deu certo (o `subscribe` da fila) e volta ao
 * primeiro plano. Chamado uma vez, do `SyncProvider`. Devolve a função que desliga.
 */
export const startDiaryUploads = (): (() => void) => {
	let previousStatus = syncQueue.getState().status;
	const unsubscribe = syncQueue.subscribe((state) => {
		// Só a passagem de "sincronizando" para "parado sem erro" é um sync que deu certo;
		// o resto (pulledVersion, o `stop` da sessão) não é.
		const synced = previousStatus === 'syncing' && state.status === 'idle' && state.lastError === null;
		previousStatus = state.status;
		if (synced) void maybeUploadDiary();
	});

	let previousAppState = AppState.currentState;
	const subscription = AppState.addEventListener('change', (next) => {
		if (next === 'active' && previousAppState !== 'active') void maybeUploadDiary();
		previousAppState = next;
	});

	return () => {
		unsubscribe();
		subscription.remove();
	};
};

/** Zera o estado do módulo, como numa abertura nova do app. Só para testes. */
export const resetUploadForTests = (): void => {
	unsupportedThisRun = false;
	inFlight = null;
	lastUploadAt = undefined;
};

