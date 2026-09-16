/**
 * Acesso à caixa de entrada de capturas e às regras por estabelecimento.
 *
 * Separado de `database.ts` para o arquivo principal não crescer com uma feature
 * inteira. Usa o mesmo handle de banco — as tabelas são criadas em `initDatabase`.
 * Nada aqui é sincronizado: ver o comentário em `Capture` (schema.ts).
 */

import { generateUniqueId } from '../utils/categoryEditUtils';
import { nowTimestamp } from '../utils/dateUtils';
import { db } from './database';
import type { Capture, MerchantRule } from './schema';

interface CaptureRow extends Omit<Capture, 'autoConfirmed'> {
	autoConfirmed: number;
}

const toCapture = (row: CaptureRow): Capture => ({
	...row,
	autoConfirmed: Boolean(row.autoConfirmed),
});

export type CaptureDraft = Omit<Capture, 'id' | 'createdAt' | 'updatedAt'>;

/**
 * `explicitId` é usado pelo import de extrato, que planeja todas as linhas antes de
 * gravar e precisa que os ids referenciados entre elas (`relatedId`) já existam.
 */
export const insertCapture = async (draft: CaptureDraft, explicitId?: string): Promise<Capture> => {
	const timestamp = nowTimestamp();
	const capture: Capture = {
		...draft,
		id: explicitId ?? generateUniqueId(),
		createdAt: timestamp,
		updatedAt: timestamp,
	};

	await db.runAsync(
		`INSERT INTO captures
       (id, fingerprint, packageName, appLabel, title, text, postedAt, amountCents, direction, kind,
        counterparty, merchantKey, cardLast4, status, question, relatedId, suggestedCategory,
        transactionId, autoConfirmed, reason, accountId, transferId, installments, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			capture.id,
			capture.fingerprint,
			capture.packageName,
			capture.appLabel,
			capture.title,
			capture.text,
			capture.postedAt,
			capture.amountCents,
			capture.direction,
			capture.kind,
			capture.counterparty,
			capture.merchantKey,
			capture.cardLast4,
			capture.status,
			capture.question,
			capture.relatedId,
			capture.suggestedCategory,
			capture.transactionId,
			capture.autoConfirmed ? 1 : 0,
			capture.reason,
			capture.accountId,
			capture.transferId,
			capture.installments,
			capture.createdAt,
			capture.updatedAt,
		]
	);

	return capture;
};

export const hasCaptureFingerprint = async (fingerprint: string): Promise<boolean> => {
	const row = await db.getFirstAsync<{ id: string }>(
		'SELECT id FROM captures WHERE fingerprint = ?',
		[fingerprint]
	);
	return row !== null;
};

export const getCapture = async (id: string): Promise<Capture | null> => {
	const row = await db.getFirstAsync<CaptureRow>('SELECT * FROM captures WHERE id = ?', [id]);
	return row ? toCapture(row) : null;
};

/** Itens publicados a partir de `sinceISO`, em qualquer status. É o que a decisão compara. */
export const getRecentCaptures = async (sinceISO: string): Promise<Capture[]> => {
	const rows = await db.getAllAsync<CaptureRow>(
		'SELECT * FROM captures WHERE postedAt >= ? ORDER BY postedAt DESC',
		[sinceISO]
	);
	return rows.map(toCapture);
};

export const getPendingCaptures = async (): Promise<Capture[]> => {
	const rows = await db.getAllAsync<CaptureRow>(
		"SELECT * FROM captures WHERE status = 'pending' ORDER BY postedAt DESC"
	);
	return rows.map(toCapture);
};

export const countPendingCaptures = async (): Promise<number> => {
	const row = await db.getFirstAsync<{ count: number }>(
		"SELECT COUNT(*) AS count FROM captures WHERE status = 'pending'"
	);
	return row?.count ?? 0;
};

/** Tudo que já saiu da fila, mais recente primeiro, para o histórico com "reverter". */
export const getResolvedCaptures = async (limit: number): Promise<Capture[]> => {
	const rows = await db.getAllAsync<CaptureRow>(
		"SELECT * FROM captures WHERE status <> 'pending' ORDER BY updatedAt DESC LIMIT ?",
		[limit]
	);
	return rows.map(toCapture);
};

export type CapturePatch = Partial<
	Pick<
		Capture,
		| 'status'
		| 'question'
		| 'relatedId'
		| 'suggestedCategory'
		| 'transactionId'
		| 'autoConfirmed'
		| 'reason'
		| 'accountId'
		| 'transferId'
		| 'installments'
	>
>;

export const updateCapture = async (id: string, patch: CapturePatch): Promise<void> => {
	const assignments: string[] = [];
	const values: Array<string | number | null> = [];

	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) continue;
		assignments.push(`${key} = ?`);
		values.push(typeof value === 'boolean' ? (value ? 1 : 0) : (value as string | number | null));
	}

	assignments.push('updatedAt = ?');
	values.push(nowTimestamp());
	values.push(id);

	await db.runAsync(`UPDATE captures SET ${assignments.join(', ')} WHERE id = ?`, values);
};

/** Apaga o histórico antigo. Pendentes ficam sempre: ninguém perde revisão por tempo. */
export const pruneResolvedCaptures = async (olderThanISO: string): Promise<void> => {
	await db.runAsync("DELETE FROM captures WHERE status <> 'pending' AND updatedAt < ?", [
		olderThanISO,
	]);
};

// ---------------------------------------------------------------------------
// Regras por estabelecimento
// ---------------------------------------------------------------------------

export const getMerchantRule = async (merchantKey: string): Promise<MerchantRule | null> =>
	db.getFirstAsync<MerchantRule>('SELECT * FROM merchant_rules WHERE merchantKey = ?', [
		merchantKey,
	]);

export const saveMerchantRule = async (
	rule: Omit<MerchantRule, 'updatedAt'>
): Promise<void> => {
	await db.runAsync(
		`INSERT INTO merchant_rules (merchantKey, categoryId, treatAs, confirmations, updatedAt)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (merchantKey) DO UPDATE SET
       categoryId = excluded.categoryId, treatAs = excluded.treatAs,
       confirmations = excluded.confirmations, updatedAt = excluded.updatedAt`,
		[rule.merchantKey, rule.categoryId, rule.treatAs, rule.confirmations, nowTimestamp()]
	);
};

export const deleteMerchantRule = async (merchantKey: string): Promise<void> => {
	await db.runAsync('DELETE FROM merchant_rules WHERE merchantKey = ?', [merchantKey]);
};

/** As contrapartes que o usuário já marcou como "conta minha": nomes próprios aprendidos. */
export const getTransferMerchantKeys = async (): Promise<string[]> => {
	const rows = await db.getAllAsync<{ merchantKey: string }>(
		"SELECT merchantKey FROM merchant_rules WHERE treatAs = 'transfer'"
	);
	return rows.map((row) => row.merchantKey);
};

// ---------------------------------------------------------------------------
// O que o import de extrato precisa saber antes de planejar
// ---------------------------------------------------------------------------

/** Impressões digitais de todas as linhas de extrato já importadas. */
export const getStatementFingerprints = async (): Promise<Set<string>> => {
	const rows = await db.getAllAsync<{ fingerprint: string }>(
		"SELECT fingerprint FROM captures WHERE fingerprint LIKE 'ofx:%'"
	);
	return new Set(rows.map((row) => row.fingerprint));
};

/** Notificações que uma linha de extrato de import anterior já reivindicou. */
export const getStatementClaimedCaptureIds = async (): Promise<Set<string>> => {
	const rows = await db.getAllAsync<{ relatedId: string }>(
		"SELECT relatedId FROM captures WHERE reason = 'statement_capture' AND relatedId IS NOT NULL"
	);
	return new Set(rows.map((row) => row.relatedId));
};

/** Lançamentos criados a partir de uma captura, ou já ligados a uma linha de extrato. */
export const getLinkedTransactionIds = async (): Promise<Set<string>> => {
	const rows = await db.getAllAsync<{ transactionId: string }>(
		'SELECT transactionId FROM captures WHERE transactionId IS NOT NULL'
	);
	return new Set(rows.map((row) => row.transactionId));
};

export default {
	insertCapture,
	hasCaptureFingerprint,
	getStatementFingerprints,
	getStatementClaimedCaptureIds,
	getLinkedTransactionIds,
	getCapture,
	getRecentCaptures,
	getPendingCaptures,
	countPendingCaptures,
	getResolvedCaptures,
	updateCapture,
	pruneResolvedCaptures,
	getMerchantRule,
	saveMerchantRule,
	deleteMerchantRule,
	getTransferMerchantKeys,
};
