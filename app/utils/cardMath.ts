/**
 * Cartão de crédito: ciclo, faturas, limite e parcelas. Puro e testado.
 *
 * Cartão não tem saldo. Tem **limite**, uma **fatura aberta** que ainda recebe compras,
 * uma **fatura fechada** que espera pagamento e **parcelas futuras** que já ocupam o
 * limite mas ainda não caíram em fatura nenhuma. Este módulo transforma os lançamentos
 * do cartão nessas quatro coisas.
 *
 * ## Ciclo
 *
 * O usuário informa o **dia do fechamento** e quantos dias depois a fatura vence (7 no
 * Nubank):
 *
 * - a fatura fecha no começo do dia do fechamento — compras desse dia em diante vão
 *   para a próxima. O dia do fechamento é, por isso, o **melhor dia de compra**;
 * - o vencimento é o fechamento mais N dias, empurrado para o próximo dia útil quando
 *   cai em fim de semana ou feriado bancário;
 * - a fatura leva o **nome do mês em que fecha**: fecha 25/09 e vence 02/10, é a fatura
 *   de setembro. A de outubro só começa a receber compras em 25/09.
 *
 * Ciclos são contíguos e cada dia pertence a exatamente um — o teste por propriedades
 * garante.
 *
 * ## De onde vem o dinheiro devido
 *
 * Mesma âncora das contas (`openingBalanceCents` no fim de `openingBalanceDate`): o que
 * o usuário informou como "fatura atual" vira um lançamento único naquele dia, e os
 * lançamentos até a âncora já estão dentro dele. Compra soma, estorno subtrai, pagamento
 * (transferência para o cartão) subtrai do devido. Assim o valor devido, a fatura aberta
 * e a fechada sempre fecham entre si.
 *
 * ## Pagamento
 *
 * Pagamento não é gasto: é transferência da conta para o cartão, e abate o devido. O
 * que ele quita segue a ordem do banco — primeiro a fatura fechada, depois a aberta
 * (pagamento antecipado). Por isso "a pagar" é o devido menos o que já caiu na fatura
 * aberta, e a fatura fechada está paga quando isso chega a zero.
 */

import { DEFAULT_CLOSING_DAYS_BEFORE } from '../database/schema';
import { nextBusinessDay } from './businessDays';
import { MAX_INSTALLMENTS } from './installments';
import { addDays, addMonthsClamped, buildClampedDate, parseISODate } from './dateUtils';

export interface InvoiceCycle {
	/** `YYYY-MM` do mês em que a fatura fecha. Identifica a fatura e dá o nome dela. */
	key: string;
	/** Primeiro dia com compras nesta fatura (o fechamento anterior). */
	start: string;
	/** Último dia com compras nesta fatura (véspera do fechamento). */
	end: string;
	closingDate: string;
	/** Fechamento mais N dias, já ajustado para dia útil. */
	dueDate: string;
}

/** O que define o ciclo de um cartão. */
export interface CycleRule {
	closingDay: number;
	/** Dias entre o fechamento e o vencimento. */
	dueDaysAfter: number;
}

export interface CardSettings {
	closingDay: number | null;
	/** Dias entre o fechamento e o vencimento (coluna `closingDaysBefore`). */
	closingDaysBefore: number | null;
	creditLimitCents: number | null;
	openingBalanceCents: number;
	openingBalanceDate: string;
}

export interface CardEntry {
	id: string;
	amountCents: number;
	/** Estorno ou crédito no cartão. */
	isIncome: boolean;
	date: string;
	note: string;
	category: string;
	installmentGroup: string | null;
	installmentIndex: number | null;
	installmentCount: number | null;
	/** Qual cartão (físico, virtual) fez a compra. Não muda a fatura, só o "quem gastou". */
	cardLast4?: string | null;
	/**
	 * Compra avisada pelo banco que ainda está na caixa de entrada. Já é dívida no cartão —
	 * o banco aprovou — então entra na fatura e no limite; só a categoria espera.
	 */
	pendingReview?: boolean;
}

