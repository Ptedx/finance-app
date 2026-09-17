/**
 * O que acontece com uma notificação capturada, do arquivo nativo até a transação.
 *
 * `ingestRawCaptures` é o funil: impressão digital (a mesma notificação nunca entra
 * duas vezes), interpretação (`captureParser`), conta de origem (`accountResolver`),
 * decisão (`captureMatcher`) e gravação na caixa de entrada — ou direto no livro-caixa,
 * quando o estabelecimento já foi confirmado vezes suficientes. `applyDecision` é a
 * parte da gravação, compartilhada com o import de extrato (`statementImport`), que
 * decide pelo mesmo motor. As demais funções são as respostas do usuário na tela de
 * revisão. Nenhuma delas mexe em estado React: o `CapturesContext` chama e recarrega.
 *
 * Três coisas saem daqui para o livro-caixa, todas pela fila de sync:
 *  - **transações** (uma, ou N parcelas de uma compra parcelada);
 *  - **transferências** entre contas do usuário, inclusive o pagamento da fatura;
 *  - nada, no caso de aplicação, resgate e do que o usuário descarta.
 */

import {
	type CaptureDraft,
	findUnpairedTransferLeg,
	getCapture,
	getMerchantRule,
	getRecentCaptures,
	hasCaptureFingerprint,
	insertCapture,
	saveMerchantRule,
	updateCapture,
} from '../database/captures';
import {
	addTransaction,
	addTransfer,
	deleteTransaction,
	deleteTransactionsInGroup,
	deleteTransfer,
	findLiveTransfer,
	getAccount,
	getTransfer,
	reassignCaptureLedger,
	updateTransfer,
} from '../database/database';
import type { Capture, Category } from '../database/schema';
import * as syncQueue from '../sync/queue';
import {
	findCardForInvoice,
	findCheckingForCard,
	resolveAccountForNotification,
} from './accountResolver';
import {
	candidateFrom,
	DEFAULT_AUTO_CONFIRM_THRESHOLD,
	type Decision,
	decide,
	fingerprintOf,
	type KnownCapture,
	learnFromConfirmation,
	type MerchantRule,
} from './captureMatcher';
import { type CaptureKind, guessCategory, isWalletPackage, parseCapture, type RawCapture } from './captureParser';
import { generateUniqueId } from './categoryEditUtils';
import { addDays, getISODate } from './dateUtils';
import { cardInstallmentDates, cycleRuleOf } from './cardMath';
import { splitInstallments } from './installments';

/** Quanto tempo para trás a decisão olha: um dia útil de TED, com folga. */
const LOOKBACK_MS = 26 * 60 * 60 * 1000;

/** Uma transferência avisada pelos dois lados pode chegar com dias de diferença. */
const TRANSFER_LINK_WINDOW_DAYS = 5;

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

export const toKnownCapture = (capture: Capture): KnownCapture => ({
	id: capture.id,
	packageName: capture.packageName,
	postedAt: capture.postedAt,
	amountCents: capture.amountCents,
	direction: capture.direction,
	kind: capture.kind as CaptureKind,
	merchantKey: capture.merchantKey,
	status: capture.status,
	relatedId: capture.relatedId,
	transactionId: capture.transactionId,
	accountId: capture.accountId,
});

export const toMerchantRule = (
	row: { merchantKey: string; categoryId: string | null; treatAs: MerchantRule['treatAs']; confirmations: number } | null
): MerchantRule | undefined =>
	row
		? { merchantKey: row.merchantKey, categoryId: row.categoryId, treatAs: row.treatAs, confirmations: row.confirmations }
		: undefined;

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

type Postable = Pick<
	Capture,
	'amountCents' | 'direction' | 'counterparty' | 'appLabel' | 'postedAt' | 'accountId' | 'installments' | 'cardLast4'
>;

/**
 * Grava a compra no livro: uma transação, ou N parcelas datadas um mês após a outra
 * e ligadas por `installmentGroup` (o id da captura). Devolve o id da primeira.
 */
