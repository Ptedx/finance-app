/**
 * Para qual conta ou cartão vai uma notificação. Puro: recebe a lista de contas e o
 * texto, devolve a decisão. `accountResolver.ts` aplica no banco de dados.
 */

import type { Account, Capture } from '../database/schema';
import { brandFor } from './bankBrands';
import { isWalletPackage, normalizeText, type ParsedCapture, type RawCapture } from './captureParser';

/** "Nu" e "Nubank", "Inter" e "Banco Inter": o mesmo banco, escrito de dois jeitos. */
export const sameBank = (a: string | null, b: string | null): boolean => {
	if (!a || !b) return false;
	const x = normalizeText(a).replace(/^banco\s+/, '');
	const y = normalizeText(b).replace(/^banco\s+/, '');
	if (x === y) return true;
	const [short, long] = x.length <= y.length ? [x, y] : [y, x];
	return short.length >= 2 && long.startsWith(short);
};

/**
 * O que a notificação diz sobre a modalidade. "Compra no crédito aprovada" e "Compra no
 * débito aprovada" são claras; o Nubank também manda só "Compra aprovada … para o cartão
 * com final 2513", e o Inter manda "Compra aprovada no cartão final 5678" no débito.
 */
export type CardHint = 'credit' | 'debit' | 'unknown';

export const cardHintOf = (raw: Pick<RawCapture, 'title' | 'text'>): CardHint => {
	const text = normalizeText(`${raw.title} ${raw.text}`);
	const credit = text.includes('credito');
	const debit = text.includes('debito');
	if (credit && !debit) return 'credit';
	if (debit && !credit) return 'debit';
	return 'unknown';
};

/** Compat: só o que a notificação afirma com todas as letras. */
export const isCreditCardNotification = (raw: RawCapture, parsed: ParsedCapture): boolean =>
	parsed.cardLast4 !== null && cardHintOf(raw) === 'credit';

const DEBIT_NAME = /\bdebito\b/;

