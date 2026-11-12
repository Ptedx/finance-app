import en from '../../i18n/locales/en';
import itLocale from '../../i18n/locales/it';
import pt from '../../i18n/locales/pt';
import { planTrail, TRAILS, type TrailRecords } from '../trails';

/**
 * Toda chave `trails.*` que o guia pode mostrar existe, com texto, em português, inglês e
 * italiano (SPD-131): os títulos e textos de cada passo, o texto do `[sem dado]`, os textos
 * das trilhas sem dado (sem cartão, iPhone, revisão vazia) e os botões do balão.
 */

const read = (locale: unknown, path: string): unknown =>
	path
		.split('.')
		.reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], locale);

const everything: TrailRecords = {
	account: [{ id: 'a' }],
	capturedAccount: [{ id: 'a' }],
	feedAccount: [{ id: 'a' }],
	businessAccount: [{ id: 'a' }],
	card: [{ id: 'c' }],
	cardNoClosing: [{ id: 'c' }],
	otherCard: [{ id: 'd' }],
	debitCard: [{ accountId: 'a', last4: '1' }],
	transaction: [{ id: 't' }],
	pending: [{}],
	capture: [{}],
};

/** As chaves de todos os planos: com tudo, sem nada (os `[sem dado]`) e as trilhas de fallback. */
const usedKeys = (): string[] => {
	const keys = new Set<string>([
		'trails.back',
		'trails.backHint',
		'trails.skipHint',
		'trails.attention',
		'trails.help',
		'trails.helpHint',
	]);
	for (const trail of Object.values(TRAILS)) {
		keys.add(`trails.${trail.id}.title`);
		for (const records of [everything, {}]) {
			for (const step of planTrail(trail, records, { screen: 'home' })) {
				keys.add(step.titleKey);
				keys.add(step.bodyKey);
				if (step.altBodyKey) keys.add(step.altBodyKey);
			}
		}
	}
	return [...keys].sort();
};

describe('textos das trilhas', () => {
	const keys = usedKeys();

	it('as trilhas 1 a 7 usam ao menos um título e um texto por passo', () => {
		expect(keys.filter((key) => key.endsWith('.title')).length).toBeGreaterThan(70);
	});

	it.each([
		['pt', pt],
		['en', en],
		['it', itLocale],
	])('%s tem todas as chaves trails.*, com texto', (_name, locale) => {
		const missing = keys.filter((key) => {
			const value = read(locale, key);
			return typeof value !== 'string' || value.trim() === '';
		});
		expect(missing).toEqual([]);
	});

	it('os textos aprovados do português, sem os marcadores [F..]', () => {
		const values = keys.map((key) => String(read(pt, key)));
		expect(values.filter((value) => /\[F\d+\]|`/.test(value))).toEqual([]);
		expect(read(pt, 'trails.accounts.steps.4.body')).toBe(
			'Principal é onde a renda cai: Pix e débito saindo dela são gastos do mês. Envelope (a caixinha de gastos) tem um valor por mês: esse valor (ou o que você mandar, se for mais) é o gasto do mês, e o que se gasta lá dentro não soma de novo.'
		);
		expect(read(pt, 'trails.accounts.steps.9.missing')).toBe(
			"Na tela de cada conta, 'Acertar com o banco' iguala o saldo do app ao do banco."
		);
		expect(read(pt, 'trails.review.steps.11.title')).toBe('Histórico.');
	});
});
