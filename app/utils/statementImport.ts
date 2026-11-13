/**
 * Import de extrato OFX: do arquivo até a caixa de entrada.
 *
 * Tudo que decide está em módulos puros e testados — `ofxParser` lê, `statementMatcher`
 * planeja, `captureMatcher` decide. Este arquivo só junta as pontas: tira a fotografia
 * do banco que o plano precisa, grava o plano linha a linha numa única transação e
 * devolve o resumo que a tela mostra ("42 linhas: 36 já registradas, 3 para revisar…").
 *
 * As linhas do extrato entram na **mesma caixa de entrada** das notificações, com
 * `packageName` `ofx:<conta>` e o FITID na impressão digital. Uma linha já registrada
 * por notificação ou por lançamento digitado entra como "já vista" apontando para o
 * registro; só o que o app não conhecia vai para revisão, e nada entra no livro sem
 * passar por ela (exceto estabelecimentos já aprendidos, que sempre podem ser desfeitos).
 *
 * A notificação ainda pendente que o extrato confirmou sai da revisão sozinha só com a
 * categoria da regra aprendida; senão fica, marcada "valor confirmado pelo extrato"
 * (SPD-117). A compra "3/10" sem plano no app vira uma oferta das parcelas que faltam, que
 * a tela mostra no resultado — criar é com o usuário.
 */

import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import {
	type CaptureDraft,
	getCapture,
	getLinkedTransactionIds,
	getMerchantRule,
	getRecentCaptures,
	getStatementClaimedCaptureIds,
	getStatementFingerprints,
	insertCapture,
	updateCapture,
} from '../database/captures';
import {
	addTransaction,
	assignTransactionAccount,
	getAccounts,
	getAccountTransactions,
	getTransactionsByDateRange,
	reassignCaptureLedger,
	runInTransaction,
} from '../database/database';
import type { Account, Capture } from '../database/schema';
import { logCaptureDecision } from '../diagnostics/capture';
import * as syncQueue from '../sync/queue';
import { generateUniqueId } from '../utils/categoryEditUtils';
import {
	resolveAccountForStatement,
	type StatementAccountChoice,
	type StatementAccountChooser,
	type StatementAccountQuestion,
} from './accountResolver';
import { ambiguityOfReason } from './ambiguityReasons';
import {
	applyDecision,
	confirmCapture,
	type IngestOptions,
	resolveCategoryId,
	toKnownCapture,
	toMerchantRule,
} from './captureActions';
import { type CaptureChoiceStore, choiceKeyOf, isDirectionGuess, rememberChoice } from './captureChoices';
import { DEFAULT_AUTO_CONFIRM_THRESHOLD, type MerchantRule, STATEMENT_LEDGER_SUSPECT_REASON } from './captureMatcher';
import { cycleRuleOf } from './cardMath';
import { addDays } from './dateUtils';
import { parseInstallmentMarker } from './installments';
import { decodeOfxBytes, parseOfx } from './ofxParser';
import {
	findTransactionForLine,
	type InstallmentCard,
	type LedgerTransaction,
	linesOf,
	MATCH_INSTALLMENT_WINDOW_DAYS,
	type PlannedLine,
	planInstallmentGaps,
	planStatementImport,
	type StatementLine,
	type StatementSummary,
	settleMatchedCapture,
	statementAnswersDirection,
	statementPackageName,
	statementPostedAt,
} from './statementMatcher';

/**
 * O que o import recebe: o mesmo da ingestão, quem pergunta de qual conta é o extrato, e o
 * lugar das respostas da revisão (`choiceStore`, SPD-164) — o aviso "entrou ou saiu?" que o
 * extrato casou precisa saber se já foi respondido, e o extrato pode responder.
 */
export type StatementImportOptions = IngestOptions & {
	chooseAccount?: StatementAccountChooser;
	choiceStore?: CaptureChoiceStore;
};

export interface StatementImportAccountResult {
	accountKey: string;
	bankName: string;
	isCard: boolean;
	/** Linhas do arquivo sem FITID, data ou valor válidos. */
	malformed: number;
	lines: number;
}

/**
 * "O extrato traz PADARIA 3/10 de R$ 50,00 e o app não tem as outras": as parcelas que
 * faltam, prontas para criar se o usuário aceitar (`createStatementInstallments`).
 */
