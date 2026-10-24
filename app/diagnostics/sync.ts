/**
 * Os eventos do sync no diário (SPD-014): um por metade do ciclo (`sync_push_done`,
 * `sync_pull_done`), o das linhas que o servidor recusou e o da falha — sempre agregados,
 * nunca um por linha. As contas são por coleção; o id e o conteúdo das linhas não entram.
 */

import type { RejectedRow } from '../sync/types';
import type { DiagnosticValue } from './contract';
import { errorData, log } from './log';

/**
 * O motivo de uma recusa `invalid`, sem o dado: o código do Prisma quando o banco recusou
 * a gravação (`writeRowIsolated` no servidor manda "o banco recusou a linha (P2003)"), ou
 * o primeiro campo que a validação reclamou. A mensagem da validação pode citar o valor
 * recebido, então só o caminho do campo passa, e só se tiver cara de nome de campo.
 */
export const refusalCode = (row: Pick<RejectedRow, 'reason' | 'message'>): string => {
	if (row.reason !== 'invalid') return row.reason;
	const message = row.message ?? '';
	const prisma = /\((P\d{4})\)/.exec(message);
	if (prisma) return prisma[1];
	if (message.startsWith('o banco recusou')) return 'db';
	const field = message.split(': ')[0];
	return message.includes(': ') && /^[\w.()]{1,40}$/.test(field) ? `validation:${field}` : 'validation';
};

/** As recusas de um push, contadas por motivo e, nas `invalid`, por coleção e código. */
export const rejectionSummary = (rejected: RejectedRow[]): Record<string, DiagnosticValue> => {
	const counts = { stale: 0, unknownCategory: 0, invalid: 0 };
	const refused = new Map<string, number>();
	for (const row of rejected) {
		if (row.reason === 'stale') counts.stale += 1;
		else if (row.reason === 'unknown_category') counts.unknownCategory += 1;
		else {
			counts.invalid += 1;
			const key = `${row.collection}/${refusalCode(row)}`;
			refused.set(key, (refused.get(key) ?? 0) + 1);
		}
	}
	return {
		rejected: rejected.length,
		...counts,
		refused: [...refused].map(([key, count]) => `${key}=${count}`).join(',') || null,
	};
};

/**
 * Registra a falha de uma fase do sync — `push`, `pull`, `finish` — com o status HTTP, o
 * código e até onde a fase chegou. Quem chama relança o erro; isto nunca lança.
 */
export const logSyncFailure = (
	phase: string,
	error: unknown,
	progress: Record<string, DiagnosticValue> = {}
): void => {
	try {
		const data = errorData(error);
		// Sem rede é o normal de um celular: aviso, não erro.
		log('sync', 'sync_failed', { level: data.offline ? 'warn' : 'error', data: { phase, ...data, ...progress } });
	} catch {
		// Diário nunca derruba quem registra.
	}
};

