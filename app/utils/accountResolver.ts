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
 * notificação, sem chave de extrato, ela ganha a chave em vez de nascer uma segunda. O
 * mesmo vale para a conta que o usuário cadastrou à mão: a primeira notificação daquele
 * banco a adota, em vez de nascer uma segunda conta do mesmo banco ao lado dela.
 */

import { getPendingCaptures } from '../database/captures';
import {
	addAccount,
	findAccountByKey,
	findAccountBySource,
	getAccountTransactions,
	getAccountTransfers,
	getAccounts,
	updateAccount,
} from '../database/database';
import { type Account, type AccountKind, defaultRoleFor } from '../database/schema';
import { type BusinessFeeds, businessAccountOf, isBusinessNotice } from './businessFeed';
import { provisionalEntries } from './accountMath';
import { brandFor, NEUTRAL_CARD_COLOR } from './bankBrands';
import { buildCardSummary, type CardEntry, type CardMovement } from './cardMath';
import { parseCardNames } from './cardNames';
import { isKnownBankPackage } from '../diagnostics/knownBanks';
import { isSmsPackage, isStatementPackage } from './captureMatcher';
import { isWalletPackage, type ParsedCapture, type RawCapture } from './captureParser';
import { bankLabelOf, isCreditCardNotification, isForeignApp, pickNotificationTarget, sameBank } from './notificationTarget';

export { bankLabelOf, cardHintOf, isCreditCardNotification, isForeignApp, pickNotificationTarget, sameBank } from './notificationTarget';
/** Os apps de SMS, ao lado de `BANK_PACKAGES`. A lista mora no `captureMatcher` (puro). */
export { BLOCKED_PACKAGES, isBlockedPackage, isSmsPackage, SMS_PACKAGES } from './captureMatcher';
import { addDays, getISODate, todayISO } from './dateUtils';
import type { OfxAccount } from './ofxParser';

export const ACCOUNT_COLORS: Record<AccountKind, string> = {
	checking: '#15E8FE',
	savings: '#4CAF50',
	investment: '#FFD166',
	cash: '#A0E7A0',
	credit_card: '#FF6B6B',
};

const yesterday = (): string => addDays(todayISO(), -1);

/**
 * Apps de banco reconhecidos pelo pacote, e o banco de cada um.
 *
 * O banco costuma ser reconhecido pelo nome do app (`brandFor`), e o nome é o que o
 * aparelho mostra — que o usuário ou o fabricante podem trocar. O Mercado Pago é a conta
 * do usuário onde fica a reserva financeira (SPD-022): não pode depender do nome na tela
 * para contar como banco, nem nunca cair nas regras de "app que não é banco".
 */
export const BANK_PACKAGES: ReadonlyMap<string, string> = new Map([['com.mercadopago.wallet', 'Mercado Pago']]);

/**
 * O aviso como o resto do resolvedor deve vê-lo: o app de banco conhecido pelo pacote
 * avisa com o nome do banco, diga o aparelho o que disser. Só para decidir a conta — a
 * captura guarda o nome original.
 */
const asBankApp = (raw: RawCapture): RawCapture => {
	const bank = BANK_PACKAGES.get(raw.packageName);
	return bank && !brandFor(raw.appLabel) ? { ...raw, appLabel: bank } : raw;
};

/**
 * Quem avisou é um app que não é banco: SMS, e-mail, mensageiro, loja, app de corrida.
 *
 * Não é "de terceiro" (`isForeignApp`): a carteira também é terceiro, mas tem tratamento
 * próprio (a duplicata com o banco, o banco citado no texto) e nunca cai nas regras de
 * ignorar. Nem o app de banco, nem o Mercado Pago, nem a linha de extrato.
 *
 * O app de banco conhecido pelo pacote (`KNOWN_BANK_PACKAGES`) também nunca é: o nome na
 * tela pode ser um que `brandFor` não reconhece ("Carteira digital" no PicPay), e o aviso
 * dele que não cita o banco seria ignorado direto (SPD-069).
 */
export const isNonBankApp = (raw: Pick<RawCapture, 'packageName' | 'appLabel'>): boolean =>
	!isWalletPackage(raw.packageName) &&
	!isStatementPackage(raw.packageName) &&
	!BANK_PACKAGES.has(raw.packageName) &&
	!isKnownBankPackage(raw.packageName) &&
	isForeignApp(raw);

