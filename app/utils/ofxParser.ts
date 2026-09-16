/**
 * Leitura de extratos OFX.
 *
 * Os bancos brasileiros exportam duas famílias: OFX 1.x (SGML, sem fechamento nos
 * campos folha, cabeçalho em linhas `CHAVE:VALOR`) e OFX 2.x (XML). O parser aceita as
 * duas com um único tokenizador: agregados sempre têm `</TAG>`, folhas podem não ter.
 *
 * O que importa de cada linha do extrato:
 *
 *  - `FITID`: o identificador único que o banco dá à transação. É o que torna o
 *    import idempotente: o mesmo arquivo duas vezes, ou dois meses com sobreposição,
 *    nunca duplicam nada.
 *  - `DTPOSTED`: dia de calendário no fuso do banco. Só os 8 primeiros dígitos contam;
 *    converter o horário para UTC mudaria o dia de um lançamento das 22h.
 *  - `TRNAMT`: valor com sinal. Negativo sai, positivo entra. A especificação usa
 *    ponto decimal e nunca separador de milhar, mas alguns bancos escrevem vírgula.
 *
 * Puro, sem importar nada nativo. A leitura do arquivo (bytes, encoding) fica em
 * `decodeOfxBytes`, também pura, para ser testada com arquivos reais.
 */

import { guessCategory, merchantKeyOf, normalizeText } from './captureParser';
import type { CaptureDirection, CaptureKind } from './captureParser';

export interface OfxEntry {
	fitid: string;
	/** `YYYY-MM-DD`, o dia que o banco imprimiu no extrato. */
	postedDate: string;
	amountCents: number;
	direction: CaptureDirection;
	trnType: string;
	name: string;
	memo: string;
	/** Texto usado para classificar: nome e memo juntos. */
	text: string;
	kind: CaptureKind;
	neutral: boolean;
	counterparty: string | null;
	merchantKey: string | null;
	suggestedCategory: string;
}

export interface OfxAccount {
	/** `bankId:acctId`, estável entre importações da mesma conta. */
	accountKey: string;
	bankId: string | null;
	acctId: string;
	acctType: string | null;
	isCard: boolean;
	/** Nome do banco, pelo código ou pelo `<ORG>` do arquivo. */
	bankName: string;
	currency: string | null;
	entries: OfxEntry[];
	/** Linhas descartadas por não terem FITID, data ou valor válidos. */
	skipped: number;
}

export interface OfxStatement {
	accounts: OfxAccount[];
}

// ---------------------------------------------------------------------------
// Bytes → texto
// ---------------------------------------------------------------------------

const decodeLatin1 = (bytes: Uint8Array): string => {
	let out = '';
	// Em pedaços: `String.fromCharCode(...bytes)` estoura a pilha em arquivos grandes.
	for (let index = 0; index < bytes.length; index += 8192) {
		out += String.fromCharCode(...bytes.subarray(index, index + 8192));
	}
	return out;
};

const decodeUtf8 = (bytes: Uint8Array): string => {
	if (typeof TextDecoder !== 'undefined') {
		try {
			return new TextDecoder('utf-8').decode(bytes);
		} catch {
			// Cai no decodificador manual abaixo.
		}
	}

	let out = '';
	let index = 0;
	while (index < bytes.length) {
		const byte = bytes[index];
		if (byte < 0x80) {
			out += String.fromCharCode(byte);
			index += 1;
		} else if (byte >= 0xc0 && byte < 0xe0 && index + 1 < bytes.length) {
			out += String.fromCharCode(((byte & 0x1f) << 6) | (bytes[index + 1] & 0x3f));
			index += 2;
		} else if (byte >= 0xe0 && byte < 0xf0 && index + 2 < bytes.length) {
			out += String.fromCharCode(
				((byte & 0x0f) << 12) | ((bytes[index + 1] & 0x3f) << 6) | (bytes[index + 2] & 0x3f)
			);
			index += 3;
		} else if (byte >= 0xf0 && index + 3 < bytes.length) {
			const codePoint =
				((byte & 0x07) << 18) |
				((bytes[index + 1] & 0x3f) << 12) |
				((bytes[index + 2] & 0x3f) << 6) |
				(bytes[index + 3] & 0x3f);
			out += String.fromCodePoint(codePoint);
			index += 4;
		} else {
			out += '�';
			index += 1;
		}
	}
	return out;
};

