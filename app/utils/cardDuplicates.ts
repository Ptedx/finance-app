/**
 * "Provável repetido" no cartão (E2E-34, SPD-098). Puro e testado.
 *
 * A mesma compra pode entrar duas vezes no cartão: digitada à mão e depois trazida pelo
 * extrato OFX ou por uma notificação que o casamento não reconheceu — ou, depois de juntar
 * dois cartões, uma cópia de cada lado. A fatura soma as duas e deixa de bater com a do
 * banco (R$ 345,90 em vez de R$ 195,90 no achado). O app não apaga nada sozinho: duas
 * compras iguais no mesmo dia existem de verdade. Só marca, e o dono apaga o que sobra.
 *
 * ## Quando dois lançamentos são provável repetido
 *
 * - mesmo cartão (quem chama passa só os lançamentos de um cartão);
 * - mesmo valor e mesma direção: compra com compra, estorno com estorno. Compra e estorno
 *   do mesmo valor se anulam de propósito;
 * - no máximo um dia de diferença (`SAME_PAYMENT_DAYS`, a mesma folga do pagamento visto
 *   duas vezes e do "Parece repetido" da revisão do extrato);
 * - final do cartão compatível: dois finais conhecidos e diferentes são o físico e o
 *   virtual, duas compras. Final em branco casa com qualquer um, como a conta de origem
 *   nula em `isSameCardPayment`;
 * - nunca o ajuste com a fatura do banco (`isCardAdjustment`): é o app acertando o que não
 *   viu, não uma compra que se possa ter lançado duas vezes;
 * - parcelas: as do mesmo parcelamento nunca são par entre si. Parcelas de parcelamentos
 *   diferentes só quando são a mesma parcela (índice e total), como no casamento do extrato
 *   (`findTransactionForLine`). Parcela com compra à vista pode ser par: o extrato pode ter
 *   trazido como compra comum a parcela que o dono cadastrou.
 *
 * A origem (digitado × extrato × notificação) não entra. Não há coluna que diga: só a
 * ligação da captura com o lançamento, e o histórico de capturas da tela é podado. E dois
 * digitados iguais, ou duas capturas que o casamento não juntou, também são repetidos.
 *
 * Encargo e compra do mesmo valor podem ser par: o IOF registrado como encargo e a linha
 * "IOF" do extrato são o mesmo dinheiro.
 */

import { accountPairKey } from './accountBinding';
import { daysBetween, isCardAdjustment, SAME_PAYMENT_DAYS } from './cardMath';

/** Folga de data do provável repetido: o mesmo dia, a véspera ou o dia seguinte. */
export const CARD_DUPLICATE_DAYS = SAME_PAYMENT_DAYS;

/** Um lançamento do cartão, do jeito que basta para saber se dois são o mesmo. */
export interface CardDuplicateEntry {
	id: string;
	amountCents: number;
	isIncome: boolean;
	date: string;
	note: string | null | undefined;
	installmentGroup: string | null;
	installmentIndex?: number | null;
	installmentCount?: number | null;
	cardLast4?: string | null;
}

export interface CardDuplicatePair {
	a: string;
	b: string;
	/** `accountPairKey(a, b)`: igual nas duas ordens. É o que o "Não é repetido" guarda. */
	key: string;
}

export interface CardDuplicates<T extends CardDuplicateEntry = CardDuplicateEntry> {
	pairs: CardDuplicatePair[];
	/** Os pares de cada lançamento marcado, pela data e pelo id. */
	partners: Map<string, string[]>;
	/**
	 * Lançamentos ligados por pares, cada grupo pela data e pelo id, e os grupos pelo
	 * primeiro. Três iguais em 07, 08 e 09 são um grupo só, mesmo 07 e 09 não sendo par.
	 */
	groups: T[][];
}

const byDateThenId = (a: CardDuplicateEntry, b: CardDuplicateEntry) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id);

