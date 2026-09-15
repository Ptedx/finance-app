/**
 * O que acontece com uma notificação capturada, do arquivo nativo até a transação.
 *
 * `ingestRawCaptures` é o funil: impressão digital (a mesma notificação nunca entra
 * duas vezes), interpretação (`captureParser`), decisão (`captureMatcher`) e gravação
 * na caixa de entrada — ou direto no livro-caixa, quando o estabelecimento já foi
 * confirmado vezes suficientes. As demais funções são as respostas do usuário na tela
 * de revisão. Nenhuma delas mexe em estado React: o `CapturesContext` chama e recarrega.
 *
 * Toda transação criada aqui passa por `addTransaction` e entra na fila de sync como
 * qualquer outra; a caixa de entrada em si nunca sai do aparelho.
 */

import {
	type CaptureDraft,
	getCapture,
	getMerchantRule,
	getRecentCaptures,
	hasCaptureFingerprint,
	insertCapture,
	saveMerchantRule,
	updateCapture,
} from '../database/captures';
import { addTransaction, deleteTransaction } from '../database/database';
import type { Capture, Category } from '../database/schema';
import * as syncQueue from '../sync/queue';
import {
	candidateFrom,
	DEFAULT_AUTO_CONFIRM_THRESHOLD,
	decide,
	fingerprintOf,
	type KnownCapture,
	learnFromConfirmation,
	type MerchantRule,
} from './captureMatcher';
import { type CaptureKind, guessCategory, parseCapture, type RawCapture } from './captureParser';
import { getISODate } from './dateUtils';

/** Quanto tempo para trás a decisão olha: um dia útil de TED, com folga. */
const LOOKBACK_MS = 26 * 60 * 60 * 1000;

export interface IngestOptions {
	/** Nomes do usuário: um Pix para si mesmo é troca de bolso. */
	ownNames: string[];
	categories: Category[];
	autoConfirmThreshold?: number;
}

export interface IngestSummary {
	/** Quantas notificações viraram itens (em qualquer status). */
	inserted: number;
	/** Quantas viraram transação sem passar pela revisão. */
	autoConfirmed: number;
}

const toKnown = (capture: Capture): KnownCapture => ({
	id: capture.id,
	packageName: capture.packageName,
	postedAt: capture.postedAt,
	amountCents: capture.amountCents,
	direction: capture.direction,
	kind: capture.kind as CaptureKind,
	merchantKey: capture.merchantKey,
	status: capture.status,
	transactionId: capture.transactionId,
});

const toRule = (row: { merchantKey: string; categoryId: string | null; treatAs: MerchantRule['treatAs']; confirmations: number } | null): MerchantRule | undefined =>
	row ? { merchantKey: row.merchantKey, categoryId: row.categoryId, treatAs: row.treatAs, confirmations: row.confirmations } : undefined;

/**
 * Garante que a categoria sugerida existe e é do lado certo do livro (receita ou
 * despesa). Uma sugestão apagada ou trocada de lado cai em "outros" do lado certo.
 */
export const resolveCategoryId = (
	wanted: string | null,
	direction: 'in' | 'out',
	categories: Category[]
): string => {
	const type = direction === 'in' ? 'income' : 'expense';
	const usable = (id: string | null): boolean =>
		id !== null && categories.some((c) => c.id === id && c.type === type && !c.deletedAt);

	if (usable(wanted)) return wanted as string;
	const fallback = direction === 'in' ? 'other_income' : 'other_expense';
	if (usable(fallback)) return fallback;
	return categories.find((c) => c.type === type && !c.deletedAt)?.id ?? 'uncategorized';
};

const localDateOf = (iso: string): string => getISODate(new Date(iso));

const postTransaction = async (
	capture: Pick<Capture, 'amountCents' | 'direction' | 'counterparty' | 'appLabel' | 'postedAt'>,
	categoryId: string
): Promise<string> => {
	const id = await addTransaction({
		amountCents: capture.amountCents,
		category: categoryId,
		date: localDateOf(capture.postedAt),
		note: capture.counterparty ?? capture.appLabel,
		isIncome: capture.direction === 'in',
	});
	syncQueue.schedule();
	return id;
};

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

