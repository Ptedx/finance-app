/**
 * De onde veio o dinheiro: a conta ou cartão por trás de cada captura.
 *
 * O usuário nunca cadastra conta na mão para começar. A primeira notificação de cada
 * app do banco cria a conta; a primeira compra no crédito com "final 1234" cria o
 * cartão; o primeiro import de extrato cria (ou adota) a conta daquele OFX. Depois
 * disso tudo cai no lugar sozinho, e o que sobra para o usuário é dar nome, informar o
 * saldo atual e, nos cartões, o dia de fechamento.
 *
 * Adotar em vez de duplicar: o extrato do Nubank e as notificações do Nubank são a
 * mesma conta. Quando o OFX chega e já existe uma conta do mesmo banco criada por
 * notificação, sem chave de extrato, ela ganha a chave em vez de nascer uma segunda.
 */

import {
	addAccount,
	findAccountByKey,
	findAccountBySource,
	getAccounts,
	updateAccount,
} from '../database/database';
import { type Account, type AccountKind, defaultRoleFor } from '../database/schema';
import { brandFor, NEUTRAL_CARD_COLOR } from './bankBrands';
import { normalizeText, type ParsedCapture, type RawCapture } from './captureParser';
import { addDays, todayISO } from './dateUtils';
import type { OfxAccount } from './ofxParser';

export const ACCOUNT_COLORS: Record<AccountKind, string> = {
	checking: '#15E8FE',
	savings: '#4CAF50',
	investment: '#FFD166',
	cash: '#A0E7A0',
	credit_card: '#FF6B6B',
};

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
 * Se a notificação é de uma compra no crédito. O final do cartão sozinho não basta:
 * o débito do Inter também diz "cartão final 1234". Precisa da palavra "crédito" sem
 * a palavra "débito" por perto.
 */
export const isCreditCardNotification = (raw: RawCapture, parsed: ParsedCapture): boolean => {
	if (!parsed.cardLast4) return false;
	const text = normalizeText(`${raw.title} ${raw.text}`);
	return text.includes('credito') && !text.includes('debito');
};

const yesterday = (): string => addDays(todayISO(), -1);

const newAccountDraft = (
	partial: Pick<Account, 'name' | 'kind' | 'bankName' | 'last4' | 'packageName' | 'accountKey'> &
		Partial<Pick<Account, 'openingBalanceCents' | 'openingBalanceDate'>>
) => ({
	name: partial.name,
	kind: partial.kind,
	role: defaultRoleFor(partial.kind),
	envelopeMonthlyCents: null,
	network: null,
	bankName: partial.bankName,
	// A cor do banco quando ele é conhecido: o Nubank roxo, o Inter laranja. É o que
	// deixa o cartão reconhecível de relance na tela inicial.
	color: brandFor(partial.bankName)?.color ?? (partial.kind === 'credit_card' ? NEUTRAL_CARD_COLOR : ACCOUNT_COLORS[partial.kind]),
	last4: partial.last4,
	closingDay: null,
	closingDaysBefore: null,
	dueDay: null,
	creditLimitCents: null,
	packageName: partial.packageName,
	accountKey: partial.accountKey,
	openingBalanceCents: partial.openingBalanceCents ?? 0,
	openingBalanceDate: partial.openingBalanceDate ?? yesterday(),
	sortOrder: 0,
	archived: false,
});

/**
 * A conta de uma notificação: o cartão de crédito com aquele final, ou a conta
 * corrente daquele app. Cria na primeira vez.
 */
export const resolveAccountForNotification = async (
	raw: RawCapture,
	parsed: ParsedCapture
): Promise<Account> => {
	const isCard = isCreditCardNotification(raw, parsed);
	const last4 = isCard ? parsed.cardLast4 : null;

	const existing = await findAccountBySource(raw.packageName, last4);
	if (existing) return existing;

	// Um cartão de extrato (OFX) do mesmo banco e mesmo final, ainda sem app: adota.
	if (isCard && last4) {
		const twin = (await getAccounts()).find(
			(account) =>
				account.kind === 'credit_card' &&
				account.last4 === last4 &&
				account.packageName === null &&
				sameBank(account.bankName, raw.appLabel)
		);
		if (twin) {
			await updateAccount({ ...twin, packageName: raw.packageName });
			return { ...twin, packageName: raw.packageName };
		}
	} else {
		const twin = (await getAccounts()).find(
			(account) =>
				account.kind !== 'credit_card' &&
				account.packageName === null &&
				account.accountKey !== null &&
				sameBank(account.bankName, raw.appLabel)
		);
		if (twin) {
			await updateAccount({ ...twin, packageName: raw.packageName });
			return { ...twin, packageName: raw.packageName };
		}
	}

	const id = await addAccount(
		newAccountDraft({
			name: isCard && last4 ? `${raw.appLabel} · final ${last4}` : raw.appLabel,
			kind: isCard ? 'credit_card' : 'checking',
			bankName: raw.appLabel,
			last4,
			packageName: raw.packageName,
			accountKey: null,
		})
	);
	const created = (await getAccounts()).find((account) => account.id === id);
	if (!created) throw new Error('Account was not created');
	return created;
};

