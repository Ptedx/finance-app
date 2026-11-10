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
 * O usuário informa o **dia do fechamento** e o **dia do vencimento**, os dois como a fatura
 * do banco mostra:
 *
 * - a fatura fecha no começo do dia do fechamento — compras desse dia em diante vão
 *   para a próxima. O dia do fechamento é, por isso, o **melhor dia de compra**;
 * - o vencimento é o dia do vencimento (`dueDay`) no mês do fechamento, quando cai depois
 *   dele, ou no mês seguinte; dia que o mês não tem é o último. Fecha 28 e vence 5: a de
 *   novembro vence 05/12, a de fevereiro 05/03. Em fim de semana ou feriado bancário, o
 *   próximo dia útil. Cartão sem o dia gravado usa o fechamento mais N dias
 *   (`closingDaysBefore`), a regra de antes (SPD-119);
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
 * ## Ajuste com a fatura do banco
 *
 * A âncora é um ponto só. Quando o banco mostra duas faturas — a fechada ainda não paga e a
 * aberta —, a fechada vira a âncora e a diferença da aberta entra como um lançamento de
 * ajuste datado hoje (`CARD_ADJUSTMENT_NOTE`, ver `planCardAdjustment`). O ajuste conta na
 * fatura, no devido e no limite, mas **não é compra nem receita**: é o app acertando o que
 * não viu. Quem soma compras do mês, "por cartão" ou entradas e saídas o deixa de fora
 * (`isCardAdjustment`). No cadastro, fora da janela entre o fechamento e o vencimento, a
 * fatura informada vira a âncora e nenhum lançamento (`planCardOpening`).
 *
 * ## Encargos
 *
 * Juros, IOF, anuidade, multa e tarifas o app não vê: nenhuma notificação de compra os traz.
 * Entram por um lançamento "Encargo do cartão" (`CARD_CHARGE_NOTE`, `isCardCharge`),
 * registrado à mão ou criado pelo "Acertar valor" com a diferença para o banco
 * (`splitCardCharges`). Como o ajuste, conta na fatura, no devido e no limite e não é compra
 * (`isCardNonPurchase`); ao contrário dele, é gasto de verdade e aparece nos relatórios.
 *
 * ## Crédito levado adiante
 *
 * Estorno maior que as compras do ciclo deixa a fatura negativa. Como no banco, isso é
 * crédito: abate a fatura seguinte, e a próxima, até acabar (`carriedCredit`). A fatura
 * continua com o próprio valor — é o que a lista de lançamentos dela soma — e o que ela
 * cobra de verdade é esse valor menos o crédito que chegou a ela.
 *
 * ## Pagamento
 *
 * Pagamento não é gasto: é transferência da conta para o cartão, e abate o devido. O
 * que ele quita segue a ordem do banco — primeiro a fatura fechada, depois a aberta
 * (pagamento antecipado). Por isso "a pagar" é o devido menos o que já caiu na fatura
 * aberta, e a fatura fechada está paga quando isso chega a zero.
 *
 * O que sobra do pagamento depois de quitar a fatura da janela vai para a seguinte, e dela
 * para a outra, até a aberta. É o caso do pagamento feito depois da âncora e antes do
 * fechamento com a fatura anterior zerada: ele é da fatura seguinte, que aparece paga (ou paga
 * em parte) como qualquer outra (SPD-120, DEC-37).
 *
 * Pagamento datado até a âncora é como a compra datada até ela: já está no valor informado
 * (`inInformedValue`) e não abate fatura nenhuma — nem o devido, nem o "pago" de cada fatura,
 * nem o lembrete. A tela o mostra junto das compras de antes (`coveredPayments`).
 */

import { DEFAULT_CLOSING_DAYS_BEFORE } from '../database/schema';
import { nextBusinessDay } from './businessDays';
import { MAX_INSTALLMENTS } from './installments';
import { addDays, addMonthsClamped, buildClampedDate, lastDayOfMonth, parseISODate } from './dateUtils';

export interface InvoiceCycle {
	/** `YYYY-MM` do mês em que a fatura fecha. Identifica a fatura e dá o nome dela. */
	key: string;
	/** Primeiro dia com compras nesta fatura (o fechamento anterior). */
	start: string;
	/** Último dia com compras nesta fatura (véspera do fechamento). */
	end: string;
	closingDate: string;
	/** O dia do vencimento depois do fechamento (ou fechamento mais N dias), já em dia útil. */
	dueDate: string;
}

/** O que define o ciclo de um cartão. */
export interface CycleRule {
	closingDay: number;
	/**
	 * Dias entre o fechamento e o vencimento. Só decide o vencimento sem `dueDay`; com ele, é o
	 * prazo de uma fatura só (a que estava aberta quando o dono digitou).
	 */
	dueDaysAfter: number;
	/** O dia de vencimento que a fatura mostra. Quando há, toda fatura vence nesse dia. */
	dueDay?: number;
}

