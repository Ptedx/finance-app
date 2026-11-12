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
 *
 * E a baixa da conta a pagar (REM-04): o lançamento que é o pagamento dela marca o mês
 * como pago (`settleBillPayment`), apagá-lo desfaz a baixa (`undoBillPayment`) e editá-lo
 * refaz a baixa (`resettleBillPayment`). O `TransactionsContext` usa as três para o
 * lançamento digitado.
 */

import {
	type CaptureDraft,
	deleteMerchantRule,
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
	getAccounts,
	getBillPayments,
	getBills,
	getTransfer,
	reassignCaptureLedger,
	saveBillPayments,
	updateBill,
	updateTransfer,
} from '../database/database';
import type { Account, BillPayment, Capture, Category, Transfer } from '../database/schema';
import { logCaptureDecision, logCaptureFailure } from '../diagnostics/capture';
import type { DiagnosticValue } from '../diagnostics/contract';
import { log } from '../diagnostics/log';
import * as syncQueue from '../sync/queue';
import {
	type AccountResolution,
	type DestinationResolution,
	findCardByClosedInvoice,
	findCardByLast4,
	findCardForInvoice,
	canLearnToIgnore,
	findCheckingForCard,
	findReserveForInvestment,
	isNoBankNotice,
	resolveAccountForNotification,
} from './accountResolver';
import { type AmbiguityCase, ambiguityOfReason, ambiguousReason, learnedReason, TARGET_CASES } from './ambiguityReasons';
import type { BusinessFeeds } from './businessFeed';
import { emitBillsChanged } from './billEvents';
import {
	type BillMatch,
	type BillMovement,
	type BillSettlementUndo,
	billPaymentPatch,
	billSettlementUndo,
	matchBillPayment,
	type SettledBill,
	settledBillOf,
} from './billMatcher';
import { billPaymentDraft } from './billPayments';
import {
	type CaptureChoiceStore,
	type CaptureChoices,
	choiceKeyOf,
	detectAmbiguity,
	invoiceCardFor,
	lookupChoice,
	rememberChoice,
	SKIP_CHOICE,
} from './captureChoices';
import {
	appRuleKeyOf,
	candidateFrom,
	DEFAULT_AUTO_CONFIRM_THRESHOLD,
	type Decision,
	decide,
	fingerprintOf,
	forgetAppDismissal,
	isAppIgnored,
	isBlockedPackage,
	type KnownCapture,
	learnFromAppDismissal,
	learnFromConfirmation,
	type MerchantRule,
} from './captureMatcher';
import {
	type CaptureDirection,
	type CaptureKind,
	guessCategory,
	isWalletPackage,
	type ParsedCapture,
	parseCapture,
	type RawCapture,
	withDirection,
} from './captureParser';
import { generateUniqueId } from './categoryEditUtils';
import { addDays, getISODate } from './dateUtils';
import { cardInstallmentDates, cycleRuleOf, daysBetween, isSameCardPayment } from './cardMath';
import { splitInstallments } from './installments';
import { scheduleBillReminders } from './notificationUtils';

/** Quanto tempo para trás a decisão olha: um dia útil de TED, com folga. */
const LOOKBACK_MS = 26 * 60 * 60 * 1000;

/**
 * Quantos dias de diferença ainda podem ser o **mesmo** movimento visto duas vezes.
 *
 * Eram cinco, e cinco dias casavam movimentos diferentes: dois aportes de R$ 200 no mesmo
 * mês (dia 3 e dia 6) viravam um só, e um Pix de R$ 1.500 era casado com o pagamento da
 * fatura de R$ 1.500 de dois dias antes — reverter o Pix apagava o pagamento da fatura
 * (achados 1.2 e 7.5). A conta e o cartão avisam o mesmo movimento no mesmo dia, ou na
 * virada da meia-noite; um dia basta, e o que não couber nele vira outra transferência.
 */
const SAME_MOVEMENT_DAYS = 1;

