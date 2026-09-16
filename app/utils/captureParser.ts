/**
 * Leitura de notificações bancárias.
 *
 * Transforma o texto de uma notificação ("Compra de R$ 35,90 APROVADA em IFOOD para o
 * cartão com final 1234") num lançamento candidato: valor em centavos, direção, tipo e
 * com quem foi. É deliberadamente tolerante — cada banco escreve de um jeito e muda o
 * texto sem avisar — e deliberadamente conservador: sem um valor **e** uma palavra que
 * indique movimentação, a notificação é ignorada. Um "seu limite subiu para R$ 5.000"
 * que virasse despesa custaria mais confiança do que dez notificações perdidas.
 *
 * Puro, sem importar nada nativo, para ser testado com textos reais.
 */

export type CaptureDirection = 'in' | 'out';

export type CaptureKind =
	| 'purchase'
	| 'pix_out'
	| 'pix_in'
	| 'transfer_out'
	| 'transfer_in'
	| 'withdrawal'
	| 'deposit'
	| 'refund'
	| 'invoice_payment'
	| 'investment'
	| 'unknown';

/** O que o serviço nativo entrega: a notificação como chegou, sem interpretação. */
export interface RawCapture {
	packageName: string;
	appLabel: string;
	title: string;
	text: string;
	/** Instante ISO 8601 em que a notificação foi publicada. */
	postedAt: string;
}

export interface ParsedCapture {
	amountCents: number;
	direction: CaptureDirection;
	kind: CaptureKind;
	/** Estabelecimento ou pessoa, como veio no texto. `null` quando não dá para saber. */
	counterparty: string | null;
	cardLast4: string | null;
	/**
	 * Verdadeiro para movimentos que não são receita nem despesa: pagar a fatura do
	 * cartão (as compras já entraram uma a uma), aplicar ou resgatar investimento.
	 * Lançar isso como gasto contaria o mesmo dinheiro duas vezes.
	 */
	neutral: boolean;
}

/**
 * Carteiras digitais que repetem a notificação do banco.
 *
 * Samsung Pay e Google Wallet avisam da compra no ato, e o banco avisa segundos ou
 * minutos depois. São a mesma compra, e a do banco costuma ter mais informação
 * (estabelecimento, final do cartão), então é a que fica.
 */
export const WALLET_PACKAGES = new Set([
	'com.samsung.android.spay',
	'com.samsung.android.spaylite',
	'com.google.android.apps.walletnfcrel',
]);

export const isWalletPackage = (packageName: string): boolean => WALLET_PACKAGES.has(packageName);

/** Minúsculas, sem acento e com espaços colapsados: base de toda comparação de texto. */
export const normalizeText = (value: string): string =>
	value
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/\s+/g, ' ')
		.trim();

// ---------------------------------------------------------------------------
// Valor
// ---------------------------------------------------------------------------

/**
 * Símbolo de moeda seguido de número. Aceita `R$ 1.234,56`, `R$1234,56`, `$1,234.56`
 * e `€ 12`. Só o **primeiro** valor do texto conta: nos avisos de compra ele é o da
 * compra, e o que vem depois ("limite disponível R$ 1.200,00") não interessa.
 */
const AMOUNT_PATTERN = /(?:R\$|US\$|\$|€|£)\s?(\d[\d.,]*\d|\d)/;

/**
 * Converte "1.234,56", "1,234.56", "1234,5" ou "35" em centavos.
 *
 * Quando há ponto e vírgula, o último separador é o decimal. Quando há só um tipo,
 * ele é decimal se for seguido de exatamente 1 ou 2 dígitos no fim; do contrário é
 * separador de milhar ("R$ 1.200" são mil e duzentos reais, não um real e vinte).
 */
export const parseNotificationAmount = (digits: string): number | null => {
	const lastComma = digits.lastIndexOf(',');
	const lastDot = digits.lastIndexOf('.');

	let integerPart: string;
	let fractionPart = '';

	if (lastComma >= 0 && lastDot >= 0) {
		const decimalAt = Math.max(lastComma, lastDot);
		integerPart = digits.slice(0, decimalAt);
		fractionPart = digits.slice(decimalAt + 1);
	} else if (lastComma >= 0 || lastDot >= 0) {
		const separatorAt = Math.max(lastComma, lastDot);
		const after = digits.slice(separatorAt + 1);
		const isDecimal = after.length <= 2 && !digits.slice(0, separatorAt).includes(digits[separatorAt]);
		if (isDecimal) {
			integerPart = digits.slice(0, separatorAt);
			fractionPart = after;
		} else {
			integerPart = digits;
		}
	} else {
		integerPart = digits;
	}

	const whole = Number(integerPart.replace(/[.,]/g, ''));
	const fraction = fractionPart.replace(/[.,]/g, '');
	if (!Number.isSafeInteger(whole) || !/^\d{0,2}$/.test(fraction)) return null;

	const cents = whole * 100 + Number(fraction.padEnd(2, '0') || '0');
	return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
};