const postTransaction = async (capture: Postable, categoryId: string, groupId: string): Promise<string> => {
	const date = localDateOf(capture.postedAt);
	const note = capture.counterparty ?? capture.appLabel;
	const count = capture.installments && capture.installments > 1 ? capture.installments : 1;

	if (count === 1) {
		const id = await addTransaction({
			amountCents: capture.amountCents,
			category: categoryId,
			date,
			note,
			isIncome: capture.direction === 'in',
			accountId: capture.accountId,
			cardLast4: capture.cardLast4,
		});
		syncQueue.schedule();
		return id;
	}

	const parts = splitInstallments(capture.amountCents, count);
	// No cartão, uma parcela por fatura: a data segue o ciclo do cartão.
	const account = capture.accountId ? await getAccount(capture.accountId) : null;
	const dates = cardInstallmentDates(date, count, account?.kind === 'credit_card' ? cycleRuleOf(account) : null);
	let firstId = '';
	for (let index = 1; index <= count; index += 1) {
		const id = await addTransaction({
			amountCents: parts[index - 1],
			category: categoryId,
			date: dates[index - 1],
			note: `${note} (${index}/${count})`,
			isIncome: capture.direction === 'in',
			accountId: capture.accountId,
			installmentGroup: groupId,
			installmentIndex: index,
			installmentCount: count,
			cardLast4: capture.cardLast4,
		});
		if (index === 1) firstId = id;
	}
	syncQueue.schedule();
	return firstId;
};

/**
 * Registra (ou reaproveita) a transferência de um movimento entre contas.
 *
 * `from`/`to` nulos significam "uma conta que o app não acompanha, ou que ainda não
 * apareceu". Se a outra perna já criou a transferência com um lado nulo, este lado
 * a completa em vez de criar outra; e uma transferência viva com o mesmo valor, dias
 * próximos e lados compatíveis é reaproveitada — é o que impede o pagamento da
 * fatura de contar duas vezes quando a conta e o cartão avisam.
 */
const recordTransfer = async (
	movement: Pick<Capture, 'amountCents' | 'postedAt' | 'counterparty' | 'appLabel'>,
	from: string | null,
	to: string | null,
	existingTransferId: string | null
): Promise<string> => {
	const date = localDateOf(movement.postedAt);

	if (existingTransferId) {
		const current = await getTransfer(existingTransferId);
		if (current && !current.deletedAt) {
			await updateTransfer({
				...current,
				fromAccountId: current.fromAccountId ?? from,
				toAccountId: current.toAccountId ?? to,
			});
			syncQueue.schedule();
			return current.id;
		}
	}

	const live = await findLiveTransfer({
		amountCents: movement.amountCents,
		fromAccountId: from,
		toAccountId: to,
		dateFrom: addDays(date, -TRANSFER_LINK_WINDOW_DAYS),
		dateTo: addDays(date, TRANSFER_LINK_WINDOW_DAYS),
	});
	if (live) {
		if ((live.fromAccountId === null && from) || (live.toAccountId === null && to)) {
			await updateTransfer({
				...live,
				fromAccountId: live.fromAccountId ?? from,
				toAccountId: live.toAccountId ?? to,
			});
		}
		syncQueue.schedule();
		return live.id;
	}

	const id = await addTransfer({
		fromAccountId: from,
		toAccountId: to,
		amountCents: movement.amountCents,
		date,
		note: movement.counterparty ?? movement.appLabel,
	});
	syncQueue.schedule();
	return id;
};

/** As pontas de uma transferência vista deste lado: saída parte daqui, entrada chega aqui. */
const transferSidesOf = (
	capture: Pick<Capture, 'direction' | 'accountId'>,
	other: string | null
): { from: string | null; to: string | null } =>
	capture.direction === 'out' ? { from: capture.accountId, to: other } : { from: other, to: capture.accountId };

/**
 * Pagar a fatura é transferir da conta para o cartão. Visto pela conta ("pagamento da
 * fatura"), o destino é o único cartão do mesmo banco; visto pelo cartão ("pagamento
 * recebido"), a origem é a única conta do mesmo banco. Com mais de um candidato o lado
 * fica nulo, e as duas vistas ainda se reconhecem pelo valor e pela data.
 */
