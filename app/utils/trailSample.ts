/**
 * O modo exemplo das trilhas (SPD-147): quando o usuário ainda não tem o registro que uma
 * trilha explica (um cartão, uma dívida, uma conta, um lançamento), o guia abre a tela com um
 * registro de exemplo, só em memória, para cada passo apontar o elemento certo — em vez de
 * pular o passo ou mostrar o texto sem apontar.
 *
 * O exemplo nunca passa pelos contextos que gravam: não vai para o SQLite, não fica sujo para
 * o sync, não entra em backup, totais, Patrimônio, relatórios, lembretes nem notificações. Ele
 * existe só como objeto montado aqui, na hora em que a tela de exemplo desenha, e só enquanto
 * a trilha está aberta (`components/tour/TrailSample.tsx`). Fechar o app no meio leva junto:
 * não há nada guardado.
 *
 * Como chega à tela: o plano da trilha (`planTrail`) recebe `TRAIL_SAMPLE_RECORDS` e, quando
 * a lista do usuário está vazia, abre a tela com o id de exemplo (`/cards/exemplo-cartao`) ou,
 * nos formulários de cadastro, com `exemplo=1`. A tela reconhece o id (`isSampleId`) e desenha
 * o exemplo, marcado "Exemplo", com os botões de gravar sem efeito. A revisão da captura
 * (SPD-159) não tem id na rota: com o exemplo ligado e a fila vazia, ela desenha os avisos de
 * `sampleCaptures`, com os mesmos botões sem efeito.
 *
 * Os valores são inventados e redondos; os nomes vêm traduzidos de quem chama (`names`).
 */

import type { Account, Capture, Debt, Transaction } from '../database/schema';
import { ambiguousReason } from './ambiguityReasons';
import { addDays } from './dateUtils';
import { impliedRateBp } from './debt';
import type { TrailRecords } from './trails';

/** Todo id de exemplo começa assim; nenhum id de verdade (UUID) começa. */
export const SAMPLE_PREFIX = 'exemplo-';

export const SAMPLE_IDS = {
	account: 'exemplo-conta',
	capturedAccount: 'exemplo-conta-captura',
	card: 'exemplo-cartao',
	cardNoClosing: 'exemplo-cartao-sem-fechamento',
	transaction: 'exemplo-lancamento',
	debt: 'exemplo-divida',
	capture: 'exemplo-aviso',
	captureDuplicate: 'exemplo-aviso-repetido',
	captureIncomplete: 'exemplo-aviso-incompleto',
	category: 'exemplo-categoria',
} as const;

/** O parâmetro da rota que abre um formulário de cadastro já preenchido com o exemplo. */
export const SAMPLE_FORM_PARAM = 'exemplo';

export const isSampleId = (id: unknown): id is string =>
	typeof id === 'string' && id.startsWith(SAMPLE_PREFIX);

/** O formulário de cadastro foi aberto pela trilha com o exemplo (`exemplo=1`). */
export const isSampleForm = (value: unknown): boolean => value === '1';

/**
 * Os registros de exemplo que o plano usa quando o usuário não tem nenhum daquele tipo. Só os
 * que a trilha abre numa tela própria; as condições (`otherCard`, `capture`) e os registros que
 * só existem com dados de verdade por trás (o débito, a conta ligada ao banco) ficam de fora: a
 * tela deles mostraria totais que o exemplo não pode ter.
 *
 * `pending` (SPD-159) é a exceção: a revisão não abre por registro (a rota não tem id) e o
 * exemplo dela não entra em total nenhum. Sem nada para revisar, a Trilha 7 anda pela revisão
 * de sempre (`{}`, sem parâmetro) com os passos dos avisos marcados `sample`, e a tela, com o
 * exemplo ligado e a fila vazia, desenha os avisos de exemplo (`sampleCaptures`).
 */
export const TRAIL_SAMPLE_RECORDS: TrailRecords = {
	account: [{ id: SAMPLE_IDS.account }],
	capturedAccount: [{ id: SAMPLE_IDS.capturedAccount }],
	card: [{ id: SAMPLE_IDS.card }],
	cardNoClosing: [{ id: SAMPLE_IDS.cardNoClosing }],
	transaction: [{ id: SAMPLE_IDS.transaction }],
	debt: [{ id: SAMPLE_IDS.debt }],
	pending: [{}],
};

/** Os nomes do exemplo, no idioma do app (`trails.sample.*`). */
export interface SampleNames {
	account: string;
	bank: string;
	card: string;
	debt: string;
	transaction: string;
}

