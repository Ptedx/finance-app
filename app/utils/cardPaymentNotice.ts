import { type CardPayment, daysBetween, isSameCardPayment } from './cardMath';

/** Uma transferência gravada, do jeito que basta para achar o pagamento de fatura. */
export interface CardTransferLike {
	id: string;
	fromAccountId: string | null;
	toAccountId: string | null;
	amountCents: number;
	date: string;
}

/**
 * Por que o "Pagar fatura" não criou um pagamento novo (SPD-133):
 * - `already`: o mesmo pagamento já estava no cartão (o primeiro toque, ou o aviso do banco);
 * - `completed`: o aviso do banco tinha gravado a saída da conta sem dizer o cartão, e o toque
 *   completou o destino dela.
 */
export interface RefusedCardPayment {
	kind: 'already' | 'completed';
	fromAccountId: string | null;
	amountCents: number;
	date: string;
}

/**
 * O pagamento que fez `recordCardPayment` devolver falso, para a tela dizer qual era.
 *
 * `before` e `after` são as transferências do cartão (`getAccountTransfers`) de antes e de
 * depois do toque. O pagamento completado não estava no cartão antes — o destino dele estava
 * em branco — e aparece depois; o que já estava, estava antes. A identidade é a mesma de
 * `recordCardPayment`: `isSameCardPayment` (mesma conta, mesmo valor, até um dia). Com mais de
 * um, o de data mais próxima; empate, o mais antigo. Nada achado (mudou no meio): nulo, e a
 * tela fica com a frase só com o valor.
 */
export const findRefusedCardPayment = (
	cardId: string,
	before: readonly CardTransferLike[],
	after: readonly CardTransferLike[],
	attempt: CardPayment
): RefusedCardPayment | null => {
	const matches = (transfer: CardTransferLike) => transfer.toAccountId === cardId && isSameCardPayment(transfer, attempt);
	const closest = (list: readonly CardTransferLike[]) =>
		[...list].sort(
			(a, b) =>
				Math.abs(daysBetween(a.date, attempt.date)) - Math.abs(daysBetween(b.date, attempt.date)) || a.date.localeCompare(b.date)
		)[0];
	const pick = (kind: RefusedCardPayment['kind'], transfer: CardTransferLike | undefined): RefusedCardPayment | null =>
		transfer ? { kind, fromAccountId: transfer.fromAccountId, amountCents: transfer.amountCents, date: transfer.date } : null;

	const wasOnCard = new Set(before.filter((transfer) => transfer.toAccountId === cardId).map((transfer) => transfer.id));
	return (
		pick('completed', closest(after.filter((transfer) => matches(transfer) && !wasOnCard.has(transfer.id)))) ??
		pick('already', closest(before.filter(matches)))
	);
};