export const ingestRawCaptures = async (
	raws: RawCapture[],
	options: IngestOptions
): Promise<IngestSummary> => {
	const summary: IngestSummary = { inserted: 0, autoConfirmed: 0 };
	const threshold = options.autoConfirmThreshold ?? DEFAULT_AUTO_CONFIRM_THRESHOLD;

	// Ordem de chegada: a decisão sobre a segunda notificação depende da primeira já
	// estar na caixa de entrada.
	const ordered = [...raws].sort((a, b) => a.postedAt.localeCompare(b.postedAt));

	for (const raw of ordered) {
		const fingerprint = fingerprintOf(raw);
		if (await hasCaptureFingerprint(fingerprint)) continue;

		const parsed = parseCapture(raw);
		if (!parsed) continue;

		const candidate = candidateFrom(raw, parsed);
		const since = new Date(new Date(raw.postedAt).getTime() - LOOKBACK_MS).toISOString();
		const recent = (await getRecentCaptures(since)).map(toKnown);
		const rule = candidate.merchantKey ? toRule(await getMerchantRule(candidate.merchantKey)) : undefined;
		const fallbackCategoryId = resolveCategoryId(guessCategory(parsed), parsed.direction, options.categories);

		let decision = decide(candidate, {
			recent,
			rule,
			ownNames: options.ownNames,
			autoConfirmThreshold: threshold,
			fallbackCategoryId,
		});

		// Uma transferência "certa" cuja outra perna o usuário já confirmou como
		// lançamento não desfaz a confirmação sozinha: vira pergunta. Apagar uma
		// transação que a pessoa aprovou é decisão dela, mesmo quando o nome é o dela.
		if (decision.action === 'transfer' && decision.relatedId) {
			const relatedId = decision.relatedId;
			const related = recent.find((known) => known.id === relatedId);
			if (related?.status === 'confirmed') {
				decision = { action: 'ask_transfer', relatedId: related.id };
			}
		}

		const base: CaptureDraft = {
			fingerprint,
			packageName: raw.packageName,
			appLabel: raw.appLabel,
			title: raw.title,
			text: raw.text,
			postedAt: raw.postedAt,
			amountCents: parsed.amountCents,
			direction: parsed.direction,
			kind: parsed.kind,
			counterparty: parsed.counterparty,
			merchantKey: candidate.merchantKey,
			cardLast4: parsed.cardLast4,
			status: 'pending',
			question: null,
			relatedId: null,
			suggestedCategory: null,
			transactionId: null,
			autoConfirmed: false,
			reason: null,
		};

		switch (decision.action) {
			case 'duplicate':
				await insertCapture({ ...base, status: 'duplicate', relatedId: decision.relatedId, reason: 'wallet' });
				break;

			case 'ask_duplicate':
				await insertCapture({
					...base,
					question: 'duplicate',
					relatedId: decision.relatedId,
					suggestedCategory: rule?.categoryId
						? resolveCategoryId(rule.categoryId, parsed.direction, options.categories)
						: fallbackCategoryId,
				});
				break;

			case 'transfer': {
				const inserted = await insertCapture({
					...base,
					status: 'transfer',
					relatedId: decision.relatedId,
					reason: decision.reason,
				});
				if (decision.relatedId) {
					await updateCapture(decision.relatedId, {
						status: 'transfer',
						question: null,
						relatedId: inserted.id,
						reason: decision.reason,
					});
				}
				break;
			}

			case 'ask_transfer':
				await insertCapture({
					...base,
					question: 'transfer',
					relatedId: decision.relatedId,
					suggestedCategory: fallbackCategoryId,
				});
				break;

			case 'neutral':
			case 'ignore':
				await insertCapture({ ...base, status: 'ignored', reason: decision.reason });
				break;

			case 'pending':
				await insertCapture({
					...base,
					suggestedCategory: resolveCategoryId(decision.categoryId, parsed.direction, options.categories),
				});
				break;

			case 'auto_confirm': {
				const categoryId = resolveCategoryId(decision.categoryId, parsed.direction, options.categories);
				const transactionId = await postTransaction(base, categoryId);
				await insertCapture({
					...base,
					status: 'confirmed',
					suggestedCategory: categoryId,
					transactionId,
					autoConfirmed: true,
					reason: 'rule',
				});
				summary.autoConfirmed += 1;
				break;
			}
		}

		summary.inserted += 1;
	}

	return summary;
};

// ---------------------------------------------------------------------------
// Respostas do usuário
// ---------------------------------------------------------------------------