const SAMPLE_COLOR = '#2B2F36';
/** O final do cartão de exemplo: não é de ninguém. */
export const SAMPLE_LAST4 = '0000';

/** Os números do exemplo, redondos. */
export const SAMPLE_VALUES = {
	accountOpeningCents: 100_000,
	cardLimitCents: 500_000,
	cardInvoiceCents: 50_000,
	cardClosingDay: 5,
	cardDueDay: 15,
	debtBalanceCents: 2_000_000,
	debtInstallmentCents: 100_000,
	debtRemaining: 24,
	debtTotal: 48,
	debtDueDay: 10,
	transactionCents: 10_000,
} as const;

const baseAccount = (today: string) => ({
	envelopeMonthlyCents: null,
	color: SAMPLE_COLOR,
	last4: null,
	network: null,
	closingDay: null,
	dueDay: null,
	closingDaysBefore: null,
	creditLimitCents: null,
	cardNames: null,
	yieldCdiBp: null,
	reservePurpose: null,
	packageName: null,
	accountKey: null,
	openingBalanceDate: addDays(today, -1),
	sortOrder: 0,
	archived: false,
	updatedAt: '',
});

/** A conta, o cartão ou a conta "criada pela captura" de exemplo; nulo para outro id. */
export const sampleAccount = (id: string, names: SampleNames, today: string): Account | null => {
	const base = baseAccount(today);
	switch (id) {
		case SAMPLE_IDS.account:
			return {
				...base,
				id,
				name: names.account,
				kind: 'checking',
				role: 'main',
				bankName: names.bank,
				openingBalanceCents: SAMPLE_VALUES.accountOpeningCents,
			};
		case SAMPLE_IDS.capturedAccount:
			// A assinatura da conta que a captura cria (`isBalanceNeverInformed`): ligada a um app,
			// sem extrato, saldo zero, nome igual ao do banco e na posição 0.
			return {
				...base,
				id,
				name: names.bank,
				kind: 'checking',
				role: 'main',
				bankName: names.bank,
				packageName: SAMPLE_PREFIX,
				openingBalanceCents: 0,
			};
		case SAMPLE_IDS.card:
		case SAMPLE_IDS.cardNoClosing: {
			const configured = id === SAMPLE_IDS.card;
			return {
				...base,
				id,
				name: names.card,
				kind: 'credit_card',
				role: 'card',
				bankName: names.bank,
				last4: SAMPLE_LAST4,
				network: 'visa',
				closingDay: configured ? SAMPLE_VALUES.cardClosingDay : null,
				dueDay: configured ? SAMPLE_VALUES.cardDueDay : null,
				closingDaysBefore: configured
					? SAMPLE_VALUES.cardDueDay - SAMPLE_VALUES.cardClosingDay
					: null,
				creditLimitCents: SAMPLE_VALUES.cardLimitCents,
				// A fatura informada no cadastro: a âncora negativa é o que o cartão deve.
				openingBalanceCents: configured ? -SAMPLE_VALUES.cardInvoiceCents : 0,
			};
		}
		default:
			return null;
	}
};

/** A dívida de exemplo: um financiamento Price, com a taxa que a parcela e o saldo dão. */
export const sampleDebt = (id: string, names: SampleNames, today: string): Debt | null => {
	if (id !== SAMPLE_IDS.debt) return null;
	const rateBp =
		impliedRateBp({
			system: 'price',
			balanceCents: SAMPLE_VALUES.debtBalanceCents,
			installmentCents: SAMPLE_VALUES.debtInstallmentCents,
			remaining: SAMPLE_VALUES.debtRemaining,
		}) ?? 0;
	return {
		id,
		name: names.debt,
		kind: 'financing',
		system: 'price',
		openingBalanceCents: SAMPLE_VALUES.debtBalanceCents,
		openingBalanceDate: today,
		installmentCents: SAMPLE_VALUES.debtInstallmentCents,
		remainingAtOpening: SAMPLE_VALUES.debtRemaining,
		installmentsTotal: SAMPLE_VALUES.debtTotal,
		dueDay: SAMPLE_VALUES.debtDueDay,
		rateBp,
		feeCents: 0,
		adminFeeBp: null,
		accountId: null,
		category: null,
		archived: false,
		sortOrder: 0,
		updatedAt: '',
	};
};

/** O lançamento de exemplo: uma despesa de hoje, sem conta e sem categoria. */
export const sampleTransaction = (
	id: string,
	names: SampleNames,
	today: string
): Transaction | null => {
	if (id !== SAMPLE_IDS.transaction) return null;
	return {
		id,
		amountCents: SAMPLE_VALUES.transactionCents,
		category: '',
		date: today,
		note: names.transaction,
		isIncome: false,
		accountId: null,
		installmentGroup: null,
		installmentIndex: null,
		installmentCount: null,
		cardLast4: null,
		updatedAt: '',
	};
};

