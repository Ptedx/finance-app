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
});
