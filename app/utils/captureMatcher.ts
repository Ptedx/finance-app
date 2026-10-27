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
/**
 * PJ e PF do mesmo banco: o Pix entre as duas é instantâneo, e os dois avisos chegam juntos.
 * Dez minutos cobrem atraso de notificação sem juntar dois Pix sem relação (DEC-34).
 */
export const SAME_BANK_TRANSFER_WINDOW_MS = 10 * 60 * 1000;
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

/** Prefixo das impressões feitas com a chave da notificação (SPD-041). */
const KEYED_FINGERPRINT_PREFIX = 'n:';

/**
 * Identifica uma notificação. É também o id da captura no sync (v19): uma impressão já
 * gravada nunca muda de formato.
 *
 * **Com a chave do Android** (`notificationKey`, SPD-041): a mesma chave com o mesmo
 * título, texto e `when` é a mesma notificação, em qualquer horário — a repostagem minutos
 * depois (D8) não vira segunda captura. Chaves diferentes são notificações diferentes,
 * mesmo no mesmo minuto e com o mesmo texto (dois cafés, D6). A mesma chave com outro
 * conteúdo (o banco atualizou o aviso com outro valor) é captura nova. O `when` entra
 * porque há app que reusa sempre o mesmo id: a compra de amanhã, com o mesmo texto, teria
 * a mesma chave e sumiria como repostagem. O formato é outro (`n:`), e a chave não sai do
 * aparelho: só o hash dela.
 *
 * **Sem a chave** (binário antigo, JS novo por OTA, extrato, testes antigos): título,
 * texto, app e o minuto em que foi publicada — o minuto, em vez do instante exato, absorve
 * a reentrega no mesmo minuto. É o formato de sempre, sem mudança.
 */
