/**
 * O evento `capture_decision` (SPD-014): um por aviso que a ingestão processou, dizendo o
 * que o parser entendeu, de onde saiu o dinheiro e o que o app decidiu — e por quê.
 *
 * Só metadados (DEC-11 b): o pacote, o tipo, a direção, a decisão e o motivo. Nunca o
 * valor, o estabelecimento, a contraparte, o final do cartão nem o nome da conta — no
 * máximo se o parser os achou. O texto do aviso só vai em `rawText`, e só quando ele veio
 * de app de banco conhecido e o parser o descartou ou não entendeu (`keepsRawText`).
 */

import type { AccountResolution, DestinationResolution } from '../utils/accountResolver';
import type { Decision } from '../utils/captureMatcher';
import type { ParsedCapture, RawCapture } from '../utils/captureParser';
import type { DiagnosticValue } from './contract';
import { isKnownBankPackage } from './knownBanks';
import { log } from './log';

/** O que a ingestão fez com o aviso, antes ou depois do motor de decisão. */
export type CaptureStep =
	/** A mesma notificação já tinha entrado (impressão digital). */
	| { step: 'already_seen' }
	/** O parser não achou movimento de dinheiro: o aviso é descartado. */
	| { step: 'not_money' }
	/** App que não é banco e texto que não cita banco (SPD-022). */
	| { step: 'no_bank' }
	/** App bloqueado: nada dele entra (SPD-069). */
	| { step: 'blocked' }
	| {
			step: 'decided';
			/** A decisão gravada. */
			decision: Decision;
			/**
			 * Por que a ingestão trocou a decisão do motor: a outra perna já confirmada
			 * (`transfer` virou `ask_transfer`), ou a moeda estrangeira (`auto_confirm`
			 * virou `pending`).
			 */
			overridden?: 'confirmed_leg' | 'foreign_currency';
			/** Moeda estrangeira sem o valor em reais: o item pendente leva esse motivo. */
			currencyReview?: boolean;
			account: AccountResolution | 'none';
			captureId: string;
			/** A saída da PJ que este recebimento neutralizou. */
			externalLeg?: boolean;
			/**
			 * Só no movimento neutro (aplicação, resgate, pagamento da fatura): como o outro
			 * lado da transferência foi achado (SPD-023). Nunca qual conta.
			 */
			destination?: DestinationResolution;
	  };

export interface CaptureDecisionInput {
	raw: Pick<RawCapture, 'packageName'>;
	fingerprint: string;
	/** `undefined`: o parser nem rodou; `null`: rodou e descartou. */
	parsed?: ParsedCapture | null;
	outcome: CaptureStep;
}

/**
 * A fronteira da DEC-11 (b): texto cru só de app de banco conhecido cujo aviso o parser
 * descartou (`null`) ou não entendeu (`kind: 'unknown'`). WhatsApp, Gmail, SMS e carteira
 * nunca, entendidos ou não.
 */
export const keepsRawText = (packageName: string, parsed: ParsedCapture | null | undefined): boolean =>
	isKnownBankPackage(packageName) && (parsed === null || parsed?.kind === 'unknown');

/** Status e motivo em que a decisão deixa o item, como a caixa de entrada os mostra. */
const outcomeOf = (
	decision: Decision,
	currencyReview: boolean
): { outcome: string; reason: string | null; question: string | null; related: boolean } => {
	// O que fica pendente guarda o motivo da moeda (`ingestRawCaptures`); o resto grava o seu.
	const pendingReason = currencyReview ? 'foreign_currency' : null;
	switch (decision.action) {
		case 'auto_confirm':
			return { outcome: 'confirmed', reason: 'rule', question: null, related: false };
		case 'pending':
			return { outcome: 'pending', reason: pendingReason, question: null, related: false };
		case 'ask_duplicate':
			return { outcome: 'pending', reason: pendingReason, question: 'duplicate', related: true };
		case 'ask_transfer':
			return { outcome: 'pending', reason: pendingReason, question: 'transfer', related: true };
		case 'duplicate':
			return { outcome: 'duplicate', reason: decision.reason, question: null, related: true };
		case 'transfer':
			return { outcome: 'transfer', reason: decision.reason, question: null, related: decision.relatedId !== null };
		case 'neutral':
			// Gravado como ignorado, com a transferência do pagamento da fatura ou do investimento.
			return { outcome: 'ignored', reason: decision.reason, question: null, related: false };
		case 'ignore':
			return { outcome: 'ignored', reason: decision.reason, question: null, related: false };
	}
};

