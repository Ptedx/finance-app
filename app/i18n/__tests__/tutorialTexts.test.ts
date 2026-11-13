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
	// A dica rápida do "?" (SPD-135).
	'tutorial.tip.fullGuide',
	'tutorial.tip.toggleHint',
	'tutorial.tip.leaveTitle',
	'tutorial.tip.leaveBody',
	'tutorial.tip.leave',
	'tutorial.tip.stay',
	'accounts.adjust.helpTip',
	'accounts.adjust.helpTipBalanceOnly',
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
		expect(pt.welcome.slides.plan.body).toContain('Configurações › Como usar');
		expect(pt.tutorial.notice.title).toBe('Novo: Como usar o Spendr');
		expect(pt.tutorial.notice.see).toBe('Ver');
		expect(pt.tutorial.notice.later).toBe('Agora não');
	});
});

/**
 * O que a leitura do código desmentiu nos textos aprovados (SPD-139, conferência do SPD-131):
 * cada frase corrigida aponta para o nome que está na tela e diz o que o app faz de verdade.
 */
describe('textos do guia batem com o app (SPD-139)', () => {
	const locales = [
		['pt', pt],
		['en', en],
		['it', itLocale],
	] as const;
	const str = (locale: unknown, path: string): string => lookup(locale, path) as string;

	/** Todas as frases do guia: as boas-vindas e o bloco `tutorial` inteiro. */
	const guideTexts = (locale: unknown): string[] => {
		const walk = (node: unknown): string[] =>
			typeof node === 'string'
				? [node]
				: typeof node === 'object' && node !== null
					? Object.values(node).flatMap(walk)
					: [];
		return [...walk(lookup(locale, 'welcome')), ...walk(lookup(locale, 'tutorial'))];
	};

	it.each(locales)('%s: a engrenagem e os guias usam o nome da tela de configurações', (_, locale) => {
		const screen = str(locale, 'settings.screenTitle');
		expect(str(locale, 'tabs.settings')).toBe(screen);
		expect(str(locale, 'tutorial.steps.home.settings.title')).toBe(screen);
		expect(str(locale, 'welcome.slides.plan.body')).toContain(`${screen} › ${str(locale, 'tutorial.howTo.settingsItem')}`);
	});

	it('pt: nenhum texto do guia diz "Ajustes", nome que nenhuma tela mostra', () => {
		expect(guideTexts(pt).filter((text) => text.includes('Ajustes'))).toEqual([]);
		expect(pt.account.deleteSuccessPartial).not.toContain('Ajustes');
		expect(pt.cards.edit.debitNoAccount).not.toContain('Ajustes');
	});

	it.each(locales)('%s: o acerto da conta usa o nome do botão de verdade', (_, locale) => {
		const button = `"${str(locale, 'accounts.edit.setBalance')}"`;
		expect(str(locale, 'tutorial.topics.accounts.body')).toContain(button);
		expect(str(locale, 'tutorial.steps.settings.accounts.body')).toContain(button);
		expect(str(locale, 'accounts.unassignedScreen.beforeAnchorWarning_one')).toContain(button);
		expect(str(locale, 'accounts.unassignedScreen.beforeAnchorWarning_other')).toContain(button);
	});

	it('nenhum texto cita o botão "Definir saldo", que não existe', () => {
		for (const [, locale] of locales) {
			const texts = [
				...guideTexts(locale),
				str(locale, 'accounts.unassignedScreen.beforeAnchorWarning_one'),
				str(locale, 'accounts.unassignedScreen.beforeAnchorWarning_other'),
			];
			expect(texts.filter((text) => /Definir saldo|Set balance|Imposta saldo/.test(text))).toEqual([]);
		}
	});

	it.each(locales)('%s: "Já paguei" fica em Contas a pagar, e o app pergunta antes de lançar', (_, locale) => {
		const bills = str(locale, 'bills.title');
		const markPaid = `"${str(locale, 'bills.markPaid')}"`;
		const home = str(locale, 'tutorial.steps.home.bills.body');
		expect(home).toContain(bills);
		expect(home).toContain(markPaid);
		const topic = str(locale, 'tutorial.topics.bills.body');
		expect(topic).toContain(markPaid);
		expect(topic).toContain(`"${str(locale, 'bills.pay.post')}"`);
	});

	it('"Já paguei" não promete mais que a saída sempre vai para a conta', () => {
		expect(guideTexts(pt).filter((text) => text.includes('a saída vai para a conta escolhida'))).toEqual([]);
		expect(guideTexts(en).filter((text) => text.includes('comes out of the account you chose'))).toEqual([]);
		expect(guideTexts(itLocale).filter((text) => text.includes("l'uscita va sul conto scelto"))).toEqual([]);
	});

	it.each(locales)('%s: a captura diz que compra de lugar novo espera 3 confirmações', (_, locale) => {
		for (const path of [
			'welcome.slides.capture.body',
			'tutorial.topics.capture.body',
			'tutorial.steps.settings.capture.body',
			'tutorial.steps.inbox.learned.body',
		]) {
			expect(str(locale, path)).toMatch(/\b3\b/);
		}
	});

	it('a revisão não promete corrigir o valor, nem que só o incerto vai para ela', () => {
		expect(pt.tutorial.topics.capture.body).not.toContain('o valor');
		expect(pt.tutorial.topics.capture.body).not.toContain('lança sozinho o que reconhece');
		expect(pt.tutorial.steps.settings.capture.body).not.toContain('lança sozinho o que reconhece');
		expect(pt.tutorial.steps.home.review.body).not.toContain('não teve certeza fica aqui');
		expect(en.tutorial.topics.capture.body).not.toContain('the amount');
		expect(en.tutorial.topics.capture.body).not.toContain('logs what it recognizes by itself');
		expect(itLocale.tutorial.topics.capture.body).not.toContain("l'importo");
		expect(itLocale.tutorial.topics.capture.body).not.toContain('registra da sola ciò che riconosce');
	});

	it('"Acertar valor" pergunta antes de lançar a diferença como encargo', () => {
		const old = [
			'a diferença vira encargo',
			'the difference becomes a charge',
			'la differenza diventa un onere',
		];
		for (const [, locale] of locales) {
			for (const path of ['tutorial.topics.invoice.body', 'tutorial.steps.card.adjust.body']) {
				const text = str(locale, path);
				for (const phrase of old) expect(text).not.toContain(phrase);
			}
		}
		expect(pt.tutorial.steps.card.adjust.body).toContain('pergunta');
		expect(en.tutorial.steps.card.adjust.body).toContain('asks');
		expect(itLocale.tutorial.steps.card.adjust.body).toContain('chiede');
	});

	it.each(locales)('%s: o orçamento explica "Gastos" × "Saiu"', (_, locale) => {
		const topic = str(locale, 'tutorial.topics.budget.body');
		expect(topic).toContain(`"${str(locale, 'month.spending')}"`);
		expect(topic).toContain(`"${str(locale, 'transactionsList.expense')}"`);
	});

	it.each(locales)('%s: a transferência tem o nome do botão do formulário', (_, locale) => {
		const button = str(locale, 'transactionForm.transfer.type');
		expect(str(locale, 'tutorial.steps.add.transfer.title')).toBe(button);
		expect(str(locale, 'tutorial.topics.add.body')).toContain(`"${button}"`);
	});

	it('o melhor dia de compra é dito como o dia do fechamento, com o nome da tela', () => {
		for (const [, locale] of locales) {
			expect(str(locale, 'tutorial.topics.cards.body').toLowerCase()).toContain(str(locale, 'cards.dates.best').toLowerCase());
		}
		expect(pt.tutorial.topics.cards.body).toMatch(/melhor dia de compra[^.]*fechamento/);
		expect(en.tutorial.topics.cards.body).toMatch(/best day to buy[^.]*clos/);
		expect(itLocale.tutorial.topics.cards.body).toMatch(/giorno migliore per acquistare[^.]*chius/);
	});

	it('a folha da reserva diz que o padrão é 12 meses', () => {
		for (const [, locale] of locales) expect(str(locale, 'reserve.sheet.monthsHint')).toMatch(/\b12\b/);
	});

	it('o extrato não promete confirmar o pendente sozinho', () => {
		expect(pt.tutorial.topics.ofx.body).not.toContain('confirma o que estava pendente');
		expect(en.tutorial.topics.ofx.body).not.toContain('confirms what was pending');
		expect(itLocale.tutorial.topics.ofx.body).not.toContain('conferma ciò che era in sospeso');
	});
});
