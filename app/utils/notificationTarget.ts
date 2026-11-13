/**
 * Para qual conta ou cartão vai uma notificação. Puro: recebe a lista de contas e o
 * texto, devolve a decisão. `accountResolver.ts` aplica no banco de dados.
 */

import type { Account, Capture } from '../database/schema';
import { ambiguityOfReason } from './ambiguityReasons';
import { BANK_BRANDS, brandFor } from './bankBrands';
import {
	type CaptureKind,
	isWalletPackage,
	kindOfNotice,
	normalizeText,
	type ParsedCapture,
	type RawCapture,
} from './captureParser';

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

/** Os jeitos de escrever um banco: o nome (sem "Banco") e os apelidos da marca. */
const bankAliases = (bankName: string): string[] => [
	...new Set([normalizeText(bankName).replace(/^banco\s+/, ''), ...(brandFor(bankName)?.aliases ?? [])].filter(Boolean)),
];

/**
 * Quem mandou o aviso: o título do SMS, do e-mail, da conversa. Na carteira o título é a
 * loja ("IFOOD") ou "Pagamento aprovado", nunca o banco — lá não há remetente.
 */
const senderOf = (raw: { packageName?: string; title: string }): string | null =>
	raw.packageName !== undefined && isWalletPackage(raw.packageName) ? null : raw.title;

/**
 * O remetente é o banco: "Bradesco", "NUBANK", "Banco Inter", "Bradesco Cartões". Começar
 * pelo nome basta; ter o nome no meio, não — "Joao Inter" é um contato, não o Inter.
 */
const senderIsBank = (sender: string, bankName: string | null): boolean => {
	if (!bankName) return false;
	const who = normalizeText(sender)
		.replace(/[^a-z0-9 ]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/^banco /, '');
	return bankAliases(bankName).some((alias) => who === alias || (alias.length >= 3 && who.startsWith(`${alias} `)));
};

/**
 * O estabelecimento: o que vem depois de "em", "no", "na" até a vírgula, o ponto, o
 * "com", o "cartão", o "final" ou o valor. "no cartão", "na conta", "no banco" não são
 * loja. Sai do texto antes de procurar o banco: "LOJA INTER SHOPPING" não é o Inter.
 */
const MERCHANT =
	/\b(em|no|na|nos|nas) (?!(cartao|cartoes|credito|debito|valor|dia|seu|sua|app|aplicativo|pix|banco|conta|final)\b)[^,;:]*?(?=\s*[,;:]|\.(\s|$)|\s(com|cartao|final|valor|dia|as)\b|\s(de )?r\$|\s*$)/g;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * O texto cita o banco num padrão de banco: no começo da mensagem ("BRADESCO CARTOES:",
 * "Itaú:"), "cartão <banco>", "conta <banco>", "banco <banco>", "<banco> informa", ou o
 * "com <banco> final" da carteira. Apelido de 2 letras ("nu", "bb") não vale no texto.
 */
const textCitesBank = (raw: { title: string; text: string }, bankName: string | null): boolean => {
	if (!bankName) return false;
	const messages = [raw.title, raw.text].map((part) => normalizeText(part).replace(MERCHANT, '$1 #'));
	return bankAliases(bankName)
		.filter((alias) => alias.length >= 3)
		.some((alias) => {
			const a = escapeRegExp(alias);
			const patterns = [
				new RegExp(`^(banco )?${a}(\\s*[:\\-]| cartao\\b| cartoes\\b| informa\\b)`),
				new RegExp(`\\b(cartao|cartoes|conta)( de credito| de debito)?( do| da)?( banco)? ${a}\\b`),
				new RegExp(`\\bbanco ${a}\\b`),
				new RegExp(`\\b${a} informa\\b`),
				new RegExp(`\\bcom( o| a)?( cartao)? ${a}(?=\\s*$|\\s*[•*,.;:]|\\s(final|cartao|credito|debito|mastercard|visa|elo|amex|hipercard)\\b)`),
			];
			return messages.some((message) => patterns.some((pattern) => pattern.test(message)));
		});
};