export interface CardMovement {
	amountCents: number;
	date: string;
	/** Verdadeiro quando o dinheiro entra no cartão: um pagamento de fatura. */
	inbound: boolean;
}

/** A regra do ciclo, ou nula enquanto o cartão não tem dia de fechamento. */
export const cycleRuleOf = (settings: Pick<CardSettings, 'closingDay' | 'closingDaysBefore'>): CycleRule | null =>
	settings.closingDay === null
		? null
		: { closingDay: settings.closingDay, dueDaysAfter: settings.closingDaysBefore ?? DEFAULT_CLOSING_DAYS_BEFORE };

// ---------------------------------------------------------------------------
// Datas
// ---------------------------------------------------------------------------

const pad = (value: number): string => String(value).padStart(2, '0');

const shiftYearMonth = (year: number, month: number, delta: number): [number, number] => {
	const total = year * 12 + (month - 1) + delta;
	return [Math.floor(total / 12), (total % 12) + 1];
};

const dayNumber = (date: string): number => {
	const [year, month, day] = date.split('-').map(Number);
	return Math.round(Date.UTC(year, month - 1, day) / 86_400_000);
};

/** Dias de `from` até `to`; negativo quando `to` já passou. */
export const daysBetween = (from: string, to: string): number => dayNumber(to) - dayNumber(from);

/** A fatura que fecha no mês `year`/`month`. Sempre derivada da regra, nunca de uma data já presa. */
export const invoiceClosingIn = (year: number, month: number, rule: CycleRule): InvoiceCycle => {
	const closingDate = buildClampedDate(year, month, rule.closingDay);
	const [py, pm] = shiftYearMonth(year, month, -1);
	return {
		key: `${year}-${pad(month)}`,
		start: buildClampedDate(py, pm, rule.closingDay),
		end: addDays(closingDate, -1),
		closingDate,
		dueDate: nextBusinessDay(addDays(closingDate, rule.dueDaysAfter)),
	};
};

/** A fatura `offset` ciclos depois (ou antes, se negativo) de `cycle`. */
export const shiftCycle = (cycle: InvoiceCycle, offset: number, rule: CycleRule): InvoiceCycle => {
	const [year, month] = cycle.key.split('-').map(Number);
	const [ty, tm] = shiftYearMonth(year, month, offset);
	return invoiceClosingIn(ty, tm, rule);
};

/** A fatura em que uma compra feita em `date` entra. */
export const cycleFor = (date: string, rule: CycleRule): InvoiceCycle => {
	const parsed = parseISODate(date);
	const cycle = invoiceClosingIn(parsed.getFullYear(), parsed.getMonth() + 1, rule);
	return date < cycle.closingDate ? cycle : shiftCycle(cycle, 1, rule);
};

// ---------------------------------------------------------------------------
// Valores
// ---------------------------------------------------------------------------

const signed = (entry: CardEntry): number => (entry.isIncome ? -entry.amountCents : entry.amountCents);

/**
 * Quanto o cartão deve no fim de `asOf`: a âncora mais compras, menos estornos e
 * pagamentos, contando só o que é datado depois da âncora. Negativo é crédito.
 */
export const owedOn = (settings: CardSettings, entries: CardEntry[], movements: CardMovement[], asOf: string): number => {
	// `0 - x` e não `-x`: com âncora zero, `-0` vazaria para a tela e para comparações.
	let owed = 0 - settings.openingBalanceCents;
	for (const entry of entries) {
		if (entry.date > settings.openingBalanceDate && entry.date <= asOf) owed += signed(entry);
	}
	for (const movement of movements) {
		if (movement.date > settings.openingBalanceDate && movement.date <= asOf) {
			owed += movement.inbound ? -movement.amountCents : movement.amountCents;
		}
	}
	return owed;
};

/**
 * O valor de uma fatura: compras menos estornos datados no ciclo, depois da âncora,
 * mais a própria âncora quando ela cai no ciclo. `upTo` limita ao que já foi lançado.
 */
