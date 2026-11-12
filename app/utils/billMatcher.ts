/**
 * Baixa automática das contas a pagar (REM-04): qual conta e qual mês um pagamento quita.
 *
 * Puro, sem banco: quem grava é `captureActions.settleBillPayment`, chamado quando uma
 * captura vira lançamento e quando o usuário lança uma despesa à mão. A regra é apertada de
 * propósito — melhor deixar a conta pendente (rende um lembrete a mais) do que dar baixa na
 * conta errada (esconde um vencimento de verdade):
 *
 *  - só despesa; conta ativa, não apagada, cuja última baixa não foi este mesmo movimento;
 *  - o mês quitado é sempre o mais antigo em aberto (`firstOpenMonth`, visto do mês do
 *    movimento, até 3 meses para trás — SPD-145): com outubro em aberto, um pagamento de
 *    05/11 quita outubro, nunca novembro. Nenhum mês em aberto é pulado;
 *  - a data cai de 10 dias antes a 5 dias depois do vencimento desse mês (dia preso ao fim do
 *    mês, `billDueDate`); depois disso o mês está atrasado e o pagamento ainda vale, mas só
 *    com o nome/dica no texto — só o valor é pouco para dizer que é dela. Antes da janela,
 *    não casa;
 *  - a conta de pagamento, se a conta a pagar tiver uma, é a do movimento;
 *  - com valor: dentro de 1% ou R$ 1 (o maior), e o nome/dica no texto ou o valor exato;
 *    sem valor (varia): o nome ou uma das dicas no texto, palavra inteira;
 *  - mais de uma candidata: fica a de texto casado; empate, nenhuma.
 *
 * A conta sem mês pago nenhum (`paidThrough` nulo: a de dívida antes do mês de partida) não tem
 * passado em aberto: o mês quitado é o do vencimento mais próximo, como antes.
 *
 * Com os registros dos meses (SPD-146): o mês pulado e o pago fora de ordem não são "em
 * aberto" — o mais antigo em aberto passa por cima deles —, e um lançamento que já é o
 * pagamento de um mês registrado não casa de novo.
 */

import type { Bill, BillDraft, BillPayment, BillPaymentDraft } from '../database/schema';
import { paymentByTransaction, paymentFor } from './billPayments';
import { billDueDate, firstUnsettledMonth } from './billReminders';
import { undoMonth } from './billRules';
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

/**
 * A conta a pagar que um lançamento quitou, para o aviso dizer qual foi (SPD-153): o mês
 * quitado é o mais antigo em aberto, que pode não ser o do pagamento.
 */
export interface SettledBill {
	name: string;
	/** Mês quitado, `YYYY-MM`. */
	month: string;
}

/** O que o aviso precisa de uma baixa: o nome da conta e o mês. */
export const settledBillOf = (match: BillMatch | null): SettledBill | null =>
	match ? { name: match.bill.name, month: match.month } : null;

/**
 * O nome da conta a pagar cuja última baixa foi o lançamento `ref`, ou `null`. Só o nome: o
 * mês não sai daqui com segurança, porque "Só marcar como paga" avança `paidThrough` e mantém
 * o `paidByRef` (`markedPaid`) — o mês gravado pode ser um pago à mão depois (SPD-153).
 */
export const billNameSettledBy = (bills: Pick<Bill, 'name' | 'paidByRef' | 'deletedAt'>[], ref: string | null): string | null => {
	if (!ref) return null;
	return bills.find((bill) => bill.paidByRef === ref && !bill.deletedAt)?.name ?? null;
};

/**
 * A conta a pagar que o lançamento `ref` quitou, com o mês quando há registro dele (SPD-146):
 * o registro guarda o lançamento de cada mês, então o mês sai certo. Sem registro (baixa de
 * antes do SPD-146, ou desfeita), só o nome, pela última baixa (`billNameSettledBy`).
 */
