/**
 * Os guias do app no prompt do Mirai (SPD-163, §6: "bloco seguinte, também em cache").
 *
 * O texto vem do i18n do app (`app/i18n/locales/pt.ts`): os tópicos de "Como usar"
 * (`tutorial.topics`) e os guias passo a passo das telas (`trails`). O script
 * `backend/scripts/gen-mirai-guides.ts` grava o resultado em `guides.pt.md`, ao lado deste
 * arquivo; a API o lê na subida. O backend não importa código do app: o arquivo gerado é a
 * ponte, e quem o atualiza é o script, com o i18n do ramo do app.
 *
 * Só português: a instrução manda responder no idioma do app, e os guias são a fonte do
 * conteúdo, não da língua.
 */

type Texts = { [key: string]: unknown };

const isTexts = (value: unknown): value is Texts =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null =>
	typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/** "Título." + corpo, num parágrafo só. O título sem pontuação final ganha um ponto. */
const titled = (title: string | null, body: string | null): string => {
	const head = title?.replace(/:$/, '.') ?? null;
	const closed = head && !/[.?!…]$/.test(head) ? `${head}.` : head;
	return [closed ? `**${closed}**` : null, body].filter(Boolean).join(' ');
};

/** Os passos em ordem numérica; os de chave não numérica (como `ios`) vêm por último, marcados. */
const renderSteps = (steps: Texts): string[] => {
	const keys = Object.keys(steps);
	const numbered = keys.filter((key) => /^\d+$/.test(key)).sort((a, b) => Number(a) - Number(b));
	const others = keys.filter((key) => !/^\d+$/.test(key)).sort();
	const lines: string[] = [];

	for (const key of [...numbered, ...others]) {
		const step = steps[key];
		if (!isTexts(step)) continue;
		const line = titled(text(step['title']), text(step['body']));
		if (!line) continue;
		const prefix = /^\d+$/.test(key) ? `${key}.` : key === 'ios' ? '- No iPhone:' : `- (${key})`;
		lines.push(`${prefix} ${line}`);
		const missing = text(step['missing']);
		if (missing) lines.push(`   Quando ainda não há nada: ${missing}`);
	}
	return lines;
};

/**
 * O markdown dos guias a partir do objeto `pt` do i18n do app. Determinístico: a mesma
 * entrada dá o mesmo texto, byte a byte — ele é parte do prefixo em cache.
 */
export const renderMiraiGuides = (pt: unknown): string => {
	if (!isTexts(pt)) throw new Error('O i18n não é um objeto.');
	const tutorial = pt['tutorial'];
	const trails = pt['trails'];
	if (!isTexts(tutorial) || !isTexts(tutorial['topics']) || !isTexts(trails)) {
		throw new Error('O i18n não tem tutorial.topics e trails.');
	}

	const out: string[] = ['## Como usar (Configurações › Como usar)', ''];
	for (const topic of Object.values(tutorial['topics'])) {
		if (!isTexts(topic)) continue;
		const title = text(topic['title']);
		const body = text(topic['body']);
		if (!title || !body) continue;
		out.push(`### ${title}`, '', body, '');
	}

	out.push('## Guias passo a passo (o "?" de cada tela)', '');
	for (const trail of Object.values(trails)) {
		if (!isTexts(trail) || !isTexts(trail['steps'])) continue;
		const title = text(trail['title']);
		const steps = renderSteps(trail['steps']);
		if (!title || steps.length === 0) continue;
		out.push(`### ${title}`, '', ...steps, '');
	}

	return `${out.join('\n').trimEnd()}\n`;
};

/** O cabeçalho do arquivo gerado. Fica fora do prompt (ver `guidesForPrompt`). */
export const GUIDES_FILE_HEADER =
	'<!-- Gerado por backend/scripts/gen-mirai-guides.ts a partir de app/i18n/locales/pt.ts. Não edite à mão. -->';

/**
 * O texto do arquivo como entra no prompt: sem o cabeçalho e com fim de linha `\n`. O
 * arquivo pode sair do git com CRLF ou LF; o prompt não pode mudar por isso.
 */
export const guidesForPrompt = (fileText: string): string =>
	fileText
		.replace(/\r\n/g, '\n')
		.split('\n')
		.filter((line) => line !== GUIDES_FILE_HEADER)
		.join('\n')
		.trim();
