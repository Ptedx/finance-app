import {
	type DiagnosticEventInput,
	type ParsedDiagnosticBatch,
	type RejectedDiagnostic,
	retentionCutoff,
} from '../schemas/diagnostics.js';

/**
 * Gravação e retenção do diário de diagnóstico (DEC-03).
 *
 * O banco chega por parâmetro, e não pelo `lib/prisma.js`: assim os testes passam um
 * falso, e a limpeza não precisa de Postgres para provar que corta na data certa. O
 * `PrismaClient` satisfaz esta forma.
 */

/** A linha como vai para `diagnostic_events`. `receivedAt` é o `now()` do banco. */
export interface DiagnosticRow {
	userId: string;
	id: string;
	at: Date;
	level: string;
	area: string;
	event: string;
	data?: Record<string, string | number | boolean | null>;
	rawText: string | null;
	appVersion: string;
	platform: string;
	installId: string;
}

export interface DiagnosticsDb {
	diagnosticEvent: {
		createMany(args: { data: DiagnosticRow[]; skipDuplicates: boolean }): PromiseLike<{ count: number }>;
		deleteMany(args: { where: { at: { lt: Date } } }): PromiseLike<{ count: number }>;
	};
}

/** `DiagnosticBatchResult` do contrato, mais o que foi recusado e por quê. */
export interface DiagnosticIngestResult {
	accepted: number;
	duplicates: number;
	rejected: RejectedDiagnostic[];
}

const toRow = (userId: string, event: DiagnosticEventInput): DiagnosticRow => ({
	userId,
	id: event.id,
	at: new Date(event.at),
	level: event.level,
	area: event.area,
	event: event.event,
	// Sem metadado a coluna fica NULL; mandar `null` ao Prisma exigiria `Prisma.DbNull`.
	...(event.data !== undefined ? { data: event.data } : {}),
	rawText: event.rawText ?? null,
	appVersion: event.appVersion,
	platform: event.platform,
	installId: event.installId,
});

/**
 * Grava os eventos válidos do lote em nome de `userId` (o do token, nunca o do corpo).
 *
 * `skipDuplicates` vira `ON CONFLICT DO NOTHING` na chave (userId, id): o reenvio do mesmo
 * evento — resposta perdida no caminho, por exemplo — não duplica a linha. O que não
 * entrou por já existir é a diferença entre o que foi mandado e o que foi gravado.
 */
export const insertDiagnostics = async (
	db: DiagnosticsDb,
	userId: string,
	batch: ParsedDiagnosticBatch
): Promise<DiagnosticIngestResult> => {
	if (batch.events.length === 0) {
		return { accepted: 0, duplicates: 0, rejected: batch.rejected };
	}

	const { count } = await db.diagnosticEvent.createMany({
		data: batch.events.map((event) => toRow(userId, event)),
		skipDuplicates: true,
	});

	return { accepted: count, duplicates: batch.events.length - count, rejected: batch.rejected };
};

/** Apaga o que tem `at` com mais de 30 dias. Devolve quantas linhas saíram. */
export const purgeExpiredDiagnostics = async (db: DiagnosticsDb, now: Date): Promise<number> => {
	const { count } = await db.diagnosticEvent.deleteMany({ where: { at: { lt: retentionCutoff(now) } } });
	return count;
};

export const DIAGNOSTICS_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Roda a limpeza agora e depois a cada 24 h.
 *
 * O timer não segura o processo (`unref`): o SIGTERM do deploy fecha o servidor e sai sem
 * esperar a próxima limpeza. Uma falha (banco fora, migração ainda não aplicada) vira uma
 * linha de erro e a tentativa seguinte; nunca uma rejeição solta, que derrubaria a API.
 */
export const scheduleDiagnosticsRetention = (
	db: DiagnosticsDb,
	options: { now?: () => Date; intervalMs?: number } = {}
): NodeJS.Timeout => {
	const now = options.now ?? (() => new Date());

	const run = (): void => {
		purgeExpiredDiagnostics(db, now())
			.then((count) => {
				if (count > 0) {
					console.log(`Diagnóstico: ${count} evento(s) com mais de 30 dias apagados.`);
				}
			})
			.catch((error: unknown) => {
				console.error(
					'Limpeza do diagnóstico falhou:',
					error instanceof Error ? error.message : String(error)
				);
			});
	};

	run();
	const timer = setInterval(run, options.intervalMs ?? DIAGNOSTICS_PURGE_INTERVAL_MS);
	timer.unref();
	return timer;
};