export interface StatementInstallmentOffer {
	accountId: string;
	accountName: string;
	/** O estabelecimento, sem o "3/10": vira a nota de cada parcela, com "(4/10)". */
	description: string;
	parcelCents: number;
	/** A parcela que o extrato trouxe (o 3 de "3/10"). */
	index: number;
	/** O total de parcelas (o 10). */
	count: number;
	/** A da regra aprendida do estabelecimento ou o palpite, do lado das despesas. */
	categoryId: string;
	parcels: Array<{ index: number; date: string }>;
}

/** A pendente que uma linha do extrato casou: confirmada sozinha ou marcada (SPD-117). */
export interface StatementSettledCapture {
	captureId: string;
	outcome: 'confirmed' | 'marked';
}

export interface StatementImportResult {
	accounts: StatementImportAccountResult[];
	summary: StatementSummary;
	settledCaptures: StatementSettledCapture[];
	installmentOffers: StatementInstallmentOffer[];
}

export class StatementImportError extends Error {
	constructor(public readonly code: 'empty' | 'unreadable') {
		super(code);
	}
}

/** Quantos dias antes da primeira linha a fotografia do banco começa. */
const CAPTURE_LOOKBACK_DAYS = 10;
const TRANSACTION_LOOKBACK_DAYS = 7;

const emptySummary = (): StatementSummary => ({
	total: 0,
	skippedExisting: 0,
	matchedCaptures: 0,
	matchedTransactions: 0,
	pending: 0,
	questions: 0,
	autoConfirmed: 0,
	transfers: 0,
	ignored: 0,
});

const baseDraftOf = (line: StatementLine, fingerprint: string, accountId: string | null): CaptureDraft => ({
	accountId,
	transferId: null,
	installments: null,
	fingerprint,
	packageName: statementPackageName(line.accountKey),
	appLabel: `${line.bankName} · OFX`,
	title: `${line.trnType || 'STMTTRN'} ${line.postedDate}`,
	text: [line.name, line.memo, `FITID ${line.fitid}`].filter((part) => part.trim().length > 0).join('\n'),
	postedAt: statementPostedAt(line.postedDate),
	amountCents: line.amountCents,
	direction: line.direction,
	kind: line.kind,
	counterparty: line.counterparty,
	merchantKey: line.merchantKey,
	cardLast4: null,
	status: 'pending',
	question: null,
	relatedId: null,
	suggestedCategory: line.suggestedCategory,
	transactionId: null,
	autoConfirmed: false,
	reason: null,
});

// ---------------------------------------------------------------------------
// "De qual cartão é este extrato?"
// ---------------------------------------------------------------------------

/**
 * Quem responde a pergunta da conta durante um import (`resolveAccountForStatement`). A
 * tela que dispara o import a registra só enquanto ele roda: o import passa pelo contexto
 * da caixa de entrada, que não sabe perguntar nada.
 */
let activeChooser: StatementAccountChooser | null = null;

export const withStatementAccountChooser = async <T>(
	chooser: StatementAccountChooser,
	run: () => Promise<T>
): Promise<T> => {
	const previous = activeChooser;
	activeChooser = chooser;
	try {
		return await run();
	} finally {
		activeChooser = previous;
	}
};

export type StatementChoiceAnswer = 'this' | 'other' | 'new';

/**
 * A pergunta, uma conta de cada vez: "Este extrato é do cartão Nubank Teste (final
 * 1111)?" com este / outro cartão / criar novo. "Outro" passa ao próximo candidato e
 * depois aos outros cartões; acabou a lista, é novo. Uma de cada vez porque o alerta do
 * Android tem no máximo três botões.
 */
export const walkStatementChoice = async (
	question: StatementAccountQuestion,
	ask: (account: Account, hasMore: boolean) => Promise<StatementChoiceAnswer>
): Promise<StatementAccountChoice> => {
	const queue = [...question.candidates, ...question.others];
	for (let index = 0; index < queue.length; index += 1) {
		const answer = await ask(queue[index], index < queue.length - 1);
		if (answer === 'this') return { type: 'existing', accountId: queue[index].id };
		if (answer === 'new') return { type: 'new' };
	}
	return { type: 'new' };
};

// ---------------------------------------------------------------------------
// "Parece repetido"
// ---------------------------------------------------------------------------

/** Folga do "Parece repetido": o mesmo dia, a véspera ou o dia seguinte. */
export const LEDGER_SUSPECT_DAYS = 1;

const dayNumber = (date: string): number => {
	const [year, month, day] = date.split('-').map(Number);
	return Math.round(Date.UTC(year, month - 1, day) / 86_400_000);
};

