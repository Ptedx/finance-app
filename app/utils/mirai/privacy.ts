import { normalizeText } from '../captureParser';
import { isSameName, nameWords } from '../ownName';

/**
 * O filtro de privacidade do Mirai (SPD-163b, especificação §4): aplicado a toda saída de
 * ferramenta antes de ela sair do aparelho.
 *
 * - Pix (e TED/DOC) para e de pessoa física vira "Pix para pessoa" / "Pix de pessoa". O
 *   estabelecimento fica: é ele que responde "onde gastei".
 * - O nome do próprio usuário (o "seu nome como aparece no banco" de Ajustes, SPD-115, e o da
 *   conta logada quando o app o passa) vira "você".
 * - CPF, CNPJ e e-mail não saem; número de conta ou de cartão sai só com o final de 4 dígitos.
 * - O texto bruto dos avisos capturados nunca entra numa saída: as ferramentas só leem o
 *   livro e, da captura, o tipo e a contraparte — que passa por aqui.
 *
 * Na dúvida, esconde: um Pix sem marca de empresa é tratado como de pessoa. Esconder o nome
 * de uma loja custa um pouco de precisão; mandar o nome de uma pessoa para fora não tem volta.
 *
 * Puro, para ser testado com nomes inventados.
 */

export const PIX_TO_PERSON = 'Pix para pessoa';
export const PIX_FROM_PERSON = 'Pix de pessoa';
export const TRANSFER_TO_PERSON = 'Transferência para pessoa';
export const TRANSFER_FROM_PERSON = 'Transferência de pessoa';
export const YOU = 'você';
export const PIX_TO_YOU = 'Pix para você';
export const PIX_FROM_YOU = 'Pix de você';
export const DOCUMENT_HIDDEN = '[documento]';
export const EMAIL_HIDDEN = '[e-mail]';

export interface PrivacyContext {
	/** Os nomes do usuário, já limpos (`ownNamesOf`). */
	ownNames: readonly string[];
}

/** O que a captura diz de um lançamento: o tipo, para que lado e com quem. */
export interface CaptureHint {
	kind: string;
	direction: 'in' | 'out';
	counterparty: string | null;
}

/** Tipos de captura em que a contraparte pode ser uma pessoa. */
const PIX_KINDS: ReadonlySet<string> = new Set(['pix_in', 'pix_out']);
const TRANSFER_KINDS: ReadonlySet<string> = new Set(['transfer_in', 'transfer_out']);

/**
 * Palavras que marcam empresa, não pessoa: as formas jurídicas e os ramos que aparecem no nome
 * de quem recebe Pix como loja. Comparadas depois de `nameWords` (sem acento, minúsculas).
 */
const BUSINESS_WORDS: ReadonlySet<string> = new Set([
	'ltda',
	'me',
	'epp',
	'eireli',
	'mei',
	'sa',
	'cia',
	'inc',
	'llc',
	'comercio',
	'comercial',
	'servicos',
	'industria',
	'pagamentos',
	'pagamento',
	'tecnologia',
	'restaurante',
	'supermercado',
	'supermercados',
	'mercado',
	'mercadinho',
	'atacadao',
	'farmacia',
	'drogaria',
	'posto',
	'padaria',
	'panificadora',
	'acougue',
	'loja',
	'lojas',
	'magazine',
	'shopping',
	'bar',
	'lanchonete',
	'pizzaria',
	'hamburgueria',
	'cafe',
	'cafeteria',
	'hotel',
	'pousada',
	'clinica',
	'laboratorio',
	'hospital',
	'academia',
	'escola',
	'colegio',
	'faculdade',
	'seguros',
	'seguradora',
	'banco',
	'bank',
	'financeira',
	'investimentos',
	'energia',
	'telecom',
	'internet',
	'distribuidora',
	'transportes',
	'imobiliaria',
	'condominio',
	'associacao',
	'igreja',
	'fundacao',
	'instituto',
	'prefeitura',
	'governo',
	'store',
	'market',
	'pet',
	'petshop',
	'auto',
	'pecas',
	'eletronicos',
	'moveis',
	'otica',
	'estacionamento',
	'oficina',
	'lavanderia',
	'salao',
	'barbearia',
	'studio',
	'estudio',
	'consultoria',
	'contabilidade',
	'advocacia',
	'odontologia',
	'veterinaria',
	'ifood',
	'uber',
	'rappi',
	'amazon',
	'shopee',
	'netflix',
	'spotify',
	'google',
	'apple',
]);