const recordInvoicePayment = async (
	capture: Pick<Capture, 'amountCents' | 'postedAt' | 'counterparty' | 'appLabel' | 'accountId' | 'direction'>
): Promise<string | null> => {
	if (!capture.accountId) return null;
	const account = await getAccount(capture.accountId);
	if (!account) return null;

	// O mesmo pagamento chega por caminhos diferentes — o aviso da conta, o aviso do
	// cartão, o botão "Pagar fatura", o extrato — e cada um pode achar uma conta de origem
	// diferente. Pagamento de mesmo valor para o mesmo cartão em poucos dias é o mesmo.
	const payInto = async (cardId: string | null, from: string | null): Promise<string> => {
		if (cardId) {
			const date = localDateOf(capture.postedAt);
			const live = await findLiveTransfer({
				amountCents: capture.amountCents,
				fromAccountId: null,
				toAccountId: cardId,
				dateFrom: addDays(date, -TRANSFER_LINK_WINDOW_DAYS),
				dateTo: addDays(date, TRANSFER_LINK_WINDOW_DAYS),
			});
			if (live) {
				if (live.fromAccountId === null && from) {
					await updateTransfer({ ...live, fromAccountId: from });
					syncQueue.schedule();
				}
				return live.id;
			}
		}
		return recordTransfer(capture, from, cardId, null);
	};

	if (account.kind === 'credit_card') {
		// Visto pelo cartão, o aviso de pagamento às vezes vem como "saída" do parser.
		const checking = await findCheckingForCard(account);
		return payInto(account.id, checking?.id ?? null);
	}

	if (capture.direction !== 'out') return null;
	const card = await findCardForInvoice(account);
	return payInto(card?.id ?? null, account.id);
};

// ---------------------------------------------------------------------------
// Gravação de uma decisão
// ---------------------------------------------------------------------------

/**
 * Grava um item novo na caixa de entrada conforme a decisão do motor.
 *
 * `base` é o rascunho com os campos da fonte (texto bruto, valor, contraparte, conta…)
 * e status pendente; a decisão diz o status final, a pergunta, o par e a categoria.
 * `auto_confirm` toca no livro (transações); `transfer` e o pagamento de fatura tocam
 * nas transferências. O resto só grava o item.
 */
export const applyDecision = async (
	base: CaptureDraft,
	decision: Decision,
	categories: Category[],
	explicitId?: string
): Promise<{ id: string; autoConfirmed: boolean }> => {
	const id = explicitId ?? generateUniqueId();

	switch (decision.action) {
		case 'duplicate': {
			await insertCapture(
				{ ...base, status: 'duplicate', relatedId: decision.relatedId, reason: decision.reason },
				id
			);
			// O Samsung Pay avisou primeiro e ficou como a compra; o banco chegou agora e é
			// quem sabe o cartão. A compra (e o que ela já pôs no livro) vai para a conta do
			// banco — senão ficaria numa conta "Samsung Wallet" e fora da fatura.
			if (decision.reason === 'wallet' && base.accountId && !isWalletPackage(base.packageName)) {
				const survivor = await getCapture(decision.relatedId);
				if (survivor && isWalletPackage(survivor.packageName) && survivor.accountId !== base.accountId) {
					await updateCapture(survivor.id, { accountId: base.accountId });
					if (survivor.transactionId) {
						await reassignCaptureLedger(survivor.transactionId, survivor.id, base.accountId);
						syncQueue.schedule();
					}
				}
			}
			return { id, autoConfirmed: false };
		}

		case 'ask_duplicate':
			await insertCapture(
				{
					...base,
					question: 'duplicate',
					relatedId: decision.relatedId,
					suggestedCategory: resolveCategoryId(base.suggestedCategory, base.direction, categories),
				},
				id
			);
			return { id, autoConfirmed: false };

		case 'transfer': {
			const related = decision.relatedId ? await getCapture(decision.relatedId) : null;
			const sides = transferSidesOf(base, related?.accountId ?? null);
			const transferId = await recordTransfer(base, sides.from, sides.to, related?.transferId ?? null);

			await insertCapture(
				{ ...base, status: 'transfer', relatedId: decision.relatedId, reason: decision.reason, transferId },
				id
			);
			if (related) {
				await updateCapture(related.id, {
					status: 'transfer',
					question: null,
					relatedId: id,
					reason: decision.reason,
					transferId,
				});
			}
			return { id, autoConfirmed: false };
		}

		case 'ask_transfer':
			await insertCapture(
				{
					...base,
					question: 'transfer',
					relatedId: decision.relatedId,
					suggestedCategory: resolveCategoryId(base.suggestedCategory, base.direction, categories),
				},
				id
			);
			return { id, autoConfirmed: false };

		case 'neutral': {
			const transferId = decision.reason === 'invoice_payment' ? await recordInvoicePayment(base) : null;
			await insertCapture({ ...base, status: 'ignored', reason: decision.reason, transferId }, id);
			return { id, autoConfirmed: false };
		}

		case 'ignore':
			await insertCapture({ ...base, status: 'ignored', reason: decision.reason }, id);
			return { id, autoConfirmed: false };

		case 'pending':
			await insertCapture(
				{ ...base, suggestedCategory: resolveCategoryId(decision.categoryId, base.direction, categories) },
				id
			);
			return { id, autoConfirmed: false };

		case 'auto_confirm': {
			const categoryId = resolveCategoryId(decision.categoryId, base.direction, categories);
			const transactionId = await postTransaction(base, categoryId, id);
			await insertCapture(
				{
					...base,
					status: 'confirmed',
					suggestedCategory: categoryId,
					transactionId,
					autoConfirmed: true,
					reason: 'rule',
				},
				id
			);
			return { id, autoConfirmed: true };
		}
	}
};

