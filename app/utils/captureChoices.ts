/**
 * Avisos ambíguos e as escolhas que o app aprende com eles (SPD-123).
 *
 * Há avisos que não dizem o bastante: para onde foi a compra (a conta, o cartão, qual
 * cartão), para que lado foi o Pix ("Fulano enviou"), de qual conta saiu o pagamento
 * da fatura que o cartão recebeu. Antes o app adivinhava, e às vezes errava sem ninguém ver.
 * Agora o aviso vai para a revisão com o motivo do caso (`ambiguityReasons.ts`), e a
 * resposta do usuário vira uma regra: na próxima vez que o **mesmo caso** aparecer, o app
 * aplica a escolha sozinho — e marca o item com o motivo `learned_<caso>`, para dar para ver
 * e desfazer. Corrigir atualiza a regra.
 *
 * A regra mora numa preferência (`captureChoicePreference.ts`): sobe no sync e vai no
 * backup, sem coluna nova nem mudança no servidor. Por isso a chave nunca leva texto do
 * aviso, nome de gente nem valor — só o banco (ou o app) que avisou, o tipo do caso, o final
 * do cartão quando o caso é dele, e, na dúvida de direção, as duas pistas que o parser
 * achou (palavras do vocabulário dele: "recebido/enviou"). O valor é o id da conta ou do
 * cartão escolhido, a direção, ou "não lançar".
 *
 * Puro: quem lê e grava a preferência é o `CapturesContext`, que repassa as regras para a
 * ingestão e o lugar de gravá-las para as respostas da revisão.
 */

import type { Account, Capture } from '../database/schema';
import { bankOfPackage } from '../diagnostics/knownBanks';
import { type AmbiguityCase, ambiguityOfReason, TARGET_CASES } from './ambiguityReasons';
import { brandFor } from './bankBrands';
import { type CaptureDirection, normalizeText, type ParsedCapture, parseCapture, type RawCapture } from './captureParser';
import { bankLabelOf, invoiceCardOf, pickNotificationTarget } from './notificationTarget';

export type { AmbiguityCase } from './ambiguityReasons';

/** As regras aprendidas: chave do caso → id da conta, direção (`in`/`out`) ou `skip`. */
export type CaptureChoices = Readonly<Record<string, string>>;

/** Onde as regras moram. O `CapturesContext` passa o da preferência; o teste, um em memória. */
export interface CaptureChoiceStore {
	read: () => Promise<CaptureChoices>;
	write: (next: CaptureChoices) => Promise<void>;
}

/** "Não lançar" o pagamento de fatura avisado pelo cartão (X-2). */
export const SKIP_CHOICE = 'skip';

/**
 * O teto do valor gravado. O servidor aceita 2.000 caracteres por preferência; a folga cobre
 * a troca de uma regra por outra maior sem o valor estourar no meio. Passando, as regras mais
 * antigas saem primeiro — a próxima vez que o caso delas aparecer, a revisão pergunta de novo.
 */
export const MAX_CHOICES_LENGTH = 1900;

/** O aviso como os campos que a chave usa: os da notificação, ou os da captura gravada. */
export type ChoiceNotice = Pick<RawCapture, 'packageName' | 'appLabel' | 'title' | 'text'> & {
	cardLast4: string | null;
};

/** Um aviso que o app não decide sozinho: o caso e a chave da regra dele. */
export interface Ambiguity {
	case: AmbiguityCase;
	key: string;
}

/**
 * O aviso como o resolvedor de contas o vê (`asBankApp`): o app de banco conhecido pelo
 * pacote avisa com o nome do banco, diga o aparelho o que disser.
 */
const asBankNotice = <T extends Pick<RawCapture, 'packageName' | 'appLabel'>>(raw: T): T => {
	const bank = bankOfPackage(raw.packageName);
	return bank && !brandFor(raw.appLabel) ? { ...raw, appLabel: bank } : raw;
};

/**
 * O banco que avisou, pelo nome da marca ("nubank", "inter"), ou o pacote do app quando o
 * banco não é reconhecido. O mesmo banco pelo app, por SMS ou pela carteira é a mesma regra.
 */
const sourceOf = (notice: ChoiceNotice): string => {
	const label = bankLabelOf(asBankNotice(notice));
	if (!label) return notice.packageName;
	return normalizeText(brandFor(label)?.name ?? label).replace(/[^a-z0-9]+/g, '');
};

/** As duas pistas da direção que o parser achou no texto (`ambiguousDirection`). */
const directionCueOf = (notice: ChoiceNotice): string | null =>
	parseCapture({ ...notice, postedAt: '' })?.ambiguousDirection ?? null;

/** Os casos em que o final do cartão é a pergunta: cada final é um caso. */
const KEYED_BY_FINAL: readonly AmbiguityCase[] = ['credit_unknown_last4', 'purchase_no_kind', 'debit_unknown_last4'];

/**
 * A chave da regra de um caso: `banco|caso`, mais o final ou as pistas da direção. Sai igual
 * da notificação, na ingestão, e da captura gravada, na revisão.
 */
export const choiceKeyOf = (notice: ChoiceNotice, ambiguity: AmbiguityCase): string => {
	const parts = [sourceOf(notice), ambiguity];
	if (KEYED_BY_FINAL.includes(ambiguity) && notice.cardLast4) parts.push(notice.cardLast4);
	if (ambiguity === 'pix_direction') parts.push(directionCueOf(notice) ?? '');
	return parts.join('|');
};

/**
 * O pagamento da fatura visto pelo cartão: "Recebemos o pagamento", "pagamento recebido". O
 * cartão sabe que recebeu, não de onde veio — pode ter sido pago por outro banco (X-2). Visto
 * pela conta ("você pagou", "debitado") a origem é quem avisou, e segue automático.
 */
