/**
 * O cadastro de conta serve para qualquer banco (SPD-121): os exemplos dos campos diziam
 * "ex.: Nubank conta corrente" e "ex.: Nubank". Como no cartão (SPD-109), nenhum texto do
 * formulário cita banco — o banco é o que a pessoa digita. Vale nos três idiomas.
 */

import { BANK_BRANDS } from '../../utils/bankBrands';
import en from '../locales/en';
import itLocale from '../locales/it';
import pt from '../locales/pt';

/** Todo texto de um bloco, com o caminho da chave. */
const stringsOf = (node: unknown, path: string): Array<[string, string]> => {
	if (typeof node === 'string') return [[path, node]];
	if (!node || typeof node !== 'object') return [];
	return Object.entries(node).flatMap(([key, value]) => stringsOf(value, `${path}.${key}`));
};

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Nome de banco como palavra inteira, com a grafia da marca ("Inter", não "interna"). */
const bankIn = (text: string): string | undefined =>
	BANK_BRANDS.map((brand) => brand.name).find((name) => new RegExp(`\\b${escapeRegExp(name)}\\b`).test(text));

describe.each([
	['pt', pt],
	['en', en],
	['it', itLocale],
])('%s', (_name, locale) => {
	it('nenhum texto do cadastro de conta cita um banco', () => {
		const found = stringsOf(locale.accounts.edit, 'accounts.edit')
			.map(([path, text]) => [path, bankIn(text)] as const)
			.filter(([, bank]) => bank !== undefined);
		expect(found).toEqual([]);
	});

	it('os exemplos do nome e do banco continuam lá, neutros', () => {
		expect(locale.accounts.edit.namePlaceholder).toMatch(/\S/);
		expect(locale.accounts.edit.bankPlaceholder).toMatch(/\S/);
		expect(locale.accounts.edit.namePlaceholder.toLowerCase()).not.toContain('nubank');
		expect(locale.accounts.edit.bankPlaceholder.toLowerCase()).not.toContain('nubank');
	});
});