const extractAmountCents = (text: string): number | null => {
	const match = AMOUNT_PATTERN.exec(text);
	return match ? parseNotificationAmount(match[1]) : null;
};

// ---------------------------------------------------------------------------
// Direção e tipo
// ---------------------------------------------------------------------------

const has = (text: string, ...needles: string[]): boolean =>
	needles.some((needle) => text.includes(needle));

/**
 * Propaganda com valor no meio: "invista a partir de R$ 1", "ganhe até R$ 100 de
 * cashback", "seu dinheiro pode render mais". Tem símbolo de moeda, tem palavras de
 * investimento ou estorno, e não é movimentação nenhuma. É descartada antes de
 * classificar — a menos que o texto também confirme algo feito ("aprovada", "você
 * recebeu"), caso em que é um aviso real com um chamariz no fim.
 */
const PROMOTIONAL_PHRASES = [
	'a partir de r$',
	'a partir de $',
	'invista',
	'ganhe ',
	'ganhe!',
	'aproveite',
	'oferta',
	'promocao',
	'cupom',
	'pode render',
	'renda mais',
	'simule',
	'contrate',
	'conheca',
	'desconto de ate',
	'ate r$',
	'ate $',
	'quando quiser',
	'saiba mais',
	'toque para',
	'clique',
];

const CONFIRMATION_PHRASES = [
	'aprovada',
	'aprovado',
	'voce recebeu',
	'voce enviou',
	'voce pagou',
	'realizada',
	'realizado',
	'concluida',
	'concluido',
	'efetuada',
	'efetuado',
	'recebido',
	'recebida',
];

export const isPromotional = (normalized: string): boolean =>
	has(normalized, ...PROMOTIONAL_PHRASES) && !has(normalized, ...CONFIRMATION_PHRASES);

/**
 * Decide o que a notificação descreve. A ordem importa: "pagamento da fatura" tem a
 * palavra "pagamento", mas não é uma compra; "estorno de compra" tem "compra", mas é
 * dinheiro voltando.
 */
const classify = (
	text: string
): { direction: CaptureDirection; kind: CaptureKind; neutral: boolean } | null => {
	if (has(text, 'fatura') && has(text, 'pagamento', 'paga ', 'pago', 'quitad')) {
		return { direction: 'out', kind: 'invoice_payment', neutral: true };
	}
	// Só o movimento feito, nunca o substantivo solto: "resgate seu dinheiro quando
	// quiser" é propaganda, "resgate de R$ 300,00 concluído" é dinheiro trocando de bolso.
	if (
		has(
			text,
			'aplicacao de r$',
			'aplicacao realizada',
			'aplicacao efetuada',
			'aplicou',
			'resgate de r$',
			'resgate realizado',
			'resgate efetuado',
			'resgatou',
			'investimento realizado'
		)
	) {
		return { direction: 'out', kind: 'investment', neutral: true };
	}
	if (has(text, 'estorno', 'reembolso', 'devolucao', 'cashback', 'estornad')) {
		return { direction: 'in', kind: 'refund', neutral: false };
	}

	const incoming = has(
		text,
		'recebeu',
		'recebido',
		'recebida',
		'entrou na sua conta',
		'entrada de',
		'creditado',
		'credito de',
		'credito em conta',
		'deposito',
		'depositado',
		'caiu na sua conta',
		'transferencia recebida',
		'pix recebido',
		'voce tem um pix'
	);
	const outgoing = has(
		text,
		'compra',
		'pagamento',
		'pagou',
		'enviou',
		'enviado',
		'enviada',
		'transferencia enviada',
		'pix enviado',
		'debito',
		'debitado',
		'saque',
		'saida de',
		'aprovada',
		'aprovado',
		'cobranca',
		'assinatura'
	);

	if (has(text, 'pix')) {
		if (incoming && !outgoing) return { direction: 'in', kind: 'pix_in', neutral: false };
		if (outgoing) return { direction: 'out', kind: 'pix_out', neutral: false };
		return null;
	}
	if (has(text, 'transferencia', 'transferiu', ' ted ', ' doc ')) {
		if (incoming && !outgoing) return { direction: 'in', kind: 'transfer_in', neutral: false };
		if (outgoing) return { direction: 'out', kind: 'transfer_out', neutral: false };
		return null;
	}
	if (has(text, 'saque')) return { direction: 'out', kind: 'withdrawal', neutral: false };
	if (has(text, 'deposito', 'depositado')) return { direction: 'in', kind: 'deposit', neutral: false };
	if (incoming && !outgoing) return { direction: 'in', kind: 'unknown', neutral: false };
	if (has(text, 'compra', 'pagamento', 'pagou', 'aprovada', 'aprovado', 'debito', 'debitado', 'cobranca', 'assinatura')) {
		return { direction: 'out', kind: 'purchase', neutral: false };
	}
	if (outgoing) return { direction: 'out', kind: 'unknown', neutral: false };

	return null;
};