/** E-mail, em qualquer lugar do texto. */
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
/** CPF (com ou sem máscara do banco: `***.456.789-**`) e CNPJ. */
const CPF = /(?<![\d*•])(?:\d{3}|[*•xX]{3})[.\s]?\d{3}[.\s]?\d{3}[-\s]?(?:\d{2}|[*•xX]{2})(?!\d)/g;
const CNPJ = /(?<!\d)\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}(?!\d)/g;
/** Sinais de empresa fora das palavras: "S/A", "S.A.", "&", ".com", número (o CNPJ junto). */
const BUSINESS_PATTERN = /(\bs\s*[/.]\s*a\b\.?)|&|\.com\b|\d/i;

/**
 * O nome parece de empresa (e então pode sair). Sem sinal nenhum, vale como pessoa.
 *
 * O CNPJ é de empresa. O CPF, mascarado ou não, é de pessoa: sai antes de procurar número, e
 * qualquer pedaço com máscara (`***`, `•`) também — senão o "***.456.789-**" que o banco
 * põe ao lado do nome faria a pessoa passar por empresa.
 */
export const isBusinessName = (value: string | null | undefined): boolean => {
	if (!value) return false;
	if (new RegExp(CNPJ.source).test(value)) return true;
	const withoutDocuments = value
		.replace(new RegExp(CPF.source, 'g'), ' ')
		.split(/\s+/)
		.filter((word) => !/[*•]/.test(word))
		.join(' ');
	if (BUSINESS_PATTERN.test(withoutDocuments)) return true;
	return normalizeText(withoutDocuments)
		.replace(/[^a-z0-9]+/g, ' ')
		.split(' ')
		.some((word) => BUSINESS_WORDS.has(word));
};

/**
 * O nome encurtado do usuário: o primeiro nome igual e cada outra palavra é uma do nome dele
 * (ou a inicial de uma) — "Helena Duarte" e "Helena Q. Duarte" para "Helena Quintanilha
 * Duarte". Mais largo que `isSameName` (que pede o mesmo número de palavras, para a captura não
 * descartar o Pix de um parente): aqui, errar para o lado de esconder é o certo.
 */
const isShortenedName = (value: string, own: string): boolean => {
	const seen = nameWords(value);
	const full = nameWords(own);
	if (seen.length < 2 || full.length < 2 || seen[0].length < 2 || seen[0] !== full[0]) return false;
	return seen
		.slice(1)
		.every((word) => full.slice(1).some((part) => part === word || (word.length === 1 && part.startsWith(word))));
};

/** O nome é o do próprio usuário (inteiro ou encurtado). */
export const isOwnName = (value: string | null | undefined, context: PrivacyContext): boolean =>
	!!value && context.ownNames.some((own) => isSameName(value, own) || isShortenedName(value, own));

/** Uma sequência de dígitos, com pontos, traços ou barras no meio. */
const DIGIT_RUN = /\d(?:[\d.\-/]*\d)?/g;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const BR_DATE = /^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/;

/**
 * Número em blocos separados por espaço ("5502 0911 2233 4321", "0001 12345 6"): um bloco de 3
 * ou mais dígitos seguido de outros, que juntos somam 8 dígitos ou mais, é um número só — senão
 * cada bloco passaria inteiro pelo corte de 4.
 */
const SPACED_NUMBER = /\d{3,}(?: \d{1,})+/g;

const maskSpaced = (run: string): string => {
	const digits = run.replace(/\D/g, '');
	if (digits.length < 8) return run;
	return `•${digits.slice(-4)}`;
};

/** Número com mais de 4 dígitos (conta, cartão, agência com dígito) sai só com o final. */
const maskDigits = (run: string): string => {
	if (ISO_DATE.test(run) || BR_DATE.test(run)) return run;
	const digits = run.replace(/\D/g, '');
	if (digits.length <= 4) return run;
	return `•${digits.slice(-4)}`;
};

/** Troca o nome do usuário por "você" onde ele aparecer no texto (de 2 a 8 palavras seguidas). */
const replaceOwnName = (text: string, context: PrivacyContext): string => {
	if (context.ownNames.length === 0) return text;
	const tokens = text.split(/(\s+)/);
	// Índices das palavras (as posições pares são palavras; as ímpares, os espaços).
	const out: string[] = [];
	let i = 0;
	while (i < tokens.length) {
		if (i % 2 === 1 || tokens[i] === '') {
			out.push(tokens[i]);
			i += 1;
			continue;
		}
		let matched = -1;
		// Do trecho mais longo para o mais curto: "Maria de Souza Oliveira" inteiro, não só um pedaço.
		for (let words = 8; words >= 2; words -= 1) {
			const end = i + (words - 1) * 2;
			if (end >= tokens.length) continue;
			const candidate = tokens.slice(i, end + 1).join('');
			// O trecho começa e termina numa palavra de nome: "De Helena Duarte" troca só o nome.
			if (nameWords(tokens[i]).length === 0 || nameWords(tokens[end]).length === 0) continue;
			if (nameWords(candidate).length < 2) continue;
			if (isOwnName(candidate, context)) {
				matched = end;
				break;
			}
		}
		if (matched < 0) {
			out.push(tokens[i]);
			i += 1;
			continue;
		}
		// A pontuação colada no fim do nome fica ("Maria Souza," → "você,").
		const trailing = tokens[matched].match(/[^\p{L}\p{N}]+$/u)?.[0] ?? '';
		out.push(`${YOU}${trailing}`);
		i = matched + 1;
	}
	return out.join('');
};