export const invoiceAmount = (
	cycle: InvoiceCycle,
	settings: CardSettings,
	entries: CardEntry[],
	upTo?: string
): number => {
	const last = upTo && upTo < cycle.end ? upTo : cycle.end;
	let total = 0;
	for (const entry of entries) {
		if (entry.date < cycle.start || entry.date > last) continue;
		if (entry.date <= settings.openingBalanceDate) continue;
		total += signed(entry);
	}
	if (settings.openingBalanceDate >= cycle.start && settings.openingBalanceDate <= last) {
		total -= settings.openingBalanceCents;
	}
	return total + 0;
};

// ---------------------------------------------------------------------------
// Resumo
// ---------------------------------------------------------------------------

export type ClosedInvoiceStatus = 'none' | 'paid' | 'due' | 'due_soon' | 'overdue';

export interface InvoiceView {
	cycle: InvoiceCycle;
	amountCents: number;
	/** -1 fechada, 0 aberta, >0 futura, <-1 anteriores. */
	offset: number;
	/**
	 * Pagamentos feitos entre o fechamento desta fatura e o da seguinte — a janela em que
	 * ela é a fatura a pagar. Na aberta, pagamentos antecipados feitos desde o começo dela.
	 */
	paidCents: number;
}

export interface InstallmentPlan {
	group: string;
	note: string;
	category: string;
	totalCount: number;
	/** Parcelas ainda por cair. */
	remainingCount: number;
	/** Valor da próxima parcela. */
	parcelCents: number;
	remainingCents: number;
	nextDate: string;
	lastDate: string;
}

export interface CardSummary {
	/** Sem dia de fechamento o app não sabe montar faturas; o resto funciona. */
	configured: boolean;
	/** Tudo o que já caiu e não foi pago. */
	owedCents: number;
	/** Pagamento a mais: fica como crédito na próxima fatura. */
	creditCents: number;
	/** Compras já feitas que cairão em faturas futuras (parcelas). */
	futureCommittedCents: number;
	limitCents: number | null;
	/** Devido mais o comprometido — é o que o banco desconta do limite. */
	limitUsedCents: number;
	limitAvailableCents: number | null;
	/** 0-100+, nulo sem limite. */
	limitUsagePercent: number | null;

	openCycle: InvoiceCycle | null;
	/** Fatura aberta inteira, inclusive parcelas já programadas para este ciclo. */
	openInvoiceCents: number;
	closedCycle: InvoiceCycle | null;
	closedInvoiceCents: number;
	/** O que falta pagar das faturas já fechadas. */
	toPayCents: number;
	closedStatus: ClosedInvoiceStatus;
	/** Pagamentos registrados desde o último fechamento. */
	paidSinceClosingCents: number;
	daysToClosing: number | null;
	daysToDue: number | null;
	/** O próximo fechamento: comprar a partir dele joga a compra para a fatura seguinte. */
	bestPurchaseDate: string | null;

	/** Faturas anteriores, a atual e as futuras com valor, da mais antiga para a mais nova. */
	invoices: InvoiceView[];
	installmentPlans: InstallmentPlan[];
	/** Compras na caixa de entrada que já entram na fatura, e quanto somam. */
	pendingEntries: CardEntry[];
	pendingReviewCents: number;
}

const INSTALLMENT_SUFFIX = /\s*\(\d{1,2}\/\d{1,2}\)\s*$/;