// ---------------------------------------------------------------------------
// Contraparte
// ---------------------------------------------------------------------------

/** Onde um nome termina: vírgula, ponto final de frase, ou a preposição seguinte. */
// Um nome pode ter ponto no meio ("APPLE.COM/BILL"), então o ponto só encerra quando
// vem seguido de espaço ou do fim do texto — o ponto final de uma frase.
const NAME_END =
	'(?=\\s*(?:,|\\.\\s|\\.$|$|\\s(?:para o|no cartao|no cartão|com o cartao|com o cartão|com|cartao|cartão|final|o valor|no valor|via|pelo|pela|em \\d|as \\d|às \\d|dia \\d)\\b))';
const NAME_BODY = '((?:[^,\\n](?!\\sR\\$))+?)';

const COUNTERPARTY_PATTERNS: Array<{ pattern: RegExp; when?: CaptureDirection }> = [
	// "em IFOOD *IFOOD para o cartão" / "em MERCADO XYZ" (compras)
	{ pattern: new RegExp(`\\bem\\s+(?!\\d)${NAME_BODY}${NAME_END}`, 'i'), when: 'out' },
	// "no débito no BGC BRASILIA o valor de R$ 63,80" (Inter): o "no" que não é
	// "no débito", "no cartão" nem "no valor" é o estabelecimento.
	{
		pattern: new RegExp(
			`\\bn[oa]\\s+(?!debito|débito|credito|crédito|cartao|cartão|valor|dia|seu|sua|app|aplicativo|pix)${NAME_BODY}${NAME_END}`,
			'i'
		),
		when: 'out',
	},
	// "para Fulano de Tal" (pix e transferências enviadas)
	{ pattern: new RegExp(`\\bpara\\s+(?!o cart|a cart|voce|você)${NAME_BODY}${NAME_END}`, 'i'), when: 'out' },
	// "de Fulano de Tal" (recebidos) — pulando o "de R$ 100,00" que vem antes
	{ pattern: new RegExp(`\\bde\\s+(?!r\\$|us\\$|\\$|€|\\d)${NAME_BODY}${NAME_END}`, 'i'), when: 'in' },
	// "Compra aprovada: R$ 35,90 - MERCADO XYZ" (alguns bancos separam com traço)
	{ pattern: /(?:R\$|US\$|\$|€|£)\s?[\d.,]+\s*[-–:]\s*([^,.\n]+?)(?=\s*(?:,|\.\s|\.$|$))/i },
];

const cleanCounterparty = (value: string): string | null => {
	const cleaned = value
		.replace(/\s+/g, ' ')
		.replace(/^(?:o |a |um |uma )/i, '')
		.replace(/\s*(?:aprovad[ao]|realizad[ao]|conclu[ií]d[ao])\s*$/i, '')
		.trim();
	// Nomes reais têm pelo menos duas letras; "R$", "12" e afins não são contraparte.
	if (cleaned.length < 2 || !/[a-zA-ZÀ-ú]{2}/.test(cleaned)) return null;
	return cleaned.slice(0, 80);
};

export const extractCounterparty = (
	text: string,
	direction: CaptureDirection
): string | null => {
	const withoutAmounts = text.replace(/\n+/g, ' ');
	for (const { pattern, when } of COUNTERPARTY_PATTERNS) {
		if (when && when !== direction) continue;
		const match = pattern.exec(withoutAmounts);
		if (match?.[1]) {
			const cleaned = cleanCounterparty(match[1]);
			if (cleaned) return cleaned;
		}
	}
	return null;
};

const extractCardLast4 = (text: string): string | null => {
	const match = /final\s*(\d{4})\b/i.exec(text) ?? /\*{2,}\s?(\d{4})\b/.exec(text);
	return match ? match[1] : null;
};

// ---------------------------------------------------------------------------
// Entrada principal
// ---------------------------------------------------------------------------

/**
 * Interpreta uma notificação. `null` significa "não é uma movimentação de dinheiro" e
 * a notificação é descartada — nunca vira um item para revisar.
 */
