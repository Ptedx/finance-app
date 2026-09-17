/**
 * Conciliação de um extrato OFX com o que o app já sabe.
 *
 * O extrato é a fonte mais completa, mas chega por último: quando ele é importado, a
 * maioria das linhas já está no app — como notificação capturada, como lançamento
 * digitado, ou como ocorrência de uma recorrência. Inserir tudo de novo seria a
 * dupla contagem que este módulo existe para impedir. A escada, do mais certo ao mais
 * provável:
 *
 *  1. **FITID já visto** → a linha já entrou num import anterior. Nada a fazer. É o
 *     que torna reimportar o mesmo arquivo, ou dois meses com sobreposição, inofensivo.
 *  2. **Notificação capturada** com o mesmo valor e direção, avisada no mesmo dia ou
 *     até alguns dias antes do lançamento no extrato → a linha é registrada como
 *     "já vista", apontando para a captura. Cada captura só casa com uma linha.
 *  3. **Lançamento no livro** que não veio de captura (digitado ou recorrente), mesmo
 *     valor e direção, até 2 dias de diferença → a linha é ligada a ele. Cada
 *     lançamento só casa com uma linha; havendo mais de um candidato, o de data mais
 *     próxima.
 *  4. **O que sobra** passa pela mesma decisão das notificações (`decide`): pode
 *     virar transferência entre duas contas importadas, neutro (fatura, aplicação),
 *     automático (estabelecimento já aprendido) ou item para revisar.
 *
 * Puro e determinístico: recebe as linhas e uma fotografia do estado, devolve um
 * plano linha a linha. Quem grava é `statementImport.ts`. Isso é o que permite testar
 * a conciliação inteira sem banco, inclusive por propriedades sobre cenários aleatórios.
 */

import {
	type Decision,
	decide,
	isStatementPackage,
	type KnownCapture,
	localDateOf,
	type MerchantRule,
	STATEMENT_LAG_DAYS_BEFORE,
	STATEMENT_PACKAGE_PREFIX,
	withinStatementLag,
} from './captureMatcher';
import { parseInstallmentMarker } from './installments';
import type { OfxAccount, OfxEntry } from './ofxParser';

export interface StatementLine extends OfxEntry {
	accountKey: string;
	bankName: string;
	isCard: boolean;
}

/** As linhas de uma conta, carimbadas com a conta a que pertencem. */
export const linesOf = (account: OfxAccount): StatementLine[] =>
	account.entries.map((entry) => ({
		...entry,
		accountKey: account.accountKey,
		bankName: account.bankName,
		isCard: account.isCard,
	}));

/** Impressão digital de uma linha: conta + FITID. Única por construção. */
export const statementFingerprint = (accountKey: string, fitid: string): string =>
	`${STATEMENT_PACKAGE_PREFIX}${accountKey}:${fitid}`;

/** O `packageName` sintético de uma conta de extrato. */
export const statementPackageName = (accountKey: string): string =>
	`${STATEMENT_PACKAGE_PREFIX}${accountKey}`;

/**
 * Meio-dia local do dia do extrato. As janelas por tempo (`TRANSFER_WINDOW_MS` etc.)
 * comparam instantes; o meio-dia mantém o dia de calendário estável em qualquer fuso
 * e deixa "ontem" e "amanhã" a exatamente um dia de distância.
 */
export const statementPostedAt = (date: string): string => `${date}T12:00:00.000`;

/** Um lançamento do livro-caixa, o suficiente para casar com uma linha. */
export interface LedgerTransaction {
	id: string;
	amountCents: number;
	isIncome: boolean;
	/** `YYYY-MM-DD`. */
	date: string;
	/** Parcela k de N, quando o lançamento é uma parcela; nulos à vista. */
	installmentIndex?: number | null;
	installmentCount?: number | null;
	/** A conta do lançamento; nulo quando o lançamento ainda não tem conta. */
	accountId?: string | null;
}

/**
 * Uma parcela é datada um mês após a anterior a partir da compra, mas a fatura a
 * lança na data de fechamento do ciclo — até ~40 dias de diferença. A linha do extrato
 * traz "k/N", e é por isso, não pela data, que ela encontra a parcela certa.
 */
export const MATCH_INSTALLMENT_WINDOW_DAYS = 45;

