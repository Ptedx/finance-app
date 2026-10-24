/**
 * O que fazer com uma notificação já interpretada.
 *
 * As duas perguntas que mais custam confiança num livro-caixa automático:
 *
 *  1. **É a mesma compra duas vezes?** Samsung Pay avisa no ato e o banco avisa logo
 *     depois; dois avisos, uma compra. Sem tratamento, viram duas despesas.
 *  2. **É dinheiro trocando de bolso?** Um Pix da conta A para a conta B aparece como
 *     saída num app e entrada no outro. Lançar os dois inventa uma despesa e uma
 *     receita que não existem; lançar um só distorce o saldo.
 *
 * A regra de ouro aqui é: **o que é certo, decide sozinho; o que é provável, pergunta.**
 * Carteira + banco com o mesmo valor é certo. Saída e entrada do mesmo valor em dois
 * bancos no mesmo dia é provável — pode ser um Pix para um amigo e outro de outro amigo —
 * então vira uma pergunta de um toque, nunca um palpite silencioso.
 *
 * As linhas de extrato OFX passam pelo mesmo funil, com `packageName` `ofx:<conta>`.
 * Elas nunca são duplicata umas das outras (o FITID já garante isso), e uma
 * notificação que chega depois de o extrato já ter a compra vira duplicata dela.
 *
 * Puro: recebe o candidato e o que já está na caixa de entrada, devolve uma decisão.
 */

import {
	type CaptureDirection,
	type CaptureKind,
	isWalletPackage,
	merchantKeyOf,
	normalizeText,
	type RawCapture,
} from './captureParser';
import { addDays, getISODate } from './dateUtils';

export type CaptureStatus =
	| 'pending'
	| 'confirmed'
	| 'dismissed'
	| 'duplicate'
	| 'transfer'
	| 'ignored';

/** A pergunta que um item pendente está fazendo, quando faz alguma. */
export type CaptureQuestion = 'duplicate' | 'transfer';

/** O que a decisão precisa saber de cada item já existente na caixa de entrada. */
export interface KnownCapture {
	id: string;
	packageName: string;
	postedAt: string;
	amountCents: number;
	direction: CaptureDirection;
	kind: CaptureKind;
	merchantKey: string | null;
	status: CaptureStatus;
	/** A outra perna, quando o item já foi pareado (duplicata ou transferência). */
	relatedId: string | null;
	transactionId: string | null;
	/** A conta ou cartão em que a captura caiu. Opcional para quem não precisa. */
	accountId?: string | null;
	/** Final do cartão, quando o aviso o trazia. Opcional para quem não precisa. */
	cardLast4?: string | null;
}

export interface Candidate {
	packageName: string;
	postedAt: string;
	amountCents: number;
	direction: CaptureDirection;
	kind: CaptureKind;
	counterparty: string | null;
	merchantKey: string | null;
	neutral: boolean;
	/** Final do cartão, quando o aviso o trazia. Opcional: as linhas de extrato não têm. */
	cardLast4?: string | null;
	/** A conta ou cartão que o resolvedor achou para este aviso. Opcional. */
	accountId?: string | null;
}

export type MerchantTreatment = 'transaction' | 'transfer' | 'ignore';

export interface MerchantRule {
	merchantKey: string;
	categoryId: string | null;
	treatAs: MerchantTreatment;
	confirmations: number;
}

export type Decision =
	/** A mesma movimentação já está na caixa de entrada por outra fonte. Nada a perguntar. */
	| { action: 'duplicate'; relatedId: string; reason: 'wallet' | 'statement' }
	/** Mesmo valor, mesma direção, dois avisos próximos: provável, então pergunta. */
	| { action: 'ask_duplicate'; relatedId: string }
	/** Transferência entre contas próprias, certa: par encontrado e nome é o seu, ou regra aprendida. */
	| { action: 'transfer'; relatedId: string | null; reason: string }
	/** Saída e entrada do mesmo valor em contas diferentes: provável, então pergunta. */
	| { action: 'ask_transfer'; relatedId: string }
	/** Pagamento de fatura, aplicação, resgate: não é receita nem despesa. */
	| { action: 'neutral'; reason: string }
	/** Regra aprendida manda ignorar este estabelecimento, ou o app que avisou (`app_rule`). */
	| { action: 'ignore'; reason: string }
	/** Fica na caixa de entrada com uma categoria sugerida. */
	| { action: 'pending'; categoryId: string | null }
	/** Estabelecimento confirmado vezes suficientes: lança e avisa. */
	| { action: 'auto_confirm'; categoryId: string };