/**
 * O aviso não diz de banco nenhum: veio de um app que não é banco e o texto não cita
 * banco. É a conversa no WhatsApp que fala de Pix, o "pedido enviado" da loja, o recibo
 * da corrida. Antes virava item "Sem conta" na revisão, e o usuário descartava à mão
 * todas as vezes (C66, C67); desde o SPD-022 é ignorado direto, sem item nem conta.
 */
export const isNoBankNotice = (raw: Pick<RawCapture, 'packageName' | 'appLabel' | 'title' | 'text'>): boolean =>
	isNonBankApp(raw) && bankLabelOf(raw) === null;

/**
 * O app pode aprender "ignorar" depois de 3 descartes: não é banco e não é SMS. O SMS
 * fica de fora porque o pacote junta todos os remetentes, inclusive o banco.
 */
export const canLearnToIgnore = (raw: Pick<RawCapture, 'packageName' | 'appLabel'>): boolean =>
	isNonBankApp(raw) && !isSmsPackage(raw.packageName);

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
	cardNames: null,
	packageName: partial.packageName,
	accountKey: partial.accountKey,
	openingBalanceCents: partial.openingBalanceCents ?? 0,
	openingBalanceDate: partial.openingBalanceDate ?? yesterday(),
	sortOrder: 0,
	archived: false,
});

/**
 * Como a conta da notificação foi achada, para o diário (SPD-014): a que já atendia o app
 * ou o final, a cadastrada à mão (ou vinda do extrato) que ganhou o app agora, ou uma nova.
 */
export type AccountResolution = 'existing' | 'adopted' | 'created';

/**
 * A conta de uma notificação: o cartão de crédito certo (`pickNotificationTarget`), a
 * conta que declarou aquele final de débito, ou a conta corrente daquele app. Cria na
 * primeira vez, ancorada na véspera **da compra** — não na véspera de quando o app
 * abriu, senão a compra da noite anterior ficaria antes da âncora e fora da fatura.
 *
 * Devolve `null` quando não dá para saber de onde saiu o dinheiro: o aviso veio de um
 * app que não é banco (SMS, e-mail, mensageiro, app de corrida) e o texto não cita banco
 * nenhum. É melhor do que inventar uma conta chamada "WhatsApp" ao lado das de verdade —
 * e esse aviso nem chega aqui desde o SPD-022 (`isNoBankNotice`): a ingestão o ignora.
 *
 * `trace.how` diz, a quem quiser saber, por qual caminho a conta veio. Não muda nada.
 * `businessFeeds` é a escolha "Avisos da Nu Empresas entram aqui" (SPD-074).
 */
