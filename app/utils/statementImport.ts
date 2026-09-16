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
 */

import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import {
	type CaptureDraft,
	getLinkedTransactionIds,
	getMerchantRule,
	getRecentCaptures,
	getStatementClaimedCaptureIds,
	getStatementFingerprints,
	insertCapture,
} from '../database/captures';
import { db, getTransactionsByDateRange } from '../database/database';
import { generateUniqueId } from '../utils/categoryEditUtils';
import { applyDecision, type IngestOptions, toKnownCapture, toMerchantRule } from './captureActions';
import { DEFAULT_AUTO_CONFIRM_THRESHOLD, type MerchantRule } from './captureMatcher';
import { addDays } from './dateUtils';
import { decodeOfxBytes, parseOfx } from './ofxParser';
import {
	type LedgerTransaction,
	linesOf,
	planStatementImport,
	type StatementLine,
	type StatementSummary,
	statementPackageName,
	statementPostedAt,
} from './statementMatcher';

export interface StatementImportAccountResult {
	accountKey: string;
	bankName: string;
	isCard: boolean;
	/** Linhas do arquivo sem FITID, data ou valor válidos. */
	malformed: number;
	lines: number;
}

export interface StatementImportResult {
	accounts: StatementImportAccountResult[];
	summary: StatementSummary;
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

const baseDraftOf = (line: StatementLine, fingerprint: string): CaptureDraft => ({
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

/**
 * Importa o conteúdo de um arquivo OFX já decodificado.
 *
 * Todas as contas do arquivo são planejadas juntas: uma transferência entre duas
 * contas presentes no mesmo arquivo é reconhecida na hora.
 */
export const importOfxContent = async (
	content: string,
	options: IngestOptions
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
				addDays(firstDate, -TRANSACTION_LOOKBACK_DAYS),
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
	}));

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
	});

	// Tudo ou nada: um import pela metade deixaria linhas "já vistas" sem as que as
	// justificam, e a próxima tentativa pularia as gravadas pelo FITID.
	await db.withTransactionAsync(async () => {
		for (const item of planned) {
			const { action, line, fingerprint, id } = item;
			if (action.type === 'skip_existing') continue;

			const base = baseDraftOf(line, fingerprint);

			if (action.type === 'match_capture') {
				await insertCapture(
					{ ...base, status: 'duplicate', relatedId: action.captureId, reason: 'statement_capture' },
					id
				);
			} else if (action.type === 'match_transaction') {
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
			} else {
				await applyDecision(base, action.decision, options.categories, id);
			}
		}
	});

	return {
		accounts: statement.accounts.map((account) => ({
			accountKey: account.accountKey,
			bankName: account.bankName,
			isCard: account.isCard,
			malformed: account.skipped,
			lines: account.entries.length,
		})),
		summary,
	};
};

/**
 * Abre o seletor de arquivos, lê o OFX escolhido e importa. `null` se o usuário
 * cancelou. Aceita qualquer tipo porque o MIME de .ofx varia entre aparelhos
 * (application/x-ofx, text/plain, application/octet-stream…).
 */
export const pickAndImportOfx = async (
	options: IngestOptions
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

export default { importOfxContent, pickAndImportOfx, StatementImportError };
