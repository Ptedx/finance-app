/**
 * As categorias padrão no idioma do app (SPD-088, E2E-11).
 *
 * As 16 nascem em inglês (o app e o servidor semeiam "Food", "Other Expense",
 * "Pass-through"…) e nunca mudavam: com o app em português, o formulário, os lançamentos e
 * os relatórios mostravam tudo em inglês. Aqui a regra pura: qual nome cada categoria padrão
 * ganha, e quando ela não é tocada.
 *
 * A regra de quem pode ser renomeado depende de o idioma ter sido **escolhido** (guardado, e
 * por isso o mesmo em todos os aparelhos da conta) ou só **detectado** no aparelho. O teste
 * do vai-e-volta entre dois aparelhos está no fim.
 */

jest.mock('../../database/database', () => ({
	getCategoriesForBackup: jest.fn(),
	renameDefaultCategories: jest.fn(),
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
	getItem: jest.fn(async () => null),
}));

jest.mock('expo-localization', () => ({ getLocales: jest.fn(() => [{ languageCode: 'pt' }]) }));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { getLocales } from 'expo-localization';
import { DEFAULT_CATEGORIES } from '../../database/schema';
import en from '../../i18n/locales/en';
import itLocale from '../../i18n/locales/it';
import pt from '../../i18n/locales/pt';
import {
	type CategoryLanguage,
	defaultCategoryName,
	planDefaultCategoryRenames,
	resolveCategoryLanguage,
} from '../defaultCategoryNames';

const CHOSEN_PT: CategoryLanguage = { code: 'pt', chosen: true };
const CHOSEN_EN: CategoryLanguage = { code: 'en', chosen: true };
const CHOSEN_IT: CategoryLanguage = { code: 'it', chosen: true };
const DEVICE_PT: CategoryLanguage = { code: 'pt', chosen: false };
const DEVICE_IT: CategoryLanguage = { code: 'it', chosen: false };

/** As linhas como o app e o servidor semeiam hoje: em inglês. */
const seeded = (): { id: string; name: string; deletedAt?: string }[] =>
	DEFAULT_CATEGORIES.map(({ id, name }) => ({ id, name }));

/** Aplica um plano a linhas em memória, como o banco faria. */
const apply = (
	rows: { id: string; name: string; deletedAt?: string }[],
	plan: { id: string; from: string; name: string }[]
) =>
	rows.map((row) => {
		const rename = plan.find((item) => item.id === row.id && item.from === row.name);
		return rename ? { ...row, name: rename.name } : row;
	});

describe('os nomes num lugar só', () => {
	it('toda categoria padrão tem nome nos três idiomas', () => {
		for (const locale of [pt, en, itLocale]) {
			for (const { id } of DEFAULT_CATEGORIES) {
				const name = (locale.defaultCategories as Record<string, string>)[id];
				expect(typeof name).toBe('string');
				expect(name.length).toBeGreaterThan(0);
			}
		}
	});

	it('o inglês é exatamente a semente do app (e a do servidor, que é cópia dela)', () => {
		for (const { id, name } of DEFAULT_CATEGORIES) {
			expect(defaultCategoryName(id, 'en')).toBe(name);
		}
	});

	it('os nomes do achado, em português', () => {
		expect(defaultCategoryName('other_expense', 'pt')).toBe('Outras despesas');
		expect(defaultCategoryName('shopping', 'pt')).toBe('Compras');
		expect(defaultCategoryName('passthrough', 'pt')).toBe('Repasse');
		expect(defaultCategoryName('food', 'pt')).toBe('Alimentação');
	});

	it('id que não é padrão ou idioma sem strings: sem nome', () => {
		expect(defaultCategoryName('minha', 'pt')).toBeNull();
		expect(defaultCategoryName('food', 'de')).toBeNull();
	});
});