export interface StatementPlanContext {
	/** Impressões digitais de tudo que já está na caixa de entrada. */
	existingFingerprints: Set<string>;
	/** Capturas recentes, de qualquer fonte, no formato da decisão. */
	captures: KnownCapture[];
	/** Capturas que uma linha de import anterior já reivindicou. */
	matchedCaptureIds: Set<string>;
	transactions: LedgerTransaction[];
	/** Lançamentos criados a partir de uma captura, ou já ligados a uma linha. */
	linkedTransactionIds: Set<string>;
	rules: Map<string, MerchantRule>;
	ownNames: string[];
	autoConfirmThreshold: number;
	/** Gera o id que a linha terá na caixa de entrada; injetável para o plano ser determinístico. */
	nextId: () => string;
	/** A conta de cada extrato do arquivo (`accountKey` → id), já resolvida. */
	accountIdByKey?: Map<string, string>;
}

export type StatementAction =
	| { type: 'skip_existing' }
	| { type: 'match_capture'; captureId: string }
	| { type: 'match_transaction'; transactionId: string }
	| { type: 'decision'; decision: Decision };

export interface PlannedLine {
	/** Id que a linha terá na caixa de entrada (vazio quando `skip_existing`). */
	id: string;
	line: StatementLine;
	fingerprint: string;
	action: StatementAction;
}

export interface StatementSummary {
	total: number;
	skippedExisting: number;
	matchedCaptures: number;
	matchedTransactions: number;
	/** Linhas novas que vão para revisão sem pergunta. */
	pending: number;
	/** Linhas novas que vão para revisão com uma pergunta (duplicata ou transferência). */
	questions: number;
	autoConfirmed: number;
	transfers: number;
	/** Fatura, aplicação, regra de ignorar. */
	ignored: number;
}

/** Quantos lançamentos o import de fato inserirá no livro-caixa. */
export const insertionsOf = (summary: StatementSummary): number => summary.autoConfirmed;

/**
 * Janela entre a data de um lançamento do livro e a data do extrato. O extrato lança
 * depois da compra (fim de semana, feriado, fechamento), então a folga para a frente
 * é maior; para trás, dois dias cobrem quem digitou o gasto no dia seguinte.
 */
export const MATCH_TRANSACTION_DAYS_BEFORE = 2;
export const MATCH_TRANSACTION_DAYS_AFTER = 5;

const dayNumber = (date: string): number => {
	const [year, month, day] = date.split('-').map(Number);
	return Math.round(Date.UTC(year, month - 1, day) / 86_400_000);
};

const isLiveForMatching = (capture: KnownCapture): boolean =>
	capture.status === 'pending' || capture.status === 'confirmed' || capture.status === 'transfer';

/**
 * Por que "o mais antigo em janela" e não "o mais próximo".
 *
 * As linhas são processadas em ordem de data, e cada registro (notificação ou
 * lançamento) aceita linhas num intervalo fixo de dias. Escolher, para cada linha, o
 * registro compatível **de data mais antiga** é o guloso clássico de "prazo mais
 * cedo primeiro", e ele casa todo registro que tenha alguma linha compatível — o
 * que "o mais próximo" não garante: uma linha poderia tomar o registro de outra e
 * deixar o seu próprio sem par, e aí o app mostraria duas vezes a mesma compra.
 * Qual registro casa com qual linha não muda os totais; deixar um sem par muda.
 */

/**
 * A notificação que já registra esta linha. Só notificações (nunca outra linha de
 * extrato), vivas, com o mesmo valor e direção, avisadas dentro da janela do extrato.
 * Entre várias, a avisada primeiro; no empate, a de id menor, para o plano ser o
 * mesmo em qualquer ordem de leitura.
 */
/**
 * Notificação de outra conta só casa se for compra: uma compra do cartão que a
 * notificação mandou para a conta corrente é a mesma compra, e o extrato do cartão corrige
 * a conta. Um Pix da conta corrente com o mesmo valor não é.
 */
const CROSS_ACCOUNT_KINDS = new Set(['purchase', 'refund', 'unknown']);

export const findCaptureForLine = (
	line: StatementLine,
	captures: KnownCapture[],
	claimed: Set<string>,
	accountId: string | null = null
): KnownCapture | undefined => {
	let best: KnownCapture | undefined;

	for (const capture of captures) {
		if (claimed.has(capture.id)) continue;
		if (accountId && capture.accountId && capture.accountId !== accountId && !CROSS_ACCOUNT_KINDS.has(capture.kind)) continue;
		if (!isLiveForMatching(capture)) continue;
		if (isStatementPackage(capture.packageName)) continue;
		if (capture.direction !== line.direction || capture.amountCents !== line.amountCents) continue;
		if (!withinStatementLag(localDateOf(capture.postedAt), line.postedDate)) continue;

		if (
			!best ||
			capture.postedAt < best.postedAt ||
			(capture.postedAt === best.postedAt && capture.id < best.id)
		) {
			best = capture;
		}
	}

	return best;
};

