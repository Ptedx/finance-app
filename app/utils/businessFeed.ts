import type { Account } from '../database/schema';
import { feedOwnerOf, siblingsOf } from './accountBinding';
import type { RawCapture } from './captureParser';

/**
 * Os avisos da conta PJ (SPD-074, DEC-34).
 *
 * PF e PJ do mesmo banco moram no mesmo app, e o vínculo da conta com o app
 * (`packageName`) só aponta para uma ficha. Mas há banco que diz no aviso quando ele é da
 * PJ: o Nubank escreve "Pix de R$ 50,00 da conta Nu Empresas foi realizado". O usuário
 * diz qual ficha é essa conta ("Avisos da Nu Empresas entram aqui"), e o resolvedor manda
 * para ela o aviso marcado. A escolha mora numa preferência (`businessFeedPreference.ts`);
 * aqui fica só o que é puro, para o resolvedor não depender do AsyncStorage.
 */

/** Qual ficha recebe os avisos da PJ de cada app: `{ [packageName]: accountId }`. */
export type BusinessFeeds = Record<string, string>;

/**
 * Como cada banco marca o aviso da PJ. Só entra o que já se viu num aviso de verdade
 * (DEC-12): marca inventada mandaria a compra da PF para a PJ.
 */
const BUSINESS_MARKERS: ReadonlyMap<string, { label: string; pattern: RegExp }> = new Map([
	['com.nu.production', { label: 'Nu Empresas', pattern: /\bnu empresas\b/i }],
]);

/** O nome da conta PJ no aviso deste app ("Nu Empresas"), ou `null` se ele não marca. */
export const businessLabelOf = (packageName: string | null): string | null =>
	packageName ? (BUSINESS_MARKERS.get(packageName)?.label ?? null) : null;

/** O aviso diz que veio da conta PJ. */
export const isBusinessNotice = (raw: Pick<RawCapture, 'packageName' | 'title' | 'text'>): boolean =>
	BUSINESS_MARKERS.get(raw.packageName)?.pattern.test(`${raw.title} ${raw.text}`) ?? false;

/**
 * A ficha marcada como PJ deste app, se ainda serve: viva, sem arquivar e conta corrente.
 * Senão `null`, e o aviso segue o caminho de sempre.
 */
export const businessAccountOf = (accounts: Account[], feeds: BusinessFeeds, packageName: string): Account | null =>
	accounts.find(
		(account) =>
			account.id === feeds[packageName] &&
			!account.deletedAt &&
			!account.archived &&
			account.kind !== 'credit_card'
	) ?? null;

export interface BusinessFeedPlan {
	packageName: string;
	/** "Nu Empresas". */
	label: string;
	/**
	 * Para onde vai o resto dos avisos do app. Quando a PJ era quem recebia tudo, os avisos
	 * da conta pessoal passam para a outra ficha do banco, se houver uma só; com mais de uma
	 * o app não escolhe (a mesma regra de `feedOwnerOf`).
	 */
	moveFeedTo: Account | null;
}

/** O que muda ao tocar "Avisos da Nu Empresas entram aqui" nesta conta. */
export const planBusinessFeed = (accounts: Account[], accountId: string): BusinessFeedPlan | null => {
	const target = accounts.find((account) => account.id === accountId);
	if (!target || target.kind === 'credit_card') return null;
	const owner = feedOwnerOf(accounts, target);
	const packageName = owner?.packageName ?? null;
	const label = businessLabelOf(packageName);
	if (!owner || !packageName || !label) return null;

	const others = siblingsOf(accounts, target);
	const moveFeedTo = owner.id === target.id && others.length === 1 ? others[0] : null;
	return { packageName, label, moveFeedTo };
};

export default { businessLabelOf, isBusinessNotice, businessAccountOf, planBusinessFeed };