const learnCategory = async (capture: Capture, categoryId: string): Promise<void> => {
	if (!capture.merchantKey) return;
	const current = toRule(await getMerchantRule(capture.merchantKey));
	await saveMerchantRule(learnFromConfirmation(current, capture.merchantKey, categoryId));
};

const learnTransfer = async (capture: Capture): Promise<void> => {
	if (!capture.merchantKey) return;
	await saveMerchantRule({
		merchantKey: capture.merchantKey,
		categoryId: null,
		treatAs: 'transfer',
		confirmations: 1,
	});
};

/** Vira transação com a categoria escolhida, e o app aprende o estabelecimento. */
export const confirmCapture = async (
	id: string,
	categoryId: string,
	categories: Category[]
): Promise<Capture | null> => {
	const capture = await getCapture(id);
	if (!capture || capture.status !== 'pending') return null;

	const resolved = resolveCategoryId(categoryId, capture.direction, categories);
	const transactionId = await postTransaction(capture, resolved);
	await updateCapture(id, {
		status: 'confirmed',
		question: null,
		suggestedCategory: resolved,
		transactionId,
		reason: null,
	});
	await learnCategory(capture, resolved);

	return { ...capture, status: 'confirmed', suggestedCategory: resolved, transactionId };
};

export const dismissCapture = async (id: string): Promise<void> => {
	await updateCapture(id, { status: 'dismissed', question: null, reason: 'manual' });
};

/**
 * "É transferência entre minhas contas": sai do livro, leva a outra perna junto quando
 * há uma pendente, e o app aprende a contraparte para decidir sozinho da próxima vez.
 */
export const markCaptureTransfer = async (id: string): Promise<void> => {
	const capture = await getCapture(id);
	if (!capture) return;

	await updateCapture(id, { status: 'transfer', question: null, reason: 'manual' });

	if (capture.relatedId) {
		const related = await getCapture(capture.relatedId);
		if (related?.status === 'pending') {
			await updateCapture(related.id, { status: 'transfer', question: null, relatedId: id, reason: 'manual' });
		} else if (related?.status === 'confirmed' && related.transactionId) {
			// A outra perna já tinha virado lançamento: o usuário acabou de dizer que
			// não era. Sai do livro e fica registrado como transferência.
			await deleteTransaction(related.transactionId);
			syncQueue.schedule();
			await updateCapture(related.id, {
				status: 'transfer',
				question: null,
				relatedId: id,
				transactionId: null,
				autoConfirmed: false,
				reason: 'manual',
			});
		}
	}

	await learnTransfer(capture);
};

/** Resposta à pergunta "é o mesmo lançamento?". */
export const answerCaptureDuplicate = async (id: string, same: boolean): Promise<void> => {
	if (same) {
		await updateCapture(id, { status: 'duplicate', question: null, reason: 'manual' });
	} else {
		await updateCapture(id, { question: null });
	}
};

/** Resposta à pergunta "é transferência entre suas contas?". */
export const answerCaptureTransfer = async (id: string, isTransfer: boolean): Promise<void> => {
	if (isTransfer) {
		await markCaptureTransfer(id);
	} else {
		await updateCapture(id, { question: null });
	}
};

/**
 * Volta um item para a fila de revisão, desfazendo o que a decisão (ou o usuário) fez:
 * apaga a transação criada, e solta a outra perna de uma transferência.
 */
export const revertCapture = async (id: string): Promise<void> => {
	const capture = await getCapture(id);
	if (!capture || capture.status === 'pending') return;

	if (capture.transactionId) {
		await deleteTransaction(capture.transactionId);
		syncQueue.schedule();
	}

	if (capture.status === 'transfer' && capture.relatedId) {
		const related = await getCapture(capture.relatedId);
		if (related?.status === 'transfer' && related.relatedId === id) {
			await updateCapture(related.id, { status: 'pending', question: null, relatedId: null, reason: null });
		}
	}

	await updateCapture(id, {
		status: 'pending',
		question: null,
		relatedId: null,
		transactionId: null,
		autoConfirmed: false,
		reason: null,
	});
};

export default {
	ingestRawCaptures,
	resolveCategoryId,
	confirmCapture,
	dismissCapture,
	markCaptureTransfer,
	answerCaptureDuplicate,
	answerCaptureTransfer,
	revertCapture,
};