/**
 * O lançamento do livro que já registra esta linha: digitado à mão ou gerado por uma
 * recorrência, nunca um criado a partir de captura (esses casam pela captura). Mesmo
 * valor e direção, até 2 dias de diferença; o de data mais antiga vence, e no empate
 * o de id menor.
 */
export const findTransactionForLine = (
	line: StatementLine,
	transactions: LedgerTransaction[],
	excluded: Set<string>,
	accountId: string | null = null
): LedgerTransaction | undefined => {
	const isIncome = line.direction === 'in';
	const marker = parseInstallmentMarker(line.text);
	let best: LedgerTransaction | undefined;

	for (const transaction of transactions) {
		if (excluded.has(transaction.id)) continue;
		// Lançamento que já tem conta, e é outra, não é esta linha: o mercado de R$ 100 no
		// débito não pode sumir com a compra de R$ 100 do cartão.
		if (accountId && transaction.accountId && transaction.accountId !== accountId) continue;
		if (transaction.isIncome !== isIncome || transaction.amountCents !== line.amountCents) continue;

		const offset = dayNumber(line.postedDate) - dayNumber(transaction.date);
		if (marker) {
			// Linha de parcela: só a parcela de mesmo índice e total, com janela larga.
			if (transaction.installmentIndex !== marker.index || transaction.installmentCount !== marker.count) continue;
			if (Math.abs(offset) > MATCH_INSTALLMENT_WINDOW_DAYS) continue;
		} else {
			if (offset < -MATCH_TRANSACTION_DAYS_BEFORE || offset > MATCH_TRANSACTION_DAYS_AFTER) continue;
		}

		if (
			!best ||
			transaction.date < best.date ||
			(transaction.date === best.date && transaction.id < best.id)
		) {
			best = transaction;
		}
	}

	return best;
};

export type RecordMatch =
	| { type: 'capture'; capture: KnownCapture }
	| { type: 'transaction'; transaction: LedgerTransaction };

/**
 * Notificação ou lançamento: um só guloso para os dois.
 *
 * Os dois conjuntos disputam a mesma linha, e olhar primeiro as notificações e só
 * depois os lançamentos quebra a garantia do "prazo mais cedo primeiro": uma linha
 * tomaria uma notificação de prazo longo enquanto um lançamento digitado, que só
 * aceita 2 dias, ficava para trás e expirava. Então o prazo é comparado entre os
 * dois — o último dia de extrato que cada registro ainda aceita — e o mais curto
 * vence. No empate, a notificação, que carrega mais informação.
 */
export const findRecordForLine = (
	line: StatementLine,
	captures: KnownCapture[],
	transactions: LedgerTransaction[],
	claimedCaptures: Set<string>,
	claimedTransactions: Set<string>,
	accountId: string | null = null
): RecordMatch | undefined => {
	const capture = findCaptureForLine(line, captures, claimedCaptures, accountId);
	const transaction = findTransactionForLine(line, transactions, claimedTransactions, accountId);

	if (capture && transaction) {
		const captureDeadline = dayNumber(localDateOf(capture.postedAt)) + STATEMENT_LAG_DAYS_BEFORE;
		const transactionDeadline =
			dayNumber(transaction.date) +
			(transaction.installmentIndex ? MATCH_INSTALLMENT_WINDOW_DAYS : MATCH_TRANSACTION_DAYS_AFTER);
		return transactionDeadline < captureDeadline ? { type: 'transaction', transaction } : { type: 'capture', capture };
	}
	if (capture) return { type: 'capture', capture };
	if (transaction) return { type: 'transaction', transaction };
	return undefined;
};

const statusAfter = (decision: Decision): KnownCapture['status'] => {
	switch (decision.action) {
		case 'duplicate':
			return 'duplicate';
		case 'transfer':
			return 'transfer';
		case 'neutral':
		case 'ignore':
			return 'ignored';
		case 'auto_confirm':
			return 'confirmed';
		default:
			return 'pending';
	}
};