/** O `data` do evento. Exportado para o teste conferir que nada do usuário entra nele. */
export const captureDecisionData = (input: CaptureDecisionInput): Record<string, DiagnosticValue> => {
	const { raw, fingerprint, parsed, outcome } = input;
	const data: Record<string, DiagnosticValue> = {
		pkg: raw.packageName,
		knownBank: isKnownBankPackage(raw.packageName),
		fingerprint,
	};

	if (parsed === null) data.parse = 'failed';
	else if (parsed) {
		data.parse = 'ok';
		data.kind = parsed.kind;
		data.direction = parsed.direction;
		// Se achou, não o quê.
		data.hasCounterparty = parsed.counterparty !== null;
		data.hasCardLast4 = parsed.cardLast4 !== null;
		if (parsed.installments !== null) data.installments = parsed.installments;
		if (parsed.foreign) {
			data.currency = parsed.foreign.currency;
			data.currencyInBrl = parsed.foreign.inBrl;
		}
	}

	switch (outcome.step) {
		case 'already_seen':
			data.outcome = 'skipped';
			data.reason = 'already_seen';
			break;
		case 'not_money':
			data.outcome = 'discarded';
			data.reason = 'not_money';
			break;
		case 'no_bank':
			data.outcome = 'ignored';
			data.reason = 'no_bank';
			break;
		case 'blocked':
			data.outcome = 'ignored';
			data.reason = 'blocked';
			break;
		case 'decided': {
			const shown = outcomeOf(outcome.decision, outcome.currencyReview === true);
			data.captureId = outcome.captureId;
			data.action = outcome.decision.action;
			data.outcome = shown.outcome;
			data.reason = shown.reason;
			data.question = shown.question;
			data.related = shown.related;
			data.account = outcome.account;
			if (outcome.overridden) data.overridden = outcome.overridden;
			if (outcome.externalLeg) data.externalLeg = true;
			if (outcome.destination) data.destination = outcome.destination;
			break;
		}
	}
	return data;
};

/** Registra a decisão sobre um aviso. Nunca lança. */
export const logCaptureDecision = (
	input: CaptureDecisionInput & { raw: Pick<RawCapture, 'packageName' | 'title' | 'text'> }
): void => {
	try {
		const rawText = keepsRawText(input.raw.packageName, input.parsed)
			? `${input.raw.title}\n${input.raw.text}`
			: null;
		log('capture', 'capture_decision', {
			// O banco conhecido que o parser não entendeu é o que se quer achar no diário.
			level: rawText ? 'warn' : 'info',
			data: captureDecisionData(input),
			rawText,
		});
	} catch {
		// Idem.
	}
};

/** A ingestão de um aviso falhou no meio: o aviso se perde (a fila nativa já esvaziou). */
export const logCaptureFailure = (
	raw: Pick<RawCapture, 'packageName'>,
	fingerprint: string | null,
	stage: string,
	error: unknown
): void => {
	log('capture', 'capture_ingest_failed', {
		level: 'error',
		data: {
			pkg: raw.packageName,
			knownBank: isKnownBankPackage(raw.packageName),
			fingerprint,
			stage,
			error: error instanceof Error ? error.name : typeof error,
		},
	});
};
