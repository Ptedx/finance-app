/**
 * Gera `src/domain/mirai/guides.pt.md`, os guias do app no prompt do Mirai (SPD-163, §6).
 *
 * Uso, na raiz do backend:
 *
 *     npx tsx scripts/gen-mirai-guides.ts ../app/i18n/locales/pt.ts
 *
 * Recebe o caminho do `pt.ts` do i18n do app — o do ramo do app que vai junto no deploy — e
 * grava os tópicos de "Como usar" e os guias passo a passo das telas. O texto é parte do
 * prefixo em cache do Mirai: rodar de novo com o mesmo i18n dá o mesmo arquivo.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GUIDES_FILE_HEADER, renderMiraiGuides } from '../src/domain/mirai/guides.js';

const source = process.argv[2];
if (!source) {
	console.error('uso: npx tsx scripts/gen-mirai-guides.ts <caminho do pt.ts do app>');
	process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', 'src', 'domain', 'mirai', 'guides.pt.md');

const module = (await import(pathToFileURL(resolve(source)).href)) as { default?: unknown };
const markdown = `${GUIDES_FILE_HEADER}\n\n${renderMiraiGuides(module.default)}`;

// CRLF, como os outros arquivos do repositório; o prompt usa `\n` de qualquer jeito.
writeFileSync(target, markdown.replace(/\n/g, '\r\n'), 'utf8');
console.log(`Guias gravados em ${target} (${markdown.length} caracteres).`);