export const planStatementImport = (
	lines: StatementLine[],
	context: StatementPlanContext
): { planned: PlannedLine[]; summary: StatementSummary } => {
	const summary: StatementSummary = {
		total: lines.length,
		skippedExisting: 0,
		matchedCaptures: 0,
		matchedTransactions: 0,
		pending: 0,
		questions: 0,
		autoConfirmed: 0,
		transfers: 0,
		ignored: 0,
	};

	// Ordem cronológica e estável: uma transferência entre duas contas do mesmo
	// arquivo precisa ver a primeira perna já no plano quando a segunda chegar.
	const ordered = [...lines].sort(
		(a, b) => a.postedDate.localeCompare(b.postedDate) || a.fitid.localeCompare(b.fitid)
	);

	const claimedCaptures = new Set(context.matchedCaptureIds);
	const claimedTransactions = new Set(context.linkedTransactionIds);
	const seenFingerprints = new Set(context.existingFingerprints);
	const recent: KnownCapture[] = [...context.captures];
	const planned: PlannedLine[] = [];

	for (const line of ordered) {
		const fingerprint = statementFingerprint(line.accountKey, line.fitid);

		if (seenFingerprints.has(fingerprint)) {
			summary.skippedExisting += 1;
			planned.push({ id: '', line, fingerprint, action: { type: 'skip_existing' } });
			continue;
		}
		seenFingerprints.add(fingerprint);

		const id = context.nextId();
		const packageName = statementPackageName(line.accountKey);
		const postedAt = statementPostedAt(line.postedDate);

		// Neutros não casam com nada: se o usuário digitou "pagamento da fatura" como
		// despesa, é escolha dele, e a linha só vai para o histórico como ignorada.
		if (!line.neutral) {
			const record = findRecordForLine(
				line,
				recent,
				context.transactions,
				claimedCaptures,
				claimedTransactions,
				context.accountIdByKey?.get(line.accountKey) ?? null
			);

			if (record?.type === 'capture') {
				claimedCaptures.add(record.capture.id);
				if (record.capture.transactionId) claimedTransactions.add(record.capture.transactionId);
				summary.matchedCaptures += 1;
				recent.push({
					id,
					packageName,
					postedAt,
					amountCents: line.amountCents,
					direction: line.direction,
					kind: line.kind,
					merchantKey: line.merchantKey,
					status: 'duplicate',
					relatedId: null,
					transactionId: null,
				});
				planned.push({ id, line, fingerprint, action: { type: 'match_capture', captureId: record.capture.id } });
				continue;
			}

			if (record?.type === 'transaction') {
				claimedTransactions.add(record.transaction.id);
				summary.matchedTransactions += 1;
				recent.push({
					id,
					packageName,
					postedAt,
					amountCents: line.amountCents,
					direction: line.direction,
					kind: line.kind,
					merchantKey: line.merchantKey,
					status: 'confirmed',
					relatedId: null,
					transactionId: record.transaction.id,
				});
				planned.push({
					id,
					line,
					fingerprint,
					action: { type: 'match_transaction', transactionId: record.transaction.id },
				});
				continue;
			}
		}

		const decision = decide(
			{
				packageName,
				postedAt,
				amountCents: line.amountCents,
				direction: line.direction,
				kind: line.kind,
				counterparty: line.counterparty,
				merchantKey: line.merchantKey,
				neutral: line.neutral,
			},
			{
				recent,
				rule: line.merchantKey ? context.rules.get(line.merchantKey) : undefined,
				ownNames: context.ownNames,
				autoConfirmThreshold: context.autoConfirmThreshold,
				fallbackCategoryId: line.suggestedCategory,
			}
		);

		switch (decision.action) {
			case 'pending':
				summary.pending += 1;
				break;
			case 'ask_duplicate':
			case 'ask_transfer':
				summary.questions += 1;
				break;
			case 'auto_confirm':
				summary.autoConfirmed += 1;
				break;
			case 'transfer':
				summary.transfers += 1;
				break;
			case 'neutral':
			case 'ignore':
				summary.ignored += 1;
				break;
			case 'duplicate':
				summary.matchedCaptures += 1;
				break;
		}

		recent.push({
			id,
			packageName,
			postedAt,
			amountCents: line.amountCents,
			direction: line.direction,
			kind: line.kind,
			merchantKey: line.merchantKey,
			status: statusAfter(decision),
			relatedId: null,
			transactionId: null,
		});
		planned.push({ id, line, fingerprint, action: { type: 'decision', decision } });
	}

	return { planned, summary };
};

export default {
	linesOf,
	planStatementImport,
	findCaptureForLine,
	findTransactionForLine,
	findRecordForLine,
	statementFingerprint,
	statementPackageName,
	statementPostedAt,
	insertionsOf,
};
