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

/**
 * A caixa de entrada inteira, para o backup — pendentes e resolvidas.
 *
 * O caso real: no dia 12/10/2026 o dono gerou um backup e reinstalou o app. As compras
 * de outubro ainda estavam **aqui**, pendentes de revisão, e não em `transactions`: não
 * sincronizam (são rascunho de cada aparelho) e não saíam no arquivo. Duas semanas de
 * compras foram embora com a desinstalação, enquanto as transferências do mesmo período
 * voltaram — porque uma captura de troca de bolso grava a transferência na hora, e uma
 * de compra espera a confirmação do usuário.
 */
export const getAllCaptures = async (): Promise<Capture[]> => {
	const rows = await db.getAllAsync<CaptureRow>('SELECT * FROM captures ORDER BY postedAt ASC');
	return rows.map(toCapture);
};

/**
 * Regrava uma captura do backup com o id, o texto cru e a decisão originais.
 *
 * O id é o do arquivo porque é por ele que `relatedId` ("é duplicata daquela?") e o
 * histórico se encontram. `fingerprint` é UNIQUE: se este aparelho já capturou a mesma
 * notificação com outro id, a linha local sai e a do arquivo entra — ela é a que carrega
 * o que o usuário decidiu. Sem isso o INSERT estouraria no meio da importação, com o
 * banco já apagado.
 */
export const restoreCapture = async (capture: Capture): Promise<void> => {
	await db.runAsync('DELETE FROM captures WHERE fingerprint = ? AND id <> ?', [
		capture.fingerprint,
		capture.id,
	]);
	await db.runAsync(
		`INSERT INTO captures
       (id, fingerprint, packageName, appLabel, title, text, postedAt, amountCents, direction, kind,
        counterparty, merchantKey, cardLast4, status, question, relatedId, suggestedCategory,
        transactionId, autoConfirmed, reason, accountId, transferId, installments, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       status = excluded.status, question = excluded.question, relatedId = excluded.relatedId,
       suggestedCategory = excluded.suggestedCategory, transactionId = excluded.transactionId,
       autoConfirmed = excluded.autoConfirmed, reason = excluded.reason,
       accountId = excluded.accountId, transferId = excluded.transferId,
       installments = excluded.installments, updatedAt = excluded.updatedAt`,
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
			capture.counterparty ?? null,
			capture.merchantKey ?? null,
			capture.cardLast4 ?? null,
			capture.status,
			capture.question ?? null,
			capture.relatedId ?? null,
			capture.suggestedCategory ?? null,
			capture.transactionId ?? null,
			capture.autoConfirmed ? 1 : 0,
			capture.reason ?? null,
			capture.accountId ?? null,
			capture.transferId ?? null,
			capture.installments ?? null,
			capture.createdAt,
			capture.updatedAt,
		]
	);
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

/**
 * Todas as regras aprendidas, para o backup. É o que o app sabe dos hábitos deste
 * usuário — qual categoria cada estabelecimento recebe, quem é conta própria, o que
 * ignorar — e quantas confirmações sustentam cada palpite. Reinstalar sem isso faz o
 * app desaprender tudo e voltar a perguntar o que já estava respondido.
 */
export const getMerchantRules = async (): Promise<MerchantRule[]> =>
	db.getAllAsync<MerchantRule>('SELECT * FROM merchant_rules ORDER BY merchantKey');

/**
 * Regrava uma regra do backup com o `updatedAt` do arquivo, e não o de agora:
 * `saveMerchantRule` carimba o instante da escrita, que é o certo para um aprendizado
 * novo e errado para um que está só voltando do backup.
 */
export const restoreMerchantRule = async (rule: MerchantRule): Promise<void> => {
	await db.runAsync(
		`INSERT INTO merchant_rules (merchantKey, categoryId, treatAs, confirmations, updatedAt)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (merchantKey) DO UPDATE SET
       categoryId = excluded.categoryId, treatAs = excluded.treatAs,
       confirmations = excluded.confirmations, updatedAt = excluded.updatedAt`,
		[
			rule.merchantKey,
			rule.categoryId ?? null,
			rule.treatAs,
			rule.confirmations,
			rule.updatedAt,
		]
	);
};

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

/**
 * A saída avisada pela conta PJ pelo mesmo app ("você enviou R$ X para VINICIUS") que
 * o motor tratou como transferência para fora, sem par. Quando o recebimento da PJ
 * é reconhecido como receita, essa saída não era da conta pessoal: é neutralizada.
 */
export const findUnpairedTransferLeg = async (match: {
	packageName: string;
	amountCents: number;
	since: string;
	until: string;
}): Promise<Capture | null> => {
	const row = await db.getFirstAsync<CaptureRow>(
		`SELECT * FROM captures
     WHERE packageName = ? AND amountCents = ? AND direction = 'out' AND status = 'transfer'
       AND relatedId IS NULL AND postedAt BETWEEN ? AND ?
     ORDER BY postedAt DESC LIMIT 1`,
		[match.packageName, match.amountCents, match.since, match.until]
	);
	return row ? toCapture(row) : null;
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
		// Parcelas ficam de fora: a captura guarda o total da compra e só casa com uma linha
		// do total. A linha "LOJA 01/10" precisa encontrar a parcela 1 pelo lançamento — senão
		// ela vira uma compra nova e a parcela conta duas vezes.
		'SELECT transactionId FROM captures WHERE transactionId IS NOT NULL AND (installments IS NULL OR installments <= 1)'
	);
	return new Set(rows.map((row) => row.transactionId));
};

export default {
	insertCapture,
	getAllCaptures,
	restoreCapture,
	getMerchantRules,
	restoreMerchantRule,
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
