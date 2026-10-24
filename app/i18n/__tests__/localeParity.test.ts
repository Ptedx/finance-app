import en from '../locales/en';
import itLocale from '../locales/it';
import pt from '../locales/pt';

/**
 * Os três idiomas têm que ter exatamente as mesmas chaves. Uma chave que existe só em
 * português aparece em inglês como o caminho cru ("reports.health.title") — e nada
 * apontava isso antes deste teste.
 */
const keyPaths = (value: unknown, prefix = ''): string[] => {
	if (typeof value !== 'object' || value === null) return [prefix];
	return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => keyPaths(child, prefix ? `${prefix}.${key}` : key));
};

const missing = (from: string[], into: string[]): string[] => {
	const set = new Set(into);
	return from.filter((key) => !set.has(key));
};

describe('paridade das traduções', () => {
	const enKeys = keyPaths(en);

	it('português tem todas as chaves do inglês, e só elas', () => {
		const ptKeys = keyPaths(pt);
		expect(missing(enKeys, ptKeys)).toEqual([]);
		expect(missing(ptKeys, enKeys)).toEqual([]);
	});

	it('italiano tem todas as chaves do inglês, e só elas', () => {
		const itKeys = keyPaths(itLocale);
		expect(missing(enKeys, itKeys)).toEqual([]);
		expect(missing(itKeys, enKeys)).toEqual([]);
	});

	// A captura parada e a etapa do onboarding (SPD-021). A paridade acima passa com as
	// três sem a chave; aqui a chave tem que existir, com texto, nos três idiomas.
	it.each([
		'captures.stalled_one',
		'captures.stalled_other',
		'captures.stalledAction',
		'captures.stalledHint',
		'captures.stalledDismiss',
		'onboardingCaptures.screenTitle',
		'onboardingCaptures.title',
		'onboardingCaptures.body',
		'onboardingCaptures.keepsOnly',
		'onboardingCaptures.enabled',
		'onboardingCaptures.skip',
		'onboardingCaptures.continue',
	])('%s existe nos três idiomas', (path) => {
		for (const locale of [pt, en, itLocale]) {
			const value = path
				.split('.')
				.reduce<unknown>(
					(node, key) => (node as Record<string, unknown> | undefined)?.[key],
					locale
				);
			expect(typeof value).toBe('string');
			expect((value as string).length).toBeGreaterThan(0);
		}
	});

	it('o aviso de captura parada mostra os dias nos três idiomas', () => {
		for (const locale of [pt, en, itLocale]) {
			expect(locale.captures.stalled_one).toContain('{{count}}');
			expect(locale.captures.stalled_other).toContain('{{count}}');
		}
	});
});