export const resolveAccountForNotification = async (
	notification: RawCapture,
	parsed: ParsedCapture,
	trace?: { how?: AccountResolution },
	businessFeeds: BusinessFeeds = {}
): Promise<Account | null> => {
	const via = (how: AccountResolution, account: Account): Account => {
		if (trace) trace.how = how;
		return account;
	};
	const raw = asBankApp(notification);
	const purchaseEve = addDays(getISODate(new Date(raw.postedAt)), -1);
	const accounts = await getAccounts();
	const target = pickNotificationTarget(accounts, { ...raw, cardLast4: parsed.cardLast4 });
	// Carteira, SMS, e-mail: quem avisou não é o app do banco, e gravar esse pacote na
	// conta faria o mensageiro "virar" o banco para sempre.
	const foreign = isForeignApp(raw);

	// O aviso diz "crédito" e o banco tem mais de um cartão: não dá para responder de qual
	// fatura é a compra. Sem conta, e o usuário atribui — nunca a conta corrente.
	if (target.type === 'unknown') return null;

	if (target.type === 'card' || target.type === 'account') {
		const found = target.account;
		// Conta ou cartão cadastrado à mão ganha o app na primeira notificação do banco.
		if (found.packageName === null && !foreign) {
			await updateAccount({ ...found, packageName: raw.packageName });
			return via('adopted', { ...found, packageName: raw.packageName });
		}
		return via('existing', found);
	}

	const isCard = target.type === 'new_card';
	const last4 = isCard ? parsed.cardLast4 : null;

	// "da conta Nu Empresas": o usuário disse qual ficha é a PJ (SPD-074). Vem antes da
	// conta ligada ao app, que é a do resto dos avisos daquele banco.
	if (!isCard && !foreign && isBusinessNotice(raw)) {
		const business = businessAccountOf(accounts, businessFeeds, raw.packageName);
		if (business) return via('existing', business);
	}

	// O app do banco é a identidade mais forte: a conta já ligada a ele vem primeiro.
	if (!foreign) {
		const existing = await findAccountBySource(raw.packageName, last4);
		if (existing) return via('existing', existing);
	}

	const bank = bankLabelOf(raw);
	if (bank === null) return null;

	const ofBank = accounts.filter(
		(account) =>
			!account.deletedAt && (account.kind === 'credit_card') === isCard && sameBank(account.bankName, bank)
	);

	// Aviso de terceiro que cita o banco: cai na conta daquele banco, se houver uma só.
	// Nunca cria — um banco reconhecido no texto de um SMS é pista, não cadastro.
	if (foreign) {
		const live = ofBank.filter((account) => !account.archived);
		const bound = live.filter((account) => account.packageName !== null);
		if (bound.length === 1) return via('existing', bound[0]);
		return live.length === 1 ? via('existing', live[0]) : null;
	}

	if (!isCard) {
		// Contas do mesmo banco ainda sem app: a do extrato (OFX) ou a cadastrada à mão.
		// Arquivada não vira gêmea: o usuário a tirou de cena (SPD-002).
		const twins = ofBank.filter((account) => account.packageName === null && !account.archived);
		// Com duas contas do mesmo banco (a PF e a PJ, por exemplo) o aviso não diz qual é:
		// adivinhar poria dinheiro na conta errada, então a nova nasce como antes.
		if (twins.length === 1) {
			const twin = twins[0];
			await updateAccount({ ...twin, packageName: raw.packageName });
			return via('adopted', { ...twin, packageName: raw.packageName });
		}
	}

	// Ligada ao app só sobrou conta arquivada: o usuário a tirou de cena. Não nasce outra no
	// lugar dela; a captura fica sem conta, para o usuário atribuir (SPD-002).
	const archivedBound = ofBank.some(
		(account) =>
			account.archived && account.packageName === raw.packageName && account.last4 === last4
	);
	if (archivedBound) return null;

	const id = await addAccount(
		newAccountDraft({
			name: isCard && last4 ? `${bank} · final ${last4}` : bank,
			kind: isCard ? 'credit_card' : 'checking',
			bankName: bank,
			last4,
			packageName: raw.packageName,
			accountKey: null,
			openingBalanceDate: purchaseEve,
		})
	);
	const created = (await getAccounts()).find((account) => account.id === id);
	if (!created) throw new Error('Account was not created');
	return via('created', created);
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

	// Cartão novo por extrato não tem saldo confiável (o sinal varia entre bancos), mas a
	// âncora precisa ficar antes da primeira linha: com âncora "ontem", todas as compras do
	// extrato ficariam antes dela e fora das faturas.
	const firstLine = statement.entries.map((entry) => entry.postedDate).sort()[0];
	const anchor =
		!statement.isCard && statement.ledgerBalanceCents !== null && statement.ledgerDate !== null
			? { openingBalanceCents: statement.ledgerBalanceCents, openingBalanceDate: statement.ledgerDate }
			: statement.isCard && firstLine
				? { openingBalanceCents: 0, openingBalanceDate: addDays(firstLine, -1) }
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
 * "fora", e o usuário indica o cartão tocando "Pagar fatura" nele (`pickOpenCardPayment`
 * completa o destino).
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

/**
 * Como o outro lado de uma aplicação, resgate ou pagamento de fatura foi achado, para o
 * diário (SPD-014, SPD-023):
 *  - `single_reserve`: a única reserva do banco (aplicação e resgate);
 *  - `notifier`: o aviso veio do próprio cartão, e o destino é ele;
 *  - `card_last4`: o cartão do final citado no aviso;
 *  - `single_card`: o único cartão do banco da conta;
 *  - `paired`: o aviso do cartão já tinha gravado este pagamento;
 *  - `invoice_amount`: a única fatura fechada em aberto com o mesmo valor;
 *  - `none`: não há escolha só, e o lado fica em branco.
 */
export type DestinationResolution =
	| 'single_reserve'
	| 'notifier'
	| 'card_last4'
	| 'single_card'
	| 'paired'
	| 'invoice_amount'
	| 'none';

/** Reserva é o papel `reserve` ou a conta poupança, seja qual for o papel que ganhou. */
const isReserveLike = (account: Account): boolean =>
	account.kind !== 'credit_card' && (account.role === 'reserve' || account.kind === 'savings');

/**
 * A caixinha de uma aplicação ou resgate (AUTO-08): a **única** reserva do mesmo banco da
 * conta que avisou, ativa. Com zero ou duas não há como saber, e o lado fica em branco como
 * antes. O aviso que já veio de uma reserva (ou de um cartão) não procura outra: "aplicação"
 * vista pela própria caixinha não diz para onde foi.
 */
export const findReserveForInvestment = async (account: Account): Promise<Account | null> => {
	if (account.kind === 'credit_card' || isReserveLike(account)) return null;
	const reserves = (await getAccounts()).filter(
		(candidate) =>
			candidate.id !== account.id &&
			!candidate.archived &&
			!candidate.deletedAt &&
			isReserveLike(candidate) &&
			sameSource(candidate, account)
	);
	return reserves.length === 1 ? reserves[0] : null;
};

/** Os cartões ativos do usuário, de qualquer banco. */
const liveCards = async (): Promise<Account[]> =>
	(await getAccounts()).filter((account) => account.kind === 'credit_card' && !account.archived && !account.deletedAt);

/**
 * O cartão cujo final o aviso do pagamento cita (AUTO-03): o final do plástico ou de um
 * virtual já nomeado, em qualquer banco — a fatura do Itaú se paga pelo app do Nubank. Só
 * quando um cartão só tem aquele final.
 */
export const findCardByLast4 = async (last4: string | null): Promise<Account | null> => {
	if (!last4) return null;
	const cards = (await liveCards()).filter(
		(card) => card.last4 === last4 || parseCardNames(card.cardNames)[last4] !== undefined
	);
	return cards.length === 1 ? cards[0] : null;
};

/**
 * O cartão cuja fatura fechada ainda em aberto vale exatamente o que foi pago (AUTO-03), entre
 * todos os cartões do usuário. Só quando um cartão só bate: dois cartões com o mesmo valor a
 * pagar ficam sem resposta.
 *
 * "Em aberto" é o que falta pagar das fechadas no dia do pagamento (`toPayCents` do resumo
 * do cartão, o mesmo número da tela): fatura já quitada não bate, e o pagamento parcial
 * anterior já foi descontado. As compras ainda na caixa de entrada entram, como na tela —
 * o banco já as cobra.
 */
export const findCardByClosedInvoice = async (amountCents: number, date: string): Promise<Account | null> => {
	const cards = await liveCards();
	if (cards.length === 0) return null;
	const pending = await getPendingCaptures();
	const matches: Account[] = [];
	for (const card of cards) {
		const [transactions, transfers] = await Promise.all([getAccountTransactions(card.id), getAccountTransfers(card.id)]);
		const entries: CardEntry[] = transactions.map((tx) => ({
			id: tx.id,
			amountCents: tx.amountCents,
			isIncome: tx.isIncome,
			date: tx.date,
			note: tx.note,
			category: tx.category,
			installmentGroup: tx.installmentGroup,
			installmentIndex: tx.installmentIndex,
			installmentCount: tx.installmentCount,
			cardLast4: tx.cardLast4,
		}));
		for (const capture of pending) entries.push(...provisionalEntries(capture, card));
		const movements: CardMovement[] = transfers.map((transfer) => ({
			amountCents: transfer.amountCents,
			date: transfer.date,
			inbound: transfer.toAccountId === card.id,
		}));
		const toPay = buildCardSummary(card, entries, movements, date).toPayCents;
		if (toPay > 0 && toPay === amountCents) matches.push(card);
	}
	return matches.length === 1 ? matches[0] : null;
};

export default {
	resolveAccountForNotification,
	resolveAccountForStatement,
	isNonBankApp,
	isNoBankNotice,
	canLearnToIgnore,
	BANK_PACKAGES,
	findCardForInvoice,
	findCheckingForCard,
	findReserveForInvestment,
	findCardByLast4,
	findCardByClosedInvoice,
	isCreditCardNotification,
	sameBank,
	ACCOUNT_COLORS,
};