export interface DecisionContext {
	/** Itens recentes da caixa de entrada, em qualquer status. */
	recent: KnownCapture[];
	rule: MerchantRule | undefined;
	/** Nomes do próprio usuário: um Pix "para VINICIUS COSTA" é troca de bolso. */
	ownNames: string[];
	/** Quantas confirmações iguais até o app lançar sozinho. */
	autoConfirmThreshold: number;
	/** Palpite de categoria quando não há regra. */
	fallbackCategoryId: string | null;
	/**
	 * A regra do app que avisou (`app:<pacote>`), quando quem avisou não é banco nem
	 * carteira. Quem chama só a passa nesse caso; o motor confere de novo (SPD-022).
	 */
	appRule?: MerchantRule;
	/**
	 * A contraparte é uma fonte externa de receita (a empresa do usuário, por exemplo):
	 * o app aprendeu isso quando ele confirmou o que ela manda como receita. Um
	 * recebimento dela nunca é transferência entre contas próprias, mesmo que o outro
	 * lado ("você enviou para VINICIUS", visto pela conta PJ no mesmo app) esteja na
	 * caixa de entrada com o mesmo valor.
	 */
	externalIncome?: boolean;
}

// Janelas de tempo. Carteira e banco avisam com segundos de diferença, mas alguns
// bancos atrasam a notificação da compra no cartão em horas — daí quatro horas para a
// certeza, e doze para a pergunta. Era uma certeza de doze horas, e isso fundia duas
// compras de R$ 20,00 do mesmo dia (achado 7.4): valor redondo repetido é o caso comum.
// Entre dois bancos, avisos a menos de 3 minutos com o mesmo valor são suspeitos.
// Uma transferência entre contas próprias pode levar até um dia útil (TED).
export const WALLET_DUPLICATE_WINDOW_MS = 4 * 60 * 60 * 1000;
export const WALLET_SUSPECT_WINDOW_MS = 12 * 60 * 60 * 1000;
export const SUSPECT_DUPLICATE_WINDOW_MS = 3 * 60 * 1000;
export const TRANSFER_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_AUTO_CONFIRM_THRESHOLD = 3;

/**
 * Quantos descartes do mesmo app que não é banco até o app passar a ignorá-lo (SPD-022).
 * Três, como as confirmações que liberam o lançamento automático: uma vez é acaso, três
 * é hábito.
 */
export const APP_IGNORE_THRESHOLD = 3;

/**
 * Quanto o extrato pode atrasar em relação à notificação. A compra é avisada na hora
 * e lançada no extrato no mesmo dia ou dias depois (fim de semana, feriado); nunca
 * antes. Um dia de folga para trás cobre o fuso e a virada da meia-noite.
 */
export const STATEMENT_LAG_DAYS_BEFORE = 5;
export const STATEMENT_LAG_DAYS_AFTER = 1;

const msBetween = (a: string, b: string): number =>
	Math.abs(new Date(a).getTime() - new Date(b).getTime());

/** Dia de calendário local de um instante. */
export const localDateOf = (postedAt: string): string => getISODate(new Date(postedAt));

/** Prefixo dos `packageName` sintéticos das linhas de extrato. */
export const STATEMENT_PACKAGE_PREFIX = 'ofx:';

export const isStatementPackage = (packageName: string): boolean =>
	packageName.startsWith(STATEMENT_PACKAGE_PREFIX);