export const billSettledBy = (
	bills: Pick<Bill, 'id' | 'name' | 'paidByRef' | 'deletedAt'>[],
	payments: readonly BillPayment[],
	ref: string | null
): { name: string; month: string | null } | null => {
	if (!ref) return null;
	const record = paymentByTransaction(payments, ref);
	const bill = record
		? bills.find((candidate) => candidate.id === record.billId && !candidate.deletedAt)
		: undefined;
	if (record && bill) return { name: bill.name, month: record.month };
	const name = billNameSettledBy(bills, ref);
	return name === null ? null : { name, month: null };
};

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

/**
 * Como o movimento casa com a conta, sem olhar a data: `'text'` (nome ou dica no texto, e o
 * valor dentro da tolerância), `'amount'` (só o valor exato) ou `null`. Também confere que é
 * despesa e que saiu da conta de pagamento exigida.
 */
const fitOf = (bill: Bill, movement: BillMovement): 'text' | 'amount' | null => {
	if (!movement.isExpense) return null;
	const amount = Math.abs(movement.amountCents);
	if (amount === 0) return null;
	if (bill.accountId && bill.accountId !== movement.accountId) return null;

	const byText = textMatches(bill, movement.text);
	if (bill.amountCents === null || bill.amountCents === undefined) return byText ? 'text' : null;

	const expected = Math.abs(bill.amountCents);
	if (Math.abs(amount - expected) > toleranceOf(expected)) return null;
	if (byText) return 'text';
	return amount === expected ? 'amount' : null;
};

/**
 * Este movimento paga o mês `month` (`YYYY-MM`) desta conta? Da janela do vencimento (10 dias
 * antes a 5 depois) em diante: na janela, pelo texto ou pelo valor exato; depois dela (o mês
 * atrasado), só pelo texto — salvo `lateByAmount`, que o "Já paguei" usa para achar um
 * pagamento já lançado: ali é o usuário quem diz que pagou. Antes da janela, não.
 *
 * Não olha se o mês está pago nem a última baixa: isso é de quem chama.
 */
export const paysBillMonth = (
	bill: Bill,
	movement: BillMovement,
	month: string,
	options: { lateByAmount?: boolean } = {}
): boolean => {
	const offset = dayNumber(movement.date) - dayNumber(billDueDate(bill, month));
	if (offset < -BILL_MATCH_DAYS_BEFORE) return false;
	const fit = fitOf(bill, movement);
	if (!fit) return false;
	if (offset <= BILL_MATCH_DAYS_AFTER) return true;
	return fit === 'text' || options.lateByAmount === true;
};

/**
 * O mês que o movimento quitaria nesta conta: o mais antigo em aberto, visto do mês do
 * movimento, sem os que já têm registro. Sem mês pago nenhum, o do vencimento mais próximo
 * (`dueMonthFor`), se ainda não tiver registro.
 */
const monthToSettle = (
	bill: Bill,
	date: string,
	payments: readonly BillPayment[]
): string | null => {
	if (bill.paidThrough !== null && bill.paidThrough !== undefined) {
		return firstUnsettledMonth(bill, monthKeyOf(date), payments);
	}
	const month = dueMonthFor(bill, date);
	return month && !paymentFor(payments, bill.id, month) ? month : null;
};

/**
 * Qual conta a pagar (e qual mês) este movimento quita, ou `null`.
 *
 * Na dúvida, `null`: duas candidatas com o texto casado (duas contas iguais), ou duas
 * só pelo valor exato, não dão baixa em nenhuma. O lançamento que já é o pagamento registrado
 * de um mês (`payments`) não casa de novo.
 */