/** Planos de parcelamento com alguma parcela ainda por cair. */
export const buildInstallmentPlans = (entries: CardEntry[], today: string): InstallmentPlan[] => {
	const groups = new Map<string, CardEntry[]>();
	for (const entry of entries) {
		if (!entry.installmentGroup || entry.isIncome) continue;
		const list = groups.get(entry.installmentGroup) ?? [];
		list.push(entry);
		groups.set(entry.installmentGroup, list);
	}

	const plans: InstallmentPlan[] = [];
	for (const [group, list] of groups) {
		const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date) || (a.installmentIndex ?? 0) - (b.installmentIndex ?? 0));
		const future = sorted.filter((entry) => entry.date > today);
		if (future.length === 0) continue;

		plans.push({
			group,
			note: sorted[0].note.replace(INSTALLMENT_SUFFIX, ''),
			category: sorted[0].category,
			totalCount: sorted[0].installmentCount ?? sorted.length,
			remainingCount: future.length,
			parcelCents: future[0].amountCents,
			remainingCents: future.reduce((total, entry) => total + entry.amountCents, 0),
			nextDate: future[0].date,
			lastDate: sorted[sorted.length - 1].date,
		});
	}

	return plans.sort((a, b) => a.nextDate.localeCompare(b.nextDate) || a.note.localeCompare(b.note));
};

/**
 * Em qual fatura um lançamento cai: `YYYY-MM` do mês em que ela fecha.
 *
 * Não é o mês da data. Com fechamento no dia 25, a compra de 26 de setembro está na
 * fatura de **outubro**, e a parcela que o app data em 25/09 (o começo do ciclo aberto)
 * também. Usar o mês da data mostraria a parcela um mês antes da fatura que a cobra.
 */
export const invoiceMonthOf = (date: string, rule: CycleRule | null): string =>
	rule === null ? date.slice(0, 7) : cycleFor(date, rule).key;

/** Pagamentos (entradas no cartão) com data em [from, until). */
const paymentsBetween = (movements: CardMovement[], from: string, until: string): number => {
	let total = 0;
	for (const movement of movements) {
		if (movement.inbound && movement.date >= from && movement.date < until) total += movement.amountCents;
	}
	return total;
};

const DUE_SOON_DAYS = 3;
const PAST_INVOICES = 6;
/**
 * Até onde as faturas futuras vão: o maior parcelamento que o app aceita (48). As vazias
 * são descartadas logo abaixo, então o custo é só percorrer os ciclos — e um
 * parcelamento de 36 vezes deixa de ter parcelas em faturas que não existem na tela.
 */
const FUTURE_INVOICES = MAX_INSTALLMENTS;