/**
 * Decide o encoding pelo próprio cabeçalho, que é ASCII puro nos dois formatos.
 *
 * `CHARSET:1252` / `ENCODING:USASCII` (OFX 1.x) e a ausência de UTF-8 declarado
 * significam Latin-1: é o que Itaú, Bradesco e Banco do Brasil exportam, com acentos
 * nos nomes. Ler isso como UTF-8 viraria "Jo�o". `ENCODING:UTF-8` ou um XML com
 * `encoding="UTF-8"` (Nubank, Inter) são lidos como UTF-8.
 */
export const decodeOfxBytes = (bytes: Uint8Array): string => {
	const header = decodeLatin1(bytes.subarray(0, Math.min(bytes.length, 512))).toUpperCase();
	const declaresUtf8 = /ENCODING\s*[:=]\s*"?UTF-?8|CHARSET\s*[:=]\s*"?UTF-?8/.test(header);
	const declaresLatin1 = /CHARSET\s*[:=]\s*"?(1252|ISO-8859-1|LATIN-?1)|ENCODING\s*:\s*USASCII/.test(header);

	if (declaresUtf8) return decodeUtf8(bytes);
	if (declaresLatin1) return decodeLatin1(bytes);

	// Nada declarado: UTF-8 válido é UTF-8; qualquer sequência inválida é Latin-1.
	const utf8 = decodeUtf8(bytes);
	return utf8.includes('�') ? decodeLatin1(bytes) : utf8;
};

// ---------------------------------------------------------------------------
// Valores e datas
// ---------------------------------------------------------------------------

/**
 * `-35.90`, `-35,90`, `1234.5`, `+100` → centavos com sinal. Sem separador de milhar:
 * a especificação proíbe, e aceitar "1.234" como mil e duzentos abriria a porta para
 * ler "1.5" como mil e quinhentos.
 */
export const parseOfxAmount = (raw: string): number | null => {
	const cleaned = raw.replace(/\s+/g, '');
	const match = /^([+-]?)(\d+)(?:[.,](\d{1,2}))?$/.exec(cleaned);
	if (!match) return null;

	const whole = Number(match[2]);
	const fraction = (match[3] ?? '').padEnd(2, '0');
	if (!Number.isSafeInteger(whole)) return null;

	const cents = whole * 100 + Number(fraction);
	if (!Number.isSafeInteger(cents)) return null;
	return match[1] === '-' ? -cents : cents;
};

