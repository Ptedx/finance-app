/**
 * O markdown simples das respostas do Mirai (SPD-180). O modelo escreve **negrito** e listas com "- ";
 * sem isto, a pessoa via os asteriscos. Títulos (#) viram uma linha em negrito; itálico (*x*, _x_) e
 * código (`x`) viram texto normal. O resto passa como veio.
 */
export interface MiraiSpan {
	text: string;
	bold: boolean;
}

const HEADING = /^\s{0,3}#{1,6}\s+(.*)$/;
const BULLET = /^(\s*)[-*+•]\s+(.*)$/;
const BOLD = /\*\*(.+?)\*\*|__(.+?)__/g;

/** Tira itálico e código, que o app não destaca: fica só o texto. */
const plain = (text: string): string =>
	text
		.replace(/`([^`\n]+)`/g, '$1')
		.replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?![*\w])/g, '$1$2')
		.replace(/(^|[^_\w])_(?!\s)([^_\n]+?)_(?![_\w])/g, '$1$2');

const push = (spans: MiraiSpan[], text: string, bold: boolean): void => {
	if (!text) return;
	const last = spans[spans.length - 1];
	if (last && last.bold === bold) last.text += text;
	else spans.push({ text, bold });
};

/** O texto da resposta em trechos, cada um em negrito ou não, na ordem. */
export const miraiSpans = (text: string): MiraiSpan[] => {
	const spans: MiraiSpan[] = [];
	text
		.replace(/\r\n/g, '\n')
		.split('\n')
		.forEach((raw, index) => {
			if (index > 0) push(spans, '\n', spans[spans.length - 1]?.bold ?? false);
			let line = raw;
			let lineBold = false;
			const heading = line.match(HEADING);
			if (heading) {
				line = heading[1] ?? '';
				lineBold = true;
			}
			const bullet = line.match(BULLET);
			if (bullet) line = `${bullet[1] ?? ''}•  ${bullet[2] ?? ''}`;
			let at = 0;
			for (const match of line.matchAll(BOLD)) {
				push(spans, plain(line.slice(at, match.index)), lineBold);
				push(spans, plain(match[1] ?? match[2] ?? ''), true);
				at = (match.index ?? 0) + match[0].length;
			}
			push(spans, plain(line.slice(at)), lineBold);
		});
	return spans;
};