/** Limpa um texto livre: o nome do usuário, documentos, e-mail e números longos. */
export const scrubText = (text: string, context: PrivacyContext): string => {
	let next = text.replace(EMAIL, EMAIL_HIDDEN);
	next = next.replace(CNPJ, DOCUMENT_HIDDEN).replace(CPF, DOCUMENT_HIDDEN);
	next = next.replace(SPACED_NUMBER, maskSpaced).replace(DIGIT_RUN, maskDigits);
	return replaceOwnName(next, context);
};

/** "Pix para Fulano", "TED de Fulano", "Transferência enviada para Fulano" no texto do lançamento. */
const TRANSFER_NOTE =
	/^\s*(pix|ted|doc|transf(?:er[eê]ncia)?\.?)\b\s*(?:enviad[oa]|recebid[oa]|realizad[oa])?\s*(?:para|pra|p\/|de|do|da)?\s*[:-]?\s*(.*)$/iu;

const personLabel = (pix: boolean, incoming: boolean): string =>
	pix ? (incoming ? PIX_FROM_PERSON : PIX_TO_PERSON) : incoming ? TRANSFER_FROM_PERSON : TRANSFER_TO_PERSON;

const youLabel = (incoming: boolean): string => (incoming ? PIX_FROM_YOU : PIX_TO_YOU);

/**
 * O "estabelecimento" de um lançamento como ele pode sair do aparelho.
 *
 * Com a captura, o tipo dela decide: Pix ou transferência com uma contraparte sem marca de
 * empresa é com pessoa. Sem captura (lançamento à mão, extrato antigo), o texto que começa por
 * "Pix", "TED", "DOC" ou "Transferência" seguido de um nome sem marca de empresa também é.
 * O resto é estabelecimento e sai, limpo por `scrubText`.
 */
export const merchantOf = (
	note: string,
	incoming: boolean,
	capture: CaptureHint | null,
	context: PrivacyContext
): string => {
	if (capture && (PIX_KINDS.has(capture.kind) || TRANSFER_KINDS.has(capture.kind))) {
		const pix = PIX_KINDS.has(capture.kind);
		const fromCapture = capture.direction === 'in';
		const counterparty = capture.counterparty?.trim() || note;
		if (isOwnName(counterparty, context) || isOwnName(note, context)) return youLabel(fromCapture);
		if (!isBusinessName(counterparty)) return personLabel(pix, fromCapture);
		return scrubText(note, context);
	}
	const transfer = TRANSFER_NOTE.exec(note);
	if (transfer) {
		const pix = transfer[1].toLowerCase() === 'pix';
		const rest = transfer[2].trim();
		if (rest.length === 0) return pix ? 'Pix' : scrubText(note, context);
		if (isOwnName(rest, context)) return youLabel(incoming);
		if (!isBusinessName(rest)) return personLabel(pix, incoming);
		return scrubText(note, context);
	}
	if (isOwnName(note, context)) return YOU;
	return scrubText(note, context);
};

/** Campos que guardam ids (o modelo os devolve nas ferramentas): não são texto livre. */
const isIdKey = (key: string | null): boolean => key !== null && (key === 'id' || /Id$/.test(key));
const MONTH = /^\d{4}-\d{2}$/;

/**
 * Aplica `scrubText` a todo texto de um resultado de ferramenta, em qualquer profundidade.
 * Ids e datas passam como estão. Devolve uma cópia.
 */
export const applyPrivacy = <T>(value: T, context: PrivacyContext, key: string | null = null): T => {
	if (typeof value === 'string') {
		if (isIdKey(key) || ISO_DATE.test(value) || MONTH.test(value)) return value;
		return scrubText(value, context) as T;
	}
	if (Array.isArray(value)) return value.map((item) => applyPrivacy(item, context, key)) as T;
	if (value !== null && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [entryKey, entry] of Object.entries(value as Record<string, unknown>)) {
			out[entryKey] = applyPrivacy(entry, context, entryKey);
		}
		return out as T;
	}
	return value;
};

/** Todo arquivo sob app/ é rota para o expo-router; o export default só satisfaz essa exigência. */
export default { applyPrivacy, merchantOf, scrubText, isBusinessName, isOwnName };