export interface CardSettings {
	closingDay: number | null;
	/** Dias entre o fechamento e o vencimento (coluna `closingDaysBefore`). */
	closingDaysBefore: number | null;
	/** O dia de vencimento digitado (coluna `dueDay`). Sem ele, o vencimento sai do prazo. */
	dueDay?: number | null;
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

/**
 * A regra do ciclo, ou nula enquanto o cartão não tem dia de fechamento. Leva o dia de
 * vencimento quando o cartão o tem gravado: é ele que dá o vencimento de cada fatura.
 */
export const cycleRuleOf = (settings: Pick<CardSettings, 'closingDay' | 'closingDaysBefore' | 'dueDay'>): CycleRule | null => {
	if (settings.closingDay === null) return null;
	const rule: CycleRule = { closingDay: settings.closingDay, dueDaysAfter: settings.closingDaysBefore ?? DEFAULT_CLOSING_DAYS_BEFORE };
	if (settings.dueDay) rule.dueDay = settings.dueDay;
	return rule;
};

/**
 * Nota do lançamento de ajuste com a fatura do banco: o mesmo texto em qualquer idioma, é
 * um marcador. Já está gravado assim nos aparelhos e no servidor — não mude.
 */
export const CARD_ADJUSTMENT_NOTE = 'Ajuste com a fatura do banco';

/**
 * O lançamento é o ajuste com a fatura do banco, e não uma compra ou um estorno?
 *
 * Sem coluna própria (mudar o schema e o sync por isto não vale), o ajuste é reconhecido
 * pela nota-marcador exata, a única coisa que todo ajuste já gravado tem em comum — os de
 * antes desta versão inclusive. A categoria não entra: ela cai em outra quando "Outras
 * despesas" foi apagada, ou o dono pode tê-la trocado, e o lançamento continua sendo o
 * ajuste. Parcela nunca é ajuste. Quem chama garante que o lançamento é de um cartão:
 * numa conta, a mesma nota é lançamento comum.
 *
 * O limite é o da nota: se o dono a editar, o lançamento passa a contar como compra; se
 * digitar exatamente esse texto numa compra do cartão, ela deixa de contar como compra
 * (continua na fatura).
 */
export const isCardAdjustment = (entry: { note: string | null | undefined; installmentGroup?: string | null }): boolean =>
	!entry.installmentGroup && (entry.note ?? '').trim() === CARD_ADJUSTMENT_NOTE;

/**
 * Encargo do cartão: juros, IOF, anuidade, multa, tarifas — o que o banco cobra na fatura e
 * nenhuma notificação de compra traz (E2E-20). Como o ajuste, é um lançamento do cartão que
 * entra na fatura, no devido e no limite, mas não é compra. Ao contrário do ajuste, é
 * dinheiro perdido de verdade: os relatórios o mostram numa linha própria.
 *
 * A nota é o marcador, no mesmo texto em qualquer idioma — `Encargo do cartão`, com o tipo
 * entre parênteses quando há (`Encargo do cartão (juros)`). Grave assim e não mude: o SQL
 * de "comprados no mês" (`CARD_CHARGE_NOTE_GLOB`) reconhece pelo mesmo texto.
 */
export const CARD_CHARGE_NOTE = 'Encargo do cartão';

/** O padrão `GLOB` do SQLite para o encargo com tipo: o mesmo critério de `isCardCharge`. */
export const CARD_CHARGE_NOTE_GLOB = `${CARD_CHARGE_NOTE} (*)`;

/**
 * Os tipos que a folha "Registrar encargo" oferece, e `bank`: a diferença para a fatura do
 * banco que o "Acertar valor" lançou como encargo, sem o dono dizer qual.
 */
export type CardChargeKind = 'interest' | 'iof' | 'annualFee' | 'fee' | 'other' | 'bank';

/** O texto entre parênteses de cada tipo. "Outro" fica sem: é a nota pura. */
const CARD_CHARGE_SUFFIX: Record<CardChargeKind, string | null> = {
	interest: 'juros',
	iof: 'IOF',
	annualFee: 'anuidade',
	fee: 'multa ou tarifa',
	other: null,
	bank: 'pela fatura do banco',
};

/** A nota-marcador de um encargo do tipo. */
export const cardChargeNote = (kind: CardChargeKind): string => {
	const suffix = CARD_CHARGE_SUFFIX[kind];
	return suffix === null ? CARD_CHARGE_NOTE : `${CARD_CHARGE_NOTE} (${suffix})`;
};

/**
 * O tipo do encargo pela nota, ou nulo quando a nota não é de encargo. Um texto entre
 * parênteses que o app não gravou (o dono editou) continua encargo, do tipo "outro".
 */
export const cardChargeKindOf = (note: string | null | undefined): CardChargeKind | null => {
	const text = (note ?? '').trim();
	if (text === CARD_CHARGE_NOTE) return 'other';
	if (!text.startsWith(`${CARD_CHARGE_NOTE} (`) || !text.endsWith(')')) return null;
	const suffix = text.slice(CARD_CHARGE_NOTE.length + 2, -1);
	const kind = (Object.keys(CARD_CHARGE_SUFFIX) as CardChargeKind[]).find((key) => CARD_CHARGE_SUFFIX[key] === suffix);
	return kind ?? 'other';
};

/**
 * O lançamento é um encargo do cartão? Pela nota-marcador, como `isCardAdjustment`, e com o
 * mesmo limite: editar a nota o faz voltar a ser compra; digitar o marcador numa compra a
 * faz deixar de ser. A categoria não entra — o encargo nasce em "Outras despesas", mas o dono
 * pode trocá-la. Parcela nunca é encargo. Quem chama garante que é lançamento de cartão.
 */
export const isCardCharge = (entry: { note: string | null | undefined; installmentGroup?: string | null }): boolean =>
	!entry.installmentGroup && cardChargeKindOf(entry.note) !== null;

/**
 * O lançamento do cartão não é compra: o ajuste com a fatura do banco ou um encargo. É o que
 * "comprados no mês", "Por cartão" e o Entrou/Saiu de Lançamentos deixam de fora.
 */
export const isCardNonPurchase = (entry: { note: string | null | undefined; installmentGroup?: string | null }): boolean =>
	isCardAdjustment(entry) || isCardCharge(entry);

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

/**
 * O vencimento de uma fatura antes do dia útil. Com o dia de vencimento: esse dia no mês do
 * fechamento, quando cai depois dele, senão no mês seguinte; dia que o mês não tem é o último
 * (fecha 25 e vence 31: 30/11; fecha 28 e vence 5: 05/03 para a de fevereiro). É a conta do
 * formulário (`dueGapFor`), então o prazo gravado é o desta data na fatura que estava aberta
 * quando o dono digitou. Sem o dia, o fechamento mais o prazo.
 */
const rawDueDate = (year: number, month: number, closingDate: string, rule: CycleRule): string => {
	if (!rule.dueDay) return addDays(closingDate, rule.dueDaysAfter);
	const sameMonth = buildClampedDate(year, month, rule.dueDay);
	if (sameMonth > closingDate) return sameMonth;
	const [ny, nm] = shiftYearMonth(year, month, 1);
	return buildClampedDate(ny, nm, rule.dueDay);
};

/** A fatura que fecha no mês `year`/`month`. Sempre derivada da regra, nunca de uma data já presa. */
export const invoiceClosingIn = (year: number, month: number, rule: CycleRule): InvoiceCycle => {
	const closingDate = buildClampedDate(year, month, rule.closingDay);
	const [py, pm] = shiftYearMonth(year, month, -1);
	return {
		key: `${year}-${pad(month)}`,
		start: buildClampedDate(py, pm, rule.closingDay),
		end: addDays(closingDate, -1),
		closingDate,
		dueDate: nextBusinessDay(rawDueDate(year, month, closingDate, rule)),
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
 * O lançamento ou pagamento datado em `date` já está no valor informado? A âncora é o que o
 * cartão devia no **fim** de `openingBalanceDate`, então o que é datado até esse dia,
 * inclusive, já está dentro dela; do dia seguinte em diante, soma ou abate. No cadastro a
 * âncora fica na véspera (`planCardOpening`): a compra e o pagamento do dia do cadastro contam.
 *
 * É a regra única para compras e pagamentos — o devido, o valor e o "pago" de cada fatura, o
 * limite, o lembrete e a lista "de antes" da tela saem dela. Antes, o "pago" das faturas não a
 * seguia: o "Pagamento recebido" de 05/11 de um cartão informado em 07/11 aparecia como
 * pagamento antecipado e o lembrete o abatia (R$ 400 onde a tela e o banco diziam R$ 1.634,56).
 */
export const inInformedValue = (settings: Pick<CardSettings, 'openingBalanceDate'>, date: string): boolean =>
	date <= settings.openingBalanceDate;

/**
 * Quanto o cartão deve no fim de `asOf`: a âncora mais compras, menos estornos e
 * pagamentos, contando só o que é datado depois da âncora. Negativo é crédito.
 */
export const owedOn = (settings: CardSettings, entries: CardEntry[], movements: CardMovement[], asOf: string): number => {
	// `0 - x` e não `-x`: com âncora zero, `-0` vazaria para a tela e para comparações.
	let owed = 0 - settings.openingBalanceCents;
	for (const entry of entries) {
		if (!inInformedValue(settings, entry.date) && entry.date <= asOf) owed += signed(entry);
	}
	for (const movement of movements) {
		if (!inInformedValue(settings, movement.date) && movement.date <= asOf) {
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
		if (inInformedValue(settings, entry.date)) continue;
		total += signed(entry);
	}
	if (settings.openingBalanceDate >= cycle.start && settings.openingBalanceDate <= last) {
		total -= settings.openingBalanceCents;
	}
	return total + 0;
};

/**
 * O que uma fatura cobrou antes de estornos e créditos: compras, encargos e ajustes datados no
 * ciclo depois da âncora, mais a própria âncora quando ela é dívida e cai no ciclo. É o que
 * separa a fatura quitada ("Paga") da que não teve o que pagar ("fechada"), ver `invoiceStatusOf`.
 */
const invoiceDebits = (cycle: InvoiceCycle, settings: CardSettings, entries: CardEntry[]): number => {
	let total = 0;
	for (const entry of entries) {
		if (entry.isIncome || entry.date < cycle.start || entry.date > cycle.end) continue;
		if (inInformedValue(settings, entry.date)) continue;
		total += entry.amountCents;
	}
	if (settings.openingBalanceDate >= cycle.start && settings.openingBalanceDate <= cycle.end) {
		total += Math.max(0, 0 - settings.openingBalanceCents);
	}
	return total;
};

/** A chave `YYYY-MM` da fatura `delta` meses depois de `key`. */
const shiftKey = (key: string, delta: number): string => {
	const [year, month] = key.split('-').map(Number);
	const [ty, tm] = shiftYearMonth(year, month, delta);
	return `${ty}-${pad(tm)}`;
};

/**
 * O crédito que chega a cada fatura vindo das anteriores: devolve uma função da chave
 * (`YYYY-MM`) da fatura para esse crédito.
 *
 * Fatura negativa — estorno maior que as compras do ciclo, ou "fatura atual" informada
 * como crédito — não some. O banco leva o que sobra para a fatura seguinte, e dela para a
 * próxima, até acabar; aqui é igual. Anda as faturas em ordem desde a primeira com valor,
 * e cada uma consome o crédito que chegou até o valor dela. Estornar uma compra parcelada
 * inteira faz, assim, as parcelas seguintes não cobrarem nada.
 *
 * O estorno não é ligado à compra que ele devolve: o lançamento não guarda esse vínculo, e
 * adivinhá-lo pelo valor erraria. O crédito é do cartão, como no banco, e vai para as
 * próximas faturas em ordem.
 *
 * Pagamentos não entram: pagar a mais é tratado onde os pagamentos são lidos.
 */
export const carriedCredit = (settings: CardSettings, entries: CardEntry[], rule: CycleRule): ((key: string) => number) => {
	// O mesmo valor de `invoiceAmount`, somado de uma vez por fatura.
	const amounts = new Map<string, number>();
	const add = (key: string, cents: number) => amounts.set(key, (amounts.get(key) ?? 0) + cents);
	for (const entry of entries) {
		if (entry.date > settings.openingBalanceDate) add(cycleFor(entry.date, rule).key, signed(entry));
	}
	if (settings.openingBalanceCents !== 0) add(cycleFor(settings.openingBalanceDate, rule).key, 0 - settings.openingBalanceCents);

	// Data torta (sem `YYYY-MM-DD`) daria uma chave que nunca é alcançada e o laço não pararia.
	const keys = [...amounts.keys()].filter((key) => /^\d{4}-\d{2}$/.test(key)).sort();
	const first = keys[0];
	const into = new Map<string, number>();
	let credit = 0;
	if (first !== undefined) {
		const last = keys[keys.length - 1];
		for (let key = first; key <= last; key = shiftKey(key, 1)) {
			into.set(key, credit);
			credit = Math.max(0, credit - (amounts.get(key) ?? 0));
		}
	}
	// Antes da primeira fatura com valor não há crédito; depois da última, sobra o que sobrou.
	return (key) => (first === undefined || key < first ? 0 : (into.get(key) ?? credit));
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
	 * ela é a fatura a pagar —, mais o que sobrou da janela das anteriores, até o que ela
	 * cobra. Na aberta, pagamentos antecipados feitos desde o começo dela e o que sobrou da
	 * fechada.
	 */
	paidCents: number;
	/**
	 * Crédito de faturas anteriores que esta consome (ver `carriedCredit`). `amountCents`
	 * continua sendo a soma dos lançamentos dela; o que ela cobra é a diferença.
	 */
	creditAppliedCents: number;
	/**
	 * O que ela cobrou antes de estornos e créditos (ver `invoiceDebits`). Com o saldo anterior,
	 * diz se havia o que pagar: a fatura coberta por estorno é "Paga"; a que só teve estorno, não.
	 */
	debitsCents: number;
	/**
	 * Só nas fechadas: o que as faturas anteriores deixaram sem pagar e veio para esta, como
	 * a linha "saldo anterior" da fatura do banco. Sem juros — o app não sabe deles. Zero
	 * quando a fatura é de antes da âncora: dali para trás o app não sabe o que foi pago.
	 */
	previousUnpaidCents: number;
	/**
	 * Só nas anteriores à fechada: o que ficou em aberto depois do vencimento e passou para a
	 * fatura seguinte (é o `previousUnpaidCents` dela).
	 */
	leftOpenCents: number;
	/**
	 * Pagamentos datados no ciclo desta fatura até a âncora: já estão no valor informado
	 * (`inInformedValue`) e não entram no `paidCents`. A tela os mostra com as compras de antes.
	 */
	coveredPayments: Array<{ date: string; amountCents: number }>;
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
	/**
	 * Crédito (pagamento a mais, estorno) que sobra depois de cobrir as parcelas futuras: as
	 * próximas faturas o consomem primeiro.
	 */
	creditCents: number;
	/** Compras já feitas que cairão em faturas futuras (parcelas), menos o crédito que as cobre. */
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
	// Os pagamentos que abatem fatura: os datados depois da âncora, como no devido. Os de antes
	// já estão no valor informado — contá-los no "pago" fazia um pagamento antecipado que não houve.
	const payments = movements.filter((movement) => movement.inbound && !inInformedValue(settings, movement.date));
	const paymentsBeforeAnchor = movements.filter((movement) => movement.inbound && inInformedValue(settings, movement.date));

	let futureSigned = 0;
	for (const entry of entries) {
		if (entry.date > today && entry.date > settings.openingBalanceDate) futureSigned += signed(entry);
	}
	const futureCents = Math.max(0, futureSigned);
	// O crédito de hoje vai para as próximas faturas, que são justamente as que têm as parcelas
	// futuras: estornar a compra parcelada inteira deixa R$ 0 comprometido, e não "R$ 1.100
	// comprometido e R$ 1.100 de crédito" — que somava como dívida no patrimônio.
	const absorbedCents = Math.min(Math.max(0, -owedNow), futureCents);
	const creditCents = Math.max(0, -owedNow) - absorbedCents;
	const futureCommittedCents = futureCents - absorbedCents;

	const limitUsedCents = Math.max(0, owedNow + futureCents);
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
	for (const movement of payments) {
		if (movement.date >= closedCycle.closingDate && movement.date <= today) {
			paidSinceClosingCents += movement.amountCents;
		}
	}

	const daysToDue = daysBetween(today, closedCycle.dueDate);

	const creditInto = carriedCredit(settings, entries, rule);
	const creditApplied = (cycle: InvoiceCycle, amountCents: number): number => Math.min(creditInto(cycle.key), Math.max(0, amountCents));

	// O saldo anterior de uma fatura fechada: o que o cartão devia na véspera do fechamento
	// dela menos o que é dela. Os pagamentos da janela da anterior — que é justamente o ciclo
	// desta — já estão descontados, então é o que a anterior deixou sem pagar. Antes da âncora
	// o devido não quer dizer nada (seria a própria âncora), e aí é zero.
	const previousUnpaid = (cycle: InvoiceCycle, offset: number): number => {
		if (offset > -1 || cycle.end < settings.openingBalanceDate) return 0;
		return Math.max(0, owedOn(settings, entries, movements, cycle.end) - invoiceAmount(cycle, settings, entries));
	};

	// Nada a pagar e havia o que pagar — compra, encargo ou saldo anterior, mesmo que o estorno
	// tenha coberto (SPD-125): paga. Antes contava só a fechada com valor positivo, e a de R$ 100
	// de compra com R$ 300 de estorno ficava sem status, como se não tivesse tido nada.
	let closedStatus: ClosedInvoiceStatus;
	if (toPayCents === 0) {
		const charged = invoiceDebits(closedCycle, settings, entries) + previousUnpaid(closedCycle, -1) > 0;
		closedStatus = charged ? 'paid' : 'none';
	} else if (daysToDue < 0) closedStatus = 'overdue';
	else if (daysToDue <= DUE_SOON_DAYS) closedStatus = 'due_soon';
	else closedStatus = 'due';

	// O pagamento que sobrou das janelas anteriores e chega a uma fatura fechada: o espelho do
	// saldo anterior. O devido na véspera do fechamento menos o que é dela, quando negativo, é
	// o que foi pago a mais antes dela — tirado o crédito de estorno, que `carriedCredit` já
	// leva. É o caso do pagamento feito depois da âncora e antes do fechamento, com a fatura
	// anterior zerada (SPD-120, DEC-37): ele cai na janela da anterior, que não cobra nada, e
	// abatia o devido sem a fatura seguinte aparecer paga. Sai do mesmo `owedOn` do "a pagar",
	// do saldo anterior e do lembrete: um número só. Antes da âncora é zero, como o saldo anterior.
	const paidFromBefore = (cycle: InvoiceCycle): number => {
		if (cycle.end < settings.openingBalanceDate) return 0;
		const before = invoiceAmount(cycle, settings, entries) - owedOn(settings, entries, movements, cycle.end);
		return Math.max(0, before - creditInto(cycle.key));
	};

	// O pagamento feito na janela de uma fatura — mais o que sobrou das anteriores — quita ela
	// até o que ela cobra: o valor dela mais o saldo anterior que veio junto; o que sobra da
	// janela da fechada é pagamento antecipado da aberta. Da fechada conta o que ela cobra: o
	// crédito de faturas anteriores já abateu parte. Sem o saldo anterior aqui, pagar R$ 800
	// numa fechada de R$ 300 com R$ 500 de saldo anterior mostrava R$ 500 de "pagamento
	// antecipado" que não houve.
	const closedWindowPaid = paymentsBetween(payments, closedCycle.closingDate, openCycle.closingDate) + paidFromBefore(closedCycle);
	const closedChargedCents =
		Math.max(0, closedInvoiceCents) - creditApplied(closedCycle, closedInvoiceCents) + previousUnpaid(closedCycle, -1);
	const invoicePaidCents = (cycle: InvoiceCycle, offset: number, amountCents: number, previousCents: number): number => {
		if (offset > 0) return 0;
		if (offset === 0) return Math.max(0, closedWindowPaid - closedChargedCents);
		const window =
			offset === -1
				? closedWindowPaid
				: paymentsBetween(payments, cycle.closingDate, shiftCycle(cycle, 1, rule).closingDate) + paidFromBefore(cycle);
		return Math.min(window, Math.max(0, amountCents) + previousCents);
	};

	const invoices: InvoiceView[] = [];
	// Da mais nova para a mais antiga: o que uma fatura deixou em aberto é o saldo anterior da seguinte.
	let nextPreviousUnpaid = 0;
	for (let offset = FUTURE_INVOICES; offset >= -PAST_INVOICES; offset -= 1) {
		const cycle = shiftCycle(openCycle, offset, rule);
		const amountCents = invoiceAmount(cycle, settings, entries);
		const previousUnpaidCents = previousUnpaid(cycle, offset);
		const leftOpenCents = offset < -1 ? nextPreviousUnpaid : 0;
		nextPreviousUnpaid = previousUnpaidCents;
		const paidCents = invoicePaidCents(cycle, offset, amountCents, previousUnpaidCents);
		const coveredPayments = paymentsBeforeAnchor
			.filter((movement) => movement.date >= cycle.start && movement.date <= cycle.end)
			.map((movement) => ({ date: movement.date, amountCents: movement.amountCents }));
		if (offset < -1 && amountCents === 0 && paidCents === 0 && previousUnpaidCents === 0 && leftOpenCents === 0) continue;
		if (offset > 0 && amountCents === 0) continue;
		invoices.unshift({
			cycle,
			amountCents,
			offset,
			paidCents,
			creditAppliedCents: creditApplied(cycle, amountCents),
			debitsCents: invoiceDebits(cycle, settings, entries),
			previousUnpaidCents,
			leftOpenCents,
			coveredPayments,
		});
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

/**
 * Diferença de data que ainda pode ser o mesmo pagamento visto duas vezes. É também a do
 * "provável repetido" entre lançamentos do cartão (`utils/cardDuplicates.ts`).
 */
export const SAME_PAYMENT_DAYS = 1;

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
 * As faturas que o cadastro do cartão pergunta hoje. A aberta sempre; a fechada só entre o
 * fechamento e o vencimento dela — é quando o app do banco mostra em destaque uma fatura
 * fechada a pagar, e quem copia esse número para "a fatura atual" o punha na fatura errada.
 * Depois do vencimento a fechada já foi paga (ou é atraso, para o "Acertar valor").
 */
export const invoicesToInform = (rule: CycleRule, today: string): { open: InvoiceCycle; closed: InvoiceCycle | null } => {
	const open = cycleFor(today, rule);
	const closed = shiftCycle(open, -1, rule);
	return { open, closed: today <= closed.dueDate ? closed : null };
};

/**
 * A fatura informada no **cadastro** do cartão, do jeito que a conta corrente faz com o
 * saldo: a aberta vira a **âncora** na véspera, e nenhum lançamento. Tudo até ontem já está
 * no valor informado; o que entra de hoje em diante soma. Antes ela virava um lançamento de
 * ajuste datado hoje, que aparecia como compra do mês e saída em Lançamentos (E2E-06).
 *
 * Quando a âncora não dá conta, vale o "Acertar valor" (`planCardAdjustment`):
 *
 * - com a fechada informada (hoje está entre o fechamento e o vencimento), a âncora é dela,
 *   na véspera do fechamento, e a aberta entra como ajuste — a âncora é um ponto só;
 * - no dia do fechamento a véspera é da fatura fechada: ancorar ali poria a aberta nela;
 * - sem dia de fechamento, a âncora já é a véspera de hoje.
 *
 * O que já está no ciclo aberto (o conserto pode ter trazido compras do cartão que caíram na
 * conta corrente) entra na conta: datado até ontem, está dentro do valor; de hoje, soma — e a
 * âncora desconta, para a fatura dar o informado.
 */
export const planCardOpening = (
	settings: CardSettings,
	entries: CardEntry[],
	movements: CardMovement[],
	today: string,
	openTypedCents: number | null,
	closedTypedCents: number | null
): CardAdjustmentPlan => {
	const rule = cycleRuleOf(settings);
	if (rule === null || closedTypedCents !== null) {
		return planCardAdjustment(settings, entries, movements, today, openTypedCents, closedTypedCents);
	}
	if (openTypedCents === null) return { anchor: null, adjustmentCents: 0 };
	const open = cycleFor(today, rule);
	const yesterday = addDays(today, -1);
	if (yesterday < open.start) return planCardAdjustment(settings, entries, movements, today, openTypedCents, null);
	const fromToday = invoiceAmount(open, { ...settings, openingBalanceCents: 0, openingBalanceDate: yesterday }, entries);
	return { anchor: { date: yesterday, cents: 0 - (openTypedCents - fromToday) }, adjustmentCents: 0 };
};

// ---------------------------------------------------------------------------
// Encargos
// ---------------------------------------------------------------------------

/**
 * O que a folha "Acertar valor" mostra em cada fatura, e onde um encargo da fechada caberia.
 * A pergunta "a diferença é juros?" compara o número do banco com **isto** — o que o dono
 * viu —, e o `AccountsContext` recalcula o mesmo na hora de gravar.
 */
export interface CardChargeShown {
	/** A fatura aberta (sem fechamento: o devido), nunca abaixo de zero — a folha mostra o campo em branco. */
	openCents: number;
	/** O que falta pagar da fechada; zero sem fechamento. */
	closedCents: number;
	/**
	 * Onde o encargo da fechada entra: a véspera do fechamento dela, o último dia do ciclo.
	 * Nulo quando não dá:
	 *
	 * - a âncora está nesse dia ou depois — o que é datado até a âncora já está dentro dela e
	 *   o encargo não somaria (o cartão cadastrado na janela, com a fechada informada);
	 * - nada falta pagar da fechada: o "a pagar" é o devido menos a aberta, cortado em zero, e
	 *   com crédito no meio o encargo não daria o número do banco.
	 *
	 * Nesses casos a fechada é acertada pela âncora, como antes, e a diferença não aparece
	 * como encargo.
	 */
	closedChargeDate: string | null;
}

export const cardChargeShown = (
	settings: Pick<CardSettings, 'openingBalanceDate'>,
	summary: Pick<CardSummary, 'configured' | 'openInvoiceCents' | 'owedCents' | 'toPayCents' | 'closedCycle'>
): CardChargeShown => {
	if (!summary.configured || summary.closedCycle === null) {
		return { openCents: Math.max(0, summary.owedCents), closedCents: 0, closedChargeDate: null };
	}
	const closedEnd = summary.closedCycle.end;
	return {
		openCents: Math.max(0, summary.openInvoiceCents),
		closedCents: summary.toPayCents,
		closedChargeDate: closedEnd > settings.openingBalanceDate && summary.toPayCents > 0 ? closedEnd : null,
	};
};

export interface CardChargeSplit {
	/** O que segue para o `planCardAdjustment` de sempre, já sem os encargos. */
	openCents: number | null;
	closedCents: number | null;
	/** Os encargos a lançar, cada um na data que o põe na fatura certa: a fechada antes. */
	charges: Array<{ date: string; cents: number }>;
	/** A soma, para a pergunta. Zero: não há o que perguntar. */
	totalCents: number;
}

/**
 * "Acertar valor" com a diferença para o banco como encargo (decisão do usuário, E2E-20):
 * quando o banco mostra **mais** do que o app numa fatura, o que passa vira um encargo
 * (`bank`) naquela fatura; o resto segue o acerto de sempre. Banco menor, igual ou fatura
 * não informada: nada muda — é ajuste, como hoje.
 *
 * - Aberta: o encargo é de hoje (está no ciclo aberto) e a aberta vai para o acerto com o
 *   valor que o app já mostrava. Se o acerto mexe na âncora (a fechada informada), o ajuste
 *   devolve o que a mudança tirar — e o encargo soma por cima.
 * - Fechada: o encargo vai para a véspera do fechamento dela (`closedChargeDate`) e a
 *   fechada **não** é ancorada de novo: com o encargo ela já dá o número do banco, e as
 *   faturas de antes continuam como estavam (o "saldo anterior não pago" inclusive). Sem
 *   onde pôr o encargo, a fechada vai inteira para a âncora.
 *
 * A pergunta é uma só, pela soma: quem acerta as duas responde de uma vez.
 */
export const splitCardCharges = (
	shown: CardChargeShown,
	today: string,
	openTypedCents: number | null,
	closedTypedCents: number | null
): CardChargeSplit => {
	const charges: Array<{ date: string; cents: number }> = [];
	let closedCents = closedTypedCents;
	if (closedTypedCents !== null && shown.closedChargeDate !== null && closedTypedCents > shown.closedCents) {
		charges.push({ date: shown.closedChargeDate, cents: closedTypedCents - shown.closedCents });
		closedCents = null;
	}
	let openCents = openTypedCents;
	if (openTypedCents !== null && openTypedCents > shown.openCents) {
		charges.push({ date: today, cents: openTypedCents - shown.openCents });
		openCents = shown.openCents;
	}
	return { openCents, closedCents, charges, totalCents: charges.reduce((sum, item) => sum + item.cents, 0) };
};

/**
 * Os meses que a folha "Registrar encargo" oferece: dois para trás (o encargo que o dono só
 * viu agora na fatura fechada), o atual e o seguinte (a anuidade que já vem anunciada).
 */
export const chargeMonthOptions = (today: string): string[] => {
	const [year, month] = today.split('-').map(Number);
	return [-2, -1, 0, 1].map((delta) => {
		const [ty, tm] = shiftYearMonth(year, month, delta);
		return `${ty}-${pad(tm)}`;
	});
};

/**
 * A data do encargo: o dia escolhido no mês (`YYYY-MM`). Nula quando o dia não existe no
 * mês — 30 de fevereiro não vira 28 calado, o dono corrige. A fatura é a do ciclo da data
 * (`cycleFor`): a anuidade de 15/11 num cartão que fecha dia 10 é da fatura de dezembro.
 */
export const cardChargeDate = (monthKey: string, day: number): string | null => {
	const [year, month] = monthKey.split('-').map(Number);
	if (!Number.isInteger(day) || day < 1 || day > lastDayOfMonth(year, month)) return null;
	return `${monthKey}-${pad(day)}`;
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
 * da lista.
 *
 * **Fatura aberta já informada** (`currentCovered`, ver `openInvoiceInformed`): o valor que o
 * dono copiou do banco já traz a parcela atual — a 2/5 que a fatura do banco mostra. Ela
 * não é criada de novo: entram só as seguintes, a partir da próxima fatura. Antes, a 2/5
 * caía no dia seguinte à âncora e somava R$ 300 em cima dos R$ 1.234,56 informados.
 */
export const existingInstallmentDates = (
	currentIndex: number,
	totalCount: number,
	rule: CycleRule | null,
	today: string,
	/** `openingBalanceDate` do cartão: a âncora que já engoliu tudo até ela. */
	anchorDate: string,
	/** A parcela atual já está no valor informado da fatura aberta: não criar. */
	currentCovered = false
): Array<{ index: number; date: string }> => {
	const dates: Array<{ index: number; date: string }> = [];
	if (currentIndex < 1 || totalCount < currentIndex) return dates;
	const fromIndex = currentCovered ? currentIndex + 1 : currentIndex;

	const firstCounted = addDays(anchorDate, 1);
	if (rule === null) {
		for (let index = fromIndex; index <= totalCount; index += 1) {
			const naive = addMonthsClamped(today, index - currentIndex);
			dates.push({ index, date: naive > firstCounted ? naive : firstCounted });
		}
		return dates;
	}

	const open = cycleFor(today, rule);
	const first = open.start > firstCounted ? open.start : firstCounted;
	// As seguintes saem da fatura em que a atual caiu, e não do ciclo aberto: se o piso da
	// âncora empurrou a atual para a fatura seguinte, as outras andam junto — uma por
	// fatura, sem duas na mesma. A atual já informada está na aberta, então as seguintes
	// saem dela.
	const firstCycle = currentCovered ? open : cycleFor(first, rule);
	for (let index = fromIndex; index <= totalCount; index += 1) {
		const offset = index - currentIndex;
		dates.push({ index, date: offset === 0 ? first : shiftCycle(firstCycle, offset, rule).start });
	}
	return dates;
};

/**
 * A fatura aberta já tem o valor que o banco mostra? É o que decide se a parcela atual de
 * uma compra antiga já está nela (`existingInstallmentDates`) e se as compras de antes da
 * âncora estão "no valor informado".
 *
 * Duas formas de ter sido informada: a âncora com valor dentro do ciclo aberto (o cadastro
 * de hoje, `planCardOpening`) ou um ajuste datado nele (o "Acertar valor", e o cadastro de
 * antes desta versão, que deixava a âncora em zero e lançava o ajuste). Âncora zero sem
 * ajuste é cartão cadastrado sem a fatura: o app não sabe de nada que estava nela.
 *
 * O encargo que o "Acertar valor" lançou com a diferença (`bank`) também é acerto com o
 * banco e conta; o registrado à mão (uma anuidade) não diz nada do resto da fatura.
 *
 * Limite: quem informou exatamente o que o app já tinha não gera ajuste, e aí a fatura
 * conta como não informada.
 */
export const openInvoiceInformed = (settings: CardSettings, entries: CardEntry[], today: string): boolean => {
	const rule = cycleRuleOf(settings);
	// Sem fechamento não há ciclo: vale a âncora com valor do último mês, que é a fatura que
	// o dono tinha na tela quando a informou.
	if (rule === null) return settings.openingBalanceCents !== 0 && settings.openingBalanceDate > addMonthsClamped(today, -1);
	const open = cycleFor(today, rule);
	const inOpen = (date: string) => date >= open.start && date <= open.end;
	if (settings.openingBalanceCents !== 0 && inOpen(settings.openingBalanceDate)) return true;
	const fromBank = (entry: CardEntry) => isCardAdjustment(entry) || (isCardCharge(entry) && cardChargeKindOf(entry.note) === 'bank');
	return entries.some((entry) => fromBank(entry) && inOpen(entry.date) && entry.date > settings.openingBalanceDate);
};

/** O que o chip de uma fatura diz. As datas saem do próprio ciclo. */
export type InvoiceStatus =
	| { kind: 'open' }
	| { kind: 'future' }
	/** A fechada, depois do vencimento, com o que falta pagar. */
	| { kind: 'overdue'; amountCents: number }
	/** A fechada, antes do vencimento, com o que falta pagar. */
	| { kind: 'toPay'; amountCents: number }
	| { kind: 'paid' }
	/** Fechada sem nada a pagar, com o vencimento ainda por vir: "vence", nunca "venceu". */
	| { kind: 'closedUpcoming' }
	| { kind: 'closedPast' }
	/** Venceu sem ser paga inteira: o que ficou foi para a fatura seguinte. */
	| { kind: 'leftOpen'; amountCents: number };

/**
 * O estado de uma fatura para o chip dela. Antes, a fechada sem valor dizia "venceu 12/11"
 * no dia 07/11, e a que ficou em aberto e já passou para a seguinte dizia só "venceu".
 *
 * Paga é a fatura que tinha o que pagar — compra, encargo, valor informado ou saldo anterior
 * (`debitsCents`, `previousUnpaidCents`) — e não deixa nada: pagamentos, estornos e o crédito
 * que veio das anteriores cobriram tudo (SPD-125). Antes a regra olhava o valor com o saldo
 * anterior, sem o crédito: a fatura de R$ 100 de compra e R$ 300 de estorno, ou a de R$ 500
 * coberta por R$ 200 de crédito e R$ 300 de pagamento, dizia "fechada" sem nada a pagar. A que
 * só teve estorno não cobrou nada e segue "fechada". O que falta pagar é o mesmo de
 * `invoiceDueCents`, do lembrete e dos Relatórios.
 */
export const invoiceStatusOf = (invoice: InvoiceView, summary: CardSummary, today: string): InvoiceStatus => {
	if (invoice.offset === 0) return { kind: 'open' };
	if (invoice.offset > 0) return { kind: 'future' };
	const hadCharges = invoice.debitsCents + invoice.previousUnpaidCents > 0;
	if (invoice.offset === -1) {
		if (summary.closedStatus === 'overdue') return { kind: 'overdue', amountCents: summary.toPayCents };
		if (summary.toPayCents > 0) return { kind: 'toPay', amountCents: summary.toPayCents };
		if (hadCharges) return { kind: 'paid' };
		return invoice.cycle.dueDate >= today ? { kind: 'closedUpcoming' } : { kind: 'closedPast' };
	}
	if (invoice.leftOpenCents > 0) return { kind: 'leftOpen', amountCents: invoice.leftOpenCents };
	// O que ela cobrava: o valor menos o crédito das anteriores, mais o saldo anterior. Valor
	// negativo (estorno maior que as compras) abate o saldo anterior, como na fatura do banco.
	const chargedCents = Math.max(0, invoice.amountCents - invoice.creditAppliedCents + invoice.previousUnpaidCents);
	if (hadCharges && invoice.paidCents >= chargedCents) return { kind: 'paid' };
	return { kind: 'closedPast' };
};

/**
 * O que falta pagar de uma fatura: o número do lembrete (`cardReminders`), que tem de bater
 * com o da tela e o do banco.
 *
 * - A fechada: o "a pagar" do resumo (`toPayCents`) — o devido menos o que já caiu na aberta.
 * - A aberta e as futuras: o valor menos o crédito que chegou das anteriores e o pagamento
 *   antecipado (`paidCents`), nunca abaixo de zero.
 * - As anteriores à fechada: zero — o que ficou delas já está no saldo anterior da fechada.
 *
 * Os pagamentos são os de `buildCardSummary`: o datado até a âncora já está no valor informado
 * (`inInformedValue`) e não abate aqui.
 */
export const invoiceDueCents = (invoice: InvoiceView, summary: Pick<CardSummary, 'toPayCents'>): number => {
	if (invoice.offset === -1) return summary.toPayCents;
	if (invoice.offset < -1) return 0;
	return Math.max(0, invoice.amountCents - invoice.creditAppliedCents - invoice.paidCents);
};

/**
 * A fatura do mês para o quadro "Este mês": as faturas que **fecham** entre `startDate`
 * e `endDate` — a de setembro fecha em setembro e é paga logo depois. Inclui parcelas e
 * a "fatura atual" informada. Nulo quando o cartão não tem fechamento; aí quem chama usa
 * as compras datadas no período.
 *
 * Cada fatura entra pelo que **cobra**: o valor menos o crédito que chegou das anteriores
 * (`carriedCredit`), nunca abaixo de zero. A fatura negativa conta 0 no mês dela e o
 * crédito abate as seguintes — somando os meses, dá compras menos estornos. Antes, o
 * negativo virava 0 no quadro e o estorno sumia, e a compra parcelada estornada seguia
 * cobrando parcela todo mês.
 */
export const invoicesClosingBetween = (
	settings: CardSettings,
	entries: CardEntry[],
	startDate: string,
	endDate: string
): number | null => {
	const rule = cycleRuleOf(settings);
	if (rule === null) return null;

	const creditInto = carriedCredit(settings, entries, rule);
	let total = 0;
	// Um ciclo antes: `cycleFor` devolve a fatura que fecha *depois* da data, e a que fecha
	// exatamente em `startDate` (fechamento dia 1) também é deste período.
	let cycle = shiftCycle(cycleFor(startDate, rule), -1, rule);
	while (cycle.closingDate <= endDate) {
		if (cycle.closingDate >= startDate) total += Math.max(0, invoiceAmount(cycle, settings, entries) - creditInto(cycle.key));
		cycle = shiftCycle(cycle, 1, rule);
	}
	return total + 0;
};

export default {
	cardInstallmentDates,
	cardChargeDate,
	cardChargeKindOf,
	cardChargeNote,
	cardChargeShown,
	chargeMonthOptions,
	isCardAdjustment,
	isCardCharge,
	isCardNonPurchase,
	isSameCardPayment,
	splitCardCharges,
	inInformedValue,
	invoiceDueCents,
	invoiceStatusOf,
	invoicesToInform,
	openInvoiceInformed,
	pickOpenCardPayment,
	planCardAdjustment,
	planCardOpening,
	cycleRuleOf,
	cycleFor,
	invoiceClosingIn,
	invoicesClosingBetween,
	shiftCycle,
	owedOn,
	invoiceAmount,
	buildCardSummary,
	buildInstallmentPlans,
	carriedCredit,
	existingInstallmentDates,
	invoiceMonthOf,
	daysBetween,
};