/**
 * O lançamento digitado que talvez já seja esta linha, mas noutra conta do mesmo tipo
 * (E2E-34): a padaria de R$ 50 lançada à mão no cartão errado, ou no cartão que o import
 * não reconheceu. No mesmo cartão o plano já casa sozinho (`findTransactionForLine`); de
 * outro cartão ele não casa de propósito — o mercado de R$ 100 no débito não pode sumir
 * com o do cartão —, então aqui só se pergunta.
 *
 * Mesmo critério do casamento (valor, direção, parcela, já ligado), com a data a no máximo
 * um dia. Cartão com cartão, conta com conta: o Pix de R$ 50 da conta corrente não é a
 * compra do cartão.
 */
export const findLedgerSuspect = (
	line: StatementLine,
	accountId: string | null,
	transactions: LedgerTransaction[],
	isCardAccount: ReadonlyMap<string, boolean>,
	excluded: Set<string>
): LedgerTransaction | undefined => {
	const near = transactions.filter(
		(transaction) =>
			transaction.accountId != null &&
			transaction.accountId !== accountId &&
			isCardAccount.get(transaction.accountId) === line.isCard &&
			Math.abs(dayNumber(line.postedDate) - dayNumber(transaction.date)) <= LEDGER_SUSPECT_DAYS
	);
	// Sem a conta, o filtro de conta do casamento deixa passar: a conta já foi vista acima.
	return findTransactionForLine(
		line,
		near.map((transaction) => ({ ...transaction, accountId: null })),
		excluded
	);
};

/**
 * Importa o conteúdo de um arquivo OFX já decodificado.
 *
 * Todas as contas do arquivo são planejadas juntas: uma transferência entre duas
 * contas presentes no mesmo arquivo é reconhecida na hora. `chooseAccount` responde
 * "de qual cartão é este extrato?"; sem ele vale o registrado por
 * `withStatementAccountChooser`, e sem nenhum a dúvida vira conta nova.
 */
