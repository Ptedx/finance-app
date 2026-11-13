/**
 * A conta a pagar que parece a fatura de um cartão (SPD-137).
 *
 * Cadastrar a fatura inteira de um cartão em Contas a pagar conta em dobro: ela entra no
 * custo fixo junto com as parcelas do cartão, e o app já avisa o vencimento da fatura. A tela
 * avisa (sem impedir) quando o nome tem cartão (pt, en, it) ou o nome ou o banco de um cartão
 * cadastrado. "Fatura" sozinha não basta (SPD-137b): "Fatura Claro" e "fatura de energia" são
 * contas de verdade. Palavra inteira: "Cartório" não é cartão, "Internet" não é o Inter.
 */

import { type CardNameLike, looksLikeCardInvoice } from '../cardInvoiceBill';

const CARDS: CardNameLike[] = [
	{ name: 'Roxinho', bankName: 'Nubank' },
	{ name: 'Inter Gold', bankName: 'Inter' },
	{ name: 'Visa do mercado', bankName: 'Itaú' },
];

describe('looksLikeCardInvoice', () => {
	it.each([
		'Cartão Inter',
		'Cartão de crédito do Itaú',
		'cartao de credito',
		'Cartões',
		'Credit card',
		'Card bill',
		'Fattura carta di credito',
		'Carta di credito',
		'Pagamento cartão - Santander',
	])('"%s" avisa, mesmo sem cartão cadastrado', (name) => {
		expect(looksLikeCardInvoice(name, [])).toBe(true);
	});

	it.each([
		'Internet',
		'Escola',
		'Cartório',
		'Cartorio 2º ofício',
		'Faturamento do MEI',
		'Cardiologista',
		'Plano de saúde',
		'Condomínio',
		'',
		'   ',
	])('"%s" não avisa', (name) => {
		expect(looksLikeCardInvoice(name, CARDS)).toBe(false);
	});

	it('o nome ou o banco de um cartão cadastrado avisa, palavra inteira', () => {
		expect(looksLikeCardInvoice('Nubank', CARDS)).toBe(true);
		expect(looksLikeCardInvoice('Roxinho', CARDS)).toBe(true);
		expect(looksLikeCardInvoice('Inter', CARDS)).toBe(true);
		expect(looksLikeCardInvoice('inter gold', CARDS)).toBe(true);
		// Sem acento e em maiúsculas também.
		expect(looksLikeCardInvoice('ITAU', CARDS)).toBe(true);
		expect(looksLikeCardInvoice('Visa do Mercado', CARDS)).toBe(true);
		// Prefixo não conta: "Internet" não é o Inter, "Nubanker" não é o Nubank.
		expect(looksLikeCardInvoice('Internet', CARDS)).toBe(false);
		expect(looksLikeCardInvoice('Nubanker', CARDS)).toBe(false);
		// Só um pedaço do nome do cartão não basta: "Gold" sozinho não é o "Inter Gold".
		expect(looksLikeCardInvoice('Academia Gold', CARDS)).toBe(false);
	});

	it('sem cartão cadastrado, o nome do banco sozinho não avisa', () => {
		expect(looksLikeCardInvoice('Nubank', [])).toBe(false);
		expect(looksLikeCardInvoice('Inter', [])).toBe(false);
	});

	// SPD-137b: fatura, invoice e fattura sozinhas são a conta de qualquer empresa.
	it.each([
		'Fatura Claro',
		'Fatura de energia',
		'fatura de energia',
		'FATURA',
		'Faturas do mês',
		'Amex invoice',
		'Electricity invoices',
		'Fattura Enel',
		'Fatture del gas',
	])('"%s" não avisa: fatura sem cartão nem cartão cadastrado', (name) => {
		expect(looksLikeCardInvoice(name, [])).toBe(false);
		expect(looksLikeCardInvoice(name, CARDS)).toBe(false);
	});

	it.each([
		'Fatura do cartão',
		'Fatura cartão Santander',
		'Faturas dos cartões',
		'Card invoice',
		'Invoices of my cards',
		'Fattura della carta',
		'Fatture carte',
	])('"%s" avisa: fatura junto com uma palavra de cartão, sem cartão cadastrado', (name) => {
		expect(looksLikeCardInvoice(name, [])).toBe(true);
	});

	it('fatura junto com o nome ou o banco de um cartão cadastrado avisa', () => {
		expect(looksLikeCardInvoice('Fatura Nubank', CARDS)).toBe(true);
		expect(looksLikeCardInvoice('Fatura Roxinho', CARDS)).toBe(true);
		expect(looksLikeCardInvoice('Invoice Inter Gold', CARDS)).toBe(true);
		expect(looksLikeCardInvoice('Fattura Itaú', CARDS)).toBe(true);
		// O mesmo nome, sem o cartão cadastrado: é só "fatura" de alguém.
		expect(looksLikeCardInvoice('Fatura Nubank', [])).toBe(false);
	});

	it('banco em branco não casa com tudo', () => {
		expect(looksLikeCardInvoice('Escola', [{ name: 'Roxinho', bankName: null }, { name: ' ', bankName: '' }])).toBe(false);
	});
});