export const buildCardSummary = (
	settings: CardSettings,
	entries: CardEntry[],
	movements: CardMovement[],
	today: string
): CardSummary => {
	const owedNow = owedOn(settings, entries, movements, today);
	const owedCents = Math.max(0, owedNow);
	const creditCents = Math.max(0, -owedNow);

	let futureCommittedCents = 0;
	for (const entry of entries) {
		if (entry.date > today && entry.date > settings.openingBalanceDate) futureCommittedCents += signed(entry);
	}
	futureCommittedCents = Math.max(0, futureCommittedCents);

	const limitUsedCents = Math.max(0, owedNow + futureCommittedCents);
	const limitCents = settings.creditLimitCents && settings.creditLimitCents > 0 ? settings.creditLimitCents : null;
	const limitAvailableCents = limitCents === null ? null : limitCents - limitUsedCents;
	const limitUsagePercent = limitCents === null ? null : Math.round((limitUsedCents / limitCents) * 100);
	const installmentPlans = buildInstallmentPlans(entries, today);

	const pendingEntries = entries.filter((entry) => entry.pendingReview && entry.date > settings.openingBalanceDate);
	const pendingReviewCents = pendingEntries.reduce((total, entry) => total + signed(entry), 0);

	const base = {
		pendingEntries,
		pendingReviewCents,
		owedCents,
		creditCents,
		futureCommittedCents,
		limitCents,
		limitUsedCents,
		limitAvailableCents,
		limitUsagePercent,
		installmentPlans,
	};

	const rule = cycleRuleOf(settings);
	if (rule === null) {
		return {
			...base,
			configured: false,
			openCycle: null,
			openInvoiceCents: 0,
			closedCycle: null,
			closedInvoiceCents: 0,
			toPayCents: owedCents,
			closedStatus: owedCents > 0 ? 'due' : 'none',
			paidSinceClosingCents: 0,
			daysToClosing: null,
			daysToDue: null,
			bestPurchaseDate: null,
			invoices: [],
		};
	}

	const openCycle = cycleFor(today, rule);
	const closedCycle = shiftCycle(openCycle, -1, rule);

	const openInvoiceCents = invoiceAmount(openCycle, settings, entries);
	const openPostedCents = invoiceAmount(openCycle, settings, entries, today);
	const closedInvoiceCents = invoiceAmount(closedCycle, settings, entries);
	// O devido menos a fatura aberta, com sinal: crédito na aberta **não** abate a fechada.
	// No Brasil o estorno credita a fatura seguinte, e a fechada continua cobrada inteira —
	// uma fechada de R$ 1.000 com estorno de R$ 200 na aberta é R$ 1.000 a pagar. Descontar
	// o estorno aqui faria o dono pagar R$ 800 onde o banco cobra R$ 1.000 e cair no
	// rotativo pelos R$ 200.
	const toPayCents = Math.max(0, owedNow - openPostedCents);

	let paidSinceClosingCents = 0;
	for (const movement of movements) {
		if (movement.inbound && movement.date >= closedCycle.closingDate && movement.date <= today) {
			paidSinceClosingCents += movement.amountCents;
		}
	}

	const daysToDue = daysBetween(today, closedCycle.dueDate);
	let closedStatus: ClosedInvoiceStatus;
	if (toPayCents === 0) closedStatus = closedInvoiceCents > 0 ? 'paid' : 'none';
	else if (daysToDue < 0) closedStatus = 'overdue';
	else if (daysToDue <= DUE_SOON_DAYS) closedStatus = 'due_soon';
	else closedStatus = 'due';

	// O pagamento feito na janela de uma fatura quita ela até o valor dela; o que sobra
	// da janela da fechada é pagamento antecipado da aberta.
	const closedWindowPaid = paymentsBetween(movements, closedCycle.closingDate, openCycle.closingDate);
	const invoicePaidCents = (cycle: InvoiceCycle, offset: number, amountCents: number): number => {
		if (offset > 0) return 0;
		if (offset === 0) return Math.max(0, closedWindowPaid - Math.max(0, closedInvoiceCents));
		const window = offset === -1 ? closedWindowPaid : paymentsBetween(movements, cycle.closingDate, shiftCycle(cycle, 1, rule).closingDate);
		return Math.min(window, Math.max(0, amountCents));
	};

	const invoices: InvoiceView[] = [];
	for (let offset = -PAST_INVOICES; offset <= FUTURE_INVOICES; offset += 1) {
		const cycle = shiftCycle(openCycle, offset, rule);
		const amountCents = invoiceAmount(cycle, settings, entries);
		const paidCents = invoicePaidCents(cycle, offset, amountCents);
		if (offset < -1 && amountCents === 0 && paidCents === 0) continue;
		if (offset > 0 && amountCents === 0) continue;
		invoices.push({ cycle, amountCents, offset, paidCents });
	}

	return {
		...base,
		configured: true,
		openCycle,
		openInvoiceCents,
		closedCycle,
		closedInvoiceCents,
		toPayCents,
		closedStatus,
		paidSinceClosingCents,
		daysToClosing: daysBetween(today, openCycle.closingDate),
		daysToDue,
		bestPurchaseDate: openCycle.closingDate,
		invoices,
	};
};

// ---------------------------------------------------------------------------
// Pagamento já registrado
// ---------------------------------------------------------------------------

/** Um pagamento de fatura, do jeito que basta para saber se dois são o mesmo. */
export interface CardPayment {
	/** Conta de onde o dinheiro saiu; nula quando é uma conta que o app não acompanha. */
	fromAccountId: string | null;
	amountCents: number;
	date: string;
}

/** Diferença de data que ainda pode ser o mesmo pagamento visto duas vezes. */
const SAME_PAYMENT_DAYS = 1;

