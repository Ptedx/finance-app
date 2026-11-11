/**
 * A conta a pagar que parece a fatura de um cartão (SPD-137).
 *
 * A fatura inteira cadastrada em Contas a pagar conta em dobro: ela entra no custo fixo junto
 * com as parcelas das compras do cartão (SPD-126), e o app já avisa o vencimento da fatura
 * dos cartões cadastrados. A tela avisa — sem impedir de salvar — quando o nome parece isso.
 * "Fatura" sozinha não basta (SPD-137b): é também o nome da conta de luz, de telefone, de
 * qualquer empresa.
 */

/** O que basta de um cartão cadastrado para reconhecê-lo no nome da conta. */
export interface CardNameLike {
	name: string;
	bankName: string | null;
}

/**
 * Palavras de cartão, em pt, en e it, já sem acento. Palavra inteira: "cartorio" e
 * "cardiologista" não são.
 *
 * Fatura, invoice e fattura não estão aqui (SPD-137b): sozinhas, são a conta de qualquer
 * empresa ("Fatura Claro", "fatura de energia"). Elas só apontam para um cartão junto com uma
 * palavra de cartão ou com o nome ou o banco de um cartão cadastrado — e cada uma dessas já
 * avisa sozinha. Por isso a palavra de fatura não decide nada e não precisa ser procurada.
 */
const CARD_WORDS = new Set(['cartao', 'cartoes', 'card', 'cards', 'carta', 'carte']);

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
 * O nome da conta a pagar parece a fatura de um cartão? Avisa quando tem cartão (ou card,
 * carta) ou o nome ou o banco de um cartão cadastrado — sempre por palavra inteira: "Internet"
 * não é o Inter, "Cartório" não é cartão. "Fatura" (invoice, fattura) sozinha não avisa:
 * "Fatura do cartão" e "Fatura Nubank", com o Nubank cadastrado, avisam pelo cartão e pelo
 * banco; "Fatura Claro" e "Fatura de energia", não.
 */
export const looksLikeCardInvoice = (name: string, cards: readonly CardNameLike[]): boolean => {
	const words = wordsOf(name);
	if (words.length === 0) return false;
	if (words.some((word) => CARD_WORDS.has(word))) return true;
	return cards.some((card) => containsPhrase(words, wordsOf(card.name)) || containsPhrase(words, wordsOf(card.bankName ?? '')));
};