/** Se a regra aprendida diz que a contraparte paga receita (categoria de receita). */
const isExternalIncomeRule = (rule: MerchantRule | undefined, categories: Category[]): boolean =>
	Boolean(
		rule?.categoryId &&
			rule.treatAs === 'transaction' &&
			categories.some((c) => c.id === rule.categoryId && c.type === 'income' && !c.deletedAt)
	);

/**
 * Um recebimento de fonte externa foi reconhecido como receita. Se a saída que a PJ
 * avisou pelo mesmo app já virou "transferência para fora", ela era da PJ, não da
 * conta pessoal: apaga a transferência e deixa o aviso no histórico como ignorado.
 */
const neutralizeExternalLeg = async (
	income: Pick<Capture, 'packageName' | 'amountCents' | 'postedAt'>
): Promise<void> => {
	const posted = new Date(income.postedAt).getTime();
	const leg = await findUnpairedTransferLeg({
		packageName: income.packageName,
		amountCents: income.amountCents,
		since: new Date(posted - LOOKBACK_MS).toISOString(),
		until: new Date(posted + LOOKBACK_MS).toISOString(),
	});
	if (!leg) return;

	if (leg.transferId) {
		await deleteTransfer(leg.transferId);
		syncQueue.schedule();
	}
	await updateCapture(leg.id, { status: 'ignored', reason: 'external_leg', transferId: null });
};

// ---------------------------------------------------------------------------
// Entrada de notificações
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
		// Uma notificação que falha não leva as outras junto: a fila nativa já foi esvaziada,
		// e o que não for gravado aqui se perde.
		try {
		const fingerprint = fingerprintOf(raw);
		if (await hasCaptureFingerprint(fingerprint)) continue;

		const parsed = parseCapture(raw);
		if (!parsed) continue;

		const account = await resolveAccountForNotification(raw, parsed);
		const candidate = candidateFrom(raw, parsed);
		const since = new Date(new Date(raw.postedAt).getTime() - LOOKBACK_MS).toISOString();
		const recent = (await getRecentCaptures(since)).map(toKnownCapture);
		const rule = candidate.merchantKey ? toMerchantRule(await getMerchantRule(candidate.merchantKey)) : undefined;
		const fallbackCategoryId = resolveCategoryId(guessCategory(parsed), parsed.direction, options.categories);

		const externalIncome = isExternalIncomeRule(rule, options.categories);

		let decision = decide(candidate, {
			recent,
			rule,
			ownNames: options.ownNames,
			autoConfirmThreshold: threshold,
			fallbackCategoryId,
			externalIncome,
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
			suggestedCategory: rule?.categoryId ?? fallbackCategoryId,
			transactionId: null,
			autoConfirmed: false,
			reason: null,
			accountId: account.id,
			transferId: null,
			installments: parsed.installments,
		};

		const result = await applyDecision(base, decision, options.categories);
		if (result.autoConfirmed) summary.autoConfirmed += 1;
		summary.inserted += 1;

		if (externalIncome && parsed.direction === 'in') await neutralizeExternalLeg(base);
		} catch (error) {
			console.error('Failed to ingest notification:', error);
		}
	}

	return summary;
};

// ---------------------------------------------------------------------------
// Respostas do usuário
// ---------------------------------------------------------------------------