/**
 * Os dois são o **mesmo** pagamento, visto duas vezes? É o caso real de a notificação do
 * banco chegar junto com o registro feito à mão — e aí gravar os dois debitaria a conta
 * duas vezes.
 *
 * A identidade é apertada de propósito: mesma conta de origem, mesmo valor e no máximo um
 * dia de diferença. Fatura de R$ 1.000 paga em duas parcelas iguais — R$ 500 em 01/10 pela
 * Nubank e R$ 500 em 03/10 pelo Inter — são **dois** pagamentos, e os dois têm de entrar.
 * Casar só por valor e janela de dias fazia o segundo sumir com mensagem de sucesso.
 *
 * Origem nula casa com qualquer uma, como em `findLiveTransfer`: é a conta que o app não
 * acompanha ou que o aviso do banco não identificou, não uma conta diferente.
 */
export const isSameCardPayment = (a: CardPayment, b: CardPayment): boolean => {
	if (a.amountCents !== b.amountCents) return false;
	if (Math.abs(daysBetween(a.date, b.date)) > SAME_PAYMENT_DAYS) return false;
	if (a.fromAccountId === null || b.fromAccountId === null) return true;
	return a.fromAccountId === b.fromAccountId;
};

/** Uma transferência gravada, do jeito que basta para saber se é um pagamento em aberto. */
export interface OpenTransferCandidate {
	fromAccountId: string | null;
	toAccountId: string | null;
	amountCents: number;
	date: string;
}

/**
 * A transferência em aberto que este "Pagar fatura" completa, ou nula quando não há.
 *
 * Com zero ou dois cartões no banco, o aviso do pagamento é gravado como transferência da
 * conta para um destino **em branco**: o app não sabe qual fatura foi paga. Quando o
 * usuário depois toca "Pagar fatura" naquele cartão, aquela transferência é este mesmo
 * pagamento — criar outra debitaria a conta duas vezes. Completa-se o destino dela.
 *
 * Aqui a origem não é curinga, ao contrário de `isSameCardPayment`: só casa a transferência
 * que saiu **desta** conta, com o mesmo valor e no máximo um dia de diferença. Duas
 * candidatas: a de data mais próxima; empate, a mais antiga.
 */
export const pickOpenCardPayment = <T extends OpenTransferCandidate>(candidates: T[], payment: CardPayment): T | null => {
	if (payment.fromAccountId === null) return null;
	let best: T | null = null;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const candidate of candidates) {
		if (candidate.toAccountId !== null) continue;
		if (candidate.fromAccountId !== payment.fromAccountId) continue;
		if (candidate.amountCents !== payment.amountCents) continue;
		const distance = Math.abs(daysBetween(candidate.date, payment.date));
		if (distance > SAME_PAYMENT_DAYS) continue;
		if (best === null || distance < bestDistance || (distance === bestDistance && candidate.date < best.date)) {
			best = candidate;
			bestDistance = distance;
		}
	}
	return best;
};

export interface CardAdjustmentPlan {
	/**
	 * Nova âncora: o que o cartão devia no fim de `date` (negativo = deve). **Nula** quando
	 * a fatura fechada não foi informada — sem ela não há o que ancorar, e a âncora de hoje
	 * fica onde está.
	 */
	anchor: { date: string; cents: number } | null;
	/**
	 * Diferença entre a fatura aberta que o banco mostra e a que o app montou, lançada hoje
	 * no cartão como "ajuste com o banco". Positivo é compra que o app não viu; negativo,
	 * estorno. Zero quando já bate — e também quando a aberta não foi informada, porque aí
	 * ela fica valendo exatamente o que o app já mostrava.
	 */
	adjustmentCents: number;
}

