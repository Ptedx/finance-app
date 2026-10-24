/**
 * Baixa automática das contas a pagar (REM-04): qual conta e qual mês um pagamento quita.
 *
 * Puro, sem banco: quem grava é `captureActions.settleBillPayment`, chamado quando uma
 * captura vira lançamento e quando o usuário lança uma despesa à mão. A regra é apertada de
 * propósito — melhor deixar a conta pendente (rende um lembrete a mais) do que dar baixa na
 * conta errada (esconde um vencimento de verdade):
 *
 *  - só despesa; conta ativa, não apagada, com o mês ainda não pago e cuja última baixa
 *    não foi este mesmo movimento;
 *  - a data cai de 10 dias antes a 5 dias depois do vencimento (dia preso ao fim do mês,
 *    `billDueDate`); o mês quitado é o desse vencimento;
 *  - a conta de pagamento, se a conta a pagar tiver uma, é a do movimento;
 *  - com valor: dentro de 1% ou R$ 1 (o maior), e o nome/dica no texto ou o valor exato;
 *    sem valor (varia): o nome ou uma das dicas no texto, palavra inteira;
 *  - mais de uma candidata: fica a de texto casado; empate, nenhuma.
 */

import type { Bill, BillDraft } from '../database/schema';
import { billDueDate } from './billReminders';
import { monthKeyOf, shiftMonthKey } from './dateUtils';

/** Quantos dias antes do vencimento um pagamento ainda é daquele mês. */
export const BILL_MATCH_DAYS_BEFORE = 10;

/** Quantos dias depois do vencimento (atraso) um pagamento ainda é daquele mês. */
export const BILL_MATCH_DAYS_AFTER = 5;

/** O movimento que pode ser o pagamento: um lançamento, do jeito que o casador precisa. */
export interface BillMovement {
	/** Id do lançamento: vira o `paidByRef` da conta a pagar. */
	id: string;
	amountCents: number;
	/** Data de calendário local, `YYYY-MM-DD`. */
	date: string;
	accountId: string | null;
	/** Descrição ou estabelecimento. */
	text: string | null;
	isExpense: boolean;
}

export interface BillMatch {
	bill: Bill;
	/** Mês quitado, `YYYY-MM`. */
	month: string;
}

/** Número do dia, em UTC só para contar: não depende do fuso do aparelho. */
const dayNumber = (isoDate: string): number => {
	const [year, month, day] = isoDate.slice(0, 10).split('-').map(Number);
	return Date.UTC(year, month - 1, day) / 86_400_000;
};

/**
 * O mês do vencimento mais próximo de `date` cuja janela contém `date`, pago ou não.
 * `null` quando a data não está na janela de vencimento nenhum.
 */
export const dueMonthFor = (bill: Pick<Bill, 'dueDay'>, date: string): string | null => {
	const day = dayNumber(date);
	const current = monthKeyOf(date);
	let best: { month: string; distance: number } | null = null;

	for (const delta of [-1, 0, 1]) {
		const month = shiftMonthKey(current, delta);
		const offset = day - dayNumber(billDueDate(bill, month));
		if (offset < -BILL_MATCH_DAYS_BEFORE || offset > BILL_MATCH_DAYS_AFTER) continue;
		if (!best || Math.abs(offset) < best.distance) best = { month, distance: Math.abs(offset) };
	}

	return best?.month ?? null;
};

/** Palavras sem acento e sem caixa; pontuação separa ("pgto*TIM-celular" → pgto, tim, celular). */
const wordsOf = (text: string): string[] =>
	text
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((word) => word.length > 0);

/** A frase aparece inteira, palavra por palavra e em ordem, no texto. */
const containsPhrase = (words: string[], phrase: string[]): boolean => {
	if (phrase.length === 0 || phrase.length > words.length) return false;
	for (let start = 0; start + phrase.length <= words.length; start += 1) {
		if (phrase.every((word, index) => words[start + index] === word)) return true;
	}
	return false;
};