/**
 * O aviso de terceiro cita este banco? Pelo remetente ou por um padrão de banco no texto.
 * Remetente que é banco decide sozinho: o SMS do Santander é do Santander, cite o texto
 * o banco que citar.
 */
const foreignCitesBank = (
	raw: { packageName?: string; title: string; text: string },
	bankName: string | null,
	senderNamesBank: boolean
): boolean => {
	const sender = senderOf(raw);
	if (senderNamesBank && sender !== null) return senderIsBank(sender, bankName);
	return textCitesBank(raw, bankName);
};

/** Finais nomeados de uma conta (`cardNames`, JSON). Lido aqui sem depender de `cardNames.ts`. */
const namedFinals = (account: Account): string[] => {
	if (!account.cardNames) return [];
	try {
		return Object.keys(JSON.parse(account.cardNames) as Record<string, string>);
	} catch {
		return [];
	}
};

/**
 * O banco de um aviso, quando dá para saber.
 *
 * O app ouve a notificação de todo mundo, e meio mundo fala de dinheiro: o app de
 * corrida avisa o valor da viagem, o SMS e o mensageiro repassam o aviso que o banco
 * mandou, o e-mail mostra a fatura. Nada disso é uma conta — foi assim que nasceram
 * contas chamadas "WhatsApp" e "Messages" ao lado das de verdade.
 *
 * Banco reconhecido pelo nome do app ("Inter", "Nu") é banco. Senão, vale o banco do
 * remetente ("Santander" no SMS) e, sem ele, o de um padrão de banco no texto, como o
 * "com Nubank final 1234" da carteira. Banco no nome da loja não conta: "LOJA INTER
 * SHOPPING" num SMS do Santander punha a compra no cartão Inter (C71). Sem nada disso, o
 * aviso não vira conta — e o de app que não é banco é ignorado direto (`isNoBankNotice`).
 */
export const bankLabelOf = (
	raw: Pick<RawCapture, 'appLabel' | 'title' | 'text'> & { packageName?: string }
): string | null => {
	if (brandFor(raw.appLabel)) return raw.appLabel;
	const sender = senderOf(raw);
	const bySender = sender === null ? undefined : BANK_BRANDS.find((brand) => senderIsBank(sender, brand.name));
	if (bySender) return bySender.name;
	return BANK_BRANDS.find((brand) => textCitesBank(raw, brand.name))?.name ?? null;
};

/** Quem avisou não é o app do banco: carteira, SMS, e-mail, mensageiro, loja. */
export const isForeignApp = (raw: Pick<RawCapture, 'packageName' | 'appLabel'>): boolean =>
	isWalletPackage(raw.packageName) || brandFor(raw.appLabel) === null;

export type NotificationTarget =
	| { type: 'card'; account: Account }
	/** Uma conta certa, não "a corrente do app": o final de débito que ela declarou. */
	| { type: 'account'; account: Account }
	| { type: 'new_card' }
	| { type: 'checking' }
	/**
	 * "Não dá para responder": não há como dizer se a compra é da conta ou de qual cartão.
	 * A captura fica sem conta e o usuário atribui — chutar poria o dinheiro no lugar
	 * errado, e desde a 1.2.6 ficar sem conta é um caminho normal. `ambiguity` diz qual é a
	 * dúvida (SPD-123): a revisão a explica, e a resposta vira regra para o mesmo caso.
	 */
	| { type: 'unknown'; ambiguity?: TargetAmbiguity };

/**
 * Por que o destino de uma compra não tem resposta segura (SPD-123). Só compras: Pix,
 * transferência e o resto seguem como sempre.
 *
 *  - `credit_no_last4`: "no crédito" sem o final, e o banco não tem um cartão só (NOTIF-06);
 *  - `credit_unknown_last4`: "crédito", dois cartões ou mais do banco e um final de nenhum
 *    deles (achado 7.6);
 *  - `purchase_no_kind`: nem "crédito" nem "débito", dois cartões ou mais e um final de
 *    nenhum deles — a conta corrente ou um dos cartões (NOTIF-15);
 *  - `debit_unknown_last4`: nem "crédito" nem "débito", um cartão do banco com outro final e
 *    a conta do banco no app — o virtual do Nubank ou o débito do Inter, que se escrevem
 *    igual (NOTIF-16). `card` é o palpite de antes; desde o SPD-132 nem o conserto das
 *    compras antigas (`planLedgerRepair`) o usa.
 */