/** Tipos que podem ser uma perna de transferência entre contas. Compra nunca é. */
const TRANSFERABLE_KINDS = new Set<CaptureKind>([
	'pix_out',
	'pix_in',
	'transfer_out',
	'transfer_in',
	'withdrawal',
	'deposit',
	'unknown',
]);

/** Itens que ainda contam para comparação: descartados e ignorados já saíram do jogo. */
const isLive = (known: KnownCapture): boolean =>
	known.status === 'pending' || known.status === 'confirmed' || known.status === 'transfer';

// ---------------------------------------------------------------------------
// Impressão digital
// ---------------------------------------------------------------------------

/** FNV-1a de 32 bits: estável, rápido, suficiente para reconhecer a mesma notificação. */
const fnv1a = (input: string): string => {
	let hash = 0x811c9dc5;
	for (let index = 0; index < input.length; index += 1) {
		hash ^= input.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, '0');
};

/**
 * Identifica uma notificação. O Android reentrega a mesma notificação quando o app do
 * banco a atualiza; título, texto, app e o minuto em que foi publicada bastam para
 * reconhecê-la — e o minuto, em vez do instante exato, absorve a reentrega.
 */
export const fingerprintOf = (raw: RawCapture): string => {
	const minute = raw.postedAt.slice(0, 16);
	return `${fnv1a(`${raw.packageName}|${raw.title}|${raw.text}|${minute}`)}-${fnv1a(raw.text)}`;
};

// ---------------------------------------------------------------------------
// Buscas
// ---------------------------------------------------------------------------

/** Dois sinais iguais: só quando os dois lados têm o sinal. Nulo não confirma nada. */
const agrees = (a: string | null | undefined, b: string | null | undefined): boolean =>
	Boolean(a) && Boolean(b) && a === b;

/** Dois sinais que os dois lados têm e que não batem: são compras diferentes. */
const conflicts = (a: string | null | undefined, b: string | null | undefined): boolean =>
	Boolean(a) && Boolean(b) && a !== b;

/**
 * O par carteira + banco: um dos dois é carteira, o outro não; mesmo valor, ambos saída,
 * ambos vivos. É a forma do par — quem decide se é a **mesma** compra é a identidade.
 */
const isWalletPair = (known: KnownCapture, candidate: Candidate): boolean =>
	isLive(known) &&
	known.direction === 'out' &&
	candidate.direction === 'out' &&
	known.amountCents === candidate.amountCents &&
	!isStatementPackage(known.packageName) &&
	isWalletPackage(known.packageName) !== isWalletPackage(candidate.packageName);

/** Estabelecimento, final do cartão ou conta: o que os dois lados têm, e não bate. */
const identityConflicts = (known: KnownCapture, candidate: Candidate): boolean =>
	conflicts(known.merchantKey, candidate.merchantKey) ||
	conflicts(known.cardLast4, candidate.cardLast4) ||
	conflicts(known.accountId, candidate.accountId);

/** Pelo menos um sinal comparável que confirma: o mesmo lugar, o mesmo plástico, a mesma conta. */
const identityAgrees = (known: KnownCapture, candidate: Candidate): boolean =>
	agrees(known.merchantKey, candidate.merchantKey) ||
	agrees(known.cardLast4, candidate.cardLast4) ||
	agrees(known.accountId, candidate.accountId);

/**
 * A mesma compra vista pela carteira e pelo banco, **com certeza**.
 *
 * O par pode estar em qualquer status vivo — se o usuário já confirmou o aviso da
 * carteira antes de o banco avisar, o do banco é que vira duplicata.
 *
 * Valor e direção não bastam: R$ 20,00 é um valor que se repete no mesmo dia, e casar só
 * por valor fundia duas compras numa (achado 7.4), fechando a fatura do app menor que a
 * do banco, sem perguntar nada. Para decidir sozinho é preciso um sinal que confirme —
 * o estabelecimento, o final do cartão ou a conta — e nenhum que desminta.
 */
