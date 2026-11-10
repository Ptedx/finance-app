/**
 * A conta a pagar que parece a fatura de um cartão (SPD-137).
 *
 * A fatura inteira cadastrada em Contas a pagar conta em dobro: ela entra no custo fixo junto
 * com as parcelas das compras do cartão (SPD-126), e o app já avisa o vencimento da fatura
 * dos cartões cadastrados. A tela avisa — sem impedir de salvar — quando o nome parece isso.
 */

/** O que basta de um cartão cadastrado para reconhecê-lo no nome da conta. */
export interface CardNameLike {
	name: string;
	bankName: string | null;
}

/**
 * Palavras de fatura e de cartão, em pt, en e it, já sem acento. Palavra inteira: "cartorio",
 * "faturamento" e "cardiologista" não são.
 */
const CARD_INVOICE_WORDS = new Set([
	'fatura',
	'faturas',
	'cartao',
	'cartoes',
	'invoice',
	'invoices',
	'card',
	'cards',
	'fattura',
	'fatture',
	'carta',
	'carte',
]);

/**
 * As palavras do texto, em minúsculas e sem acento ("Cartão de crédito" → cartao, de, credito),
 * como em `billMatcher`: pontuação separa.
 */
const wordsOf = (text: string): string[] =>
	text
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((word) => word.length > 0);

/** `phrase` aparece em `words` como palavras inteiras e seguidas. Frase vazia não aparece. */
const containsPhrase = (words: readonly string[], phrase: readonly string[]): boolean => {
	if (phrase.length === 0) return false;
	for (let start = 0; start + phrase.length <= words.length; start++) {
		if (phrase.every((word, index) => words[start + index] === word)) return true;
	}
	return false;
};

/**
 * O nome da conta a pagar parece a fatura de um cartão? Avisa quando tem fatura/cartão (ou
 * invoice, card, fattura, carta) ou o nome ou o banco de um cartão cadastrado — sempre por
 * palavra inteira: "Internet" não é o Inter, "Cartório" não é cartão.
 */
export const looksLikeCardInvoice = (name: string, cards: readonly CardNameLike[]): boolean => {
	const words = wordsOf(name);
	if (words.length === 0) return false;
	if (words.some((word) => CARD_INVOICE_WORDS.has(word))) return true;
	return cards.some((card) => containsPhrase(words, wordsOf(card.name)) || containsPhrase(words, wordsOf(card.bankName ?? '')));
};
