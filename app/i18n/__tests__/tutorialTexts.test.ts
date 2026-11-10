import { TOPICS, TOUR_GUIDES } from '../../utils/tour';
import en from '../locales/en';
import itLocale from '../locales/it';
import pt from '../locales/pt';

/**
 * Os textos do guia na tela (SPD-129) existem nos três idiomas: cada passo de cada guia, cada
 * tópico do "Como usar", as quatro boas-vindas e os botões. A paridade geral
 * (`localeParity.test.ts`) passa com a chave faltando nos três; aqui ela tem que existir, com
 * texto.
 */

const lookup = (locale: unknown, path: string): unknown =>
	path
		.split('.')
		.reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], locale);

const stepPaths = Object.entries(TOUR_GUIDES).flatMap(([screen, steps]) =>
	steps.flatMap((step) => [
		`tutorial.steps.${screen}.${step.id}.title`,
		`tutorial.steps.${screen}.${step.id}.body`,
	])
);
const topicPaths = TOPICS.flatMap((topic) => [
	`tutorial.topics.${topic.id}.title`,
	`tutorial.topics.${topic.id}.body`,
]);
const welcomePaths = ['money', 'capture', 'cards', 'plan'].flatMap((slide) => [
	`welcome.slides.${slide}.title`,
	`welcome.slides.${slide}.body`,
]);
const buttonPaths = [
	'welcome.skip',
	'welcome.skipHint',
	'welcome.next',
	'welcome.start',
	'welcome.page',
	'tutorial.next',
	'tutorial.skip',
	'tutorial.skipHint',
	'tutorial.done',
	'tutorial.counter',
	'tutorial.counterLabel',
	'tutorial.help',
	'tutorial.helpHint',
	'tutorial.helpTopicHint',
	'tutorial.notice.title',
	'tutorial.notice.body',
	'tutorial.notice.see',
	'tutorial.notice.seeHint',
	'tutorial.notice.later',
	'tutorial.howTo.settingsItem',
	'tutorial.howTo.title',
	'tutorial.howTo.back',
	'tutorial.howTo.showOnScreen',
	'tutorial.howTo.showOnScreenHint',
	'tutorial.howTo.reviewWelcome',
];

describe('textos do guia na tela', () => {
	it.each([
		...stepPaths,
		...topicPaths,
		...welcomePaths,
		...buttonPaths,
	])('%s existe nos três idiomas', (path) => {
		for (const locale of [pt, en, itLocale]) {
			const value = lookup(locale, path);
			expect(typeof value).toBe('string');
			expect((value as string).trim().length).toBeGreaterThan(0);
		}
	});

	it('o contador mostra o passo e o total nos três idiomas', () => {
		for (const locale of [pt, en, itLocale]) {
			for (const text of [
				locale.tutorial.counter,
				locale.tutorial.counterLabel,
				locale.welcome.page,
			]) {
				expect(text).toContain('{{current}}');
				expect(text).toContain('{{total}}');
			}
		}
	});

	it('as boas-vindas antigas saíram (os textos genéricos de antes)', () => {
		for (const locale of [pt, en, itLocale]) {
			expect(lookup(locale, 'welcome.trackExpenses')).toBeUndefined();
			expect(lookup(locale, 'welcome.getStarted')).toBeUndefined();
		}
	});

	it('o português é o texto aprovado (as boas-vindas e o aviso)', () => {
		expect(pt.welcome.slides.money.title).toBe('Seu dinheiro como o banco mostra');
		expect(pt.welcome.slides.plan.body).toContain('Ajustes › Como usar');
		expect(pt.tutorial.notice.title).toBe('Novo: Como usar o Spendr');
		expect(pt.tutorial.notice.see).toBe('Ver');
		expect(pt.tutorial.notice.later).toBe('Agora não');
	});
});