export const parseCapture = (raw: RawCapture): ParsedCapture | null => {
	const original = `${raw.title} ${raw.text}`.replace(/\s+/g, ' ').trim();
	const amountCents = extractAmountCents(original);
	if (amountCents === null) return null;

	const normalized = ` ${normalizeText(original)} `;
	if (isPromotional(normalized)) return null;

	const classified = classify(normalized);
	if (!classified) return null;

	return {
		amountCents,
		direction: classified.direction,
		kind: classified.kind,
		counterparty: extractCounterparty(original, classified.direction),
		cardLast4: extractCardLast4(original),
		neutral: classified.neutral,
	};
};

/**
 * Chave estável de um estabelecimento, para aprender categoria e reconhecer repetição.
 *
 * "IFOOD *IFOOD BR", "IFD*IFOOD" e "Ifood" precisam cair na mesma chave: prefixos de
 * adquirente (PAG*, MP*, IFD*), tudo depois de um asterisco, dígitos e pontuação são
 * ruído. O que sobra são as primeiras palavras do nome.
 */
export const merchantKeyOf = (counterparty: string | null): string | null => {
	if (!counterparty) return null;
	let key = normalizeText(counterparty);
	key = key.replace(/^(?:pag|pg|mp|ifd|dl|ame|ec|pay|zup|stone|cielo|rede|getnet)\s*\*\s*/i, '');
	key = key.replace(/\*.*$/, '');
	key = key.replace(/[^a-z0-9 ]/g, ' ').replace(/\b\d+\b/g, ' ').replace(/\s+/g, ' ').trim();
	if (!key) return null;
	return key.split(' ').slice(0, 3).join(' ');
};

/**
 * Palpite de categoria pelo nome do estabelecimento, usado só quando não há regra
 * aprendida. Erra pouco no comum (mercado, posto, farmácia) e prefere não opinar a
 * chutar no resto — "Other" é honesto, uma categoria errada é trabalho de correção.
 */
const CATEGORY_HINTS: Array<{ categoryId: string; words: string[] }> = [
	{
		categoryId: 'food',
		words: ['ifood', 'rappi', 'restaurante', 'lanche', 'burger', 'pizza', 'padaria', 'mercado', 'supermercado', 'acougue', 'hortifruti', ' cafe ', ' bar ', 'sushi', 'mcdonald', 'subway', 'ze delivery', 'atacadao', 'carrefour', 'pao de acucar', 'assai'],
	},
	{
		categoryId: 'transport',
		words: ['uber', '99app', ' 99 ', 'posto', 'combustivel', 'gasolina', 'shell', 'ipiranga', 'estacionamento', 'pedagio', ' metro ', 'onibus', 'bilhete unico', 'sem parar', 'conectcar', 'localiza'],
	},
	{
		categoryId: 'health',
		words: ['farmacia', 'drogaria', 'drogasil', ' raia ', 'pague menos', 'clinica', 'laboratorio', 'hospital', 'dentista', 'academia', 'smart fit'],
	},
	{
		categoryId: 'entertainment',
		words: ['netflix', 'spotify', 'disney', ' hbo ', ' max ', 'prime video', 'cinema', 'cinemark', 'steam', 'playstation', 'xbox', 'nintendo', 'youtube', 'globoplay', 'ingresso'],
	},
	{
		categoryId: 'utilities',
		words: [' enel ', ' cpfl ', ' light ', 'cemig', 'copel', 'sabesp', 'sanepar', 'comgas', ' vivo ', ' claro ', ' tim ', ' oi ', 'internet', 'energia', ' agua ', 'condominio', 'aluguel'],
	},
	{
		categoryId: 'shopping',
		words: ['amazon', 'mercado livre', 'mercadolivre', 'shopee', 'aliexpress', 'magalu', 'magazine', 'americanas', 'casas bahia', 'renner', 'riachuelo', 'zara', 'shein', 'kabum', 'leroy'],
	},
	{
		categoryId: 'education',
		words: ['udemy', 'alura', 'coursera', 'escola', 'faculdade', 'universidade', 'curso', 'livraria'],
	},
];

export const guessCategory = (
	parsed: Pick<ParsedCapture, 'direction' | 'kind' | 'counterparty'>
): string => {
	if (parsed.direction === 'in') {
		return parsed.kind === 'refund' ? 'refund' : 'other_income';
	}
	const name = ` ${normalizeText(parsed.counterparty ?? '')} `;
	for (const hint of CATEGORY_HINTS) {
		if (hint.words.some((word) => name.includes(normalizeText(word)))) return hint.categoryId;
	}
	return 'other_expense';
};

export default {
	parseCapture,
	parseNotificationAmount,
	extractCounterparty,
	merchantKeyOf,
	guessCategory,
	normalizeText,
	isWalletPackage,
	WALLET_PACKAGES,
};