export type TargetAmbiguity =
	| { case: 'credit_no_last4' }
	| { case: 'credit_unknown_last4' }
	| { case: 'purchase_no_kind' }
	| { case: 'debit_unknown_last4'; card: Account };

type TargetNotice = { packageName: string; appLabel: string; title: string; text: string; cardLast4: string | null };

/**
 * "Esta conta é do banco do aviso?": pelo app que avisou, ou pelo banco que o aviso cita
 * quando quem avisou não é o app do banco (SMS, carteira, e-mail).
 */
const bankMatcher = (accounts: Account[], notification: TargetNotice): ((account: Account) => boolean) => {
	const foreign = isForeignApp(notification);
	// O remetente é um banco (da lista ou de uma conta do usuário): só ele vale.
	const sender = foreign ? senderOf(notification) : null;
	const senderNamesBank =
		sender !== null &&
		(BANK_BRANDS.some((brand) => senderIsBank(sender, brand.name)) ||
			accounts.some((account) => senderIsBank(sender, account.bankName)));
	return (account: Account): boolean =>
		foreign
			? foreignCitesBank(notification, account.bankName, senderNamesBank)
			: (account.packageName !== null && account.packageName === notification.packageName) ||
				sameBank(account.bankName, notification.appLabel);
};

/** Cartão de crédito de verdade, vivo: um "cartão" com "débito" no nome não tem fatura. */
const isLiveCreditCard = (account: Account): boolean =>
	account.kind === 'credit_card' &&
	!account.archived &&
	!account.deletedAt &&
	!DEBIT_NAME.test(normalizeText(`${account.name} ${account.bankName ?? ''}`));

const hasFinal = (card: Account, last4: string): boolean => card.last4 === last4 || namedFinals(card).includes(last4);

/**
 * O cartão que recebeu um pagamento de fatura avisado pelo próprio cartão ("Recebemos o
 * pagamento", X-2): o do final citado, ou o único cartão do banco do aviso. Senão `null`.
 */
export const invoiceCardOf = (accounts: Account[], notification: TargetNotice): Account | null => {
	const cards = accounts.filter(isLiveCreditCard).filter(bankMatcher(accounts, notification));
	const last4 = notification.cardLast4;
	const exact = last4 ? cards.find((card) => hasFinal(card, last4)) : undefined;
	if (exact) return exact;
	return cards.length === 1 ? cards[0] : null;
};

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
 * Aviso de carteira (Samsung Pay, Google Wallet), SMS ou e-mail não é do banco: o banco
 * sai do remetente ou de um padrão de banco no texto, nunca do nome da loja (C71).
 *
 * Compra em que nada disso responde com segurança não é chutada: `unknown`, com a dúvida
 * (`TargetAmbiguity`, SPD-123). "No crédito" sem final vai para o único cartão do banco,
 * como o final desconhecido já ia. `kind` é o que o parser entendeu; sem ele, sai do texto.
 */