/** O banco aparece no texto? "… com Nubank final 1234", no aviso do Samsung Pay. */
const textMentionsBank = (text: string, bankName: string | null): boolean => {
	if (!bankName) return false;
	const name = normalizeText(bankName).replace(/^banco\s+/, '');
	const aliases = [name, ...(brandFor(bankName)?.aliases ?? [])].filter((alias) => alias.length >= 3);
	return aliases.some((alias) => new RegExp(`(^|[^a-z0-9])${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(text));
};

export type NotificationTarget =
	| { type: 'card'; account: Account }
	| { type: 'new_card' }
	| { type: 'checking' };

/**
 * Para onde vai uma compra com final de cartão. Puro, para ser testado caso a caso.
 *
 * 1. Um cartão de crédito com exatamente aquele final: ele.
 * 2. Senão, o **único** cartão de crédito ativo daquele banco. É o caso dos cartões
 *    virtuais do Nubank: cada loja tem um final (2513, 6422) e todos caem na mesma
 *    fatura do cartão físico. Um "cartão" com "débito" no nome não conta — é um débito
 *    cadastrado como cartão por engano, e débito não tem fatura.
 * 3. Sem cartão do banco: se a notificação diz "crédito", nasce um cartão; se diz
 *    "débito" ou não diz nada, é a conta corrente (o débito do Inter não diz a palavra).
 *
 * Aviso de carteira (Samsung Pay, Google Wallet) não é do banco: o banco sai do texto.
 */
export const pickNotificationTarget = (
	accounts: Account[],
	notification: { packageName: string; appLabel: string; title: string; text: string; cardLast4: string | null }
): NotificationTarget => {
	const hint = cardHintOf(notification);
	if (!notification.cardLast4 || hint === 'debit') return { type: 'checking' };

	const wallet = isWalletPackage(notification.packageName);
	const text = normalizeText(`${notification.title} ${notification.text}`);
	const cards = accounts.filter(
		(account) =>
			account.kind === 'credit_card' &&
			!account.archived &&
			!account.deletedAt &&
			!DEBIT_NAME.test(normalizeText(`${account.name} ${account.bankName ?? ''}`))
	);
	const ofBank = cards.filter((card) =>
		wallet
			? textMentionsBank(text, card.bankName)
			: (card.packageName !== null && card.packageName === notification.packageName) ||
				sameBank(card.bankName, notification.appLabel)
	);

	const exact = (wallet ? cards : ofBank).find((card) => card.last4 === notification.cardLast4);
	if (exact) return { type: 'card', account: exact };
	if (ofBank.length === 1) return { type: 'card', account: ofBank[0] };
	if (hint === 'credit' && !wallet && ofBank.length === 0) return { type: 'new_card' };
	return { type: 'checking' };
};

/** Nome que o app dá a um cartão criado sozinho por notificação: "Nubank · final 2513". */
const AUTO_CARD_NAME = / · final \d{4}$/;

export interface LedgerRepairPlan {
	/** Cartões criados por final de cartão virtual, a juntar no cartão de verdade do banco. */
	mergeCards: Array<{ fromId: string; toId: string }>;
	/** Compras com final de cartão que caíram na conta corrente e são do cartão. */
	moveCaptures: Array<{ captureId: string; transactionId: string | null; toId: string }>;
}

/**
 * Conserta o que as regras antigas fizeram com compras já registradas.
 *
 * Antes, cada final de cartão virtual do Nubank (2513, 6422…) virava um cartão próprio,
 * sem fechamento e fora da fatura; e "Compra aprovada" sem a palavra "crédito" ia para a
 * conta corrente. Aqui as mesmas regras de hoje (`pickNotificationTarget`) são aplicadas
 * ao que já existe. Puro e idempotente: rodar de novo não acha mais nada.
 *
 * - Cartão criado sozinho (nome "· final 1234", sem fechamento nem limite) é juntado ao
 *   único cartão configurado do mesmo banco, quando há exatamente um.
 * - Captura com final de cartão, confirmada ou pendente, numa conta que não é cartão, vai
 *   para o cartão que as regras de hoje escolheriam.
 */
export const planLedgerRepair = (accounts: Account[], captures: Capture[]): LedgerRepairPlan => {
	const live = accounts.filter((account) => !account.deletedAt);
	const autoCards = live.filter(
		(account) =>
			account.kind === 'credit_card' &&
			AUTO_CARD_NAME.test(account.name) &&
			account.closingDay === null &&
			account.creditLimitCents === null
	);
	const autoIds = new Set(autoCards.map((card) => card.id));
	const realAccounts = live.filter((account) => !autoIds.has(account.id));

	const mergeCards: LedgerRepairPlan['mergeCards'] = [];
	const mergedInto = new Map<string, string>();
	for (const auto of autoCards) {
		const candidates = realAccounts.filter(
			(account) =>
				account.kind === 'credit_card' &&
				!account.archived &&
				!DEBIT_NAME.test(normalizeText(`${account.name} ${account.bankName ?? ''}`)) &&
				((auto.packageName !== null && account.packageName === auto.packageName) || sameBank(account.bankName, auto.bankName))
		);
		if (candidates.length === 1) {
			mergeCards.push({ fromId: auto.id, toId: candidates[0].id });
			mergedInto.set(auto.id, candidates[0].id);
		}
	}

	const byId = new Map(live.map((account) => [account.id, account]));
	const moveCaptures: LedgerRepairPlan['moveCaptures'] = [];
	for (const capture of captures) {
		if (capture.status !== 'confirmed' && capture.status !== 'pending') continue;
		if (!capture.cardLast4 || !capture.accountId || mergedInto.has(capture.accountId)) continue;
		const current = byId.get(capture.accountId);
		if (!current || current.kind === 'credit_card') continue;

		const decided = pickNotificationTarget(realAccounts, capture);
		if (decided.type === 'card' && decided.account.id !== capture.accountId) {
			moveCaptures.push({ captureId: capture.id, transactionId: capture.transactionId, toId: decided.account.id });
		}
	}

	return { mergeCards, moveCaptures };
};