/** `20260914120000[-3:BRT]`, `20260914`, `2026-09-14` → `2026-09-14`. */
export const parseOfxDate = (raw: string): string | null => {
	const compact = raw.replace(/[^0-9]/g, '').slice(0, 8);
	if (compact.length !== 8) return null;

	const year = Number(compact.slice(0, 4));
	const month = Number(compact.slice(4, 6));
	const day = Number(compact.slice(6, 8));
	if (year < 1990 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;

	return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
};

// ---------------------------------------------------------------------------
// Classificação da linha
// ---------------------------------------------------------------------------

const has = (text: string, ...needles: string[]): boolean =>
	needles.some((needle) => text.includes(needle));

/**
 * Tipo da linha pelo texto. Diferente das notificações, aqui **toda** linha é dinheiro
 * — a direção vem do sinal — então nunca há "não é movimentação"; o que não se
 * reconhece é compra (saída) ou entrada genérica.
 *
 * Os neutros são os que contariam dinheiro duas vezes:
 *  - pagamento de fatura na conta corrente (as compras já entraram uma a uma);
 *  - o mesmo pagamento visto pelo cartão, como crédito "Pagamento recebido";
 *  - aplicação e resgate (troca de bolso com o investimento).
 * Rendimento e juros não são neutros: é dinheiro novo.
 */
export const classifyStatementText = (
	text: string,
	direction: CaptureDirection,
	isCard: boolean
): { kind: CaptureKind; neutral: boolean } => {
	const n = ` ${normalizeText(text)} `;

	if (isCard && direction === 'in' && has(n, 'pagamento', 'pgto', 'pagto')) {
		return { kind: 'invoice_payment', neutral: true };
	}
	if (has(n, 'fatura') && has(n, 'pagamento', 'pgto', 'pagto', ' pag ')) {
		return { kind: 'invoice_payment', neutral: true };
	}
	if (has(n, 'rendimento', 'juros', 'dividendo', ' jcp ', 'remuneracao')) {
		return { kind: 'unknown', neutral: false };
	}
	if (
		has(n, 'aplicacao', ' aplic ', 'resgate', ' rdb ', ' cdb ', 'tesouro', 'poupanca', 'investimento', ' lci ', ' lca ', 'fundo')
	) {
		return { kind: 'investment', neutral: true };
	}
	if (has(n, 'estorno', 'reembolso', 'devolucao', 'cashback', 'chargeback')) {
		return { kind: 'refund', neutral: false };
	}
	if (has(n, ' pix ', 'pix ', ' pix')) {
		return { kind: direction === 'in' ? 'pix_in' : 'pix_out', neutral: false };
	}
	if (has(n, 'transferencia', ' transf ', ' ted ', ' doc ', ' tef ')) {
		return { kind: direction === 'in' ? 'transfer_in' : 'transfer_out', neutral: false };
	}
	if (has(n, 'saque', 'withdraw')) return { kind: 'withdrawal', neutral: false };
	if (has(n, 'deposito')) return { kind: 'deposit', neutral: false };

	return { kind: direction === 'in' ? 'unknown' : 'purchase', neutral: false };
};

/**
 * Nome de quem está do outro lado, a partir do NAME/MEMO do extrato.
 *
 * Nubank escreve "Transferência enviada pelo Pix - JOAO SILVA - •••.123.456-•• - BANCO X";
 * Itaú, "PIX TRANSF JOAO 14/09"; Inter, "Compra no débito - IFOOD". A regra: se o
 * texto tem segmentos separados por " - " e o primeiro é um rótulo de operação, o nome
 * é o segundo; senão é o primeiro segmento, sem prefixos de operação.
 */
const OPERATION_PREFIX =
	/^(?:compra(?: no (?:debito|credito))?|pagamento(?: de boleto)?(?: efetuado)?|transferencia(?: enviada| recebida)?(?: pelo pix)?|pix(?: enviado| recebido)?|envio(?: de)? pix|recebimento(?: de)? pix|debito|credito|saque|deposito|estorno|reembolso)\b/;

export const extractStatementCounterparty = (name: string, memo: string): string | null => {
	const source = (name.trim() || memo.trim()).replace(/\s+/g, ' ');
	if (!source) return null;

	const segments = source
		.split(/\s+-\s+/)
		.map((segment) => segment.trim())
		.filter((segment) => segment.length > 0);
	if (segments.length === 0) return null;

	let candidate = segments[0];
	if (segments.length > 1 && OPERATION_PREFIX.test(normalizeText(segments[0]))) {
		candidate = segments[1];
	} else {
		candidate = candidate
			.replace(/^(?:compra no (?:debito|débito|credito|crédito)|pix (?:enviado|recebido)|pix transf|transf(?:erencia|erência)?(?: enviada| recebida)?|ted|doc)\s*[-:]?\s*/i, '')
			.trim();
	}

	// Documentos mascarados, datas e códigos não são nome.
	candidate = candidate
		.replace(/[•*]{2,}[\d.•*-]*/g, '')
		.replace(/\b\d{2}\/\d{2}(?:\/\d{2,4})?\b/g, '')
		.replace(/\s+/g, ' ')
		.trim();

	if (candidate.length < 2 || !/[a-zA-ZÀ-ú]{2}/.test(candidate)) return null;
	return candidate.slice(0, 80);
};

// ---------------------------------------------------------------------------
// Tokenizador
// ---------------------------------------------------------------------------

/** Códigos COMPE dos bancos que exportam OFX com alguma frequência. */
const BANK_NAMES: Record<string, string> = {
	'001': 'Banco do Brasil',
	'033': 'Santander',
	'041': 'Banrisul',
	'077': 'Inter',
	'104': 'Caixa',
	'208': 'BTG Pactual',
	'212': 'Banco Original',
	'237': 'Bradesco',
	'260': 'Nubank',
	'290': 'PagBank',
	'323': 'Mercado Pago',
	'336': 'C6 Bank',
	'341': 'Itaú',
	'380': 'PicPay',
	'389': 'Mercantil',
	'422': 'Safra',
	'623': 'Pan',
	'655': 'Neon',
	'748': 'Sicredi',
	'756': 'Sicoob',
};

const stripHeader = (content: string): string => {
	const start = content.search(/<OFX>/i);
	return start >= 0 ? content.slice(start) : content;
};

/** Entidades que aparecem em OFX 2.x; o SGML 1.x raramente escapa alguma coisa. */
const unescape = (value: string): string =>
	value
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'");

interface RawTransaction {
	[key: string]: string;
}

interface RawStatement {
	isCard: boolean;
	fields: Record<string, string>;
	transactions: RawTransaction[];
}

/**
 * Percorre as tags e monta um extrato por `STMTRS` / `CCSTMTRS`. Folhas (`<NAME>x`)
 * são atribuídas ao agregado corrente; a pilha só tem agregados, então um
 * `</NAME>` de XML é simplesmente ignorado por não bater com o topo.
 */
const tokenize = (content: string): { org: string | null; statements: RawStatement[] } => {
	const statements: RawStatement[] = [];
	let org: string | null = null;
	let current: RawStatement | null = null;
	let transaction: RawTransaction | null = null;
	const stack: string[] = [];

	const tagPattern = /<(\/?)([A-Za-z0-9._-]+)>([^<]*)/g;
	let match: RegExpExecArray | null = tagPattern.exec(content);

	while (match !== null) {
		const closing = match[1] === '/';
		const name = match[2].toUpperCase();
		const value = unescape(match[3].trim());

		if (closing) {
			if (stack[stack.length - 1] === name) stack.pop();
			if (name === 'STMTTRN' && transaction && current) {
				current.transactions.push(transaction);
				transaction = null;
			}
		} else if (value === '') {
			stack.push(name);
			if (name === 'STMTRS' || name === 'CCSTMTRS') {
				current = { isCard: name === 'CCSTMTRS', fields: {}, transactions: [] };
				statements.push(current);
			} else if (name === 'STMTTRN') {
				transaction = {};
			}
		} else if (transaction) {
			transaction[name] = value;
		} else if (name === 'ORG') {
			org = value;
		} else if (current) {
			// Chaves de conta ficam distintas das da lista de transações.
			current.fields[name] = value;
		}

		match = tagPattern.exec(content);
	}

	return { org, statements };
};

// ---------------------------------------------------------------------------
// Entrada principal
// ---------------------------------------------------------------------------

export const parseOfx = (content: string): OfxStatement => {
	const { org, statements } = tokenize(stripHeader(content));

	const accounts: OfxAccount[] = statements.map((statement) => {
		const bankId = statement.fields.BANKID ?? null;
		const acctId = statement.fields.ACCTID ?? 'unknown';
		// COMPE tem três dígitos; alguns bancos exportam "0260", outros "260".
		const compe = bankId ? bankId.replace(/^0+(?=\d{3}$)/, '').padStart(3, '0') : null;
		const bankName =
			(compe && BANK_NAMES[compe]) || org || (bankId ? `Banco ${bankId}` : 'Extrato');
		const isCard = statement.isCard || statement.fields.ACCTTYPE === 'CREDITCARD';
		const accountKey = `${bankId ?? 'card'}:${acctId}`;

		const seen = new Set<string>();
		let skipped = 0;
		const entries: OfxEntry[] = [];

		for (const raw of statement.transactions) {
			const fitid = raw.FITID?.trim();
			const postedDate = raw.DTPOSTED ? parseOfxDate(raw.DTPOSTED) : null;
			const amountCents = raw.TRNAMT ? parseOfxAmount(raw.TRNAMT) : null;

			if (!fitid || !postedDate || amountCents === null || amountCents === 0 || seen.has(fitid)) {
				skipped += 1;
				continue;
			}
			seen.add(fitid);

			const name = raw.NAME ?? raw.PAYEE ?? '';
			const memo = raw.MEMO ?? '';
			const text = `${name} ${memo}`.replace(/\s+/g, ' ').trim();
			const direction: CaptureDirection = amountCents < 0 ? 'out' : 'in';
			const { kind, neutral } = classifyStatementText(text, direction, isCard);
			const counterparty = extractStatementCounterparty(name, memo);

			entries.push({
				fitid,
				postedDate,
				amountCents: Math.abs(amountCents),
				direction,
				trnType: raw.TRNTYPE ?? '',
				name,
				memo,
				text,
				kind,
				neutral,
				counterparty,
				merchantKey: merchantKeyOf(counterparty),
				suggestedCategory: guessCategory({ direction, kind, counterparty }),
			});
		}

		return {
			accountKey,
			bankId,
			acctId,
			acctType: statement.fields.ACCTTYPE ?? (isCard ? 'CREDITCARD' : null),
			isCard,
			bankName,
			currency: statement.fields.CURDEF ?? null,
			entries,
			skipped,
		};
	});

	return { accounts };
};

export default {
	decodeOfxBytes,
	parseOfx,
	parseOfxAmount,
	parseOfxDate,
	classifyStatementText,
	extractStatementCounterparty,
};