export const pickNotificationTarget = (
	accounts: Account[],
	notification: TargetNotice & { kind?: CaptureKind | null }
): NotificationTarget => {
	const hint = cardHintOf(notification);
	const foreign = isForeignApp(notification);
	const purchase = (notification.kind !== undefined ? notification.kind : kindOfNotice(notification)) === 'purchase';
	/** Do mesmo banco do aviso: pelo app que avisou, ou pelo banco que o aviso cita. */
	const ofNotificationBank = bankMatcher(accounts, notification);

	// Final nomeado numa conta que não é cartão é cartão de débito: a compra é daquela
	// conta, mesmo quando o banco também tem cartão de crédito. Quem declarou decide, e
	// por isso vem antes de tudo — inclusive do aviso que diz "débito" sem dizer a conta.
	if (notification.cardLast4) {
		const last4 = notification.cardLast4;
		const debit = accounts.find(
			(account) =>
				account.kind !== 'credit_card' &&
				!account.archived &&
				!account.deletedAt &&
				namedFinals(account).includes(last4) &&
				ofNotificationBank(account)
		);
		if (debit) return { type: 'account', account: debit };
	}

	const cards = accounts.filter(isLiveCreditCard);
	const ofBank = cards.filter(ofNotificationBank);

	if (!notification.cardLast4) {
		// "Você acaba de comprar no crédito", sem final (NOTIF-06): não é da conta corrente,
		// para onde ia. Com um cartão só do banco, é dele — como o final desconhecido já era.
		// Com dois ou nenhum, não há como dizer qual: a revisão pergunta.
		if (purchase && hint === 'credit') {
			return ofBank.length === 1
				? { type: 'card', account: ofBank[0] }
				: { type: 'unknown', ambiguity: { case: 'credit_no_last4' } };
		}
		return { type: 'checking' };
	}
	if (hint === 'debit') return { type: 'checking' };
	const last4 = notification.cardLast4;

	// O final do plástico ou de um virtual já nomeado: com dois cartões de crédito do mesmo
	// banco (PF e PJ, por exemplo), é isso que decide a fatura.
	const exact = (foreign ? cards : ofBank).find((card) => hasFinal(card, last4));
	if (exact) return { type: 'card', account: exact };
	if (ofBank.length === 1) {
		// "Compra aprovada no cartão final 0443" é o débito do Inter e também o virtual do
		// Nubank: sem "crédito" nem "débito", com a conta do banco no app, os dois cabem
		// (NOTIF-16). A carteira fica no cartão: o aviso do banco chega junto e decide.
		const debitHome = accounts.some(
			(account) =>
				account.kind !== 'credit_card' && !account.archived && !account.deletedAt && ofNotificationBank(account)
		);
		if (purchase && hint === 'unknown' && debitHome && !isWalletPackage(notification.packageName)) {
			return { type: 'unknown', ambiguity: { case: 'debit_unknown_last4', card: ofBank[0] } };
		}
		return { type: 'card', account: ofBank[0] };
	}
	if (hint === 'credit' && !foreign && ofBank.length === 0) return { type: 'new_card' };
	// Dois cartões do mesmo banco (PF e PJ) e um final que não é de nenhum deles: o texto
	// diz "crédito", então a compra **não** é da conta corrente — mas também não há como
	// dizer de qual fatura é. Caía em "conta corrente", e R$ 480 saíam do saldo e ficavam
	// fora das duas faturas (achado 7.6). A resposta certa é não responder.
	if (hint === 'credit' && ofBank.length > 1) return { type: 'unknown', ambiguity: { case: 'credit_unknown_last4' } };
	// Sem "crédito" a dúvida é maior ainda — a conta corrente ou um dos cartões —, e ia para
	// a conta corrente (NOTIF-15). Também não responde.
	if (purchase && hint === 'unknown' && ofBank.length > 1) {
		return { type: 'unknown', ambiguity: { case: 'purchase_no_kind' } };
	}
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
 *   para o cartão que as regras de hoje escolheriam. Quando elas não respondem (a compra
 *   iria para a revisão), a captura fica onde está, sem mover nem apagar (SPD-132).
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
		// Conta escolhida pelo usuário na revisão, ou pela regra aprendida com ele (SPD-123):
		// o conserto não a desfaz.
		if (ambiguityOfReason(capture.reason)) continue;
		const current = byId.get(capture.accountId);
		if (!current || current.kind === 'credit_card') continue;

		// Só o que as regras de hoje põem num cartão sem dúvida. A compra que um aviso igual
		// mandaria para a revisão (`unknown`, SPD-123) — "aprovada" sem "crédito" com a conta
		// do banco no app (NOTIF-16), um final que não é de nenhum dos cartões — não é chutada
		// aqui também (SPD-132): fica onde está.
		const decided = pickNotificationTarget(realAccounts, { ...capture, kind: capture.kind as CaptureKind });
		if (decided.type === 'card' && decided.account.id !== capture.accountId) {
			moveCaptures.push({ captureId: capture.id, transactionId: capture.transactionId, toId: decided.account.id });
		}
	}

	return { mergeCards, moveCaptures };
};