/**
 * "Acertar valor" com o que o app do banco mostra: a fatura aberta e, se houver, a fechada
 * ainda não paga. As duas **não se misturam**.
 *
 * - A fechada vira a âncora na véspera do fechamento: tudo até ali está dentro dela, e os
 *   pagamentos registrados depois do fechamento continuam abatendo. Assim ela aparece
 *   como fechada, com o status pelo vencimento, e pagar depois a quita.
 * - A aberta é o que caiu desde o fechamento. O app já tem parte disso (notificações,
 *   lançamentos); o que falta ou sobra vira um ajuste datado hoje, visível na fatura.
 *
 * **Campo em branco é `null`: "não informei", nunca "o banco mostra zero".** Quem tem uma
 * fechada de R$ 1.200 em aberto e R$ 450 na aberta e preenche só a fechada não está
 * dizendo que a aberta é zero — e ler o branco como zero gerava um estorno falso de
 * R$ 450 datado hoje. A fatura não informada fica valendo exatamente o que o app já
 * mostrava: a não informada não se move.
 *
 * Sem dia de fechamento não há fatura para separar: a âncora fica na véspera de hoje com
 * a soma do que foi informado, descontado o que já foi lançado hoje.
 */
export const planCardAdjustment = (
	settings: CardSettings,
	entries: CardEntry[],
	movements: CardMovement[],
	today: string,
	openTypedCents: number | null,
	closedTypedCents: number | null
): CardAdjustmentPlan => {
	const rule = cycleRuleOf(settings);
	if (rule === null) {
		if (openTypedCents === null && closedTypedCents === null) return { anchor: null, adjustmentCents: 0 };
		let todayNet = 0;
		for (const entry of entries) if (entry.date === today) todayNet += signed(entry);
		for (const movement of movements) {
			if (movement.date === today) todayNet += movement.inbound ? -movement.amountCents : movement.amountCents;
		}
		return {
			anchor: { date: addDays(today, -1), cents: 0 - ((openTypedCents ?? 0) + (closedTypedCents ?? 0) - todayNet) },
			adjustmentCents: 0,
		};
	}

	const open = cycleFor(today, rule);
	const closed = shiftCycle(open, -1, rule);
	const anchorDate = closed.end;

	// O que o app mostra hoje na fatura aberta. É isto que vale quando a aberta não foi
	// informada — inclusive quando mover a âncora para trás tiraria dela a "fatura atual"
	// informada antes, que o ajuste devolve.
	const openBefore = invoiceAmount(open, settings, entries);

	// Pagamentos já registrados depois do fechamento abatem a fechada: a âncora é o valor
	// "ainda não pago" mais eles, para que o devido de hoje dê exatamente o digitado.
	let movedSince = 0;
	for (const movement of movements) {
		if (movement.date > anchorDate && movement.date <= today) {
			movedSince += movement.inbound ? movement.amountCents : -movement.amountCents;
		}
	}

	const anchor = closedTypedCents === null ? null : { date: anchorDate, cents: 0 - (closedTypedCents + movedSince) };
	const anchored: CardSettings =
		anchor === null ? settings : { ...settings, openingBalanceCents: anchor.cents, openingBalanceDate: anchor.date };
	const openAfter = invoiceAmount(open, anchored, entries);
	return { anchor, adjustmentCents: (openTypedCents ?? openBefore) - openAfter + 0 };
};

/**
 * Datas das parcelas de uma compra parcelada no cartão: a primeira no dia da compra, as
 * seguintes um mês depois cada, **uma por fatura**. Somar um mês nem sempre muda de
 * fatura — comprar em 29/01 com fechamento dia 30 põe a segunda parcela em 28/02, que já
 * é o fechamento de fevereiro — e aí a parcela vai para o começo da fatura certa. Sem
 * regra de ciclo, de mês em mês.
 */
export const cardInstallmentDates = (purchaseDate: string, count: number, rule: CycleRule | null): string[] => {
	const dates: string[] = [];
	const first = rule === null ? null : cycleFor(purchaseDate, rule);
	for (let index = 1; index <= count; index += 1) {
		const naive = addMonthsClamped(purchaseDate, index - 1);
		if (first === null || rule === null || index === 1) {
			dates.push(naive);
			continue;
		}
		const expected = shiftCycle(first, index - 1, rule);
		dates.push(cycleFor(naive, rule).key === expected.key ? naive : expected.start);
	}
	return dates;
};