export const importOfxContent = async (
	content: string,
	options: StatementImportOptions
): Promise<StatementImportResult> => {
	const statement = parseOfx(content);
	const lines = statement.accounts.flatMap(linesOf);

	if (statement.accounts.length === 0) throw new StatementImportError('empty');
	if (lines.length === 0) {
		return {
			accounts: statement.accounts.map((account) => ({
				accountKey: account.accountKey,
				bankName: account.bankName,
				isCard: account.isCard,
				malformed: account.skipped,
				lines: 0,
			})),
			summary: emptySummary(),
			settledCaptures: [],
			installmentOffers: [],
		};
	}

	const dates = lines.map((line) => line.postedDate).sort();
	const firstDate = dates[0];
	const lastDate = dates[dates.length - 1];

	const [existingFingerprints, matchedCaptureIds, linkedTransactionIds, recentCaptures, transactions] =
		await Promise.all([
			getStatementFingerprints(),
			getStatementClaimedCaptureIds(),
			getLinkedTransactionIds(),
			getRecentCaptures(`${addDays(firstDate, -CAPTURE_LOOKBACK_DAYS)}T00:00:00.000Z`),
			getTransactionsByDateRange(
				// Parcelas casam com até 45 dias de diferença: a busca precisa ir até lá.
				addDays(firstDate, -Math.max(TRANSACTION_LOOKBACK_DAYS, MATCH_INSTALLMENT_WINDOW_DAYS)),
				addDays(lastDate, TRANSACTION_LOOKBACK_DAYS)
			),
		]);

	const merchantKeys = [...new Set(lines.flatMap((line) => (line.merchantKey ? [line.merchantKey] : [])))];
	const rules = new Map<string, MerchantRule>();
	for (const key of merchantKeys) {
		const rule = toMerchantRule(await getMerchantRule(key));
		if (rule) rules.set(key, rule);
	}

	const ledger: LedgerTransaction[] = transactions.map((transaction) => ({
		id: transaction.id,
		amountCents: transaction.amountCents,
		isIncome: transaction.isIncome,
		date: transaction.date,
		installmentIndex: transaction.installmentIndex,
		installmentCount: transaction.installmentCount,
		accountId: transaction.accountId,
	}));

	// A conta de cada extrato do arquivo, criada ou adotada antes de qualquer gravação:
	// as linhas nascem já com a conta, e o LEDGERBAL vira a âncora do saldo.
	const accountIdByKey = new Map<string, string>();
	const chooseAccount = options.chooseAccount ?? activeChooser;
	for (const account of statement.accounts) {
		const resolved = await resolveAccountForStatement(account, chooseAccount);
		accountIdByKey.set(account.accountKey, resolved.id);
	}

	const { planned, summary } = planStatementImport(lines, {
		existingFingerprints,
		captures: recentCaptures.map(toKnownCapture),
		matchedCaptureIds,
		transactions: ledger,
		linkedTransactionIds,
		rules,
		ownNames: options.ownNames,
		autoConfirmThreshold: options.autoConfirmThreshold ?? DEFAULT_AUTO_CONFIRM_THRESHOLD,
		nextId: generateUniqueId,
		accountIdByKey,
	});

	// O que ia para a revisão (ou entraria sozinho) e tem um lançamento digitado parecido
	// noutra conta do mesmo tipo pergunta antes: confirmar os dois dobrava o gasto.
	const allAccounts = await getAccounts();
	const isCardAccount = new Map(allAccounts.map((account) => [account.id, account.kind === 'credit_card']));
	const claimedByPlan = new Set(linkedTransactionIds);
	for (const item of planned) {
		if (item.action.type === 'match_transaction') claimedByPlan.add(item.action.transactionId);
	}
	const ledgerSuspects = new Set<string>();
	for (const item of planned) {
		if (item.action.type !== 'decision') continue;
		const decided = item.action.decision.action;
		if (decided !== 'pending' && decided !== 'auto_confirm') continue;
		const suspect = findLedgerSuspect(
			item.line,
			accountIdByKey.get(item.line.accountKey) ?? null,
			ledger,
			isCardAccount,
			claimedByPlan
		);
		if (!suspect) continue;
		claimedByPlan.add(suspect.id);
		ledgerSuspects.add(item.id);
		item.action = { type: 'decision', decision: { action: 'ask_duplicate', relatedId: suspect.id } };
		if (decided === 'pending') summary.pending -= 1;
		else summary.autoConfirmed -= 1;
		summary.questions += 1;
	}

	const installmentOffers = await installmentOffersOf(planned, accountIdByKey, allAccounts, rules, options);

	// As notificações pendentes que o extrato casou: decididas depois da gravação (SPD-117).
	const matchedPending: Array<{ capture: Capture; accountMoved: boolean; line: StatementLine }> = [];

	// Tudo ou nada: um import pela metade deixaria linhas "já vistas" sem as que as
	// justificam, e a próxima tentativa pularia as gravadas pelo FITID.
	await runInTransaction(async () => {
		for (const item of planned) {
			const { action, line, fingerprint, id } = item;
			if (action.type === 'skip_existing') continue;

			const accountId = accountIdByKey.get(line.accountKey) ?? null;
			const base = baseDraftOf(line, fingerprint, accountId);

			if (action.type === 'match_capture') {
				// O extrato sabe a conta: uma compra que a notificação pôs na conta corrente,
				// e o extrato do cartão confirma, passa para o cartão — com o que já lançou.
				const matched = await getCapture(action.captureId);
				const accountMoved = Boolean(matched && accountId && matched.accountId !== accountId);
				if (matched && accountId && accountMoved) {
					await updateCapture(matched.id, { accountId });
					if (matched.transactionId) await reassignCaptureLedger(matched.transactionId, matched.id, accountId);
				}
				// A linha casada é também a marca "valor confirmado pelo extrato" da pendente.
				await insertCapture(
					{ ...base, status: 'duplicate', relatedId: action.captureId, reason: 'statement_capture' },
					id
				);
				if (matched?.status === 'pending') matchedPending.push({ capture: matched, accountMoved, line });
			} else if (action.type === 'match_transaction') {
				// O lançamento digitado não sabia de onde saiu; o extrato sabe.
				if (accountId) await assignTransactionAccount(action.transactionId, accountId);
				await insertCapture(
					{
						...base,
						status: 'confirmed',
						transactionId: action.transactionId,
						suggestedCategory: null,
						reason: 'statement_transaction',
					},
					id
				);
			} else if (ledgerSuspects.has(id)) {
				await applyDecision({ ...base, reason: STATEMENT_LEDGER_SUSPECT_REASON }, action.decision, options.categories, id);
			} else {
				await applyDecision(base, action.decision, options.categories, id);
			}
		}
	});

	const settledCaptures: StatementSettledCapture[] = [];
	for (const { capture, accountMoved, line } of matchedPending) {
		settledCaptures.push(await settleCapture(capture, accountMoved, line, lines, options));
	}

	return {
		accounts: statement.accounts.map((account) => ({
			accountKey: account.accountKey,
			bankName: account.bankName,
			isCard: account.isCard,
			malformed: account.skipped,
			lines: account.entries.length,
		})),
		summary,
		settledCaptures,
		installmentOffers,
	};
};

