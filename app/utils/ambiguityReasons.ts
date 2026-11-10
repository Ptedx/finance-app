/**
 * Os casos em que o aviso não diz o bastante para o app lançar sozinho (SPD-123), e o motivo
 * que o item da caixa de entrada grava para cada um.
 *
 * O motivo é o que leva o caso pela vida do item: a revisão explica a dúvida e faz a pergunta
 * certa, confirmar sabe qual regra aprender, reverter devolve a pergunta, e o conserto das
 * compras antigas (`planLedgerRepair`) não mexe no que o usuário escolheu. Sem coluna nova:
 * `reason` já viaja no sync (texto livre, até 64 caracteres no servidor).
 *
 *  - `ambiguous_<caso>`: o app perguntou (ou o usuário respondeu à pergunta);
 *  - `learned_<caso>`: a regra aprendida com uma resposta anterior decidiu sozinha.
 *
 * Sem dependências, para o `notificationTarget` poder ler o motivo sem import circular.
 */

export const AMBIGUITY_CASES = [
	/** "no crédito" sem o final do cartão, e o banco não tem um cartão só (NOTIF-06). */
	'credit_no_last4',
	/** "crédito" com um final que não é de nenhum dos cartões do banco (achado 7.6). */
	'credit_unknown_last4',
	/** Nem "crédito" nem "débito", dois cartões ou mais do banco e um final novo (NOTIF-15). */
	'purchase_no_kind',
	/** Nem "crédito" nem "débito", um cartão do banco, a conta do banco e um final novo (NOTIF-16). */
	'debit_unknown_last4',
	/** O aviso tem pista de entrada e de saída ao mesmo tempo: "Fulano te enviou" (NOTIF-11). */
	'pix_direction',
	/** O cartão recebeu o pagamento da fatura, sem dizer de qual conta ele saiu (X-2). */
	'invoice_payment',
] as const;

export type AmbiguityCase = (typeof AMBIGUITY_CASES)[number];

/** Os casos em que a resposta é uma conta ou um cartão de destino da compra. */
export const TARGET_CASES: readonly AmbiguityCase[] = [
	'credit_no_last4',
	'credit_unknown_last4',
	'purchase_no_kind',
	'debit_unknown_last4',
];

const ASKED = 'ambiguous_';
const LEARNED = 'learned_';

export const ambiguousReason = (ambiguity: AmbiguityCase): string => `${ASKED}${ambiguity}`;
export const learnedReason = (ambiguity: AmbiguityCase): string => `${LEARNED}${ambiguity}`;

const isCase = (value: string): value is AmbiguityCase => (AMBIGUITY_CASES as readonly string[]).includes(value);

/** O caso de um motivo gravado, e se foi a regra aprendida; `null` para qualquer outro motivo. */
export const ambiguityOfReason = (
	reason: string | null | undefined
): { case: AmbiguityCase; learned: boolean } | null => {
	if (!reason) return null;
	for (const [prefix, learned] of [
		[ASKED, false],
		[LEARNED, true],
	] as const) {
		if (!reason.startsWith(prefix)) continue;
		const rest = reason.slice(prefix.length);
		return isCase(rest) ? { case: rest, learned } : null;
	}
	return null;
};

export default { AMBIGUITY_CASES, TARGET_CASES, ambiguousReason, learnedReason, ambiguityOfReason };
