/**
 * Cores dos bancos, para o cartão na tela parecer o cartão na carteira.
 *
 * A cor é da marca; o texto sobre ela é escolhido pelo contraste (WCAG), nunca à mão:
 * o amarelo do Banco do Brasil pede texto preto, o roxo do Nubank pede branco. O teste
 * `bankBrands.test.ts` garante contraste mínimo de 4,5:1 para toda marca da lista.
 *
 * Puro, sem React Native.
 */

import { normalizeText } from './captureParser';

export interface BankBrand {
	id: string;
	name: string;
	/** Cor principal da marca, `#RRGGBB`. */
	color: string;
	/** Formas como o nome aparece em notificações, extratos e no que o usuário digita. */
	aliases: string[];
}

export const BANK_BRANDS: BankBrand[] = [
	{ id: 'nubank', name: 'Nubank', color: '#820AD1', aliases: ['nubank', 'nu', 'nu pagamentos', 'nu financeira'] },
	{ id: 'inter', name: 'Inter', color: '#FF7A00', aliases: ['inter', 'banco inter', 'intermedium'] },
	{ id: 'mercadopago', name: 'Mercado Pago', color: '#00A6E6', aliases: ['mercado pago', 'mercadopago', 'mp'] },
	{ id: 'itau', name: 'Itaú', color: '#EC7000', aliases: ['itau', 'itau unibanco', 'iti'] },
	{ id: 'bradesco', name: 'Bradesco', color: '#CC092F', aliases: ['bradesco', 'next'] },
	{ id: 'santander', name: 'Santander', color: '#EC0000', aliases: ['santander'] },
	{ id: 'bb', name: 'Banco do Brasil', color: '#FCFC30', aliases: ['banco do brasil', 'bb', 'ourocard'] },
	{ id: 'caixa', name: 'Caixa', color: '#005CA9', aliases: ['caixa', 'caixa economica', 'cef'] },
	{ id: 'c6', name: 'C6 Bank', color: '#242424', aliases: ['c6', 'c6 bank', 'c6bank'] },
	{ id: 'picpay', name: 'PicPay', color: '#21C25E', aliases: ['picpay'] },
	{ id: 'btg', name: 'BTG Pactual', color: '#0B2A4A', aliases: ['btg', 'btg pactual'] },
	{ id: 'xp', name: 'XP', color: '#1B1B1B', aliases: ['xp', 'xp investimentos'] },
	{ id: 'neon', name: 'Neon', color: '#0068FF', aliases: ['neon'] },
	{ id: 'pan', name: 'Banco Pan', color: '#00AEEF', aliases: ['pan', 'banco pan'] },
	{ id: 'will', name: 'Will Bank', color: '#FFD800', aliases: ['will', 'will bank'] },
	{ id: 'pagbank', name: 'PagBank', color: '#1BB99A', aliases: ['pagbank', 'pagseguro'] },
	{ id: 'sicredi', name: 'Sicredi', color: '#3FA110', aliases: ['sicredi'] },
	{ id: 'sicoob', name: 'Sicoob', color: '#003641', aliases: ['sicoob'] },
];

/** Cor de um cartão de banco que a lista não conhece. */
export const NEUTRAL_CARD_COLOR = '#2B2F36';

/**
 * A marca de um banco pelo nome, tolerante a acento, caixa e prefixos ("Banco Inter",
 * "Nu"). Nomes curtos (2 letras) só casam por igualdade, para "mp" não achar "mpx".
 */
export const brandFor = (bankName: string | null | undefined): BankBrand | null => {
	if (!bankName) return null;
	const target = normalizeText(bankName).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
	if (!target) return null;

	for (const brand of BANK_BRANDS) {
		for (const alias of brand.aliases) {
			if (alias.length <= 2) {
				if (target === alias) return brand;
				continue;
			}
			if (target === alias || target.startsWith(`${alias} `) || target.endsWith(` ${alias}`) || target.includes(` ${alias} `)) {
				return brand;
			}
		}
	}
	return null;
};

const channel = (value: number): number => {
	const c = value / 255;
	return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** Luminância relativa WCAG de `#RRGGBB`. */
export const relativeLuminance = (hex: string): number => {
	const clean = hex.replace('#', '');
	const r = Number.parseInt(clean.slice(0, 2), 16);
	const g = Number.parseInt(clean.slice(2, 4), 16);
	const b = Number.parseInt(clean.slice(4, 6), 16);
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

/** Razão de contraste WCAG entre duas cores. */
export const contrastRatio = (a: string, b: string): number => {
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	const [light, dark] = la > lb ? [la, lb] : [lb, la];
	return (light + 0.05) / (dark + 0.05);
};

/** Preto ou branco, o que tiver mais contraste sobre `background`. */
export const readableTextOn = (background: string): '#000000' | '#FFFFFF' =>
	contrastRatio(background, '#000000') >= contrastRatio(background, '#FFFFFF') ? '#000000' : '#FFFFFF';

export type CardNetwork = 'visa' | 'mastercard' | 'elo' | 'amex' | 'hipercard';

export const CARD_NETWORKS: CardNetwork[] = ['mastercard', 'visa', 'elo', 'amex', 'hipercard'];

export const NETWORK_LABELS: Record<CardNetwork, string> = {
	visa: 'VISA',
	mastercard: 'Mastercard',
	elo: 'elo',
	amex: 'American Express',
	hipercard: 'Hipercard',
};

export default { BANK_BRANDS, brandFor, readableTextOn, contrastRatio, relativeLuminance, NETWORK_LABELS };
