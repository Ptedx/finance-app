import AsyncStorage from '@react-native-async-storage/async-storage';
import { getLocales } from 'expo-localization';
import { getCategoriesForBackup, renameDefaultCategories } from '../database/database';
import { DEFAULT_CATEGORIES } from '../database/schema';
import en from '../i18n/locales/en';
import itLocale from '../i18n/locales/it';
import pt from '../i18n/locales/pt';
import { STORAGE_KEYS } from './storageUtils';

/**
 * As categorias padrão no idioma do app (SPD-088, E2E-11).
 *
 * O app e o servidor semeiam as 16 em inglês ("Food", "Other Expense", "Pass-through"…) e o
 * nome nunca mudava: com o app em português, o formulário, os lançamentos e os relatórios
 * mostravam tudo em inglês. Os nomes por idioma ficam num lugar só (o bloco
 * `defaultCategories` das traduções), e a categoria padrão cujo nome ainda é um nome padrão
 * é renomeada para o idioma atual. A renomeação sobe pelo sync como qualquer edição; a
 * categoria que o usuário renomeou nunca é tocada.
 *
 * O vai-e-volta entre dois aparelhos da conta em idiomas diferentes. Cada aparelho localiza
 * o que baixou da conta, então a regra precisa ter um ponto fixo:
 * - idioma **escolhido** (guardado; chega também pelo sync, então é o mesmo em todos os
 *   aparelhos da conta): o nome padrão de qualquer idioma vai para ele;
 * - idioma só **detectado** no aparelho (nunca escolhido): só o inglês da semente vai para
 *   ele. Um aparelho em italiano não desfaz o português que outro deu — o primeiro a
 *   localizar fica, e ninguém briga.
 */

const NAMES_BY_LANGUAGE: Record<string, Record<string, string>> = {
	en: en.defaultCategories,
	pt: pt.defaultCategories,
	it: itLocale.defaultCategories,
};

const DEFAULT_IDS: ReadonlySet<string> = new Set(DEFAULT_CATEGORIES.map((category) => category.id));

/** O nome da semente (inglês), o que o app e o servidor gravam ao criar as padrão. */
const SEED_NAMES: ReadonlyMap<string, string> = new Map(
	DEFAULT_CATEGORIES.map((category) => [category.id, category.name])
);

/** O idioma em que as padrão devem estar, e se ele foi escolhido ou só detectado. */
export interface CategoryLanguage {
	code: string;
	chosen: boolean;
}

export interface DefaultCategoryRename {
	id: string;
	/** O nome que a linha tem agora; a troca só vale se ela ainda tiver este nome. */
	from: string;
	name: string;
}

/** O nome padrão de uma categoria num idioma, ou `null` se o id ou o idioma não têm. */
export const defaultCategoryName = (id: string, code: string): string | null =>
	(DEFAULT_IDS.has(id) && NAMES_BY_LANGUAGE[code]?.[id]) || null;

/** Os nomes que contam como "ainda o padrão" para uma categoria. */
const replaceableNames = (id: string, chosen: boolean): Set<string> => {
	const names = new Set<string>();
	const seed = SEED_NAMES.get(id);
	if (seed) names.add(seed);
	if (chosen) {
		for (const byId of Object.values(NAMES_BY_LANGUAGE)) {
			if (byId[id]) names.add(byId[id]);
		}
	}
	return names;
};

/** Quais categorias padrão trocam de nome, e para qual. Pura. */
export const planDefaultCategoryRenames = (
	rows: readonly { id: string; name: string; deletedAt?: string | null }[],
	language: CategoryLanguage
): DefaultCategoryRename[] => {
	const plan: DefaultCategoryRename[] = [];
	for (const row of rows) {
		if (row.deletedAt) continue;
		const target = defaultCategoryName(row.id, language.code);
		if (!target || row.name === target) continue;
		if (!replaceableNames(row.id, language.chosen).has(row.name)) continue;
		plan.push({ id: row.id, from: row.name, name: target });
	}
	return plan;
};

/**
 * O idioma do app, resolvido como o `LanguageContext` resolve: o guardado, se for um que o
 * app tem; senão o do aparelho; senão inglês. Lido aqui, e não do i18next, porque a abertura
 * roda antes de o contexto terminar de carregar o idioma.
 */
export const resolveCategoryLanguage = async (): Promise<CategoryLanguage> => {
	try {
		const saved = await AsyncStorage.getItem(STORAGE_KEYS.language);
		const code = saved ? (JSON.parse(saved) as { code?: unknown } | null)?.code : null;
		if (typeof code === 'string' && code in NAMES_BY_LANGUAGE) return { code, chosen: true };
	} catch {
		// Guardado ilegível: vale o do aparelho, como no `LanguageContext`.
	}
	try {
		const device = getLocales()[0]?.languageCode;
		if (device && device in NAMES_BY_LANGUAGE) return { code: device, chosen: false };
	} catch {
		// Sem o módulo de idioma: inglês.
	}
	return { code: 'en', chosen: false };
};

let running: Promise<number> = Promise.resolve(0);

/**
 * Põe as categorias padrão no idioma do app e devolve quantas trocaram de nome (quem chama
 * pede o sync quando passa de zero). Uma rodada por vez: a abertura, o pull e a troca de
 * idioma podem chegar juntos. Nunca lança — um nome em inglês não pode impedir o app de abrir.
 */
export const localizeDefaultCategories = (): Promise<number> => {
	const run = async (): Promise<number> => {
		try {
			const language = await resolveCategoryLanguage();
			const plan = planDefaultCategoryRenames(await getCategoriesForBackup(), language);
			return plan.length > 0 ? await renameDefaultCategories(plan) : 0;
		} catch (error) {
			console.warn('Categorias padrão: não deu para pôr no idioma do app:', error);
			return 0;
		}
	};
	running = running.then(run, run);
	return running;
};

/**
 * Todo arquivo sob app/ é tratado como rota pelo expo-router, e uma rota sem export
 * default é um módulo quebrado do ponto de vista dele. Este export existe só para
 * satisfazer essa exigência — nada navega para cá.
 */
export default {
	defaultCategoryName,
	planDefaultCategoryRenames,
	resolveCategoryLanguage,
	localizeDefaultCategories,
};
