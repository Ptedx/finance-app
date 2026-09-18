/**
 * Cartões de uma conta: o plástico e os virtuais de uma conta de crédito, ou os de débito
 * de uma conta corrente.
 *
 * A **fatura é da conta**. No Nubank o físico e os virtuais (o do iFood/99, o de
 * assinaturas) caem na mesma fatura; o que muda é qual cartão gastou. Cada lançamento
 * guarda o final (`transactions.cardLast4`) e a conta guarda o nome que o usuário deu a
 * cada final (`accounts.cardNames`, JSON). Um final sem nome aparece como "final 6422".
 *
 * Puro e testado.
 */

import type { Account } from '../database/schema';
import { normalizeText } from './captureParser';
import { sameBank } from './notificationTarget';

export type CardNames = Record<string, string>;

export const parseCardNames = (json: string | null | undefined): CardNames => {
	if (!json) return {};
	try {
		const parsed: unknown = JSON.parse(json);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
		const names: CardNames = {};
		for (const [last4, name] of Object.entries(parsed as Record<string, unknown>)) {
			if (/^\d{4}$/.test(last4) && typeof name === 'string' && name.trim()) names[last4] = name.trim();
		}
		return names;
	} catch {
		return {};
	}
};

/** Chaves em ordem, para o mesmo conteúdo gerar sempre o mesmo texto (e não sujar o sync). */
export const serializeCardNames = (names: CardNames): string | null => {
	const keys = Object.keys(names).sort();
	if (keys.length === 0) return null;
	return JSON.stringify(Object.fromEntries(keys.map((key) => [key, names[key]])));
};

/** Dá (ou tira, com nome vazio) o nome de um final. */
export const withCardName = (json: string | null, last4: string, name: string | null): string | null => {
	const names = parseCardNames(json);
	const trimmed = name?.trim() ?? '';
	if (trimmed) names[last4] = trimmed;
	else delete names[last4];
	return serializeCardNames(names);
};

export interface CardUsage {
	/** Nulo: lançamentos sem cartão identificado (digitados à mão, extrato, ajuste). */
	last4: string | null;
	name: string | null;
	totalCents: number;
	count: number;
}

/**
 * Quanto cada cartão gastou num conjunto de lançamentos: compras somam, estornos
 * subtraem. Do maior para o menor gasto; os sem cartão por último. Finais com nome e sem
 * lançamento também aparecem (com zero), para o cartão não "sumir" num mês parado.
 */
export const usageByCard = (
	entries: Array<{ amountCents: number; isIncome: boolean; cardLast4?: string | null }>,
	cardNamesJson: string | null,
	primaryLast4: string | null = null
): CardUsage[] => {
	const names = parseCardNames(cardNamesJson);
	const byCard = new Map<string | null, CardUsage>();
	const ensure = (last4: string | null) => {
		let usage = byCard.get(last4);
		if (!usage) {
			usage = { last4, name: last4 ? (names[last4] ?? null) : null, totalCents: 0, count: 0 };
			byCard.set(last4, usage);
		}
		return usage;
	};

	for (const last4 of Object.keys(names)) ensure(last4);
	if (primaryLast4) ensure(primaryLast4);
	for (const entry of entries) {
		const usage = ensure(entry.cardLast4 ?? null);
		usage.totalCents += entry.isIncome ? -entry.amountCents : entry.amountCents;
		usage.count += 1;
	}

	return [...byCard.values()]
		.filter((usage) => usage.last4 !== null || usage.count > 0)
		.sort((a, b) => {
			if (a.last4 === null) return 1;
			if (b.last4 === null) return -1;
			return b.totalCents - a.totalCents || a.last4.localeCompare(b.last4);
		});
};

const DEBIT_NAME = /(^|[^a-z])debito([^a-z]|$)/;

export interface DebitCardConversion {
	card: Account;
	checking: Account;
	/** `cardNames` da conta corrente depois de receber o nome do cartão. */
	cardNames: string | null;
}

/**
 * "Cartões de crédito" que são débito ("Débito Inter"): débito não tem fatura, então os
 * lançamentos pertencem à conta corrente do mesmo banco, e o nome vira o nome do cartão
 * de débito dela. A conta é a única corrente do banco que não é externa, ou a principal.
 */
export const planDebitCardConversions = (accounts: Account[]): DebitCardConversion[] => {
	const live = accounts.filter((account) => !account.deletedAt);
	const plans: DebitCardConversion[] = [];

	for (const card of live) {
		if (card.kind !== 'credit_card') continue;
		if (!DEBIT_NAME.test(normalizeText(card.name))) continue;

		const candidates = live.filter(
			(account) =>
				account.kind === 'checking' &&
				!account.archived &&
				account.role !== 'external' &&
				((card.packageName !== null && account.packageName === card.packageName) || sameBank(account.bankName, card.bankName))
		);
		const main = candidates.filter((account) => account.role === 'main');
		const checking = candidates.length === 1 ? candidates[0] : main.length === 1 ? main[0] : null;
		if (!checking) continue;

		plans.push({
			card,
			checking,
			cardNames: card.last4 ? withCardName(checking.cardNames, card.last4, card.name) : checking.cardNames,
		});
	}
	return plans;
};

export default { parseCardNames, serializeCardNames, withCardName, usageByCard, planDebitCardConversions };