export const fingerprintOf = (raw: RawCapture): string => {
	if (raw.notificationKey) {
		const when = raw.notificationWhen ?? '';
		const content = `${raw.packageName}|${raw.notificationKey}|${when}|${raw.title}|${raw.text}`;
		return `${KEYED_FINGERPRINT_PREFIX}${fnv1a(content)}-${fnv1a(`${raw.text}|${raw.notificationKey}|${when}`)}`;
	}
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

// ---------------------------------------------------------------------------
// Nome de loja aproximado (SPD-044)
// ---------------------------------------------------------------------------

/**
 * Sufixos societários. A carteira costuma trazer a razão social ("BOM PRECO LTDA") e o
 * banco, o nome de fantasia. "S/A" chega à chave como "s a": letra solta também cai.
 */
const CORPORATE_SUFFIXES: ReadonlySet<string> = new Set(['ltda', 'ltd', 'me', 'epp', 'eireli', 'sa', 'ss', 'slu', 'cia', 'mei']);

/** O menor pedaço que vale como abreviação: "SUPERM" é "SUPERMERCADO", "S" não é "SAO". */
const MIN_ABBREVIATION_LENGTH = 3;

/** As palavras que identificam a loja. Se só sobrar sufixo, fica o nome como veio. */
const merchantWords = (key: string): string[] => {
	const words = normalizeText(key).split(' ').filter(Boolean);
	const meaningful = words.filter((word) => word.length > 1 && !CORPORATE_SUFFIXES.has(word));
	return meaningful.length > 0 ? meaningful : words;
};

/**
 * Se o nome curto sai do longo só encurtando: pulando palavras inteiras, cortando o fim de
 * uma palavra (ao menos três letras) ou colando palavras vizinhas ("POSTOSHELL"). A ordem
 * se mantém. "POSTOSHELL" sai de "POSTO SHELL", mas não de "POSTO IPIRANGA": a palavra
 * colada tem que ser coberta inteira.
 */
const shortensTo = (short: string[], long: string[]): boolean => {
	// `offset`: quanto da palavra `short[index]` já foi coberto, colando palavras de `long`.
	const walk = (index: number, offset: number, cursor: number): boolean => {
		if (index === short.length) return true;
		if (cursor === long.length) return false;
		// Entre uma palavra e outra, a palavra do nome longo pode faltar no curto.
		if (offset === 0 && walk(index, 0, cursor + 1)) return true;
		const rest = short[index].slice(offset);
		const word = long[cursor];
		// A palavra inteira, e o resto da palavra curta continua na próxima (colagem)...
		if (rest.startsWith(word)) {
			return rest.length === word.length ? walk(index + 1, 0, cursor + 1) : walk(index, offset + word.length, cursor + 1);
		}
		// ...ou o resto da palavra curta é o começo desta (abreviação).
		return rest.length >= MIN_ABBREVIATION_LENGTH && word.startsWith(rest) && walk(index + 1, 0, cursor + 1);
	};
	return walk(0, 0, 0);
};

/**
 * Se duas chaves de estabelecimento podem ser a mesma loja escrita de outro jeito: a
 * carteira escreve "SUPERMERCADO BOM PRECO LTDA" e o banco, "SUPERM BOM PRECO". Vale
 * abreviação, sufixo societário, palavra a mais de um lado e palavras coladas; o prefixo
 * de adquirente ("PAG*", "MP*") a chave já não tem. "PADARIA CENTRAL" e "POSTO SHELL" não
 * são compatíveis, nem "POSTO SHELL" e "POSTO IPIRANGA".
 */
export const merchantKeysCompatible = (a: string, b: string): boolean => {
	if (a === b) return true;
	const left = merchantWords(a);
	const right = merchantWords(b);
	return shortensTo(left, right) || shortensTo(right, left);
};

/**
 * O estabelecimento desmente quando os dois lados têm nome e eles não são compatíveis.
 * Compatível só deixa de desmentir; não confirma (ver `identityAgrees`).
 */
const merchantsConflict = (a: string | null | undefined, b: string | null | undefined): boolean =>
	Boolean(a && b && !merchantKeysCompatible(a, b));

/** Estabelecimento, final do cartão ou conta: o que os dois lados têm, e não bate. */
const identityConflicts = (known: KnownCapture, candidate: Candidate): boolean =>
	merchantsConflict(known.merchantKey, candidate.merchantKey) ||
	conflicts(known.cardLast4, candidate.cardLast4) ||
	conflicts(known.accountId, candidate.accountId);

/**
 * Pelo menos um sinal comparável que confirma: o mesmo lugar, o mesmo plástico, a mesma conta.
 *
 * O lugar confirma só com o mesmo nome. Nome apenas compatível ("SUPERM" × "SUPERMERCADO")
 * não decide sozinho (SPD-044): é um palpite sobre texto, e o achado 7.4 é justamente
 * duas compras do mesmo valor no mesmo dia. Com o mesmo final de cartão ou a mesma conta
 * junto, é a mesma compra; sem nenhum outro sinal, vira pergunta.
 */
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
 * A outra perna de um Pix entre duas contas do mesmo banco (a PJ e a PF, SPD-074).
 *
 * O aviso da saída da PJ não diz para quem foi ("Pix de R$ 500,00 da conta Nu Empresas foi
 * realizado"), então o nome não ajuda. O que diz é o resto: o mesmo app, contas diferentes
 * (o resolvedor já separou a PJ da PF), mesmo valor, direções opostas, minutos de
 * diferença. Sem a conta de uma das pontas, nada feito: na mesma conta são dois Pix.
 */
export const findSameBankTransferLeg = (candidate: Candidate, recent: KnownCapture[]): KnownCapture | undefined => {
	if (!TRANSFERABLE_KINDS.has(candidate.kind) || !candidate.accountId) return undefined;
	return recent.find(
		(known) =>
			isLive(known) &&
			known.packageName === candidate.packageName &&
			!!known.accountId &&
			known.accountId !== candidate.accountId &&
			known.direction !== candidate.direction &&
			known.amountCents === candidate.amountCents &&
			TRANSFERABLE_KINDS.has(known.kind) &&
			!(known.status === 'transfer' && known.relatedId !== null) &&
			msBetween(known.postedAt, candidate.postedAt) <= SAME_BANK_TRANSFER_WINDOW_MS
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

	// 5b. Saída de uma conta e entrada noutra do mesmo banco, mesmo valor, minutos depois:
	//     a PJ mandando para a PF (DEC-34). Certo o bastante para não perguntar.
	const sameBankLeg = isExternalIncome ? undefined : findSameBankTransferLeg(candidate, context.recent);
	if (sameBankLeg) return { action: 'transfer', relatedId: sameBankLeg.id, reason: 'same_bank_accounts' };

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
	merchantKeysCompatible,
	findStatementTwin,
	findSuspectedDuplicate,
	findTransferCounterpart,
	findSameBankTransferLeg,
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