/**
 * Os textos dos avisos de exemplo da revisão (SPD-159), no idioma do app (`trails.sample.*`):
 * os nomes e as notificações inventadas, no formato de um banco, já com o valor formatado.
 */
export interface SampleCaptureNames {
	/** O app do banco que mandou o aviso. */
	bank: string;
	/** A carteira do celular, que repete o aviso da compra (a pergunta "é o mesmo?"). */
	wallet: string;
	/** Onde foi a compra. */
	merchant: string;
	/** Onde foi a compra no crédito que não diz o cartão. */
	store: string;
	/** O título e o texto de cada notificação. */
	purchaseTitle: string;
	purchaseText: string;
	walletTitle: string;
	walletText: string;
	creditTitle: string;
	creditText: string;
}

/** Os valores dos avisos de exemplo, redondos, e há quantos minutos cada um chegou. */
export const SAMPLE_CAPTURE_VALUES = {
	purchaseCents: 10_000,
	creditCents: 5_000,
	purchaseMinutesAgo: 30,
	walletMinutesAgo: 29,
	creditMinutesAgo: 10,
} as const;

/** Nenhum app de verdade tem este pacote: o exemplo não casa regra, extrato nem app ignorado. */
const SAMPLE_PACKAGE = `${SAMPLE_PREFIX}app`;

const minutesBefore = (now: Date, minutes: number): string =>
	new Date(now.getTime() - minutes * 60_000).toISOString();

/**
 * Os avisos de exemplo da revisão (SPD-159), na ordem da tela:
 * 1. a compra de sempre, já na conta de exemplo: o aviso, a conta, a categoria, os três
 *    botões e a notificação original (passos 2 a 6);
 * 2. o mesmo valor, um minuto depois, pela carteira do celular: a pergunta "Parece o mesmo
 *    lançamento" (passo 7);
 * 3. a compra no crédito que não diz o cartão, sem conta: a linha que explica a dúvida
 *    (passo 8).
 *
 * Só objetos: quem desenha não grava, não soma e não sincroniza nada disto
 * (`components/tour/TrailSample.tsx`, `screens/CaptureInboxScreen.tsx`).
 */
export const sampleCaptures = (names: SampleCaptureNames, now: Date): Capture[] => {
	const base = {
		packageName: SAMPLE_PACKAGE,
		direction: 'out' as const,
		kind: 'purchase',
		merchantKey: null,
		cardLast4: null,
		status: 'pending' as const,
		question: null,
		relatedId: null,
		suggestedCategory: null,
		transactionId: null,
		autoConfirmed: false,
		reason: null,
		accountId: null,
		transferId: null,
		installments: null,
		createdAt: now.toISOString(),
		updatedAt: '',
	};
	return [
		{
			...base,
			id: SAMPLE_IDS.capture,
			fingerprint: SAMPLE_IDS.capture,
			appLabel: names.bank,
			title: names.purchaseTitle,
			text: names.purchaseText,
			postedAt: minutesBefore(now, SAMPLE_CAPTURE_VALUES.purchaseMinutesAgo),
			amountCents: SAMPLE_CAPTURE_VALUES.purchaseCents,
			counterparty: names.merchant,
			accountId: SAMPLE_IDS.account,
		},
		{
			...base,
			id: SAMPLE_IDS.captureDuplicate,
			fingerprint: SAMPLE_IDS.captureDuplicate,
			appLabel: names.wallet,
			title: names.walletTitle,
			text: names.walletText,
			postedAt: minutesBefore(now, SAMPLE_CAPTURE_VALUES.walletMinutesAgo),
			amountCents: SAMPLE_CAPTURE_VALUES.purchaseCents,
			counterparty: names.merchant,
			question: 'duplicate',
			relatedId: SAMPLE_IDS.capture,
			accountId: SAMPLE_IDS.account,
		},
		{
			...base,
			id: SAMPLE_IDS.captureIncomplete,
			fingerprint: SAMPLE_IDS.captureIncomplete,
			appLabel: names.bank,
			title: names.creditTitle,
			text: names.creditText,
			postedAt: minutesBefore(now, SAMPLE_CAPTURE_VALUES.creditMinutesAgo),
			amountCents: SAMPLE_CAPTURE_VALUES.creditCents,
			counterparty: names.store,
			reason: ambiguousReason('credit_no_last4'),
		},
	];
};
