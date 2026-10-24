import { z } from 'zod';

/**
 * Lote do diário de diagnóstico (`POST /api/diagnostics`, DEC-03).
 *
 * Espelha `app/diagnostics/contract.ts` — o backend não importa código do app. Mudou lá,
 * muda aqui: os limites abaixo são os mesmos `DIAGNOSTIC_LIMITS`.
 *
 * A validação é em duas camadas. O lote (versão, de 1 a 500 eventos) é tudo ou nada: um
 * lote fora disso é um cliente quebrado, e 400 é a resposta certa. Cada evento é
 * validado sozinho: um evento ruim é recusado com o motivo e os outros entram, porque
 * derrubar o lote faria o aparelho reenviar para sempre os bons junto com o ruim.
 *
 * Texto longo é cortado, não recusado: é corte seguro (o começo do texto continua
 * verdadeiro), e o aviso de banco comprido é justamente o que mais interessa ler. O que
 * não dá para cortar sem mudar o sentido — um nome de evento, uma chave, um id — é
 * recusado.
 */

export const DIAGNOSTIC_SCHEMA_VERSION = 1;

export const DIAGNOSTIC_LIMITS = {
	maxEventsPerBatch: 500,
	maxDataKeys: 20,
	maxKeyLength: 40,
	maxStringLength: 200,
	maxEventNameLength: 64,
	maxRawTextLength: 2000,
	/** O servidor apaga o que tem `at` com mais de 30 dias. */
	retentionDays: 30,
} as const;

/** Teto do corpo da rota, no formato do `express.json`. O contrato fala em 512 KB. */
export const DIAGNOSTIC_BODY_LIMIT = '512kb';

/**
 * Quanto o relógio do aparelho pode estar adiantado. Um evento "do futuro" além disso
 * nunca seria alcançado pela limpeza de 30 dias, que corta por `at`.
 */
const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Instante antes do qual um evento já passou da retenção.
 *
 * Conta em milissegundos e não em dias de calendário: o servidor roda em UTC e o corte
 * não pode andar uma hora quando algum fuso entra ou sai do horário de verão.
 */
export const retentionCutoff = (now: Date): Date =>
	new Date(now.getTime() - DIAGNOSTIC_LIMITS.retentionDays * DAY_MS);

/**
 * Corta em `max` unidades UTF-16 sem partir um par substituto (emoji) ao meio, e tira o
 * caractere nulo: o Postgres recusa `\u0000` em TEXT e em JSONB, e uma linha recusada no
 * `createMany` derrubaria o lote inteiro.
 */
const clip = (text: string, max: number): string => {
	const clean = text.replaceAll('\u0000', '');
	if (clean.length <= max) return clean;
	const cut = clean.slice(0, max);
	const last = cut.charCodeAt(cut.length - 1);
	return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
};

const clippedText = (max: number) => z.string().transform((text) => clip(text, max));

/**
 * Identificador: id, nome de evento, versão, chave de metadado. ASCII visível, sem espaço
 * nem caractere de controle — cortar mudaria o que ele identifica, então só cabe ou não.
 */
const identifier = (max: number) =>
	z
		.string()
		.min(1)
		.max(max)
		.regex(/^[\x21-\x7e]+$/, 'Use só caracteres ASCII visíveis.');

/** Só escalares: o evento cabe numa linha e não leva objeto do app junto. */
const diagnosticValue = z.union([
	clippedText(DIAGNOSTIC_LIMITS.maxStringLength),
	z.number(),
	z.boolean(),
	z.null(),
]);

const diagnosticData = z
	.record(identifier(DIAGNOSTIC_LIMITS.maxKeyLength), diagnosticValue)
	.refine((data) => Object.keys(data).length <= DIAGNOSTIC_LIMITS.maxDataKeys, {
		message: `No máximo ${DIAGNOSTIC_LIMITS.maxDataKeys} chaves.`,
	});

export const diagnosticEventSchema = z.object({
	/** uuid v4 do aparelho; a chave é (userId, id), então o reenvio é ignorado. */
	id: identifier(64),
	at: z.iso.datetime({ offset: true }),
	level: z.enum(['debug', 'info', 'warn', 'error']),
	area: z.enum(['capture', 'native', 'sync', 'session', 'reminders', 'app']),
	event: identifier(DIAGNOSTIC_LIMITS.maxEventNameLength),
	data: diagnosticData.optional(),
	/** Só texto de aviso de banco que o parser descartou ou não entendeu (DEC-11 b). */
	rawText: clippedText(DIAGNOSTIC_LIMITS.maxRawTextLength).nullish(),
	appVersion: identifier(32),
	platform: z.enum(['android', 'ios', 'web']),
	installId: identifier(64),
});

export type DiagnosticEventInput = z.infer<typeof diagnosticEventSchema>;

/** O envelope. Os eventos entram como `unknown` para serem validados um a um. */
export const diagnosticBatchSchema = z.object({
	schemaVersion: z.literal(DIAGNOSTIC_SCHEMA_VERSION),
	events: z.array(z.unknown()).min(1).max(DIAGNOSTIC_LIMITS.maxEventsPerBatch),
});

export interface RejectedDiagnostic {
	/** Posição no lote enviado. */
	index: number;
	/** O id, quando dá para ler um; senão `null`. */
	id: string | null;
	/** Caminho e mensagem do zod. Nunca ecoa o valor recebido. */
	reason: string;
}

export interface ParsedDiagnosticBatch {
	events: DiagnosticEventInput[];
	rejected: RejectedDiagnostic[];
}

const idOf = (raw: unknown): string | null => {
	if (typeof raw !== 'object' || raw === null) return null;
	const id = (raw as { id?: unknown }).id;
	return typeof id === 'string' && id.length > 0 && id.length <= 64 ? id : null;
};

/**
 * Valida o lote. Lança `ZodError` (o handler central responde 400) se o envelope não
 * serve; evento ruim vai para `rejected`, com o motivo, e não derruba os outros.
 */
export const parseDiagnosticBatch = (raw: unknown, now: Date): ParsedDiagnosticBatch => {
	const batch = diagnosticBatchSchema.parse(raw);
	const oldest = retentionCutoff(now).getTime();
	const newest = now.getTime() + MAX_CLOCK_SKEW_MS;

	const events: DiagnosticEventInput[] = [];
	const rejected: RejectedDiagnostic[] = [];

	batch.events.forEach((item, index) => {
		const result = diagnosticEventSchema.safeParse(item);
		if (!result.success) {
			const issue = result.error.issues[0];
			const path = issue && issue.path.length > 0 ? issue.path.join('.') : '(evento)';
			rejected.push({ index, id: idOf(item), reason: `${path}: ${issue?.message ?? 'inválido'}` });
			return;
		}

		const at = Date.parse(result.data.at);
		if (at < oldest) {
			rejected.push({
				index,
				id: result.data.id,
				reason: `at: mais antigo que ${DIAGNOSTIC_LIMITS.retentionDays} dias.`,
			});
			return;
		}
		if (at > newest) {
			rejected.push({ index, id: result.data.id, reason: 'at: no futuro.' });
			return;
		}

		events.push(result.data);
	});

	return { events, rejected };
};
