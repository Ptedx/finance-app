/**
 * Compras parceladas no cartão.
 *
 * A notificação avisa a compra inteira no dia ("R$ 300,00 em 3x"); a fatura cobra uma
 * parcela por mês. Para a fatura do app bater com a fatura do banco, a compra vira
 * `count` lançamentos — um por mês, a partir da data da compra — que compartilham um
 * `installmentGroup`. O extrato do cartão traz cada parcela marcada ("2/3", "PARC 02/03"),
 * e é por essa marca que a linha do OFX encontra a parcela certa.
 *
 * Puro, testado. Nada aqui sabe de banco de dados.
 */

import { normalizeText, parseNotificationAmount } from './captureParser';
import { addMonthsClamped } from './dateUtils';

export const MAX_INSTALLMENTS = 48;

/**
 * Divide o total em `count` parcelas inteiras em centavos. O resto da divisão vai
 * para a primeira parcela, que é como os bancos fazem — e a soma volta ao total exato.
 */
export const splitInstallments = (totalCents: number, count: number): number[] => {
	if (count <= 1) return [totalCents];
	const base = Math.floor(totalCents / count);
	const remainder = totalCents - base * count;
	return Array.from({ length: count }, (_, index) => base + (index === 0 ? remainder : 0));
};

/** Data da parcela `index` (1 = a primeira, no dia da compra), um mês por parcela. */
export const installmentDate = (purchaseDate: string, index: number): string =>
	addMonthsClamped(purchaseDate, index - 1);

export interface InstallmentMarker {
	index: number;
	count: number;
}

/**
 * "2/3", "02/03", "PARC 2/3", "parcela 2 de 3" numa linha de extrato ou fatura.
 * Datas ("14/09") não confundem: o segundo número precisa ser maior ou igual ao
 * primeiro e não pode passar de 48.
 */
export const parseInstallmentMarker = (text: string): InstallmentMarker | null => {
	const normalized = normalizeText(text);
	const pattern = /(?:parc(?:ela)?\.?\s*)?\b(\d{1,2})\s*(?:\/|de)\s*(\d{1,2})\b/g;
	let match = pattern.exec(normalized);
	while (match !== null) {
		const index = Number(match[1]);
		const count = Number(match[2]);
		if (count >= 2 && count <= MAX_INSTALLMENTS && index >= 1 && index <= count) {
			return { index, count };
		}
		match = pattern.exec(normalized);
	}
	return null;
};

export interface NotificationInstallments {
	count: number;
	/** O valor de cada parcela, quando o texto diz "3x de R$ 100,00"; senão nulo. */
	parcelCents: number | null;
}

/**
 * "em 3x", "3x de R$ 100,00", "parcelado em 3" numa notificação de compra.
 * `count` entre 2 e 48; "1x" é à vista e devolve nulo.
 */
export const detectNotificationInstallments = (text: string): NotificationInstallments | null => {
	const normalized = normalizeText(text);

	const withAmount = /(\d{1,2})\s*x\s*(?:de\s*)?(?:r\$|us\$|\$)\s?(\d[\d.,]*\d|\d)/.exec(normalized);
	if (withAmount) {
		const count = Number(withAmount[1]);
		const parcelCents = parseNotificationAmount(withAmount[2]);
		if (count >= 2 && count <= MAX_INSTALLMENTS && parcelCents) return { count, parcelCents };
	}

	const plain = /\bem\s+(\d{1,2})\s*x\b/.exec(normalized) ?? /parcelad[ao]\s+em\s+(\d{1,2})\b/.exec(normalized);
	if (plain) {
		const count = Number(plain[1]);
		if (count >= 2 && count <= MAX_INSTALLMENTS) return { count, parcelCents: null };
	}

	return null;
};

export default {
	splitInstallments,
	installmentDate,
	parseInstallmentMarker,
	detectNotificationInstallments,
	MAX_INSTALLMENTS,
};