const learnCategory = async (capture: Capture, categoryId: string): Promise<void> => {
	if (!capture.merchantKey) return;
	const current = toMerchantRule(await getMerchantRule(capture.merchantKey));
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

/** Apaga o que uma captura pôs no livro: a transação, ou todas as parcelas. */
const removePostedTransactions = async (capture: Capture): Promise<void> => {
	if (!capture.transactionId) return;
	if (capture.installments && capture.installments > 1) {
		await deleteTransactionsInGroup(capture.id);
	} else {
		await deleteTransaction(capture.transactionId);
	}
	syncQueue.schedule();
};

/** Vira transação (ou parcelas) com a categoria escolhida, e o app aprende o estabelecimento. */
export const confirmCapture = async (
	id: string,
	categoryId: string,
	categories: Category[]
): Promise<Capture | null> => {
	const capture = await getCapture(id);
	if (!capture || capture.status !== 'pending') return null;

	const resolved = resolveCategoryId(categoryId, capture.direction, categories);
	const transactionId = await postTransaction(capture, resolved, capture.id);
	await updateCapture(id, {
		status: 'confirmed',
		question: null,
		suggestedCategory: resolved,
		transactionId,
		reason: null,
	});
	await learnCategory(capture, resolved);

	// Confirmar um recebimento como receita é o que ensina que a fonte é externa; a
	// saída que a PJ avisou pelo mesmo app, se já virou transferência, deixa de ser.
	if (
		capture.direction === 'in' &&
		categories.some((c) => c.id === resolved && c.type === 'income' && !c.deletedAt)
	) {
		await neutralizeExternalLeg(capture);
	}

	return { ...capture, status: 'confirmed', suggestedCategory: resolved, transactionId };
};

export const dismissCapture = async (id: string): Promise<void> => {
	await updateCapture(id, { status: 'dismissed', question: null, reason: 'manual' });
};

/**
 * "É transferência entre minhas contas": sai do livro, entra como transferência entre
 * as contas das duas pernas (quando há a outra pendente ou já confirmada), e o app
 * aprende a contraparte para decidir sozinho da próxima vez.
 */
export const markCaptureTransfer = async (id: string): Promise<void> => {
	const capture = await getCapture(id);
	if (!capture) return;

	const related = capture.relatedId ? await getCapture(capture.relatedId) : null;
	const pairable = related && (related.status === 'pending' || related.status === 'confirmed');

	if (pairable && related.status === 'confirmed') {
		// A outra perna já tinha virado lançamento: o usuário acabou de dizer que
		// não era. Sai do livro e fica registrado como transferência.
		await removePostedTransactions(related);
	}

	const sides = transferSidesOf(capture, pairable ? related.accountId : null);
	const transferId = await recordTransfer(capture, sides.from, sides.to, related?.transferId ?? null);

	await updateCapture(id, { status: 'transfer', question: null, reason: 'manual', transferId });
	if (pairable) {
		await updateCapture(related.id, {
			status: 'transfer',
			question: null,
			relatedId: id,
			transactionId: null,
			autoConfirmed: false,
			reason: 'manual',
			transferId,
		});
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
 * apaga a transação (ou as parcelas) criada, apaga a transferência, e solta a outra
 * perna de uma transferência.
 *
 * Uma linha de extrato ligada a um lançamento digitado (`statement_transaction`) não
 * apaga esse lançamento ao reverter: ele não foi criado por ela, é do usuário.
 */
export const revertCapture = async (id: string): Promise<void> => {
	const capture = await getCapture(id);
	if (!capture || capture.status === 'pending') return;

	if (capture.transactionId && capture.reason !== 'statement_transaction') {
		await removePostedTransactions(capture);
	}

	if (capture.transferId) {
		await deleteTransfer(capture.transferId);
		syncQueue.schedule();
	}

	if (capture.status === 'transfer' && capture.relatedId) {
		const related = await getCapture(capture.relatedId);
		if (related?.status === 'transfer' && related.relatedId === id) {
			await updateCapture(related.id, {
				status: 'pending',
				question: null,
				relatedId: null,
				reason: null,
				transferId: null,
			});
		}
	}

	await updateCapture(id, {
		status: 'pending',
		question: null,
		relatedId: null,
		transactionId: null,
		autoConfirmed: false,
		reason: null,
		transferId: null,
	});
};

export default {
	ingestRawCaptures,
	applyDecision,
	resolveCategoryId,
	confirmCapture,
	dismissCapture,
	markCaptureTransfer,
	answerCaptureDuplicate,
	answerCaptureTransfer,
	revertCapture,
};