export interface IngestOptions {
	/** Nomes do usuário: um Pix para si mesmo é troca de bolso. */
	ownNames: string[];
	/** O "seu nome como aparece no banco" de Ajustes, à parte para o diário (SPD-115). */
	bankName?: string | null;
	categories: Category[];
	autoConfirmThreshold?: number;
	/** Qual conta recebe os avisos da PJ de cada app ("da conta Nu Empresas", SPD-074). */
	businessFeeds?: BusinessFeeds;
	/** O que o app aprendeu com as respostas da revisão nos avisos ambíguos (SPD-123). */
	captureChoices?: CaptureChoices;
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
	// Entram na identidade da duplicata de carteira: valor e direção não bastam.
	cardLast4: capture.cardLast4,
	// O nome do app separa o recibo de quem não é banco do aviso do banco (NOTIF-20, SPD-112).
	appLabel: capture.appLabel ?? undefined,
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

// ---------------------------------------------------------------------------
// Baixa automática das contas a pagar
// ---------------------------------------------------------------------------

/**
 * Uma baixa (ou o desfazer) por vez: duas lidas das contas ao mesmo tempo gravariam uma
 * por cima da outra.
 */
let billSettling: Promise<unknown> = Promise.resolve();

const serialized = <T>(work: () => Promise<T>): Promise<T> => {
	const run = billSettling.then(work);
	billSettling = run.catch(() => undefined);
	return run;
};

/**
 * Depois de gravar: sobe pelo sync, remarca os lembretes com as contas relidas e avisa
 * quem mostra. Lembrete que não remarca não desfaz a baixa, que já está gravada.
 */
const afterBillsWrite = async (): Promise<void> => {
	syncQueue.schedule();
	try {
		const [bills, payments] = await Promise.all([getBills(), getBillPayments()]);
		await scheduleBillReminders(bills, new Date(), payments);
	} catch (error) {
		console.error('Failed to reschedule bill reminders:', error);
	}
	emitBillsChanged();
};

/**
 * Grava a baixa de um mês: o registro do mês com o lançamento e o valor (SPD-146) e a conta
 * (`paidThrough` e a última baixa). O registro primeiro: é ele que diz qual mês o
 * lançamento pagou, e sem a conta gravada `paidThrough` só fica atrás — piso, não erro.
 */
const writeSettlement = async (
	match: BillMatch,
	movement: BillMovement,
	payments: readonly BillPayment[]
): Promise<void> => {
	await saveBillPayments([
		billPaymentDraft(
			match.bill.id,
			match.month,
			'paid',
			movement.id,
			Math.abs(movement.amountCents)
		),
	]);
	await updateBill(match.bill.id, billPaymentPatch(match.bill, match.month, movement.id, payments));
};

/** Desfaz a baixa de um lançamento numa conta: a conta, o registro que sai e os que entram. */
const writeSettlementUndo = async (billId: string, undo: BillSettlementUndo): Promise<void> => {
	await saveBillPayments(undo.fill, undo.remove ? [undo.remove.id] : []);
	await updateBill(billId, undo.draft);
};

/**
 * Dá baixa na conta a pagar que este lançamento paga, se houver uma (`billMatcher`).
 * Devolve a conta e o mês quitados, ou `null`.
 *
 * Nunca falha: a baixa é um extra do lançamento, e um erro aqui não pode desfazer a
 * gravação dele — fica no log e a conta continua pendente.
 */
export const settleBillPayment = (movement: BillMovement): Promise<BillMatch | null> =>
	serialized(async () => {
		try {
			const [bills, payments] = await Promise.all([getBills(), getBillPayments()]);
			const match = matchBillPayment(bills, movement, payments);
			if (!match) return null;
			await writeSettlement(match, movement, payments);
			await afterBillsWrite();
			return match;
		} catch (error) {
			console.error('Failed to settle bill payment:', error);
			return null;
		}
	});

/**
 * O lançamento `ref` foi apagado: o mês que ele pagou volta a ficar pendente. Com o registro
 * do mês (SPD-146), é exatamente aquele mês; sem ele, a conta cuja última baixa foi o
 * lançamento, e `date` (a do lançamento) diz qual mês ele tinha quitado. Nunca falha.
 */
export const undoBillPayment = (ref: string, date: string | null): Promise<void> =>
	serialized(async () => {
		try {
			let changed = false;
			const [bills, payments] = await Promise.all([getBills(), getBillPayments()]);
			for (const bill of bills) {
				const undo = billSettlementUndo(bill, ref, date, payments);
				if (!undo) continue;
				await writeSettlementUndo(bill.id, undo);
				changed = true;
			}
			if (changed) await afterBillsWrite();
		} catch (error) {
			console.error('Failed to undo bill payment:', error);
		}
	});

/** Os campos que decidem a baixa: com todos iguais, casar de novo daria no mesmo. */
const sameBillMovement = (a: BillMovement, b: BillMovement): boolean =>
	a.amountCents === b.amountCents &&
	a.date === b.date &&
	a.accountId === b.accountId &&
	a.text === b.text &&
	a.isExpense === b.isExpense;

/**
 * O lançamento foi editado: a baixa que ele tinha dado sai, com a data **de antes** (é ela
 * que diz qual mês ele quitou), e o casamento roda de novo com os dados novos. Devolve a
 * baixa dada agora, ou `null`.
 *
 * Edição que não muda nada do que decide a baixa (só a categoria, por exemplo) não mexe
 * em conta nenhuma. Sem o "antes" (`previous` nulo) não se desfaz nada: desfazer sem a
 * data antiga voltaria um mês do que está gravado, e isso pode ser um mês pago à mão
 * depois. As garantias de `billPaymentUndo` e `billPaymentPatch` valem aqui: `paidThrough`
 * pago à mão depois da baixa não diminui. Nunca falha, como as outras duas.
 */
export const resettleBillPayment = (previous: BillMovement | null, next: BillMovement): Promise<BillMatch | null> =>
	serialized(async () => {
		try {
			if (previous && sameBillMovement(previous, next)) return null;

			let changed = false;
			if (previous) {
				const [bills, payments] = await Promise.all([getBills(), getBillPayments()]);
				for (const bill of bills) {
					const undo = billSettlementUndo(bill, next.id, previous.date, payments);
					if (!undo) continue;
					await writeSettlementUndo(bill.id, undo);
					changed = true;
				}
			}

			// Relidas: a conta que acabou de perder a baixa pode ser a que o dado novo quita.
			const [bills, payments] = await Promise.all([getBills(), getBillPayments()]);
			const match = matchBillPayment(bills, next, payments);
			if (match) {
				await writeSettlement(match, next, payments);
				changed = true;
			}

			if (changed) await afterBillsWrite();
			return match;
		} catch (error) {
			console.error('Failed to resettle bill payment:', error);
			return null;
		}
	});

type Postable = Pick<
	Capture,
	'amountCents' | 'direction' | 'counterparty' | 'appLabel' | 'postedAt' | 'accountId' | 'installments' | 'cardLast4'
>;

/** O lançamento gravado: o id do primeiro e a conta a pagar que ele quitou, se quitou (SPD-153). */
interface PostedTransaction {
	id: string;
	settledBill: SettledBill | null;
}

/**
 * Grava a compra no livro: uma transação, ou N parcelas datadas um mês após a outra
 * e ligadas por `installmentGroup` (o id da captura). Devolve o id da primeira e a conta
 * a pagar que ela quitou.
 */
const postTransaction = async (capture: Postable, categoryId: string, groupId: string): Promise<PostedTransaction> => {
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
		// Compra parcelada não é pagamento de conta: só a de uma vez pode dar baixa.
		const match = await settleBillPayment({
			id,
			amountCents: capture.amountCents,
			date,
			accountId: capture.accountId,
			text: capture.counterparty,
			isExpense: capture.direction === 'out',
		});
		return { id, settledBill: settledBillOf(match) };
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
	return { id: firstId, settledBill: null };
};

/**
 * Um lado conhecido casa com o mesmo lado conhecido, ou completa um lado em branco. Lado
 * em branco **deste** aviso não casa com lado preenchido do que já está gravado: sem
 * saber a contraparte não há como afirmar que é o mesmo movimento, e afirmar errado funde
 * duas transferências numa.
 */
const sideFits = (mine: string | null, theirs: string | null): boolean =>
	mine !== null ? theirs === null || theirs === mine : theirs === null;

/**
 * A transferência que já está no livro é este mesmo movimento?
 *
 * Identidade apertada de propósito: um dia de janela e as duas pontas compatíveis. Na
 * dúvida o certo é **criar outra** — perder o pareamento rende um aviso a mais na caixa
 * de entrada, enquanto fundir duas transferências faz dinheiro desaparecer do saldo de
 * uma conta sem nada ter sido gasto.
 */
const isSameMovement = (
	live: Pick<Transfer, 'fromAccountId' | 'toAccountId' | 'date'>,
	from: string | null,
	to: string | null,
	date: string
): boolean =>
	Math.abs(daysBetween(live.date, date)) <= SAME_MOVEMENT_DAYS &&
	sideFits(from, live.fromAccountId) &&
	sideFits(to, live.toAccountId);

/**
 * Registra (ou reaproveita) a transferência de um movimento entre contas.
 *
 * `from`/`to` nulos significam "uma conta que o app não acompanha, ou que ainda não
 * apareceu". Se a outra perna já criou a transferência com um lado nulo, este lado
 * a completa em vez de criar outra; e uma transferência viva que seja o mesmo movimento
 * (`isSameMovement`) é reaproveitada — é o que impede o pagamento da fatura de contar
 * duas vezes quando a conta e o cartão avisam.
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

	// `findLiveTransfer` ignora a ponta que este aviso não conhece: ela devolve qualquer
	// transferência viva daquela conta, com aquele valor, na janela — inclusive uma que já
	// tem a outra ponta preenchida (era assim que o Pix casava com o pagamento da fatura).
	// A consulta mora em `database.ts`; o aperto da identidade é aqui.
	const live = await findLiveTransfer({
		amountCents: movement.amountCents,
		fromAccountId: from,
		toAccountId: to,
		dateFrom: addDays(date, -SAME_MOVEMENT_DAYS),
		dateTo: addDays(date, SAME_MOVEMENT_DAYS),
	});
	if (live && isSameMovement(live, from, to, date)) {
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

/** A transferência de um movimento neutro, e como o outro lado dela foi achado (o diário). */
interface NeutralMove {
	transferId: string | null;
	destination: DestinationResolution;
}

/**
 * Pagar a fatura é transferir da conta para o cartão. Visto pelo cartão ("pagamento
 * recebido"), a origem é a única conta do mesmo banco. Visto pela conta ("pagamento da
 * fatura"), o destino é o cartão quando há uma escolha só (AUTO-03), nesta ordem:
 *
 *  1. o cartão do final citado no aviso, de qualquer banco;
 *  2. o único cartão do mesmo banco (era o único caminho até o SPD-023);
 *  3. o cartão cujo aviso já gravou este mesmo pagamento — antes do valor, senão o valor
 *     escolheria outro cartão para um pagamento que já está no livro;
 *  4. sem final no aviso, a única fatura fechada em aberto com o mesmo valor.
 *
 * Senão o lado fica nulo, e as duas vistas ainda se reconhecem pelo valor e pela data. Final
 * citado que não é de cartão nenhum não cai no valor: o aviso disse qual era, e não é este.
 */
/**
 * Grava o pagamento da fatura de `cardId` saindo de `from` (qualquer dos dois pode ser
 * nulo: o lado que não se sabe fica em branco).
 *
 * O mesmo pagamento chega por caminhos diferentes — o aviso da conta, o aviso do cartão, o
 * botão "Pagar fatura", o extrato — e cada um pode achar uma conta de origem diferente. Quem
 * diz se dois são o mesmo pagamento é `isSameCardPayment`: mesmo valor, no máximo um dia de
 * diferença e a mesma origem (origem em branco casa com qualquer uma). Casar só por valor
 * numa janela de cinco dias fundia pagamentos distintos.
 */
const payIntoCard = async (
	capture: Pick<Capture, 'amountCents' | 'postedAt' | 'counterparty' | 'appLabel'>,
	cardId: string | null,
	from: string | null
): Promise<string> => {
	const date = localDateOf(capture.postedAt);
	if (cardId) {
		const live = await findLiveTransfer({
			amountCents: capture.amountCents,
			fromAccountId: null,
			toAccountId: cardId,
			dateFrom: addDays(date, -SAME_MOVEMENT_DAYS),
			dateTo: addDays(date, SAME_MOVEMENT_DAYS),
		});
		if (
			live &&
			isSameCardPayment(
				{ fromAccountId: live.fromAccountId, amountCents: live.amountCents, date: live.date },
				{ fromAccountId: from, amountCents: capture.amountCents, date }
			)
		) {
			if (live.fromAccountId === null && from) {
				await updateTransfer({ ...live, fromAccountId: from });
				syncQueue.schedule();
			}
			return live.id;
		}
	}
	return recordTransfer(capture, from, cardId, null);
};

const recordInvoicePayment = async (
	capture: Pick<
		Capture,
		'amountCents' | 'postedAt' | 'counterparty' | 'appLabel' | 'accountId' | 'direction' | 'cardLast4'
	>
): Promise<NeutralMove> => {
	const nothing: NeutralMove = { transferId: null, destination: 'none' };
	if (!capture.accountId) return nothing;
	const account = await getAccount(capture.accountId);
	if (!account) return nothing;
	const date = localDateOf(capture.postedAt);
	const payInto = (cardId: string | null, from: string | null): Promise<string> => payIntoCard(capture, cardId, from);

	if (account.kind === 'credit_card') {
		// Visto pelo cartão, o aviso de pagamento às vezes vem como "saída" do parser.
		const checking = await findCheckingForCard(account);
		return { transferId: await payInto(account.id, checking?.id ?? null), destination: 'notifier' };
	}

	if (capture.direction !== 'out') return nothing;
	const byLast4 = await findCardByLast4(capture.cardLast4);
	if (byLast4) return { transferId: await payInto(byLast4.id, account.id), destination: 'card_last4' };
	const card = await findCardForInvoice(account);
	if (card) return { transferId: await payInto(card.id, account.id), destination: 'single_card' };

	// Não se sabe ainda qual fatura foi paga. Mas se o aviso do cartão já registrou este
	// pagamento, é este mesmo movimento, e gravar outro debitaria a conta duas vezes.
	// `findLiveTransfer` não sabe pedir "para qualquer cartão deste usuário": ela devolve o
	// que sai desta conta e o filtro é aqui.
	const live = await findLiveTransfer({
		amountCents: capture.amountCents,
		fromAccountId: account.id,
		toAccountId: null,
		dateFrom: addDays(date, -SAME_MOVEMENT_DAYS),
		dateTo: addDays(date, SAME_MOVEMENT_DAYS),
	});
	if (live && live.fromAccountId === account.id && live.toAccountId !== null) {
		const destination = await getAccount(live.toAccountId);
		if (destination?.kind === 'credit_card') return { transferId: live.id, destination: 'paired' };
	}

	const byInvoice = capture.cardLast4 ? null : await findCardByClosedInvoice(capture.amountCents, date);
	if (byInvoice) return { transferId: await payInto(byInvoice.id, account.id), destination: 'invoice_amount' };
	return { transferId: await recordTransfer(capture, account.id, null, null), destination: 'none' };
};

/**
 * Aplicação e resgate: não é receita nem despesa, mas o dinheiro **saiu** da conta
 * corrente e entrou na caixinha (ou voltou dela). Enquanto nada era gravado, a conta
 * corrente ficava R$ 5.000 acima do real indefinidamente (achado 7.2) — nenhum lançamento
 * datado depois da âncora a corrigia, e o saldo errado nunca se consertava sozinho.
 *
 * A caixinha é a **única** reserva do banco da conta que avisou, quando há uma só (AUTO-08):
 * a aplicação vai da conta para ela, o resgate volta dela. Com zero ou duas o app não chuta:
 * vira transferência com o outro lado em branco, pelo mesmo mecanismo que o pagamento da
 * fatura usa quando não sabe o cartão. Sem conta de origem conhecida não há o que gravar —
 * a captura fica ignorada e o usuário atribui.
 */
const recordInvestmentMove = async (
	capture: Pick<Capture, 'amountCents' | 'postedAt' | 'counterparty' | 'appLabel' | 'accountId' | 'direction'>
): Promise<NeutralMove> => {
	if (!capture.accountId) return { transferId: null, destination: 'none' };
	const account = await getAccount(capture.accountId);
	const reserve = account ? await findReserveForInvestment(account) : null;
	const sides = transferSidesOf(capture, reserve?.id ?? null);
	return {
		transferId: await recordTransfer(capture, sides.from, sides.to, null),
		destination: reserve ? 'single_reserve' : 'none',
	};
};

/**
 * O porquê que o histórico mostra para o movimento neutro: o destino achado pelo SPD-023 diz
 * como, e o resto continua com o motivo da decisão ("Pagamento da fatura", "Investimento").
 */
const NEUTRAL_REASON: Partial<Record<DestinationResolution, string>> = {
	single_reserve: 'investment_reserve',
	card_last4: 'invoice_card_last4',
	invoice_amount: 'invoice_amount',
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
 * nas transferências. O resto só grava o item. `destination` só vem no movimento neutro:
 * como o outro lado da transferência foi achado, para o diário.
 */
export const applyDecision = async (
	base: CaptureDraft,
	decision: Decision,
	categories: Category[],
	explicitId?: string,
	/** O motivo do lançamento automático, quando não é só a regra do estabelecimento (SPD-123). */
	autoReason?: string
): Promise<{ id: string; autoConfirmed: boolean; destination?: DestinationResolution }> => {
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
			// Neutro não é "nada aconteceu": o pagamento da fatura e o investimento movem
			// dinheiro entre contas, e sem a transferência o saldo da conta fica errado.
			const move: NeutralMove =
				decision.reason === 'invoice_payment'
					? await recordInvoicePayment(base)
					: decision.reason === 'investment'
						? await recordInvestmentMove(base)
						: { transferId: null, destination: 'none' };
			const reason = NEUTRAL_REASON[move.destination] ?? decision.reason;
			await insertCapture({ ...base, status: 'ignored', reason, transferId: move.transferId }, id);
			return { id, autoConfirmed: false, destination: move.destination };
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
			const { id: transactionId } = await postTransaction(base, categoryId, id);
			await insertCapture(
				{
					...base,
					status: 'confirmed',
					suggestedCategory: categoryId,
					transactionId,
					autoConfirmed: true,
					reason: autoReason ?? 'rule',
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
): Promise<boolean> => {
	const posted = new Date(income.postedAt).getTime();
	const leg = await findUnpairedTransferLeg({
		packageName: income.packageName,
		amountCents: income.amountCents,
		since: new Date(posted - LOOKBACK_MS).toISOString(),
		until: new Date(posted + LOOKBACK_MS).toISOString(),
	});
	if (!leg) return false;

	if (leg.transferId) {
		await deleteTransfer(leg.transferId);
		syncQueue.schedule();
	}
	await updateCapture(leg.id, { status: 'ignored', reason: 'external_leg', transferId: null });
	return true;
};

// ---------------------------------------------------------------------------
// Entrada de notificações
// ---------------------------------------------------------------------------

/**
 * O valor do aviso é de outra moeda e o aviso não trouxe o valor em reais: o número na
 * caixa de entrada é o da outra moeda (US$ 15,99 viraria R$ 15,99), e só o usuário sabe
 * quanto saiu em reais. Com o valor em reais junto (`inBrl`), o número já é o certo.
 */
const needsCurrencyReview = (parsed: Pick<ParsedCapture, 'foreign'>): boolean =>
	parsed.foreign !== undefined && !parsed.foreign.inBrl;

/**
 * O pagamento da fatura que o cartão recebeu, com a conta de origem que a regra aprendida diz
 * (SPD-123, X-2): sai dela para o cartão do aviso, e o item fica guardado, como o pagamento
 * de sempre, com o motivo da regra.
 */
const recordLearnedInvoicePayment = async (
	base: CaptureDraft,
	from: Account,
	accounts: Account[]
): Promise<{ id: string; autoConfirmed: boolean; destination?: DestinationResolution }> => {
	const id = generateUniqueId();
	const card = invoiceCardFor(accounts, base);
	const transferId = await payIntoCard(base, card?.id ?? null, from.id);
	await insertCapture(
		{ ...base, accountId: from.id, status: 'ignored', reason: learnedReason('invoice_payment'), transferId },
		id
	);
	return { id, autoConfirmed: false };
};

/** O motivo que o item ficou gravando, para o diário (SPD-123). */
const storedReasonOf = (
	decision: Decision,
	pendingReason: string | null,
	autoReason: string | undefined,
	learnedInvoice: boolean
): string | null => {
	if (learnedInvoice) return learnedReason('invoice_payment');
	switch (decision.action) {
		case 'pending':
		case 'ask_duplicate':
		case 'ask_transfer':
			return pendingReason;
		case 'auto_confirm':
			return autoReason ?? 'rule';
		default:
			return decision.reason;
	}
};

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
		// Até onde o aviso chegou, para o diário dizer onde uma falha aconteceu (SPD-014).
		let stage = 'fingerprint';
		let fingerprint: string | null = null;
		// Uma notificação que falha não leva as outras junto: a fila nativa já foi esvaziada,
		// e o que não for gravado aqui se perde.
		try {
		fingerprint = fingerprintOf(raw);
		// App bloqueado (SPD-069): nada dele entra, nem citando banco. O diário guarda só o pacote.
		if (isBlockedPackage(raw.packageName)) {
			logCaptureDecision({ raw, fingerprint, outcome: { step: 'blocked' } });
			continue;
		}
		if (await hasCaptureFingerprint(fingerprint)) {
			logCaptureDecision({ raw, fingerprint, outcome: { step: 'already_seen' } });
			continue;
		}

		stage = 'parse';
		const parsed = parseCapture(raw);
		if (!parsed) {
			logCaptureDecision({ raw, fingerprint, parsed: null, outcome: { step: 'not_money' } });
			continue;
		}

		// App que não é banco e texto que não cita banco: não há de onde ter saído o dinheiro.
		// Não grava nada — nem item na revisão, nem conta, nem o texto da conversa (SPD-022).
		if (isNoBankNotice(raw)) {
			logCaptureDecision({ raw, fingerprint, parsed, outcome: { step: 'no_bank' } });
			continue;
		}

		stage = 'account';
		const accountTrace: { how?: AccountResolution } = {};
		const resolved = await resolveAccountForNotification(raw, parsed, accountTrace, options.businessFeeds);

		// O aviso diz o bastante para o app decidir sozinho (SPD-123)? Se não diz, a regra
		// aprendida com uma resposta anterior decide; sem ela (ou com a conta dela sumida), o
		// aviso não é lançado sozinho: vai para a revisão com o motivo do caso.
		stage = 'ambiguity';
		const accounts = await getAccounts();
		const ambiguity = detectAmbiguity(accounts, raw, parsed);
		const choice = ambiguity ? lookupChoice(options.captureChoices ?? {}, ambiguity, accounts) : null;
		const learned = choice?.state === 'applied' ? choice : null;
		const invoiceAmbiguity = ambiguity?.case === 'invoice_payment';
		// A direção aprendida vale antes de tudo: muda o tipo, a categoria e a decisão.
		const read = learned && 'direction' in learned ? withDirection(parsed, learned.direction) : parsed;
		// A conta (ou o cartão) aprendido, na compra. O pagamento da fatura é à parte, abaixo.
		const account =
			ambiguity && TARGET_CASES.includes(ambiguity.case) && learned && 'account' in learned
				? learned.account
				: resolved;

		stage = 'decide';
		const candidate = candidateFrom(raw, read, account?.id ?? null);
		const since = new Date(new Date(raw.postedAt).getTime() - LOOKBACK_MS).toISOString();
		const recent = (await getRecentCaptures(since)).map(toKnownCapture);
		const rule = candidate.merchantKey ? toMerchantRule(await getMerchantRule(candidate.merchantKey)) : undefined;
		// A regra do app só existe para quem não é banco nem SMS: o banco, o Mercado Pago, a
		// carteira e o SMS nunca são ignorados por ela, nem com uma regra gravada para eles.
		const appRule = canLearnToIgnore(raw)
			? toMerchantRule(await getMerchantRule(appRuleKeyOf(raw.packageName)))
			: undefined;
		const fallbackCategoryId = resolveCategoryId(guessCategory(read), read.direction, options.categories);
		// Estorno e devolução têm a chave da compra que desfazem (SPD-043), mas a categoria
		// da regra é a da compra, de despesa: na volta do dinheiro ela virava "outras
		// receitas". O estorno é sempre estorno; a regra só decide se entra sozinho.
		const refundCategoryId =
			read.kind === 'refund' ? resolveCategoryId('refund', read.direction, options.categories) : null;

		const externalIncome = isExternalIncomeRule(rule, options.categories);

		let decision = decide(candidate, {
			recent,
			rule,
			ownNames: options.ownNames,
			bankName: options.bankName,
			autoConfirmThreshold: threshold,
			fallbackCategoryId,
			externalIncome,
			appRule,
		});

		if (refundCategoryId && (decision.action === 'auto_confirm' || decision.action === 'pending')) {
			decision = { ...decision, categoryId: refundCategoryId };
		}

		let overridden: 'confirmed_leg' | 'foreign_currency' | 'ambiguity' | undefined;

		// Uma transferência "certa" cuja outra perna o usuário já confirmou como
		// lançamento não desfaz a confirmação sozinha: vira pergunta. Apagar uma
		// transação que a pessoa aprovou é decisão dela, mesmo quando o nome é o dela.
		if (decision.action === 'transfer' && decision.relatedId) {
			const relatedId = decision.relatedId;
			const related = recent.find((known) => known.id === relatedId);
			if (related?.status === 'confirmed') {
				decision = { action: 'ask_transfer', relatedId: related.id };
				overridden = 'confirmed_leg';
			}
		}

		// Moeda estrangeira sem o valor em reais nunca entra sozinha no livro: a regra
		// aprendida acerta a categoria, não o valor. Fica pendente com a categoria que a
		// decisão sugeriu, e o porquê vai no item para a tela avisar.
		const currencyReview = needsCurrencyReview(read);
		if (currencyReview && decision.action === 'auto_confirm') {
			decision = { action: 'pending', categoryId: decision.categoryId };
			overridden = 'foreign_currency';
		}

		// O que fica pendente guarda o porquê: a moeda, a dúvida do aviso (a revisão a explica
		// e faz a pergunta) ou a regra aprendida que decidiu por ele.
		let reason: string | null = currencyReview ? 'foreign_currency' : null;
		let autoReason: string | undefined;
		let invoiceFrom: Account | null = null;
		if (ambiguity && invoiceAmbiguity) {
			// O pagamento da fatura que o cartão recebeu: de qual conta saiu (X-2). Sem resposta,
			// nada de transferência — nem da conta do mesmo banco, que pode não ter pago nada.
			if (decision.action === 'neutral') {
				if (!learned) {
					decision = { action: 'pending', categoryId: null };
					overridden = 'ambiguity';
					reason = ambiguousReason(ambiguity.case);
				} else if ('skip' in learned) {
					decision = { action: 'ignore', reason: learnedReason(ambiguity.case) };
				} else if ('account' in learned) {
					invoiceFrom = learned.account;
				}
			}
		} else if (ambiguity && !learned) {
			// Nada entra sozinho no livro, nem vira transferência com a direção trocada.
			if (decision.action === 'auto_confirm' || decision.action === 'transfer') {
				decision = {
					action: 'pending',
					categoryId: decision.action === 'auto_confirm' ? decision.categoryId : fallbackCategoryId,
				};
				overridden = 'ambiguity';
			}
			// A moeda fica com o motivo, se for o caso: o valor errado é o que mais custa, e a
			// conta em branco já abre o seletor na revisão (só não vira regra).
			if (!currencyReview) reason = ambiguousReason(ambiguity.case);
		} else if (ambiguity) {
			autoReason = learnedReason(ambiguity.case);
			if (!currencyReview) reason = autoReason;
		}

		const base: CaptureDraft = {
			fingerprint,
			packageName: raw.packageName,
			appLabel: raw.appLabel,
			title: raw.title,
			text: raw.text,
			postedAt: raw.postedAt,
			amountCents: read.amountCents,
			direction: read.direction,
			kind: read.kind,
			counterparty: read.counterparty,
			merchantKey: candidate.merchantKey,
			cardLast4: read.cardLast4,
			status: 'pending',
			question: null,
			relatedId: null,
			suggestedCategory: refundCategoryId ?? rule?.categoryId ?? fallbackCategoryId,
			transactionId: null,
			autoConfirmed: false,
			// Só os itens que ficam pendentes o guardam: duplicata, transferência e ignorado
			// gravam o próprio porquê por cima.
			reason,
			// Sem conta quando o aviso não é de banco: o usuário atribui em "Sem conta". O
			// pagamento de fatura em dúvida também: a conta do aviso não é a que pagou.
			accountId: invoiceAmbiguity && decision.action === 'pending' ? null : (account?.id ?? null),
			transferId: null,
			installments: read.installments,
		};

		stage = 'write';
		const result = invoiceFrom
			? await recordLearnedInvoicePayment(base, invoiceFrom, accounts)
			: await applyDecision(base, decision, options.categories, undefined, autoReason);
		if (result.autoConfirmed) summary.autoConfirmed += 1;
		summary.inserted += 1;

		stage = 'external_leg';
		const externalLeg = externalIncome && read.direction === 'in' ? await neutralizeExternalLeg(base) : false;

		logCaptureDecision({
			raw,
			fingerprint,
			parsed,
			outcome: {
				step: 'decided',
				decision,
				overridden,
				currencyReview,
				account: account ? (accountTrace.how ?? 'existing') : 'none',
				captureId: result.id,
				externalLeg,
				destination: result.destination,
				...(ambiguity
					? {
							ambiguity: ambiguity.case,
							choice: learned ? ('learned' as const) : ('asked' as const),
							staleChoice: choice?.state === 'stale' ? true : undefined,
							reason: storedReasonOf(decision, base.reason, autoReason, invoiceFrom !== null),
						}
					: {}),
			},
		});
		} catch (error) {
			console.error('Failed to ingest notification:', error);
			logCaptureFailure(raw, fingerprint, stage, error);
		}
	}

	return summary;
};

// ---------------------------------------------------------------------------
// Respostas do usuário
// ---------------------------------------------------------------------------

const learnCategory = async (capture: Capture, categoryId: string): Promise<void> => {
	// O estorno divide a chave com a compra (SPD-043): confirmar "Estorno" trocaria a regra
	// da loja, e a compra seguinte perderia a categoria e o automático.
	if (!capture.merchantKey || capture.kind === 'refund') return;
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

/**
 * Uma resposta do usuário na caixa de revisão, no diário (SPD-014): o quê, de que tipo de
 * aviso e de que estado ele saiu. Nunca o valor, o estabelecimento nem o texto.
 */
const logReview = (
	event: string,
	capture: Pick<Capture, 'id' | 'packageName' | 'kind' | 'status' | 'reason'>,
	data: Record<string, DiagnosticValue> = {}
): void =>
	log('capture', event, {
		data: {
			captureId: capture.id,
			pkg: capture.packageName,
			kind: capture.kind,
			from: capture.status,
			fromReason: capture.reason,
			...data,
		},
	});

/** A resposta não fez nada: o item sumiu ou já não estava no estado que ela pede. */
const logReviewSkipped = (action: string, id: string, capture: Capture | null): void =>
	log('capture', 'capture_review_skipped', {
		data: { action, captureId: id, from: capture?.status ?? 'missing' },
	});

/**
 * Apaga o que uma captura pôs no livro: a transação, ou todas as parcelas. A baixa que a
 * transação tinha dado numa conta a pagar é desfeita junto.
 */
const removePostedTransactions = async (capture: Capture): Promise<void> => {
	if (!capture.transactionId) return;
	if (capture.installments && capture.installments > 1) {
		await deleteTransactionsInGroup(capture.id);
	} else {
		await deleteTransaction(capture.transactionId);
	}
	syncQueue.schedule();
	await undoBillPayment(capture.transactionId, localDateOf(capture.postedAt));
};

/**
 * A resposta do usuário a um aviso ambíguo vira a regra do caso (SPD-123): a mesma chave
 * (`choiceKeyOf`) que a ingestão procura. Sem lugar para gravar (`store`), ou com a mesma
 * escolha de antes, não grava nada. Devolve se a regra mudou.
 */
const learnChoice = async (
	notice: Pick<Capture, 'packageName' | 'appLabel' | 'title' | 'text' | 'cardLast4'>,
	ambiguity: AmbiguityCase,
	value: string,
	store: CaptureChoiceStore | undefined
): Promise<boolean> => {
	if (!store) return false;
	const key = choiceKeyOf(notice, ambiguity);
	const current = await store.read();
	if (current[key] === value) return false;
	await store.write(rememberChoice(current, key, value));
	return true;
};

/**
 * O motivo que o item resolvido guarda: o do caso ambíguo continua (a resposta foi do
 * usuário), e é por ele que reverter devolve a pergunta e o conserto das compras antigas
 * não mexe na conta escolhida. Qualquer outro sai, como sempre.
 */
const answeredReason = (reason: string | null): string | null => {
	const ambiguity = ambiguityOfReason(reason);
	return ambiguity ? ambiguousReason(ambiguity.case) : null;
};

/**
 * Vira transação (ou parcelas) com a categoria escolhida, e o app aprende o estabelecimento.
 *
 * `accountId` é a conta escolhida na revisão (SPD-111): sem ela (`undefined`), fica a do
 * aviso; `null` é "Sem conta". O lançamento nasce nela e a captura passa a apontar para ela,
 * então o "Desfazer" devolve o item à revisão já com a conta escolhida. Num cartão, as
 * parcelas seguem o ciclo dele (`postTransaction`), como qualquer compra do cartão.
 *
 * No aviso ambíguo (SPD-123) confirmar também é a resposta: a conta ou o cartão escolhido,
 * ou a direção que está na tela, vira a regra do caso (`choices`, onde ela mora).
 *
 * Devolve também a conta a pagar que o lançamento quitou (`settledBill`, SPD-153), para o
 * aviso da revisão dizer a conta e o mês.
 */
export const confirmCapture = async (
	id: string,
	categoryId: string,
	categories: Category[],
	accountId?: string | null,
	choices?: CaptureChoiceStore
): Promise<(Capture & { settledBill: SettledBill | null }) | null> => {
	const found = await getCapture(id);
	if (!found || found.status !== 'pending') {
		logReviewSkipped('confirm', id, found);
		return null;
	}
	const accountChanged = accountId !== undefined && accountId !== found.accountId;
	const capture = accountChanged ? { ...found, accountId } : found;
	const ambiguity = ambiguityOfReason(found.reason);

	const resolved = resolveCategoryId(categoryId, capture.direction, categories);
	const { id: transactionId, settledBill } = await postTransaction(capture, resolved, capture.id);
	await updateCapture(id, {
		status: 'confirmed',
		question: null,
		suggestedCategory: resolved,
		transactionId,
		// A regra que decidiu e o usuário manteve continua dizendo que foi ela.
		reason: ambiguity?.learned && !accountChanged ? found.reason : answeredReason(found.reason),
		accountId: accountChanged ? accountId : undefined,
	});
	await learnCategory(capture, resolved);

	let learnedChoice = false;
	if (ambiguity && TARGET_CASES.includes(ambiguity.case) && capture.accountId) {
		learnedChoice = await learnChoice(capture, ambiguity.case, capture.accountId, choices);
	} else if (ambiguity?.case === 'pix_direction') {
		learnedChoice = await learnChoice(capture, ambiguity.case, capture.direction, choices);
	}

	// Confirmar um recebimento como receita é o que ensina que a fonte é externa; a
	// saída que a PJ avisou pelo mesmo app, se já virou transferência, deixa de ser.
	let externalLeg = false;
	if (
		capture.direction === 'in' &&
		categories.some((c) => c.id === resolved && c.type === 'income' && !c.deletedAt)
	) {
		externalLeg = await neutralizeExternalLeg(capture);
	}

	logReview('capture_confirmed', capture, {
		direction: capture.direction,
		// Se o usuário trocou a categoria sugerida, e se a escolhida não servia (caiu em "outros").
		categoryChanged: resolved !== capture.suggestedCategory,
		categoryFallback: resolved !== categoryId,
		installments: capture.installments,
		learned: capture.merchantKey !== null,
		externalLeg,
		// Se o usuário trocou a conta do aviso, e se o app tinha achado uma. Nunca qual.
		accountChoice: !accountChanged ? 'kept' : accountId === null ? 'cleared' : 'chosen',
		hadAccount: found.accountId !== null,
		// O aviso ambíguo (SPD-123): se a resposta mudou a regra do caso. Nunca a chave.
		...(ambiguity ? { ambiguity: ambiguity.case, choiceLearned: learnedChoice } : {}),
	});

	return { ...capture, status: 'confirmed', suggestedCategory: resolved, transactionId, settledBill };
};

/**
 * "Entrou" ou "Saiu", no aviso em que a direção é um palpite (SPD-123, NOTIF-11): o item
 * passa a ser da direção respondida — o tipo, a categoria sugerida e o lado do saldo vêm
 * junto —, continua na revisão para confirmar, e a resposta vira a regra do caso.
 */
export const answerCaptureDirection = async (
	id: string,
	direction: CaptureDirection,
	choices?: CaptureChoiceStore
): Promise<void> => {
	const capture = await getCapture(id);
	if (!capture || capture.status !== 'pending') {
		logReviewSkipped('direction', id, capture);
		return;
	}
	const ambiguity = ambiguityOfReason(capture.reason);
	const answered = withDirection({ direction: capture.direction, kind: capture.kind as CaptureKind }, direction);
	await updateCapture(id, {
		direction: answered.direction,
		kind: answered.kind,
		suggestedCategory: guessCategory({ ...answered, counterparty: capture.counterparty }),
		reason: ambiguity ? ambiguousReason(ambiguity.case) : capture.reason,
	});
	const learned =
		ambiguity?.case === 'pix_direction' ? await learnChoice(capture, ambiguity.case, direction, choices) : false;
	log('capture', 'capture_answered', {
		data: { captureId: id, question: 'direction', answer: direction, changed: direction !== capture.direction, learned },
	});
};

/**
 * De qual conta saiu o pagamento da fatura que o cartão avisou ter recebido (SPD-123, X-2).
 * Com a conta, grava o pagamento dela para o cartão do aviso; com `null` ("Não lançar"),
 * guarda o aviso sem mexer em saldo nenhum. Os dois viram a regra do caso.
 *
 * Um cartão não paga a fatura de outro: escolher um cartão como origem não faz nada.
 */
export const resolveInvoicePaymentCapture = async (
	id: string,
	fromAccountId: string | null,
	choices?: CaptureChoiceStore
): Promise<boolean> => {
	const capture = await getCapture(id);
	if (!capture || capture.status !== 'pending' || ambiguityOfReason(capture.reason)?.case !== 'invoice_payment') {
		logReviewSkipped('invoice_payment', id, capture);
		return false;
	}
	const reason = ambiguousReason('invoice_payment');

	if (fromAccountId === null) {
		await updateCapture(id, { status: 'ignored', question: null, reason, accountId: null });
		const learned = await learnChoice(capture, 'invoice_payment', SKIP_CHOICE, choices);
		logReview('capture_invoice_resolved', capture, { answer: 'skip', learned });
		return true;
	}

	const accounts = await getAccounts();
	const from = accounts.find((account) => account.id === fromAccountId && !account.deletedAt);
	if (!from || from.kind === 'credit_card') {
		logReviewSkipped('invoice_payment', id, capture);
		return false;
	}
	const card = invoiceCardFor(accounts, capture);
	const transferId = await payIntoCard(capture, card?.id ?? null, from.id);
	await updateCapture(id, { status: 'ignored', question: null, reason, accountId: from.id, transferId });
	const learned = await learnChoice(capture, 'invoice_payment', from.id, choices);
	logReview('capture_invoice_resolved', capture, { answer: 'account', card: card !== null, learned });
	return true;
};

/**
 * Descarta. Se o aviso veio de um app que não é banco nem SMS, conta o descarte: no
 * terceiro daquele app, os avisos dele passam a ser ignorados sozinhos (SPD-022). Só conta
 * o que estava pendente — descartar de novo o que já tinha saído da fila não é outro
 * descarte. O SMS não conta: o pacote junta todos os remetentes, inclusive o banco.
 */
export const dismissCapture = async (id: string): Promise<void> => {
	const capture = await getCapture(id);
	await updateCapture(id, { status: 'dismissed', question: null, reason: 'manual' });
	let appRule: MerchantRule | null = null;
	let learned = false;
	if (capture?.status === 'pending' && canLearnToIgnore(capture)) {
		const key = appRuleKeyOf(capture.packageName);
		const current = toMerchantRule(await getMerchantRule(key));
		appRule = learnFromAppDismissal(current, capture.packageName);
		await saveMerchantRule(appRule);
		learned = isAppIgnored(appRule) && !isAppIgnored(current);
	}

	if (!capture) {
		logReviewSkipped('dismiss', id, null);
		return;
	}
	logReview('capture_dismissed', capture, { appDismissals: appRule?.confirmations ?? null });
	// O terceiro descarte: daqui em diante os avisos deste app são ignorados sozinhos.
	if (learned && appRule) {
		log('capture', 'capture_app_rule_learned', {
			data: { pkg: capture.packageName, dismissals: appRule.confirmations },
		});
	}
};

/**
 * "Desfazer" o aprendizado: os avisos do app voltam para a revisão, e a contagem de
 * descartes recomeça do zero. O que já foi ignorado fica no histórico, onde cada item
 * pode ser revertido.
 */
export const stopIgnoringApp = async (packageName: string): Promise<void> => {
	await deleteMerchantRule(appRuleKeyOf(packageName));
	log('capture', 'capture_app_rule_removed', { data: { pkg: packageName } });
};

/**
 * "É transferência entre minhas contas": sai do livro, entra como transferência entre
 * as contas das duas pernas (quando há a outra pendente ou já confirmada), e o app
 * aprende a contraparte para decidir sozinho da próxima vez.
 */
export const markCaptureTransfer = async (id: string): Promise<void> => {
	const capture = await getCapture(id);
	if (!capture) {
		logReviewSkipped('transfer', id, null);
		return;
	}

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

	logReview('capture_marked_transfer', capture, {
		paired: Boolean(pairable),
		removedLeg: Boolean(pairable && related.status === 'confirmed'),
		learned: capture.merchantKey !== null,
	});
};

/** Resposta à pergunta "é o mesmo lançamento?". */
export const answerCaptureDuplicate = async (id: string, same: boolean): Promise<void> => {
	log('capture', 'capture_answered', { data: { captureId: id, question: 'duplicate', answer: same } });
	if (same) {
		await updateCapture(id, { status: 'duplicate', question: null, reason: 'manual' });
	} else {
		await updateCapture(id, { question: null });
	}
};

/** Resposta à pergunta "é transferência entre suas contas?". */
export const answerCaptureTransfer = async (id: string, isTransfer: boolean): Promise<void> => {
	log('capture', 'capture_answered', { data: { captureId: id, question: 'transfer', answer: isTransfer } });
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
 *
 * Desfaz também a **regra aprendida** que o toque em "Transferência" acabou de criar. A
 * regra de transferência é gravada na primeira vez (a de categoria exige três
 * confirmações) e nenhuma tela mostra ou apaga regras aprendidas: sem isto, um toque por
 * engano fazia aquele estabelecimento desaparecer das despesas para sempre (achado 7.3).
 */
export const revertCapture = async (id: string): Promise<void> => {
	const capture = await getCapture(id);
	if (!capture || capture.status === 'pending') {
		logReviewSkipped('revert', id, capture);
		return;
	}
	const undone: Record<string, DiagnosticValue> = {
		ruleRemoved: false,
		appRule: null,
		removedLedger: false,
		removedTransfer: false,
		releasedLeg: false,
	};

	// `reason: 'manual'` é a marca do toque do usuário — e é exatamente nele que
	// `markCaptureTransfer` grava a regra. Decisão automática ("o nome é o seu", "a outra
	// ponta já foi reconhecida") não aprende nada, e aqui não há nada a apagar.
	if (capture.status === 'transfer' && capture.reason === 'manual' && capture.merchantKey) {
		const rule = await getMerchantRule(capture.merchantKey);
		if (rule?.treatAs === 'transfer') {
			await deleteMerchantRule(capture.merchantKey);
			undone.ruleRemoved = true;
		}
	}

	// O descarte à mão de um app que não é banco contou para a regra do app (SPD-022):
	// reverter desconta. Abaixo de três, os avisos dele voltam para a revisão.
	if (capture.status === 'dismissed' && capture.reason === 'manual' && canLearnToIgnore(capture)) {
		const key = appRuleKeyOf(capture.packageName);
		const rule = toMerchantRule(await getMerchantRule(key));
		if (rule?.treatAs === 'ignore') {
			const next = forgetAppDismissal(rule);
			if (next) await saveMerchantRule(next);
			else await deleteMerchantRule(key);
			undone.appRule = next ? 'decremented' : 'removed';
		}
	}

	if (capture.transactionId && capture.reason !== 'statement_transaction') {
		await removePostedTransactions(capture);
		undone.removedLedger = true;
	}

	if (capture.transferId) {
		await deleteTransfer(capture.transferId);
		syncQueue.schedule();
		undone.removedTransfer = true;
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
			undone.releasedLeg = true;
		}
	}

	// O aviso ambíguo volta com a pergunta (SPD-123): é respondendo de novo que se corrige o
	// que a regra aprendida (ou a resposta anterior) fez, e a regra se atualiza. O pagamento
	// da fatura volta sem conta: a de origem é justamente o que está sendo perguntado.
	const ambiguity = ambiguityOfReason(capture.reason);
	await updateCapture(id, {
		status: 'pending',
		question: null,
		relatedId: null,
		transactionId: null,
		autoConfirmed: false,
		reason: answeredReason(capture.reason),
		transferId: null,
		...(ambiguity?.case === 'invoice_payment' ? { accountId: null } : {}),
	});

	logReview('capture_reverted', capture, undone);
};

export default {
	ingestRawCaptures,
	applyDecision,
	resolveCategoryId,
	confirmCapture,
	dismissCapture,
	stopIgnoringApp,
	markCaptureTransfer,
	answerCaptureDuplicate,
	answerCaptureTransfer,
	answerCaptureDirection,
	resolveInvoicePaymentCapture,
	revertCapture,
	settleBillPayment,
	undoBillPayment,
	resettleBillPayment,
};
