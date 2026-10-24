/**
 * A captura de notificações está funcionando? O aviso da tela inicial (`CaptureReviewBanner`).
 *
 * Dois jeitos de parar, e só um o sistema conta:
 * - **desligada**: o usuário (ou uma reinstalação) tirou o acesso a notificações. O módulo
 *   nativo sabe dizer (`isCaptureEnabled`).
 * - **parada**: o acesso continua ligado, mas o Android desvinculou o serviço (economia de
 *   bateria, processo morto, atualização do app) e nada mais chega. O sistema não avisa; o
 *   único sinal é o silêncio. Quem tem conta ligada a app de banco e passa 3 dias sem
 *   nenhum aviso de banco recebe "Não recebemos avisos do seu banco há N dias" (AUTO-02).
 *
 * O silêncio pode ser só uma semana sem gastar, então a dispensa da "parada" vence em 7
 * dias em vez de valer para sempre. A da "desligada" continua como era (SPD-068).
 *
 * Puro: recebe o estado e o relógio, devolve o aviso.
 */

import type { Account, Capture } from '../database/schema';
import { isStatementPackage } from './captureMatcher';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Dias sem aviso de banco até a captura ser dada como parada. */
export const STALLED_AFTER_DAYS = 3;

/** Por quantos dias a dispensa do aviso de captura parada vale. */
export const STALLED_DISMISS_DAYS = 7;

/**
 * Quando o usuário dispensou o aviso de captura parada (milissegundos desde a época).
 * É deste aparelho: não viaja no backup nem no sync — o silêncio de um celular não diz
 * nada sobre o outro.
 */
export const CAPTURE_STALLED_DISMISSED_KEY = '@spendr_capture_stalled_dismissed_at';

export type CaptureWarning = { kind: 'off' } | { kind: 'stalled'; days: number } | null;

export interface CaptureHealthInput {
	/** Se esta build tem o serviço nativo (Android). */
	supported: boolean;
	/** Se o acesso a notificações está ligado. */
	enabled: boolean;
	/** O aviso "captura desligada" foi dispensado. */
	offDismissed: boolean;
	/** Quando o aviso de captura parada foi dispensado (ms), ou nulo. */
	stalledDismissedAt: number | null;
	accounts: ReadonlyArray<Pick<Account, 'packageName' | 'archived'>>;
	/** As capturas que o app tem à mão (pendentes e o histórico recente). */
	captures: ReadonlyArray<Pick<Capture, 'packageName' | 'postedAt'>>;
	now: number;
}

/** Uma conta ativa ligada a app de banco: dela se espera aviso. Extrato OFX não conta. */
const hasLinkedBank = (accounts: CaptureHealthInput['accounts']): boolean =>
	accounts.some(
		(account) =>
			!account.archived && account.packageName !== null && !isStatementPackage(account.packageName)
	);

/**
 * O instante do aviso de banco mais recente, em ms, ou nulo se não há nenhum. Linha de
 * extrato OFX não é notificação e fica de fora.
 */
export const lastBankNotificationAt = (captures: CaptureHealthInput['captures']): number | null => {
	let last: number | null = null;
	for (const capture of captures) {
		if (isStatementPackage(capture.packageName)) continue;
		const at = new Date(capture.postedAt).getTime();
		if (Number.isNaN(at)) continue;
		if (last === null || at > last) last = at;
	}
	return last;
};

/**
 * A dispensa ainda vale? Por 7 dias a partir do toque. Um relógio que andou para trás não
 * a faz valer para sempre: longe demais em qualquer direção, ela venceu.
 */
export const isStalledDismissalActive = (dismissedAt: number | null, now: number): boolean => {
	if (dismissedAt === null || Number.isNaN(dismissedAt)) return false;
	return Math.abs(now - dismissedAt) < STALLED_DISMISS_DAYS * DAY_MS;
};

/** Lê o valor guardado da dispensa. Ausente ou ilegível é "não dispensado". */
export const parseStalledDismissedAt = (value: string | null): number | null => {
	if (value === null) return null;
	const at = Number(value);
	return Number.isFinite(at) ? at : null;
};

/** O aviso que a tela inicial deve mostrar sobre a captura, ou nulo. */
export const captureWarning = (input: CaptureHealthInput): CaptureWarning => {
	if (!input.supported) return null;
	if (!input.enabled) return input.offDismissed ? null : { kind: 'off' };

	if (!hasLinkedBank(input.accounts)) return null;
	// Sem nenhum aviso guardado não há de onde contar os dias.
	const last = lastBankNotificationAt(input.captures);
	if (last === null) return null;

	const days = Math.floor((input.now - last) / DAY_MS);
	if (days < STALLED_AFTER_DAYS) return null;
	if (isStalledDismissalActive(input.stalledDismissedAt, input.now)) return null;
	return { kind: 'stalled', days };
};
