import fs from 'node:fs';
import path from 'node:path';
import { PRIVACY_POLICIES, type PrivacyPolicy, privacyPolicyFor } from '../privacyPolicy';

/**
 * As três versões da política de privacidade dizem a mesma coisa (SPD-118).
 *
 * A política está na tela (`utils/privacyPolicyText/`) e em `docs/privacy-policy*.html`, em
 * português, inglês e italiano. Quem atualiza uma versão e esquece as outras deixa um idioma
 * prometendo outra coisa: aqui as três têm as mesmas seções, na mesma ordem e com o mesmo
 * número de parágrafos, e cada html tem o mesmo texto da tela no seu idioma.
 */

const DOCS_DIR = path.resolve(__dirname, '../../../docs');

const HTML_FILES: Record<keyof typeof PRIVACY_POLICIES, { file: string; lang: string }> = {
	pt: { file: 'privacy-policy.html', lang: 'pt-BR' },
	en: { file: 'privacy-policy.en.html', lang: 'en' },
	it: { file: 'privacy-policy.it.html', lang: 'it' },
};

const LANGUAGES = Object.keys(HTML_FILES) as (keyof typeof HTML_FILES)[];

/** O formato de cada seção: o ícone e quantos parágrafos de cada tipo ela tem. */
const shape = (policy: PrivacyPolicy) =>
	policy.sections.map((section) => ({
		icon: section.icon,
		body: section.body?.length ?? 0,
		list: section.list?.length ?? 0,
		after: section.after?.length ?? 0,
	}));

/** Os parágrafos de uma seção na ordem em que aparecem, os itens como "rótulo — texto". */
const paragraphs = (section: PrivacyPolicy['sections'][number]): string[] => [
	...(section.body ?? []),
	...(section.list ?? []).map(([label, text]) => `${label} — ${text}`),
	...(section.after ?? []),
];

const decode = (html: string): string =>
	html
		.replace(/<[^>]+>/g, '')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&')
		.replace(/\s+/g, ' ')
		.trim();

const readHtml = (language: keyof typeof HTML_FILES): string =>
	fs.readFileSync(path.join(DOCS_DIR, HTML_FILES[language].file), 'utf8');

/** As seções do html: título, ícone e parágrafos (`<p>` e `<li>`), na ordem. */
const htmlSections = (html: string) => {
	const main = html.slice(html.indexOf('<div class="content">'), html.indexOf('</main>'));
	return main
		.split('<div class="section">')
		.slice(1)
		.map((chunk) => ({
			icon: decode(chunk.match(/<div class="section-icon">([\s\S]*?)<\/div>/)?.[1] ?? ''),
			title: decode(chunk.match(/<h2>([\s\S]*?)<\/h2>/)?.[1] ?? ''),
			paragraphs: [...chunk.matchAll(/<(p|li)>([\s\S]*?)<\/\1>/g)].map((match) => decode(match[2])),
		}));
};

describe('SPD-118 — as versões da política', () => {
	it('pt, en e it têm as mesmas seções, com os mesmos ícones e o mesmo número de parágrafos', () => {
		const expected = shape(PRIVACY_POLICIES.pt);
		expect(expected.length).toBeGreaterThan(5);
		expect(shape(PRIVACY_POLICIES.en)).toEqual(expected);
		expect(shape(PRIVACY_POLICIES.it)).toEqual(expected);
		expect(PRIVACY_POLICIES.en.pills.map((pill) => pill.icon)).toEqual(PRIVACY_POLICIES.pt.pills.map((pill) => pill.icon));
		expect(PRIVACY_POLICIES.it.pills.map((pill) => pill.icon)).toEqual(PRIVACY_POLICIES.pt.pills.map((pill) => pill.icon));
	});

	it.each(LANGUAGES)('em %s, o e-mail de contato aparece as mesmas vezes que em pt', (language) => {
		const count = (policy: PrivacyPolicy) => JSON.stringify(policy).split('vinicosta37@gmail.com').length - 1;
		expect(count(PRIVACY_POLICIES.pt)).toBe(2);
		expect(count(PRIVACY_POLICIES[language])).toBe(2);
	});

	it.each(LANGUAGES)('o html em %s tem as mesmas seções e o mesmo texto da tela', (language) => {
		const policy = PRIVACY_POLICIES[language];
		const sections = htmlSections(readHtml(language));
		expect(sections).toHaveLength(policy.sections.length);
		sections.forEach((section, index) => {
			const expected = policy.sections[index];
			expect(section.icon).toBe(expected.icon);
			expect(section.title).toBe(expected.title);
			expect(section.paragraphs).toEqual(paragraphs(expected));
		});
	});

	it.each(LANGUAGES)('o html em %s tem o título, a introdução, a data e os destaques da tela', (language) => {
		const policy = PRIVACY_POLICIES[language];
		const html = readHtml(language);
		const hero = html.slice(html.indexOf('<section class="hero">'), html.indexOf('</section>'));
		expect(decode(hero.match(/<h1>([\s\S]*?)<\/h1>/)?.[1] ?? '')).toBe(`${policy.title}${policy.accent}`);
		expect(decode(hero.match(/<p>([\s\S]*?)<\/p>/)?.[1] ?? '')).toBe(policy.intro);
		expect(decode(hero.match(/<div class="updated">([\s\S]*?)<\/div>/)?.[1] ?? '')).toBe(policy.updated);
		const labels = [...html.matchAll(/<div class="label">([\s\S]*?)<\/div>/g)].map((match) => decode(match[1]));
		expect(labels).toEqual(policy.pills.map((pill) => pill.label));
	});

	it.each(LANGUAGES)('o html em %s declara o idioma e tem links para as três versões', (language) => {
		const html = readHtml(language);
		expect(html).toContain(`<html lang="${HTML_FILES[language].lang}">`);
		for (const other of LANGUAGES) {
			expect(html).toContain(`href="./${HTML_FILES[other].file}"`);
		}
	});
});

describe('privacyPolicyFor', () => {
	it('escolhe a versão pelo idioma do app', () => {
		expect(privacyPolicyFor('en')).toBe(PRIVACY_POLICIES.en);
		expect(privacyPolicyFor('it')).toBe(PRIVACY_POLICIES.it);
		expect(privacyPolicyFor('pt')).toBe(PRIVACY_POLICIES.pt);
	});

	it('aceita a etiqueta com região', () => {
		expect(privacyPolicyFor('en-US')).toBe(PRIVACY_POLICIES.en);
		expect(privacyPolicyFor('pt-BR')).toBe(PRIVACY_POLICIES.pt);
	});

	it('sem versão no idioma (ou sem idioma), fica o português', () => {
		expect(privacyPolicyFor('de')).toBe(PRIVACY_POLICIES.pt);
		expect(privacyPolicyFor('')).toBe(PRIVACY_POLICIES.pt);
		expect(privacyPolicyFor(undefined)).toBe(PRIVACY_POLICIES.pt);
	});
});