/**
 * A pendente que o extrato casou (DEC-36 Q5, `settleMatchedCapture`): confirma pelo mesmo
 * caminho do toque na revisão (`confirmCapture`) quando a categoria é a da regra aprendida;
 * senão ela fica onde está, e a linha do extrato já gravada é a marca. Roda fora da
 * transação do import: a confirmação lança no livro e dá baixa em conta a pagar por conta
 * própria, e uma falha aqui não desfaz o extrato — a captura só continua pendente, marcada.
 * A conta já é a do extrato (corrigida na gravação), e a confirmação a lê de novo.
 *
 * O aviso "entrou ou saiu?" (SPD-164) passa por `directionOf` antes: respondido, segue como
 * os outros; sem resposta, o extrato responde quando pode; senão continua pendente, marcado.
 */
const settleCapture = async (
	capture: Capture,
	accountMoved: boolean,
	line: StatementLine,
	lines: StatementLine[],
	options: StatementImportOptions
): Promise<StatementSettledCapture> => {
	const rule = capture.merchantKey ? toMerchantRule(await getMerchantRule(capture.merchantKey)) : undefined;
	const direction = await directionOf(capture, line, lines, options.choiceStore);
	const settlement = settleMatchedCapture(capture, rule, direction === 'answered' || direction === 'statement');
	let confirmed = false;
	if (settlement.action === 'confirm' && capture.suggestedCategory) {
		try {
			confirmed =
				(await confirmCapture(capture.id, capture.suggestedCategory, options.categories, undefined, options.choiceStore)) !==
				null;
		} catch (error) {
			console.error('Failed to confirm capture from statement:', error);
		}
	}
	logCaptureDecision({
		raw: { packageName: capture.packageName, title: '', text: '' },
		fingerprint: capture.fingerprint,
		outcome: {
			step: 'statement_match',
			captureId: capture.id,
			confirmed,
			why: settlement.action === 'mark' ? settlement.why : confirmed ? 'rule' : 'confirm_failed',
			accountMoved,
			...(direction ? { direction } : {}),
		},
	});
	return { captureId: capture.id, outcome: confirmed ? 'confirmed' : 'marked' };
};

/**
 * A direção do aviso "entrou ou saiu?" que o extrato casou (SPD-164). `null` para os outros
 * avisos.
 *
 *  - `answered`: já respondida na revisão, ou decidida pela regra aprendida (`isDirectionGuess`);
 *  - `statement`: era o palpite, e o extrato respondeu (`statementAnswersDirection`). A
 *    resposta vai para a mesma preferência que a revisão grava (a regra do caso), com a
 *    direção da linha — que é a do item, porque só casa a mesma direção. O item não muda;
 *  - `guess`: continua o palpite — sem o lugar das respostas, ou com o extrato se
 *    contradizendo. Fica pendente, marcado, e a revisão pergunta.
 *
 * Uma falha ao ler ou gravar a preferência vale como `guess`: o aviso só continua na revisão.
 */
const directionOf = async (
	capture: Capture,
	line: StatementLine,
	lines: StatementLine[],
	store: CaptureChoiceStore | undefined
): Promise<'answered' | 'statement' | 'guess' | null> => {
	if (ambiguityOfReason(capture.reason)?.case !== 'pix_direction') return null;
	if (!store) return isDirectionGuess(capture, {}) ? 'guess' : 'answered';
	try {
		const choices = await store.read();
		if (!isDirectionGuess(capture, choices)) return 'answered';
		if (!statementAnswersDirection(capture, line, lines)) return 'guess';
		await store.write(rememberChoice(choices, choiceKeyOf(capture, 'pix_direction'), line.direction));
		return 'statement';
	} catch (error) {
		console.error('Failed to answer capture direction from statement:', error);
		return 'guess';
	}
};

// ---------------------------------------------------------------------------
// As parcelas que faltam (SPD-117, AUTO-15)
// ---------------------------------------------------------------------------

/** "PADARIA 3/10" → "PADARIA": a marca da parcela sai, a nota de cada uma ganha a sua. */
const withoutInstallmentMarker = (text: string): string =>
	text
		.replace(/(?:parc(?:ela)?\.?\s*)?\b\d{1,2}\s*(?:\/|de)\s*\d{1,2}\b/gi, '')
		.replace(/\s+/g, ' ')
		.replace(/[\s\-–:]+$/, '')
		.trim();