/** Os dois lançamentos do mesmo cartão podem ser a mesma compra lançada duas vezes? */
export const isLikelyCardDuplicate = (a: CardDuplicateEntry, b: CardDuplicateEntry): boolean => {
	if (a.id === b.id) return false;
	if (a.amountCents <= 0 || a.amountCents !== b.amountCents || a.isIncome !== b.isIncome) return false;
	if (Math.abs(daysBetween(a.date, b.date)) > CARD_DUPLICATE_DAYS) return false;
	if (isCardAdjustment(a) || isCardAdjustment(b)) return false;
	if (a.cardLast4 && b.cardLast4 && a.cardLast4 !== b.cardLast4) return false;
	if (a.installmentGroup && b.installmentGroup) {
		if (a.installmentGroup === b.installmentGroup) return false;
		if (a.installmentIndex !== b.installmentIndex || a.installmentCount !== b.installmentCount) return false;
	}
	return true;
};

/**
 * Os prováveis repetidos entre os lançamentos de **um** cartão. Pares em `dismissed` (o
 * dono disse "não é repetido", chaves de `accountPairKey`) ficam de fora.
 */
export const findCardDuplicates = <T extends CardDuplicateEntry>(
	entries: readonly T[],
	dismissed: ReadonlySet<string> = new Set()
): CardDuplicates<T> => {
	const sorted = [...entries].sort(byDateThenId);
	const pairs: CardDuplicatePair[] = [];
	const partners = new Map<string, string[]>();
	// União por id: cada lançamento aponta para o primeiro do grupo dele.
	const root = new Map<string, string>();
	const find = (id: string): string => {
		let current = id;
		while (root.get(current) !== current) current = root.get(current) as string;
		return current;
	};

	for (let i = 0; i < sorted.length; i += 1) {
		for (let j = i + 1; j < sorted.length; j += 1) {
			const a = sorted[i];
			const b = sorted[j];
			// Ordenados pela data: passou da folga, nenhum dos seguintes é par deste.
			if (daysBetween(a.date, b.date) > CARD_DUPLICATE_DAYS) break;
			if (!isLikelyCardDuplicate(a, b)) continue;
			const key = accountPairKey(a.id, b.id);
			if (dismissed.has(key)) continue;

			pairs.push({ a: a.id, b: b.id, key });
			partners.set(a.id, [...(partners.get(a.id) ?? []), b.id]);
			partners.set(b.id, [...(partners.get(b.id) ?? []), a.id]);
			if (!root.has(a.id)) root.set(a.id, a.id);
			if (!root.has(b.id)) root.set(b.id, b.id);
			const ra = find(a.id);
			const rb = find(b.id);
			if (ra !== rb) root.set(rb, ra);
		}
	}

	const order = new Map(sorted.map((entry, index) => [entry.id, index]));
	for (const [id, list] of partners) {
		partners.set(
			id,
			[...list].sort((x, y) => (order.get(x) as number) - (order.get(y) as number))
		);
	}

	const byRoot = new Map<string, T[]>();
	for (const entry of sorted) {
		if (!root.has(entry.id)) continue;
		const key = find(entry.id);
		byRoot.set(key, [...(byRoot.get(key) ?? []), entry]);
	}

	return { pairs, partners, groups: [...byRoot.values()] };
};

export interface CardDuplicateSummary {
	/** Quantos lançamentos sobram se os marcados forem repetidos: em cada grupo, todos menos um. */
	count: number;
	/**
	 * Quanto a fatura muda se forem: compra repetida soma a mais, estorno repetido a menos.
	 * Positivo = a fatura fica menor quando o dono apagar o que sobra.
	 */
	extraCents: number;
	/** Os lançamentos marcados dos grupos contados. */
	ids: Set<string>;
}

/**
 * Resume os grupos para o aviso. Com `shownIds`, só os grupos com algum lançamento entre
 * eles: o da fatura que está na tela (o par pode cair um de cada lado do fechamento).
 */
export const summarizeCardDuplicates = (
	groups: readonly CardDuplicateEntry[][],
	shownIds?: ReadonlySet<string>
): CardDuplicateSummary => {
	let count = 0;
	let extraCents = 0;
	const ids = new Set<string>();
	for (const group of groups) {
		if (shownIds && !group.some((member) => shownIds.has(member.id))) continue;
		const extra = group.length - 1;
		count += extra;
		extraCents += extra * (group[0].isIncome ? -group[0].amountCents : group[0].amountCents);
		for (const member of group) ids.add(member.id);
	}
	return { count, extraCents, ids };
};

export default { findCardDuplicates, isLikelyCardDuplicate, summarizeCardDuplicates };