/**
 * Datas das parcelas restantes de uma compra parcelada feita **antes** do app, a partir
 * da parcela que cai na fatura aberta. A parcela atual entra no começo do ciclo aberto;
 * as seguintes, no começo de cada ciclo depois dele — uma por fatura, como no banco.
 * Sem vencimento informado, a atual fica hoje e as outras de mês em mês.
 *
 * Nenhuma parcela é datada antes do **dia seguinte à âncora** do cartão. A âncora é o que
 * o cartão devia no **fim** daquele dia, e tanto `owedOn` como `invoiceAmount` só somam o
 * que vem depois dela: o dia seguinte é, por isso, o primeiro dia que conta. Num cartão
 * cadastrado hoje (âncora = ontem) o começo do ciclo aberto é o fechamento anterior,
 * semanas atrás — a parcela atual cairia antes da âncora e seria descartada da fatura e
 * da lista; e com a "fatura atual" informada antes (que já continha essa parcela) ela
 * passaria a contar em cima do valor informado.
 */
export const existingInstallmentDates = (
	currentIndex: number,
	totalCount: number,
	rule: CycleRule | null,
	today: string,
	/** `openingBalanceDate` do cartão: a âncora que já engoliu tudo até ela. */
	anchorDate: string
): Array<{ index: number; date: string }> => {
	const dates: Array<{ index: number; date: string }> = [];
	if (currentIndex < 1 || totalCount < currentIndex) return dates;

	const firstCounted = addDays(anchorDate, 1);
	if (rule === null) {
		for (let index = currentIndex; index <= totalCount; index += 1) {
			const naive = addMonthsClamped(today, index - currentIndex);
			dates.push({ index, date: naive > firstCounted ? naive : firstCounted });
		}
		return dates;
	}

	const open = cycleFor(today, rule);
	const first = open.start > firstCounted ? open.start : firstCounted;
	// As seguintes saem da fatura em que a atual caiu, e não do ciclo aberto: se o piso da
	// âncora empurrou a atual para a fatura seguinte, as outras andam junto — uma por
	// fatura, sem duas na mesma.
	const firstCycle = cycleFor(first, rule);
	for (let index = currentIndex; index <= totalCount; index += 1) {
		const offset = index - currentIndex;
		dates.push({ index, date: offset === 0 ? first : shiftCycle(firstCycle, offset, rule).start });
	}
	return dates;
};

/**
 * A fatura do mês para o quadro "Este mês": as faturas que **fecham** entre `startDate`
 * e `endDate` — a de setembro fecha em setembro e é paga logo depois. Inclui parcelas e
 * a "fatura atual" informada. Nulo quando o cartão não tem fechamento; aí quem chama usa
 * as compras datadas no período.
 */
export const invoicesClosingBetween = (
	settings: CardSettings,
	entries: CardEntry[],
	startDate: string,
	endDate: string
): number | null => {
	const rule = cycleRuleOf(settings);
	if (rule === null) return null;

	let total = 0;
	// Um ciclo antes: `cycleFor` devolve a fatura que fecha *depois* da data, e a que fecha
	// exatamente em `startDate` (fechamento dia 1) também é deste período.
	let cycle = shiftCycle(cycleFor(startDate, rule), -1, rule);
	while (cycle.closingDate <= endDate) {
		if (cycle.closingDate >= startDate) total += invoiceAmount(cycle, settings, entries);
		cycle = shiftCycle(cycle, 1, rule);
	}
	return total + 0;
};

export default {
	cardInstallmentDates,
	isSameCardPayment,
	pickOpenCardPayment,
	planCardAdjustment,
	cycleRuleOf,
	cycleFor,
	invoiceClosingIn,
	invoicesClosingBetween,
	shiftCycle,
	owedOn,
	invoiceAmount,
	buildCardSummary,
	buildInstallmentPlans,
	existingInstallmentDates,
	invoiceMonthOf,
	daysBetween,
};