export const findWalletDuplicate = (
	candidate: Candidate,
	recent: KnownCapture[]
): KnownCapture | undefined =>
	recent.find(
		(known) =>
			isWalletPair(known, candidate) &&
			identityAgrees(known, candidate) &&
			!identityConflicts(known, candidate) &&
			msBetween(known.postedAt, candidate.postedAt) <= WALLET_DUPLICATE_WINDOW_MS
	);

/**
 * O par carteira + banco de identidade **indefinida**: mesmo valor e mesma direção, mas
 * sem nada que confirme ser a mesma compra (o aviso da carteira muitas vezes não traz
 * estabelecimento nem conta) ou com horas de diferença.
 *
 * Aqui o app não decide: pergunta. Duas compras de R$ 20,00 no mesmo dia, uma às 9h pela
 * carteira e outra às 18h no cartão, são duas — e eram uma só, em silêncio. Quando a
 * identidade **desmente** (outro estabelecimento, outro final) nem pergunta: são duas.
 */
export const findWalletSuspect = (
	candidate: Candidate,
	recent: KnownCapture[]
): KnownCapture | undefined =>
	recent.find(
		(known) =>
			isWalletPair(known, candidate) &&
			!identityConflicts(known, candidate) &&
			msBetween(known.postedAt, candidate.postedAt) <= WALLET_SUSPECT_WINDOW_MS
	);

/**
 * Se `statementDate` (dia do extrato) é compatível com `noticeDate` (dia do aviso):
 * o extrato lança no mesmo dia ou até alguns dias depois, nunca muito antes.
 */
export const withinStatementLag = (noticeDate: string, statementDate: string): boolean =>
	statementDate >= addDays(noticeDate, -STATEMENT_LAG_DAYS_AFTER) &&
	statementDate <= addDays(noticeDate, STATEMENT_LAG_DAYS_BEFORE);

/**
 * A linha de extrato que já registra esta notificação.
 *
 * Só para candidatos vindos de notificação: o extrato costuma ser importado depois,
 * e aí é o import que casa as linhas com as notificações (`statementMatcher`). Mas se
 * o extrato veio primeiro — importado no mesmo dia da compra — a notificação que
 * chega depois não pode virar uma segunda entrada.
 */
export const findStatementTwin = (
	candidate: Candidate,
	recent: KnownCapture[]
): KnownCapture | undefined => {
	if (isStatementPackage(candidate.packageName)) return undefined;
	const noticeDate = localDateOf(candidate.postedAt);
	return recent.find(
		(known) =>
			isLive(known) &&
			isStatementPackage(known.packageName) &&
			known.direction === candidate.direction &&
			known.amountCents === candidate.amountCents &&
			withinStatementLag(noticeDate, localDateOf(known.postedAt))
	);
};

/**
 * Dois avisos de banco, mesmo valor e direção, quase ao mesmo tempo.
 *
 * Pode ser o banco reenviando com outro texto, pode ser cobrança em dobro, pode ser
 * duas compras iguais seguidas (dois cafés). Não dá para saber daqui — pergunta.
 * Linhas de extrato ficam de fora dos dois lados: entre si o FITID já as distingue, e
 * contra notificações o casamento é feito pelo `statementMatcher`, com janela de dias.
 */
export const findSuspectedDuplicate = (
	candidate: Candidate,
	recent: KnownCapture[]
): KnownCapture | undefined => {
	if (isStatementPackage(candidate.packageName)) return undefined;
	return recent.find(
		(known) =>
			isLive(known) &&
			known.direction === candidate.direction &&
			known.amountCents === candidate.amountCents &&
			!isWalletPackage(known.packageName) &&
			!isWalletPackage(candidate.packageName) &&
			!isStatementPackage(known.packageName) &&
			msBetween(known.postedAt, candidate.postedAt) <= SUSPECT_DUPLICATE_WINDOW_MS
	);
};