const isReceivedInvoicePayment = (raw: Pick<RawCapture, 'title' | 'text'>): boolean => {
	const text = ` ${normalizeText(`${raw.title} ${raw.text}`)} `;
	const received = ['recebemos', 'recebido', 'recebida'].some((cue) => text.includes(cue));
	const paidHere = ['voce pagou', 'debitad', 'sua conta'].some((cue) => text.includes(cue));
	return received && !paidHere;
};

/**
 * O aviso é um dos casos em que o app não decide sozinho? A dúvida de destino vem de
 * `pickNotificationTarget`, a de direção do parser, a do pagamento da fatura do texto.
 */
export const detectAmbiguity = (accounts: Account[], raw: RawCapture, parsed: ParsedCapture): Ambiguity | null => {
	const notice: ChoiceNotice = { ...raw, cardLast4: parsed.cardLast4 };
	const found = (ambiguity: AmbiguityCase): Ambiguity => ({ case: ambiguity, key: choiceKeyOf(notice, ambiguity) });

	if (parsed.kind === 'invoice_payment' && isReceivedInvoicePayment(raw)) return found('invoice_payment');
	if (parsed.ambiguousDirection) return found('pix_direction');
	const target = pickNotificationTarget(accounts, { ...asBankNotice(notice), kind: parsed.kind });
	return target.type === 'unknown' && target.ambiguity ? found(target.ambiguity.case) : null;
};

/** O cartão que recebeu o pagamento de fatura avisado por ele (X-2), visto como o resolvedor vê o aviso. */
export const invoiceCardFor = (accounts: Account[], notice: ChoiceNotice): Account | null =>
	invoiceCardOf(accounts, asBankNotice(notice));

/** O que a regra aprendida diz para um aviso ambíguo. */
export type ChoiceLookup =
	/** Não há regra: a revisão pergunta. */
	| { state: 'none' }
	/** Havia, mas a conta dela sumiu (apagada, arquivada, juntada) ou o valor não serve. */
	| { state: 'stale' }
	| { state: 'applied'; account: Account }
	| { state: 'applied'; direction: CaptureDirection }
	| { state: 'applied'; skip: true };

/** A conta da regra, se ainda serve: viva e sem arquivar (quem juntou cartões apagou um). */
const liveAccount = (accounts: Account[], id: string): Account | null =>
	accounts.find((account) => account.id === id && !account.deletedAt && !account.archived) ?? null;

export const lookupChoice = (choices: CaptureChoices, ambiguity: Ambiguity, accounts: Account[]): ChoiceLookup => {
	const value = choices[ambiguity.key];
	if (value === undefined) return { state: 'none' };

	if (ambiguity.case === 'pix_direction') {
		return value === 'in' || value === 'out' ? { state: 'applied', direction: value } : { state: 'stale' };
	}
	if (ambiguity.case === 'invoice_payment') {
		if (value === SKIP_CHOICE) return { state: 'applied', skip: true };
		// O pagamento sai de uma conta; um cartão não paga a fatura de outro.
		const from = liveAccount(accounts, value);
		return from && from.kind !== 'credit_card' ? { state: 'applied', account: from } : { state: 'stale' };
	}
	const account = TARGET_CASES.includes(ambiguity.case) ? liveAccount(accounts, value) : null;
	return account ? { state: 'applied', account } : { state: 'stale' };
};

/**
 * A direção do item ainda é o palpite do parser (SPD-162)? É, no aviso que perguntou "entrou
 * ou saiu" (`ambiguous_pix_direction`) enquanto a escolha guardada para o caso dele não for a
 * direção que está no item: responder grava as duas juntas (`answerCaptureDirection`). Sem
 * escolha, ou com outra (o usuário respondeu diferente num aviso igual depois), a pergunta
 * vale de novo. O item que a regra aprendida decidiu (`learned_`) não é palpite.
 *
 * Com o palpite, nenhuma ação da revisão grava: a saída chutada virava gasto, ou uma
 * transferência que saía da conta que tinha recebido o dinheiro.
 */
export const isDirectionGuess = (
	capture: ChoiceNotice & Pick<Capture, 'reason' | 'direction'>,
	choices: CaptureChoices
): boolean => {
	const ambiguity = ambiguityOfReason(capture.reason);
	if (ambiguity?.case !== 'pix_direction' || ambiguity.learned) return false;
	return choices[choiceKeyOf(capture, 'pix_direction')] !== capture.direction;
};

/**
 * Grava (ou troca) a escolha de um caso. A escolha nova vai para o fim, e as mais antigas
 * saem enquanto o valor não couber em `MAX_CHOICES_LENGTH`.
 */
export const rememberChoice = (choices: CaptureChoices, key: string, value: string): CaptureChoices => {
	const next: Record<string, string> = { ...choices };
	delete next[key];
	next[key] = value;
	const keys = Object.keys(next);
	while (keys.length > 1 && serializeCaptureChoices(next).length > MAX_CHOICES_LENGTH) {
		delete next[keys.shift() as string];
	}
	return next;
};

export const serializeCaptureChoices = (choices: CaptureChoices): string => JSON.stringify(choices);

/** Lê o valor gravado. Valor estragado vale como nenhuma regra: o aviso volta à revisão. */
export const parseCaptureChoices = (stored: string | null | undefined): CaptureChoices => {
	if (!stored) return {};
	try {
		const parsed: unknown = JSON.parse(stored);
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
		return Object.fromEntries(
			Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
		);
	} catch {
		return {};
	}
};

export default {
	choiceKeyOf,
	detectAmbiguity,
	lookupChoice,
	isDirectionGuess,
	rememberChoice,
	serializeCaptureChoices,
	parseCaptureChoices,
};
