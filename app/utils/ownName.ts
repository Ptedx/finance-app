import { normalizeText } from './captureParser';

/**
 * Se o nome num aviso de banco é o do usuário (SPD-115, DEC-36).
 *
 * Cada banco escreve o mesmo nome do seu jeito: um põe "MARIA S OLIVEIRA", outro "Maria
 * Souza Oliveira". O app confere contra o nome da conta logada e contra o "seu nome como
 * aparece no banco" de Ajustes, e um nome que confere faz o Pix virar transferência entre
 * contas próprias **sem perguntar**. Juntar errado esconde uma despesa de verdade (o Pix
 * para a irmã vira troca de bolso); perguntar custa um toque, e a resposta "é
 * transferência" vira regra para a próxima vez. Por isso a regra é conservadora:
 *
 *  - sem acento, sem caixa, sem pontuação; "de", "da", "do", "dos", "das" e "e" não contam;
 *  - o mesmo número de palavras dos dois lados — um nome a mais ou a menos pode ser outra
 *    pessoa ("MARIA OLIVEIRA" e "Maria Souza Oliveira"; o "Junior" do filho);
 *  - o primeiro nome e o último sobrenome iguais, por inteiro, nunca abreviados — família
 *    divide os sobrenomes, e o banco que corta o último ("OLIVEI") fica perguntando;
 *  - cada nome do meio igual, ou uma inicial que é a primeira letra dele ("S" e "Souza");
 *  - uma palavra só nunca confere: é pouco para dizer que é a mesma pessoa.
 *
 * Puro, para ser testado com nomes inventados.
 */

const CONNECTORS: ReadonlySet<string> = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);

/** As palavras do nome, na ordem, como a regra as compara. */
export const nameWords = (value: string): string[] =>
	normalizeText(value)
		.replace(/[^a-z0-9]+/g, ' ')
		.split(' ')
		// Número não é nome: um pedaço do CPF mascarado que o banco ponha junto.
		.filter((word) => word.length > 0 && !/\d/.test(word) && !CONNECTORS.has(word));

/** A mesma palavra, ou uma inicial que é a primeira letra da outra. */
const sameMiddleName = (a: string, b: string): boolean =>
	a === b || (a.length === 1 && b.startsWith(a)) || (b.length === 1 && a.startsWith(b));

export const isSameName = (
	seen: string | null | undefined,
	own: string | null | undefined
): boolean => {
	if (!seen || !own) return false;
	const a = nameWords(seen);
	const b = nameWords(own);
	if (a.length < 2 || a.length !== b.length) return false;

	const last = a.length - 1;
	if (a[0].length < 2 || a[last].length < 2) return false;
	if (a[0] !== b[0] || a[last] !== b[last]) return false;

	for (let i = 1; i < last; i++) {
		if (!sameMiddleName(a[i], b[i])) return false;
	}
	return true;
};

/** O nome como é guardado: sem espaço sobrando. Vazio é nenhum nome. */
export const cleanOwnName = (value: string): string | null => {
	const clean = value.replace(/\s+/g, ' ').trim();
	return clean.length > 0 ? clean : null;
};

/**
 * Os nomes do usuário para a captura: o da conta logada e o de Ajustes, sem vazios e sem
 * o mesmo nome duas vezes.
 */
export const ownNamesOf = (names: ReadonlyArray<string | null | undefined>): string[] => {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const name of names) {
		const clean = name ? cleanOwnName(name) : null;
		if (!clean) continue;
		const key = nameWords(clean).join(' ');
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(clean);
	}
	return out;
};

export default { isSameName, nameWords, cleanOwnName, ownNamesOf };