/**
 * A outra perna de uma transferência entre contas próprias.
 *
 * Mesmo valor, direção oposta, tipos compatíveis com transferência, dentro de um dia,
 * e ainda sem par. Compras e estornos ficam de fora: "gastei 50 no mercado" e "recebi
 * 50 de estorno" não são troca de bolso.
 *
 * Por padrão a outra perna tem que vir de outro app: um Pix para um amigo e outro de
 * outro amigo, no mesmo banco, no mesmo dia, são dois lançamentos. Mas quando a
 * decisão já é certa por outro motivo — o nome é o do usuário, ou há regra aprendida —
 * o mesmo app vale (`allowSamePackage`): conta pessoal e conta PJ do mesmo banco
 * moram no mesmo aplicativo e avisam as duas pontas da mesma transferência.
 */
export const findTransferCounterpart = (
	candidate: Candidate,
	recent: KnownCapture[],
	allowSamePackage = false
): KnownCapture | undefined => {
	if (!TRANSFERABLE_KINDS.has(candidate.kind)) return undefined;
	return recent.find(
		(known) =>
			isLive(known) &&
			known.direction !== candidate.direction &&
			known.amountCents === candidate.amountCents &&
			(allowSamePackage || known.packageName !== candidate.packageName) &&
			TRANSFERABLE_KINDS.has(known.kind) &&
			!(known.status === 'transfer' && known.relatedId !== null) &&
			msBetween(known.postedAt, candidate.postedAt) <= TRANSFER_WINDOW_MS
	);
};

/**
 * Se a contraparte é o próprio usuário.
 *
 * Compara nome a nome, sem acento e sem caixa, e exige ao menos duas palavras iguais
 * (ou uma, quando o nome só tem uma): "VINICIUS COSTA" bate com "Vinicius A Costa",
 * mas "Vinicius" sozinho não bate com "Vinicius Silva".
 */
export const matchesOwnName = (counterparty: string | null, ownNames: string[]): boolean => {
	if (!counterparty) return false;
	const target = new Set(normalizeText(counterparty).split(' ').filter((w) => w.length > 1));
	if (target.size === 0) return false;

	return ownNames.some((own) => {
		const words = normalizeText(own).split(' ').filter((w) => w.length > 1);
		if (words.length === 0) return false;
		const hits = words.filter((word) => target.has(word)).length;
		return words.length === 1 ? hits === 1 && target.size === 1 : hits >= 2;
	});
};

// ---------------------------------------------------------------------------
// Apps que não são banco (SPD-022)
// ---------------------------------------------------------------------------

/**
 * A regra de um app mora em `merchant_rules`, como a de um estabelecimento, com a chave
 * `app:<pacote>`. Sincroniza e entra no backup sem nada novo, e não colide com chave de
 * estabelecimento: `merchantKeyOf` só devolve letras, números e espaços.
 */
export const APP_RULE_PREFIX = 'app:';

export const appRuleKeyOf = (packageName: string): string => `${APP_RULE_PREFIX}${packageName}`;

/**
 * Apps de SMS. Um pacote só junta todos os remetentes — o banco, a operadora, a loja —, e
 * calar o pacote calaria também o SMS do banco: em produção já chegou SMS com valor (há uma
 * conta fantasma "Messages"). Eles nunca aprendem "ignorar"; o aviso sem banco citado
 * continua ignorado direto, como o de qualquer app que não é banco. Para incluir outro
 * fabricante, basta acrescentar o pacote aqui.
 *
 * Mora aqui, e não em `accountResolver.ts` (que a reexporta), porque `decide()` precisa
 * dela e este arquivo é puro: o resolvedor depende do banco de dados.
 */
export const SMS_PACKAGES: ReadonlySet<string> = new Set([
	'com.google.android.apps.messaging',
	'com.samsung.android.messaging',
	'com.android.mms',
	'com.android.messaging',
	'com.motorola.messaging',
	'com.oneplus.mms',
	'com.miui.mms',
]);

export const isSmsPackage = (packageName: string): boolean => SMS_PACKAGES.has(packageName);

/**
 * Apps cujos avisos nunca são capturados, citem banco ou não (SPD-069, DEC-29). O
 * OnlineBanking é um app que o usuário desenvolve para um banco: os avisos dele são de
 * teste, não dinheiro dele. Para bloquear outro app, basta acrescentar o pacote aqui.
 */