/** O nome e cada dica (separadas por vírgula) que identificam o pagamento. */
const termsOf = (bill: Pick<Bill, 'name' | 'matchHint'>): string[][] =>
	[bill.name, ...(bill.matchHint ?? '').split(',')].map(wordsOf).filter((term) => term.length > 0);

const textMatches = (bill: Bill, text: string | null): boolean => {
	if (!text) return false;
	const words = wordsOf(text);
	return termsOf(bill).some((term) => containsPhrase(words, term));
};

/** Tolerância do valor: 1% ou R$ 1, o maior. */
const toleranceOf = (amountCents: number): number => Math.max(Math.round(Math.abs(amountCents) * 0.01), 100);

const isMonthPaid = (bill: Pick<Bill, 'paidThrough'>, month: string): boolean =>
	bill.paidThrough !== null && bill.paidThrough !== undefined && bill.paidThrough >= month;

/**
 * Qual conta a pagar (e qual mês) este movimento quita, ou `null`.
 *
 * Na dúvida, `null`: duas candidatas com o texto casado (duas contas iguais), ou duas
 * só pelo valor exato, não dão baixa em nenhuma.
 */
export const matchBillPayment = (bills: Bill[], movement: BillMovement): BillMatch | null => {
	if (!movement.isExpense) return null;
	const amount = Math.abs(movement.amountCents);
	if (amount === 0) return null;

	const candidates: { match: BillMatch; byText: boolean }[] = [];

	for (const bill of bills) {
		if (!bill.active || bill.deletedAt) continue;
		if (bill.paidByRef === movement.id) continue;
		if (bill.accountId && bill.accountId !== movement.accountId) continue;

		const month = dueMonthFor(bill, movement.date);
		if (!month || isMonthPaid(bill, month)) continue;

		const byText = textMatches(bill, movement.text);
		if (bill.amountCents === null || bill.amountCents === undefined) {
			if (!byText) continue;
		} else {
			const expected = Math.abs(bill.amountCents);
			if (Math.abs(amount - expected) > toleranceOf(expected)) continue;
			if (!byText && amount !== expected) continue;
		}

		candidates.push({ match: { bill, month }, byText });
	}

	const byText = candidates.filter((candidate) => candidate.byText);
	if (byText.length === 1) return byText[0].match;
	if (byText.length === 0 && candidates.length === 1) return candidates[0].match;
	return null;
};

/** Os campos gravados por `updateBill`, a partir da conta como está. */
const draftOf = (bill: Bill): BillDraft => ({
	name: bill.name,
	dueDay: bill.dueDay,
	amountCents: bill.amountCents,
	accountId: bill.accountId,
	category: bill.category,
	matchHint: bill.matchHint,
	debtId: bill.debtId,
	paidThrough: bill.paidThrough,
	paidByRef: bill.paidByRef,
	active: bill.active,
	sortOrder: bill.sortOrder,
});

/** A baixa: `paidThrough` vai ao mês casado (nunca diminui) e `paidByRef` é o lançamento. */
export const billPaymentPatch = (bill: Bill, month: string, ref: string): BillDraft => ({
	...draftOf(bill),
	paidThrough: bill.paidThrough && bill.paidThrough > month ? bill.paidThrough : month,
	paidByRef: ref,
});

/**
 * Desfaz a baixa quando o lançamento `ref` foi apagado, ou `null` se não há o que desfazer
 * (a última baixa já é de outro lançamento, ou de nenhum).
 *
 * O mês casado sai de novo da data do lançamento. Se `paidThrough` ainda é ele, volta ao
 * mês anterior; se já passou dele (um mês pago depois, à mão), fica — só a referência sai.
 * Sem a data, volta um mês do que está gravado.
 */
export const billPaymentUndo = (bill: Bill, ref: string, date: string | null): BillDraft | null => {
	if (bill.paidByRef !== ref) return null;

	const matched = (date ? dueMonthFor(bill, date) : null) ?? bill.paidThrough;
	const paidThrough =
		matched && bill.paidThrough === matched ? shiftMonthKey(matched, -1) : bill.paidThrough;

	return { ...draftOf(bill), paidThrough, paidByRef: null };
};