describe('o que é renomeado', () => {
	it('app em português: as 16 semeadas em inglês passam para português (menos as iguais)', () => {
		const plan = planDefaultCategoryRenames(seeded(), CHOSEN_PT);

		// "Freelance" é igual nos dois idiomas: nada a fazer.
		expect(plan).toHaveLength(DEFAULT_CATEGORIES.length - 1);
		expect(plan).toContainEqual({
			id: 'other_expense',
			from: 'Other Expense',
			name: 'Outras despesas',
		});
		expect(plan).toContainEqual({ id: 'passthrough', from: 'Pass-through', name: 'Repasse' });
		expect(plan.find((item) => item.id === 'freelance')).toBeUndefined();
	});

	it('categoria que o usuário renomeou nunca é tocada', () => {
		const rows = seeded().map((row) => (row.id === 'food' ? { ...row, name: 'Mercado' } : row));

		const plan = planDefaultCategoryRenames(rows, CHOSEN_PT);

		expect(plan.find((item) => item.id === 'food')).toBeUndefined();
	});

	it('categoria criada pelo usuário com o nome de uma padrão também não: só os ids padrão', () => {
		const plan = planDefaultCategoryRenames([{ id: 'minha', name: 'Food' }], CHOSEN_PT);

		expect(plan).toEqual([]);
	});

	it('categoria apagada (lápide) fica como está', () => {
		const rows = [{ id: 'food', name: 'Food', deletedAt: '2026-11-01T00:00:00.000Z' }];

		expect(planDefaultCategoryRenames(rows, CHOSEN_PT)).toEqual([]);
	});

	it('idioma escolhido: troca de um idioma para outro, porque todos os aparelhos têm o mesmo', () => {
		const inPortuguese = apply(seeded(), planDefaultCategoryRenames(seeded(), CHOSEN_PT));

		const plan = planDefaultCategoryRenames(inPortuguese, CHOSEN_IT);

		expect(plan).toContainEqual({
			id: 'other_expense',
			from: 'Outras despesas',
			name: 'Altre spese',
		});
		const back = apply(
			apply(inPortuguese, plan),
			planDefaultCategoryRenames(apply(inPortuguese, plan), CHOSEN_EN)
		);
		expect(back.map((row) => row.name)).toEqual(
			DEFAULT_CATEGORIES.map((category) => category.name)
		);
	});

	it('idioma só detectado no aparelho: só sai do inglês da semente, nunca de outro idioma', () => {
		const inPortuguese = apply(seeded(), planDefaultCategoryRenames(seeded(), DEVICE_PT));
		expect(inPortuguese.find((row) => row.id === 'other_expense')?.name).toBe('Outras despesas');

		// Um aparelho em italiano, sem idioma escolhido, não desfaz o português de outro.
		expect(planDefaultCategoryRenames(inPortuguese, DEVICE_IT)).toEqual([]);
	});

	it('já no idioma: nada a fazer', () => {
		const inPortuguese = apply(seeded(), planDefaultCategoryRenames(seeded(), CHOSEN_PT));

		expect(planDefaultCategoryRenames(inPortuguese, CHOSEN_PT)).toEqual([]);
	});

	it('idioma sem strings no app: nada a fazer', () => {
		expect(planDefaultCategoryRenames(seeded(), { code: 'de', chosen: true })).toEqual([]);
	});
});

describe('dois aparelhos na mesma conta: sem vai-e-volta', () => {
	/** Cada aparelho localiza o que baixou da conta; a conta fica com a última escrita. */
	const converge = (languages: CategoryLanguage[], rounds = 6) => {
		let account = seeded();
		const renamesPerDevice = languages.map(() => 0);
		for (let round = 0; round < rounds; round += 1) {
			languages.forEach((language, device) => {
				const plan = planDefaultCategoryRenames(account, language);
				if (plan.length > 0) renamesPerDevice[device] += 1;
				account = apply(account, plan);
			});
		}
		return { account, renamesPerDevice };
	};

	it('idiomas só detectados e diferentes: o primeiro a localizar fica, o outro não briga', () => {
		const { account, renamesPerDevice } = converge([DEVICE_PT, DEVICE_IT]);

		expect(account.find((row) => row.id === 'other_expense')?.name).toBe('Outras despesas');
		expect(renamesPerDevice).toEqual([1, 0]);
	});

	it('idioma escolhido (o mesmo nos dois, porque ele vai pelo sync): uma troca só', () => {
		const { account, renamesPerDevice } = converge([CHOSEN_IT, CHOSEN_IT]);

		expect(account.find((row) => row.id === 'other_expense')?.name).toBe('Altre spese');
		expect(renamesPerDevice).toEqual([1, 0]);
	});

	it('um aparelho com o idioma escolhido e outro só detectado: o escolhido vale', () => {
		const { account, renamesPerDevice } = converge([DEVICE_IT, CHOSEN_PT]);

		expect(account.find((row) => row.id === 'other_expense')?.name).toBe('Outras despesas');
		expect(renamesPerDevice).toEqual([1, 1]);
	});
});

describe('qual idioma vale', () => {
	beforeEach(() => jest.clearAllMocks());

	it('o guardado (escolhido em Ajustes ou chegado pelo sync) é escolhido', async () => {
		(AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(
			JSON.stringify({ code: 'it', name: 'Italian' })
		);

		await expect(resolveCategoryLanguage()).resolves.toEqual({ code: 'it', chosen: true });
	});

	it('sem nada guardado, o do aparelho, como detectado', async () => {
		await expect(resolveCategoryLanguage()).resolves.toEqual({ code: 'pt', chosen: false });
	});

	it('aparelho num idioma sem strings: inglês, detectado', async () => {
		(getLocales as jest.Mock).mockReturnValueOnce([{ languageCode: 'de' }]);

		await expect(resolveCategoryLanguage()).resolves.toEqual({ code: 'en', chosen: false });
	});

	it('guardado ilegível ou de um idioma sem strings: cai no do aparelho', async () => {
		(AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('{quebrado');

		await expect(resolveCategoryLanguage()).resolves.toEqual({ code: 'pt', chosen: false });
	});
});