export const BLOCKED_PACKAGES: ReadonlySet<string> = new Set(['com.mobileapp.basasuperapp']);

export const isBlockedPackage = (packageName: string): boolean => BLOCKED_PACKAGES.has(packageName);

/** A regra está ligada: o usuário já descartou avisos daquele app vezes suficientes. */
export const isAppIgnored = (rule: MerchantRule | undefined): boolean =>
	rule?.treatAs === 'ignore' && rule.confirmations >= APP_IGNORE_THRESHOLD;

/**
 * Mais um descarte de um aviso daquele app. A regra nasce no primeiro, como a de
 * categoria nasce na primeira confirmação, e só passa a valer no terceiro.
 */
export const learnFromAppDismissal = (rule: MerchantRule | undefined, packageName: string): MerchantRule => ({
	merchantKey: appRuleKeyOf(packageName),
	categoryId: null,
	treatAs: 'ignore',
	confirmations: rule?.treatAs === 'ignore' ? rule.confirmations + 1 : 1,
});

/**
 * Um descarte foi revertido: desconta. Abaixo de três a regra deixa de valer sozinha — o
 * usuário acabou de dizer que um aviso daquele app importava. `null` quando não sobra
 * descarte nenhum e a regra deve ser esquecida.
 */
export const forgetAppDismissal = (rule: MerchantRule): MerchantRule | null =>
	rule.confirmations > 1 ? { ...rule, confirmations: rule.confirmations - 1 } : null;

// ---------------------------------------------------------------------------
// Decisão
// ---------------------------------------------------------------------------

export const decide = (candidate: Candidate, context: DecisionContext): Decision => {
	// 0. O usuário descartou avisos deste app (que não é banco) vezes suficientes: ignora
	// antes de qualquer pergunta, senão ele responderia sobre um app que mandou calar. A
	// carteira, o extrato e o SMS nunca caem aqui, nem com uma regra gravada para eles.
	const appRule = context.appRule;
	if (
		isAppIgnored(appRule) &&
		appRule?.merchantKey === appRuleKeyOf(candidate.packageName) &&
		!isWalletPackage(candidate.packageName) &&
		!isSmsPackage(candidate.packageName) &&
		!isStatementPackage(candidate.packageName)
	) {
		return { action: 'ignore', reason: 'app_rule' };
	}

	// 1. Carteira digital + banco: a mesma compra, com certeza. Fica a do banco.
	const walletTwin = findWalletDuplicate(candidate, context.recent);
	if (walletTwin) return { action: 'duplicate', relatedId: walletTwin.id, reason: 'wallet' };

	// 1b. O extrato já tem esta movimentação: a notificação chegou depois do import.
	const statementTwin = findStatementTwin(candidate, context.recent);
	if (statementTwin) return { action: 'duplicate', relatedId: statementTwin.id, reason: 'statement' };

	// 1c. Carteira + banco com o mesmo valor, sem nada que confirme ser a mesma compra:
	// pergunta. Vem antes do neutro de propósito — a fatura paga pela carteira e pelo
	// banco com identidade indefinida é exatamente o caso em que registrar as duas
	// debitaria a conta duas vezes, e perguntar custa um toque.
	const walletSuspect = findWalletSuspect(candidate, context.recent);
	if (walletSuspect) return { action: 'ask_duplicate', relatedId: walletSuspect.id };

	// 2. Movimentos que não são receita nem despesa.
	if (candidate.neutral) {
		return {
			action: 'neutral',
			reason: candidate.kind === 'invoice_payment' ? 'invoice_payment' : 'investment',
		};
	}

	// 3. Regra aprendida para o estabelecimento ou pessoa.
	const rule = context.rule;
	if (rule?.treatAs === 'ignore') return { action: 'ignore', reason: 'rule' };
	if (rule?.treatAs === 'transfer') {
		const twin = findTransferCounterpart(candidate, context.recent, true);
		return { action: 'transfer', relatedId: twin?.id ?? null, reason: 'rule' };
	}

	// 4. Transferência para si mesmo: o nome na notificação é o seu.
	if (matchesOwnName(candidate.counterparty, context.ownNames)) {
		const twin = findTransferCounterpart(candidate, context.recent, true);
		return { action: 'transfer', relatedId: twin?.id ?? null, reason: 'own_name' };
	}

	// Receita de fonte externa (a PJ do usuário mandando o pró-labore): é receita, e
	// ponto. Nunca vira transferência com a saída que a PJ avisou pelo mesmo app.
	const isExternalIncome = context.externalIncome === true && candidate.direction === 'in';

	// 5. A outra perna já foi reconhecida como transferência e está sem par (a conta
	//    PJ recebeu "de VINICIUS", certo pelo nome; esta é a saída da conta pessoal,
	//    no mesmo app): junta as duas sem perguntar.
	const decidedLeg = isExternalIncome ? undefined : findTransferCounterpart(candidate, context.recent, true);
	if (decidedLeg?.status === 'transfer') {
		return { action: 'transfer', relatedId: decidedLeg.id, reason: 'counterpart' };
	}

	// 6. Saída e entrada do mesmo valor em apps diferentes: provável, pergunta.
	const counterpart = isExternalIncome ? undefined : findTransferCounterpart(candidate, context.recent);
	if (counterpart) return { action: 'ask_transfer', relatedId: counterpart.id };

	// 6. Dois bancos, mesmo valor, quase ao mesmo tempo: provável, pergunta.
	const suspect = findSuspectedDuplicate(candidate, context.recent);
	if (suspect) return { action: 'ask_duplicate', relatedId: suspect.id };

	// 7. Categoria: aprendida (e talvez automática) ou palpite.
	if (rule?.categoryId) {
		if (rule.confirmations >= context.autoConfirmThreshold) {
			return { action: 'auto_confirm', categoryId: rule.categoryId };
		}
		return { action: 'pending', categoryId: rule.categoryId };
	}

	return { action: 'pending', categoryId: context.fallbackCategoryId };
};