export const matchBillPayment = (
	bills: Bill[],
	movement: BillMovement,
	payments: readonly BillPayment[] = []
): BillMatch | null => {
	if (paymentByTransaction(payments, movement.id)) return null;
	const candidates: { match: BillMatch; byText: boolean }[] = [];

	for (const bill of bills) {
		if (!bill.active || bill.deletedAt) continue;
		if (bill.paidByRef === movement.id) continue;

		const month = monthToSettle(bill, movement.date, payments);
		if (!month || !paysBillMonth(bill, movement, month)) continue;

		candidates.push({ match: { bill, month }, byText: fitOf(bill, movement) === 'text' });
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

/**
 * A baixa: `paidThrough` vai ao mês casado (nunca diminui) e segue por cima dos meses
 * seguintes que já têm registro (`payments`, SPD-146); `paidByRef` é o lançamento.
 */
export const billPaymentPatch = (
	bill: Bill,
	month: string,
	ref: string,
	payments: readonly BillPayment[] = []
): BillDraft => {
	let paidThrough = bill.paidThrough && bill.paidThrough > month ? bill.paidThrough : month;
	while (paymentFor(payments, bill.id, shiftMonthKey(paidThrough, 1)))
		paidThrough = shiftMonthKey(paidThrough, 1);
	return { ...draftOf(bill), paidThrough, paidByRef: ref };
};

/**
 * O mês mais adiante que um pagamento desta data pode ter quitado: o último cuja janela já
 * tinha começado (vencimento − 10 dias). Como a baixa vai sempre ao mais antigo em aberto, o
 * mês quitado pode ser anterior (o de 05/11 pode ter quitado outubro), nunca posterior.
 */
const latestMonthPayableOn = (bill: Pick<Bill, 'dueDay'>, date: string): string => {
	const current = monthKeyOf(date);
	for (const delta of [1, 0]) {
		const month = shiftMonthKey(current, delta);
		if (dayNumber(date) - dayNumber(billDueDate(bill, month)) >= -BILL_MATCH_DAYS_BEFORE) return month;
	}
	return shiftMonthKey(current, -1);
};

/**
 * Desfaz a baixa quando o lançamento `ref` foi apagado, ou `null` se não há o que desfazer
 * (a última baixa já é de outro lançamento, ou de nenhum).
 *
 * A baixa que ele deu foi a do último mês pago (`paidThrough`), que volta a ficar em aberto —
 * só ele, um mês. Se `paidThrough` já está adiante de qualquer mês que um pagamento daquela
 * data poderia quitar (um mês pago depois, à mão), fica — só a referência sai. Sem a data,
 * volta um mês do que está gravado.
 */
export const billPaymentUndo = (bill: Bill, ref: string, date: string | null): BillDraft | null => {
	if (bill.paidByRef !== ref) return null;

	const reach = date ? latestMonthPayableOn(bill, date) : bill.paidThrough;
	const paidThrough =
		bill.paidThrough && reach && bill.paidThrough <= reach ? shiftMonthKey(bill.paidThrough, -1) : bill.paidThrough;

	return { ...draftOf(bill), paidThrough, paidByRef: null };
};

/** O que apagar o lançamento de uma baixa desfaz: a conta, o registro que sai e os que entram. */
export interface BillSettlementUndo {
	draft: BillDraft;
	remove: BillPayment | null;
	fill: BillPaymentDraft[];
}

/**
 * Desfaz a baixa do lançamento `ref`, apagado. Com o registro do mês que ele pagou (SPD-146),
 * reabre exatamente aquele mês (`undoMonth`) e tira a referência, se for a da última baixa.
 * Sem registro (baixa de antes do SPD-146), a regra da fase 1 (`billPaymentUndo`). `null`
 * quando não há o que desfazer.
 */
export const billSettlementUndo = (
	bill: Bill,
	ref: string,
	date: string | null,
	payments: readonly BillPayment[]
): BillSettlementUndo | null => {
	const record = paymentByTransaction(payments, ref);
	if (record && record.billId === bill.id) {
		const undo = undoMonth(bill, payments, record.month);
		if (!undo) return null;
		return {
			draft: {
				...draftOf(bill),
				paidThrough: undo.paidThrough,
				paidByRef: bill.paidByRef === ref ? null : bill.paidByRef,
			},
			remove: undo.remove,
			fill: undo.fill,
		};
	}
	const draft = billPaymentUndo(bill, ref, date);
	return draft ? { draft, remove: null, fill: [] } : null;
};