const last4OfAcctId = (acctId: string): string | null => {
	const digits = acctId.replace(/\D/g, '');
	return digits.length >= 4 ? digits.slice(-4) : null;
};

/**
 * A conta de um extrato OFX. Cria na primeira vez, ou adota uma conta do mesmo banco
 * que veio das notificações e ainda não tem chave de extrato. Em contas que não são
 * cartão, o `LEDGERBAL` do arquivo vira a âncora do saldo quando é mais novo que a
 * âncora atual — o banco sabe o saldo melhor que qualquer estimativa.
 */
export const resolveAccountForStatement = async (statement: OfxAccount): Promise<Account> => {
	const existing = await findAccountByKey(statement.accountKey);
	if (existing) {
		return maybeAnchorFromStatement(existing, statement);
	}

	const last4 = statement.isCard ? last4OfAcctId(statement.acctId) : null;
	const all = await getAccounts();
	const twin = all.find((account) =>
		statement.isCard
			? account.kind === 'credit_card' &&
				account.accountKey === null &&
				sameBank(account.bankName, statement.bankName) &&
				(last4 === null || account.last4 === null || account.last4 === last4)
			: account.kind !== 'credit_card' &&
				account.accountKey === null &&
				sameBank(account.bankName, statement.bankName)
	);

	if (twin) {
		const adopted: Account = { ...twin, accountKey: statement.accountKey, last4: twin.last4 ?? last4 };
		await updateAccount(adopted);
		return maybeAnchorFromStatement(adopted, statement);
	}

	const anchor =
		!statement.isCard && statement.ledgerBalanceCents !== null && statement.ledgerDate !== null
			? { openingBalanceCents: statement.ledgerBalanceCents, openingBalanceDate: statement.ledgerDate }
			: {};

	const id = await addAccount(
		newAccountDraft({
			name: statement.isCard
				? `${statement.bankName} · cartão${last4 ? ` final ${last4}` : ''}`
				: `${statement.bankName} · conta`,
			kind: statement.isCard ? 'credit_card' : 'checking',
			bankName: statement.bankName,
			last4,
			packageName: null,
			accountKey: statement.accountKey,
			...anchor,
		})
	);
	const created = (await getAccounts()).find((account) => account.id === id);
	if (!created) throw new Error('Account was not created');
	return created;
};

const maybeAnchorFromStatement = async (account: Account, statement: OfxAccount): Promise<Account> => {
	if (statement.isCard || statement.ledgerBalanceCents === null || statement.ledgerDate === null) {
		return account;
	}
	if (statement.ledgerDate <= account.openingBalanceDate) return account;

	const anchored: Account = {
		...account,
		openingBalanceCents: statement.ledgerBalanceCents,
		openingBalanceDate: statement.ledgerDate,
	};
	await updateAccount(anchored);
	return anchored;
};

/** Mesmo banco: mesmo app de notificação ou mesmo nome de banco. */
const sameSource = (a: Account, b: Account): boolean =>
	(a.packageName !== null && a.packageName === b.packageName) || sameBank(a.bankName, b.bankName);

/**
 * O cartão que uma conta corrente paga. Só quando não há dúvida: um único cartão ativo
 * do mesmo banco. Com dois cartões, o pagamento da fatura fica como transferência para
 * "fora", e o usuário indica o cartão ao revisar.
 */
export const findCardForInvoice = async (checking: Account): Promise<Account | null> => {
	const cards = (await getAccounts()).filter(
		(account) => account.kind === 'credit_card' && !account.archived && !account.deletedAt && sameSource(account, checking)
	);
	return cards.length === 1 ? cards[0] : null;
};

/**
 * A conta corrente que paga um cartão: o inverso de `findCardForInvoice`, para o
 * "Pagamento recebido" que aparece no cartão.
 *
 * Contas externas não pagam o cartão pessoal: a Nubank PJ é do mesmo banco que o
 * cartão, mas quem paga é a Nubank PF. Sobrando mais de uma, vence a principal.
 */
export const findCheckingForCard = async (card: Account): Promise<Account | null> => {
	const candidates = (await getAccounts()).filter(
		(account) =>
			account.kind === 'checking' &&
			!account.archived &&
			!account.deletedAt &&
			account.role !== 'external' &&
			sameSource(account, card)
	);
	if (candidates.length === 1) return candidates[0];
	const main = candidates.filter((account) => account.role === 'main');
	return main.length === 1 ? main[0] : null;
};

export default {
	resolveAccountForNotification,
	resolveAccountForStatement,
	findCardForInvoice,
	findCheckingForCard,
	isCreditCardNotification,
	sameBank,
	ACCOUNT_COLORS,
};