/**
 * Como uma regra evolui a cada confirmação.
 *
 * Confirmar com a mesma categoria soma; confirmar com outra recomeça do um — três
 * confirmações iguais seguidas é o que libera o lançamento automático, e uma mudança
 * de ideia no meio zera a contagem em vez de ser ignorada.
 */
export const learnFromConfirmation = (
	rule: MerchantRule | undefined,
	merchantKey: string,
	categoryId: string
): MerchantRule => {
	if (rule && rule.treatAs === 'transaction' && rule.categoryId === categoryId) {
		return { ...rule, confirmations: rule.confirmations + 1 };
	}
	return { merchantKey, categoryId, treatAs: 'transaction', confirmations: 1 };
};

export const candidateFrom = (
	raw: RawCapture,
	parsed: {
		amountCents: number;
		direction: CaptureDirection;
		kind: CaptureKind;
		counterparty: string | null;
		neutral: boolean;
		cardLast4?: string | null;
	},
	/** A conta que o resolvedor achou, quando já é conhecida: entra na identidade. */
	accountId: string | null = null
): Candidate => ({
	packageName: raw.packageName,
	postedAt: raw.postedAt,
	amountCents: parsed.amountCents,
	direction: parsed.direction,
	kind: parsed.kind,
	counterparty: parsed.counterparty,
	merchantKey: merchantKeyOf(parsed.counterparty),
	neutral: parsed.neutral,
	cardLast4: parsed.cardLast4 ?? null,
	accountId,
});

export default {
	decide,
	fingerprintOf,
	findWalletDuplicate,
	findWalletSuspect,
	findStatementTwin,
	findSuspectedDuplicate,
	findTransferCounterpart,
	matchesOwnName,
	learnFromConfirmation,
	learnFromAppDismissal,
	forgetAppDismissal,
	isAppIgnored,
	appRuleKeyOf,
	isSmsPackage,
	isBlockedPackage,
	candidateFrom,
	isStatementPackage,
	withinStatementLag,
	localDateOf,
};
