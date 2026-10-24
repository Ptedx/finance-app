/**
 * Contrato do diário de diagnóstico (Log B, DEC-03 e DEC-11): o que o aparelho guarda e o que
 * sobe para o servidor. O backend valida a mesma forma com zod (`backend/src/schemas/diagnostics.ts`).
 *
 * O diário guarda metadados. Texto cru só entra em `rawText`, e só de aviso de app de banco
 * conhecido que o parser descartou ou não entendeu (DEC-11 b). Nunca token, senha, chave nem
 * cabeçalho de requisição.
 */

/** Versão da forma do evento. Mudou um campo obrigatório → sobe; campo novo opcional não sobe. */
export const DIAGNOSTIC_SCHEMA_VERSION = 1;

export type DiagnosticLevel = 'debug' | 'info' | 'warn' | 'error';

/** De onde veio: decide quem lê o evento e como filtrar no servidor. */
export type DiagnosticArea = 'capture' | 'native' | 'sync' | 'session' | 'reminders' | 'app';

/** Valor de metadado: só escalares, para o evento caber numa linha e não levar objeto do app. */
export type DiagnosticValue = string | number | boolean | null;

export interface DiagnosticEvent {
	/** uuid v4 gerado no aparelho; o servidor ignora id repetido (reenvio é seguro). */
	id: string;
	/** Instante ISO em UTC (`toISOString()`). */
	at: string;
	level: DiagnosticLevel;
	area: DiagnosticArea;
	/** Nome curto em snake_case: `capture_discarded`, `listener_disconnected`, `sync_pull_done`. */
	event: string;
	/** Metadados. Até 20 chaves; chave até 40 caracteres; texto até 200 caracteres. */
	data?: Record<string, DiagnosticValue>;
	/** Só DEC-11 b (ver acima). Até 2000 caracteres. */
	rawText?: string | null;
	/** `expo-application` nativeApplicationVersion, ex. "1.2.9". */
	appVersion: string;
	platform: 'android' | 'ios' | 'web';
	/** Id aleatório da instalação (gerado uma vez, guardado no aparelho). Não é IMEI nem id do sistema. */
	installId: string;
}

/** Um envio ao servidor: `POST /api/diagnostics`, autenticado. */
export interface DiagnosticBatch {
	schemaVersion: typeof DIAGNOSTIC_SCHEMA_VERSION;
	/** De 1 a 500 eventos; corpo até 512 KB. */
	events: DiagnosticEvent[];
}

/** Resposta do servidor: quantos entraram e quantos já existiam (id repetido). */
export interface DiagnosticBatchResult {
	accepted: number;
	duplicates: number;
	/**
	 * Os que o servidor recusou, com a posição no lote e o motivo. Opcional: servidor mais
	 * antigo não manda. Recusado não volta a subir: reenviar daria a mesma recusa.
	 */
	rejected?: { index: number; id: string | null; reason: string }[];
}

export const DIAGNOSTIC_LIMITS = {
	maxEventsPerBatch: 500,
	maxDataKeys: 20,
	maxKeyLength: 40,
	maxStringLength: 200,
	maxEventNameLength: 64,
	maxRawTextLength: 2000,
	/** Servidor apaga o que tem mais de 30 dias (DEC-03). */
	retentionDays: 30,
} as const;
