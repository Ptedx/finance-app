/**
 * O `logEvent` para quem decide (SPD-014): a captura, o sync, a sessão e os lembretes.
 *
 * Quem decide não importa o diário (`diary.ts`): ele puxa o AsyncStorage e o sistema de
 * arquivos já na importação, e quem decide é importado por telas, contextos e testes que
 * não têm nada disso — registrar nunca pode derrubar quem chama, nem na importação. É o
 * diário que se liga aqui quando é carregado, e o `_layout` o carrega na abertura (por
 * `lifecycle.ts`). Sem ele ligado o registro some em silêncio, como qualquer outra falha
 * do diário.
 */

import type { DiagnosticArea, DiagnosticValue } from './contract';
import type { LogOptions } from './diary';

type Writer = (area: DiagnosticArea, event: string, options: LogOptions) => void;

let writer: Writer | null = null;

/** Liga o diário (`diary.ts` faz isso ao ser carregado). Os testes ligam um dublê. */
export const attachDiary = (next: Writer | null): void => {
	writer = next;
};

/** Registra no diário. Síncrono, nunca lança. */
export const log = (area: DiagnosticArea, event: string, options: LogOptions = {}): void => {
	try {
		writer?.(area, event, options);
	} catch {
		// Diário nunca derruba quem registra.
	}
};

/**
 * O que uma falha diz sem dizer nada do usuário: o status HTTP e o código do `ApiError`
 * (lidos pela forma, para não depender do cliente HTTP), e o nome da exceção. Nunca a
 * mensagem: a do servidor e a do SQLite podem trazer trecho do dado.
 */
export const errorData = (error: unknown): Record<string, DiagnosticValue> => {
	const shape = (error ?? {}) as { name?: unknown; status?: unknown; code?: unknown };
	const data: Record<string, DiagnosticValue> = {
		error: error instanceof Error ? error.name : typeof error,
	};
	if (typeof shape.status === 'number') {
		data.status = shape.status;
		// Os mesmos critérios de `ApiError.isOffline` e `isAuthExpired`.
		data.offline = shape.status === 0 || shape.status === 502 || shape.status === 503 || shape.status === 504;
	}
	if (typeof shape.code === 'string') data.code = shape.code;
	return data;
};

/** Milissegundos desde `startedAt` (`Date.now()`), para a duração de um ciclo. */
export const elapsedSince = (startedAt: number): number => Math.max(0, Date.now() - startedAt);