/**
 * As ofertas do import: as lacunas que `planInstallmentGaps` acha, com o nome, a categoria
 * e a conta que a tela mostra. Só lê o livro inteiro dos cartões quando o arquivo traz
 * alguma linha "k/N" — as parcelas seguintes são futuras, fora da fotografia do plano.
 */
const installmentOffersOf = async (
	planned: PlannedLine[],
	accountIdByKey: Map<string, string>,
	accounts: Account[],
	rules: Map<string, MerchantRule>,
	options: IngestOptions
): Promise<StatementInstallmentOffer[]> => {
	const cardIds = new Set(
		planned.flatMap(({ line }) => {
			const accountId = line.isCard && parseInstallmentMarker(line.text) ? accountIdByKey.get(line.accountKey) : undefined;
			return accountId ? [accountId] : [];
		})
	);
	const cards = new Map<string, InstallmentCard>();
	const ledger: LedgerTransaction[] = [];
	for (const account of accounts) {
		if (!cardIds.has(account.id) || account.kind !== 'credit_card') continue;
		cards.set(account.id, { rule: cycleRuleOf(account), openingBalanceDate: account.openingBalanceDate });
		for (const transaction of await getAccountTransactions(account.id)) {
			ledger.push({
				id: transaction.id,
				amountCents: transaction.amountCents,
				isIncome: transaction.isIncome,
				date: transaction.date,
				installmentIndex: transaction.installmentIndex,
				installmentCount: transaction.installmentCount,
				accountId: transaction.accountId,
			});
		}
	}
	if (cards.size === 0) return [];

	return planInstallmentGaps(planned, { accountIdByKey, cards, ledger }).map((gap) => {
		const { line } = gap.planned;
		const rule = line.merchantKey ? rules.get(line.merchantKey) : undefined;
		const wanted = rule?.treatAs === 'transaction' && rule.categoryId ? rule.categoryId : line.suggestedCategory;
		const named = line.counterparty ?? (line.name.trim() || line.memo);
		return {
			accountId: gap.accountId,
			accountName: accounts.find((account) => account.id === gap.accountId)?.name ?? line.bankName,
			description: withoutInstallmentMarker(named) || named.trim() || line.bankName,
			parcelCents: line.amountCents,
			index: gap.index,
			count: gap.count,
			categoryId: resolveCategoryId(wanted, 'out', options.categories),
			parcels: gap.parcels,
		};
	});
};

/**
 * Cria as parcelas que a oferta lista, quando o usuário aceita: um plano só
 * (`installmentGroup`), as mesmas colunas e a mesma nota "(4/10)" das parcelas que o app já
 * lança (`postTransaction`, "Parcela antiga" do cartão). A parcela do extrato não entra:
 * ela já está na caixa de entrada pela linha do import. Devolve quantas criou.
 */
export const createStatementInstallments = async (offer: StatementInstallmentOffer): Promise<number> => {
	if (offer.parcels.length === 0) return 0;
	const group = generateUniqueId();
	await runInTransaction(async () => {
		for (const { index, date } of offer.parcels) {
			await addTransaction({
				amountCents: offer.parcelCents,
				category: offer.categoryId,
				date,
				note: `${offer.description} (${index}/${offer.count})`,
				isIncome: false,
				accountId: offer.accountId,
				installmentGroup: group,
				installmentIndex: index,
				installmentCount: offer.count,
			});
		}
	});
	syncQueue.schedule();
	return offer.parcels.length;
};

/**
 * Abre o seletor de arquivos, lê o OFX escolhido e importa. `null` se o usuário
 * cancelou. Aceita qualquer tipo porque o MIME de .ofx varia entre aparelhos
 * (application/x-ofx, text/plain, application/octet-stream…).
 */
export const pickAndImportOfx = async (
	options: StatementImportOptions
): Promise<StatementImportResult | null> => {
	const result = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
	if (result.canceled) return null;

	const uri = result.assets?.[0]?.uri;
	if (!uri) throw new StatementImportError('unreadable');

	let bytes: Uint8Array;
	try {
		bytes = await new File(uri).bytes();
	} catch {
		throw new StatementImportError('unreadable');
	}

	return importOfxContent(decodeOfxBytes(bytes), options);
};

export default {
	importOfxContent,
	createStatementInstallments,
	pickAndImportOfx,
	StatementImportError,
	withStatementAccountChooser,
	walkStatementChoice,
	findLedgerSuspect,
};
