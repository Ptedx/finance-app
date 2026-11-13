/**
 * Avisos ambíguos (SPD-123): quando o aviso não diz para onde foi o dinheiro (conta,
 * cartão, qual cartão) ou para que lado (entrou, saiu), o app não chuta — o aviso vai
 * para a revisão com um motivo próprio, e a escolha do usuário vira uma regra.
 *
 * Os textos são inventados, no formato plausível de cada banco (nenhum é de um usuário).
 * Cada caso diz o que acontecia antes (automático e às vezes errado) e o que acontece agora.
 */

import type { Account } from '../../database/schema';
import { ambiguityOfReason, ambiguousReason, learnedReason } from '../ambiguityReasons';
import {
	choiceKeyOf,
	detectAmbiguity,
	lookupChoice,
	MAX_CHOICES_LENGTH,
	parseCaptureChoices,
	rememberChoice,
	serializeCaptureChoices,
} from '../captureChoices';
import { parseCapture, type RawCapture } from '../captureParser';
import { invoiceCardOf, pickNotificationTarget, planLedgerRepair } from '../notificationTarget';

const NUBANK = 'com.nu.production';
const INTER = 'br.com.intermedium';
const PICPAY = 'com.picpay';
const SMS = 'com.google.android.apps.messaging';
const SAMSUNG = 'com.samsung.android.spay';

const account = (overrides: Partial<Account>): Account => ({
	id: 'x',
	name: 'Conta',
	kind: 'checking',
	role: 'main',
	envelopeMonthlyCents: null,
	network: null,
	bankName: null,
	color: '#000',
	last4: null,
	closingDay: null,
	dueDay: null,
	closingDaysBefore: null,
	creditLimitCents: null,
	cardNames: null,
	packageName: null,
	accountKey: null,
	openingBalanceCents: 0,
	openingBalanceDate: '2026-09-01',
	sortOrder: 0,
	archived: false,
	updatedAt: '',
	...overrides,
});

const interPF = account({ id: 'inter-pf', name: 'Inter', bankName: 'Inter', packageName: INTER });
const interCard = account({ id: 'inter-cc', name: 'Cartão Inter', kind: 'credit_card', role: 'card', bankName: 'Inter', packageName: INTER, last4: '5678', closingDay: 25 });
const interCard2 = account({ id: 'inter-cc2', name: 'Cartão Inter PJ', kind: 'credit_card', role: 'card', bankName: 'Inter', packageName: INTER, last4: '1111', closingDay: 5 });
const nuPF = account({ id: 'nu-pf', name: 'Nubank', bankName: 'Nubank', packageName: NUBANK });
const nuCard = account({ id: 'nu-cc', name: 'Cartão PF', kind: 'credit_card', role: 'card', bankName: 'Nubank', packageName: NUBANK, last4: '1534', closingDay: 25 });
const nuCardPJ = account({ id: 'nu-cc-pj', name: 'Cartão PJ', kind: 'credit_card', role: 'card', bankName: 'Nubank', packageName: NUBANK, last4: '9999', closingDay: 10 });
const bradescoPF = account({ id: 'bra-pf', name: 'Bradesco', bankName: 'Bradesco' });
const bradescoCard = account({ id: 'bra-cc', name: 'Cartão Bradesco', kind: 'credit_card', role: 'card', bankName: 'Bradesco', last4: '9876', closingDay: 3 });

const notice = (packageName: string, appLabel: string, title: string, text: string): RawCapture => ({
	packageName,
	appLabel,
	title,
	text,
	postedAt: '2026-11-05T15:00:00.000Z',
});

/** O alvo como o resolvedor o pede: o aviso, mais o final que o parser achou. */
const targetOf = (accounts: Account[], raw: RawCapture) =>
	pickNotificationTarget(accounts, { ...raw, cardLast4: parseCapture(raw)?.cardLast4 ?? null });

const ambiguityOf = (accounts: Account[], raw: RawCapture) => {
	const parsed = parseCapture(raw);
	if (!parsed) throw new Error('o aviso de teste não foi lido');
	return detectAmbiguity(accounts, raw, parsed);
};

// Inter: a compra no crédito sem o final do cartão (C05, formato a confirmar).
const interCreditNoFinal = notice(INTER, 'Inter', 'Inter', 'Olá, você acaba de comprar no crédito em POSTO EXEMPLO o valor de R$ 200,00.');
// Inter: o débito no mesmo molde da compra do cartão, sem a palavra "débito" (A6).
const interDebitUnknownFinal = notice(INTER, 'Inter', 'Compra aprovada', 'Compra aprovada no cartão final 0443: R$ 50,00 em PADARIA EXEMPLO');
// Nubank: "Compra aprovada" sem "crédito", com um final que não é de nenhum dos dois cartões (A3).
const nuPurchaseNoKind = notice(NUBANK, 'Nubank', 'Compra aprovada', 'Compra de R$ 480,00 APROVADA em LOJA EXEMPLO para o cartão com final 6422.');
// Bradesco por SMS: o remetente é o banco, e o final não é o do cartão cadastrado.
const bradescoSms = notice(SMS, 'Mensagens', 'Bradesco', 'BRADESCO: COMPRA APROVADA NO CARTAO FINAL 3456 DE R$ 45,00 EM DROGARIA EXEMPLO.');
// PicPay: "recebido" e "enviou", sem dizer para quem (sem "te", sem "para você"). O "Fulano te
// enviou" do C68 deixou de ser dúvida (SPD-162): é entrada, e está mais abaixo.
const picpaySent = notice(PICPAY, 'PicPay', 'Pix recebido', 'Ana Exemplo enviou R$ 20,00.');
// Mercado Pago (formato a confirmar): "recebida" e "enviou" no mesmo aviso, sem "para você".
const transferBoth = notice('com.mercadopago.wallet', 'Mercado Pago', 'Transferência recebida', 'Carlos Exemplo enviou R$ 75,00.');
// Nubank: o cartão avisa que recebeu o pagamento, sem dizer de qual conta ele saiu (X-2).
const nuInvoiceReceived = notice(NUBANK, 'Nubank', 'Pagamento recebido', 'Recebemos o pagamento da sua fatura no valor de R$ 1.500,00.');

describe('NOTIF-06: "no crédito" sem o final do cartão', () => {
	it('com um cartão só do banco, é dele (antes ia para a conta corrente)', () => {
		expect(targetOf([interPF, interCard], interCreditNoFinal)).toEqual({ type: 'card', account: interCard });
		expect(ambiguityOf([interPF, interCard], interCreditNoFinal)).toBeNull();
	});

	it('com dois cartões do banco, ou nenhum, vai para a revisão (antes: conta corrente, automático)', () => {
		expect(targetOf([interPF, interCard, interCard2], interCreditNoFinal)).toEqual({
			type: 'unknown',
			ambiguity: { case: 'credit_no_last4' },
		});
		expect(ambiguityOf([interPF, interCard, interCard2], interCreditNoFinal)?.case).toBe('credit_no_last4');
		expect(ambiguityOf([interPF], interCreditNoFinal)?.case).toBe('credit_no_last4');
	});

	it('"crédito em conta" não é compra no crédito: continua na conta corrente', () => {
		const deposit = notice(INTER, 'Inter', 'Inter', 'Crédito em conta de R$ 500,00 recebido de EMPRESA EXEMPLO.');
		expect(targetOf([interPF, interCard], deposit)).toEqual({ type: 'checking' });
		expect(ambiguityOf([interPF, interCard], deposit)).toBeNull();
	});
});

describe('NOTIF-15: dois cartões do banco e "Compra aprovada" sem "crédito"', () => {
	it('final que não é de nenhum dos dois: revisão (antes: conta corrente, automático)', () => {
		expect(targetOf([nuPF, nuCard, nuCardPJ], nuPurchaseNoKind)).toEqual({
			type: 'unknown',
			ambiguity: { case: 'purchase_no_kind' },
		});
		expect(ambiguityOf([nuPF, nuCard, nuCardPJ], nuPurchaseNoKind)?.case).toBe('purchase_no_kind');
	});

	it('o final exato continua decidindo sozinho', () => {
		const exact = notice(NUBANK, 'Nubank', 'Compra aprovada', 'Compra de R$ 480,00 APROVADA em LOJA EXEMPLO para o cartão com final 9999.');
		expect(targetOf([nuPF, nuCard, nuCardPJ], exact)).toEqual({ type: 'card', account: nuCardPJ });
		expect(ambiguityOf([nuPF, nuCard, nuCardPJ], exact)).toBeNull();
	});
});

describe('NOTIF-16: débito com um final desconhecido', () => {
	it('Inter: com um cartão de crédito e a conta do banco, revisão (antes: fatura do cartão, automático)', () => {
		const target = targetOf([interPF, interCard], interDebitUnknownFinal);
		expect(target).toEqual({ type: 'unknown', ambiguity: { case: 'debit_unknown_last4', card: interCard } });
		expect(ambiguityOf([interPF, interCard], interDebitUnknownFinal)?.case).toBe('debit_unknown_last4');
	});

	it('Bradesco por SMS: o mesmo caso, pelo remetente', () => {
		expect(ambiguityOf([bradescoPF, bradescoCard], bradescoSms)?.case).toBe('debit_unknown_last4');
	});

	it('o que já era seguro continua automático', () => {
		// "débito" escrito: conta corrente.
		const debit = notice(NUBANK, 'Nubank', 'Compra no débito aprovada', 'Compra de R$ 10,00 APROVADA em X para o cartão com final 4444.');
		expect(targetOf([nuPF, nuCard], debit)).toEqual({ type: 'checking' });
		// "crédito" escrito, um cartão só do banco: a fatura dele (virtual do Nubank).
		const credit = notice(NUBANK, 'Nubank', 'Compra no crédito aprovada', 'Compra de R$ 26,90 APROVADA em EXEMPLO PLAY para o cartão com final 2513.');
		expect(targetOf([nuPF, nuCard], credit)).toEqual({ type: 'card', account: nuCard });
		// Sem conta do banco no app, débito não tem para onde ir: a fatura do único cartão.
		expect(targetOf([interCard], interDebitUnknownFinal)).toEqual({ type: 'card', account: interCard });
		// Carteira (Samsung Pay): o aviso do banco chega junto e decide; a carteira fica no cartão.
		const wallet = notice(SAMSUNG, 'Samsung Wallet', 'Pagamento aprovado', 'R$ 35,90 em MERCADO EXEMPLO com Nubank final 1234');
		expect(targetOf([nuPF, nuCard], wallet)).toEqual({ type: 'card', account: nuCard });
		// Final nomeado no cartão: decidido.
		const named = { ...nuCard, cardNames: '{"6422":"Assinaturas"}' };
		expect(ambiguityOf([nuPF, named], nuPurchaseNoKind)).toBeNull();
	});

	it('o conserto das compras antigas não mexe no que o usuário (ou a regra aprendida) decidiu', () => {
		const base = {
			id: 'cap-1',
			fingerprint: 'f',
			packageName: INTER,
			appLabel: 'Inter',
			title: interDebitUnknownFinal.title,
			text: interDebitUnknownFinal.text,
			postedAt: interDebitUnknownFinal.postedAt,
			amountCents: 5000,
			direction: 'out' as const,
			kind: 'purchase',
			counterparty: 'PADARIA EXEMPLO',
			merchantKey: 'padaria exemplo',
			cardLast4: '0443',
			status: 'confirmed' as const,
			question: null,
			relatedId: null,
			suggestedCategory: 'food',
			transactionId: 'tx-1',
			autoConfirmed: false,
			reason: null,
			accountId: 'inter-pf',
			transferId: null,
			installments: null,
			createdAt: '',
			updatedAt: '',
		};
		// Compra antiga (antes do SPD-123): ia para o cartão, mas hoje um aviso igual vai para a
		// revisão — o conserto também não chuta e a deixa na conta (SPD-132).
		expect(planLedgerRepair([interPF, interCard], [base]).moveCaptures).toEqual([]);
		// Com o final nomeado depois no cartão, as regras de hoje dizem "cartão", sem dúvida: a
		// antiga vai para ele. A escolhida na revisão ou pela regra aprendida fica onde o
		// usuário pôs.
		const namedLater = { ...interCard, cardNames: '{"0443":"Virtual"}' };
		expect(planLedgerRepair([interPF, namedLater], [base]).moveCaptures).toHaveLength(1);
		for (const reason of [ambiguousReason('debit_unknown_last4'), learnedReason('debit_unknown_last4')]) {
			expect(planLedgerRepair([interPF, namedLater], [{ ...base, reason }]).moveCaptures).toEqual([]);
		}
	});
});

describe('NOTIF-11: "Fulano enviou" — entrou ou saiu?', () => {
	it('PicPay: o aviso tem as duas pistas, e a direção vai para a revisão (antes: saída, sem dúvida nenhuma)', () => {
		const parsed = parseCapture(picpaySent);
		expect(parsed?.direction).toBe('out');
		expect(parsed?.ambiguousDirection).toBeDefined();
		expect(ambiguityOf([], picpaySent)?.case).toBe('pix_direction');
	});

	it('Transferência "recebida" com "enviou": a mesma dúvida', () => {
		expect(parseCapture(transferBoth)?.ambiguousDirection).toBeDefined();
		expect(ambiguityOf([], transferBoth)?.case).toBe('pix_direction');
	});

	it('Pix só enviado ou só recebido continua decidido', () => {
		for (const raw of [
			notice(INTER, 'Inter', 'Pix enviado', 'Pix enviado: R$ 1.200,00 para JOAO EXEMPLO. Toque para ver o comprovante.'),
			notice(INTER, 'Inter', 'Pix recebido', 'Você recebeu um Pix de R$ 350,00 de EMPRESA EXEMPLO LTDA.'),
		]) {
			expect(parseCapture(raw)?.ambiguousDirection).toBeUndefined();
			expect(ambiguityOf([], raw)).toBeNull();
		}
	});
});

describe('SPD-162: "Fulano te enviou" é entrada, sem dúvida', () => {
	// O aviso do Inter de 12/11, com nome e conta inventados: Pix da conta PF de outro banco
	// para a conta do Inter. Antes: saída (palpite), com a dúvida "recebido/enviou".
	const interReceived = notice(
		INTER,
		'Inter',
		'Pix recebido',
		'Fulano Exemplo te enviou um Pix de R$ 291,65 creditado na sua conta final ***0000-0.'
	);

	it('o aviso do Inter: entrada, Pix recebido, R$ 291,65, sem pergunta', () => {
		expect(parseCapture(interReceived)).toMatchObject({ direction: 'in', kind: 'pix_in', amountCents: 29_165 });
		expect(parseCapture(interReceived)?.ambiguousDirection).toBeUndefined();
		expect(ambiguityOf([interPF], interReceived)).toBeNull();
	});

	it.each([
		['te enviou', notice(PICPAY, 'PicPay', 'Pix recebido', 'Ana Exemplo te enviou R$ 20,00.')],
		['te mandou', notice(PICPAY, 'PicPay', 'PicPay', 'Ana Exemplo te mandou um Pix de R$ 20,00.')],
		['enviou para você', notice('com.mercadopago.wallet', 'Mercado Pago', 'Transferência recebida', 'Carlos Exemplo enviou R$ 75,00 para você.')],
		['enviou R$ 1.500,00 para você', notice(NUBANK, 'Nubank', 'Pix', 'Carlos Exemplo enviou R$ 1.500,00 para você.')],
		['creditado na sua conta', notice(INTER, 'Inter', 'Pix', 'Pix de R$ 80,00 enviado por Fulano Exemplo e creditado na sua conta.')],
		['"Transferência recebida" com "te enviou"', notice(INTER, 'Inter', 'Transferência recebida', 'Fulano Exemplo te enviou R$ 40,00 por TED.')],
	])('%s: entrada, sem dúvida (antes: saída, palpite)', (_case, raw) => {
		const parsed = parseCapture(raw);
		expect(parsed?.direction).toBe('in');
		expect(['pix_in', 'transfer_in']).toContain(parsed?.kind);
		expect(parsed?.ambiguousDirection).toBeUndefined();
		expect(ambiguityOf([], raw)).toBeNull();
	});

	it.each([
		['"Você enviou" com "recebido"', notice(INTER, 'Inter', 'Pix enviado', 'Você enviou R$ 30,00 para Fulano Exemplo. O valor foi recebido na conta dele.')],
		['"Pix enviado" com "recebida"', notice(INTER, 'Inter', 'Pix enviado', 'Pix enviado: R$ 30,00 para Fulano Exemplo. Confirmação recebida.')],
	])('%s: continua saída, agora sem dúvida', (_case, raw) => {
		const parsed = parseCapture(raw);
		expect(parsed?.direction).toBe('out');
		expect(parsed?.kind).toBe('pix_out');
		expect(parsed?.ambiguousDirection).toBeUndefined();
	});

	it.each([
		['"recebido" e "enviou" sem dizer para quem', picpaySent],
		['"recebida" e "enviou" na transferência', transferBoth],
		['as duas certezas no mesmo aviso', notice(INTER, 'Inter', 'Pix', 'Você enviou R$ 30,00 e o valor foi creditado na sua conta.')],
		['"recebido" e "pagamento"', notice(INTER, 'Inter', 'Pix recebido', 'Pagamento de R$ 30,00 via Pix.')],
	])('continua ambíguo: %s', (_case, raw) => {
		expect(parseCapture(raw)?.ambiguousDirection).toBeDefined();
		expect(ambiguityOf([], raw)?.case).toBe('pix_direction');
	});
});

describe('X-2: "Recebemos o pagamento da fatura" não diz de qual conta saiu', () => {
	it('o aviso do cartão vai para a revisão (antes: saída da conta do mesmo banco, automática)', () => {
		expect(ambiguityOf([nuPF, nuCard, interPF], nuInvoiceReceived)?.case).toBe('invoice_payment');
	});

	it('o aviso da conta que pagou continua automático', () => {
		const paid = notice(INTER, 'Inter', 'Pagamento de fatura', 'Você pagou R$ 1.500,00 da fatura do cartão.');
		expect(parseCapture(paid)?.kind).toBe('invoice_payment');
		expect(ambiguityOf([interPF, interCard], paid)).toBeNull();
	});

	it('o cartão que recebeu o pagamento: o do final citado, ou o único do banco do aviso', () => {
		expect(invoiceCardOf([nuPF, nuCard, interPF, interCard], { ...nuInvoiceReceived, cardLast4: null })?.id).toBe('nu-cc');
		expect(invoiceCardOf([nuPF, nuCard, nuCardPJ], { ...nuInvoiceReceived, cardLast4: null })).toBeNull();
		expect(invoiceCardOf([nuPF, nuCard, nuCardPJ], { ...nuInvoiceReceived, cardLast4: '9999' })?.id).toBe('nu-cc-pj');
	});
});

describe('AUTO-07: aviso de fatura fechada ou de vencimento nunca vira gasto', () => {
	it.each([
		['Nubank', notice(NUBANK, 'Nubank', 'Fatura fechada', 'A fatura do seu cartão fechou em R$ 1.234,56 e vence em 10/12.')],
		['Inter', notice(INTER, 'Inter', 'Fatura disponível', 'Sua fatura está disponível. Valor: R$ 980,00. Vencimento: 05/12.')],
		['Bradesco SMS', notice(SMS, 'Mensagens', 'Bradesco', 'BRADESCO CARTOES: FATURA FECHADA. VALOR R$ 2.345,67 VENC 15/12.')],
		['Itaú SMS', notice(SMS, 'Mensagens', 'Itau', 'Itaú: o vencimento da sua fatura de R$ 432,10 é amanhã, 03/12.')],
		['Santander', notice(SMS, 'Mensagens', 'Santander', 'Lembrete: a fatura do cartão final 7890, de R$ 600,00, vence em 08/12.')],
		['sem a palavra fatura', notice(INTER, 'Inter', 'Cartão fechou', 'Seu cartão fechou: total de R$ 1.100,00 com vencimento em 12/12. Débito automático ativo.')],
	])('%s: descartado, sem item nem lançamento', (_bank, raw) => {
		expect(parseCapture(raw)).toBeNull();
	});
});

describe('a chave da regra: banco, tipo do caso e o final — nunca texto, nome ou valor', () => {
	const cases: Array<[string, Account[], RawCapture]> = [
		['NOTIF-06', [interPF, interCard, interCard2], interCreditNoFinal],
		['NOTIF-15', [nuPF, nuCard, nuCardPJ], nuPurchaseNoKind],
		['NOTIF-16', [interPF, interCard], interDebitUnknownFinal],
		['NOTIF-16 SMS', [bradescoPF, bradescoCard], bradescoSms],
		['NOTIF-11', [], picpaySent],
		['X-2', [nuPF, nuCard], nuInvoiceReceived],
	];

	it.each(cases)('%s', (_id, accounts, raw) => {
		const found = ambiguityOf(accounts, raw);
		expect(found).not.toBeNull();
		const key = found?.key as string;
		expect(key).toMatch(/^[a-z0-9.|_/ ]+$/);
		for (const forbidden of ['ana', 'exemplo', 'padaria', 'posto', 'loja', 'drogaria', 'carlos', '20,00', '2000', '200', '480', '45,00', '1.500', '1500']) {
			expect(key).not.toContain(forbidden);
		}
		// A mesma chave sai da captura gravada, na hora de aprender.
		expect(choiceKeyOf({ ...raw, cardLast4: parseCapture(raw)?.cardLast4 ?? null }, found?.case as never)).toBe(key);
	});

	it('o mesmo caso de outro banco, ou com outro final, é outra regra', () => {
		const inter = ambiguityOf([interPF, interCard], interDebitUnknownFinal)?.key;
		const otherFinal = ambiguityOf(
			[interPF, interCard],
			notice(INTER, 'Inter', 'Compra aprovada', 'Compra aprovada no cartão final 7001: R$ 12,00 em MERCADO EXEMPLO')
		)?.key;
		const sameFinalOtherPlace = ambiguityOf(
			[interPF, interCard],
			notice(INTER, 'Inter', 'Compra aprovada', 'Compra aprovada no cartão final 0443: R$ 99,90 em FARMACIA EXEMPLO')
		)?.key;
		expect(otherFinal).not.toBe(inter);
		expect(sameFinalOtherPlace).toBe(inter);
		expect(ambiguityOf([bradescoPF, bradescoCard], bradescoSms)?.key).not.toBe(inter);
	});
});

describe('a regra aprendida', () => {
	const debit = () => ambiguityOf([interPF, interCard], interDebitUnknownFinal) as NonNullable<ReturnType<typeof ambiguityOf>>;

	it('aplica a conta escolhida enquanto ela existe; apagada, arquivada ou juntada, volta para a revisão', () => {
		const choices = rememberChoice({}, debit().key, 'inter-pf');
		expect(lookupChoice(choices, debit(), [interPF, interCard])).toEqual({ state: 'applied', account: interPF });
		expect(lookupChoice({}, debit(), [interPF, interCard])).toEqual({ state: 'none' });
		expect(lookupChoice(choices, debit(), [{ ...interPF, deletedAt: '2026-11-06T00:00:00.000Z' }, interCard])).toEqual({ state: 'stale' });
		expect(lookupChoice(choices, debit(), [{ ...interPF, archived: true }, interCard])).toEqual({ state: 'stale' });
		expect(lookupChoice(choices, debit(), [interCard])).toEqual({ state: 'stale' });
	});

	it('a direção aprendida', () => {
		const pix = ambiguityOf([], picpaySent) as NonNullable<ReturnType<typeof ambiguityOf>>;
		expect(lookupChoice(rememberChoice({}, pix.key, 'in'), pix, [])).toEqual({ state: 'applied', direction: 'in' });
		expect(lookupChoice(rememberChoice({}, pix.key, 'lixo'), pix, [])).toEqual({ state: 'stale' });
	});

	it('o pagamento da fatura: de uma conta (nunca um cartão), ou "não lançar"', () => {
		const x2 = ambiguityOf([nuPF, nuCard, interPF], nuInvoiceReceived) as NonNullable<ReturnType<typeof ambiguityOf>>;
		const accounts = [nuPF, nuCard, interPF];
		expect(lookupChoice(rememberChoice({}, x2.key, 'inter-pf'), x2, accounts)).toEqual({ state: 'applied', account: interPF });
		expect(lookupChoice(rememberChoice({}, x2.key, 'skip'), x2, accounts)).toEqual({ state: 'applied', skip: true });
		expect(lookupChoice(rememberChoice({}, x2.key, 'nu-cc'), x2, accounts)).toEqual({ state: 'stale' });
	});

	it('cabe na preferência (até 2.000 caracteres): as mais antigas saem primeiro', () => {
		let choices = {};
		for (let index = 0; index < 60; index += 1) {
			choices = rememberChoice(choices, `br.com.intermedium|debit_unknown_last4|${String(index).padStart(4, '0')}`, `conta-${'x'.repeat(30)}-${index}`);
		}
		const serialized = serializeCaptureChoices(choices);
		expect(serialized.length).toBeLessThanOrEqual(MAX_CHOICES_LENGTH);
		expect(MAX_CHOICES_LENGTH).toBeLessThanOrEqual(2000);
		const kept = parseCaptureChoices(serialized);
		expect(kept['br.com.intermedium|debit_unknown_last4|0059']).toBe(`conta-${'x'.repeat(30)}-59`);
		expect(kept['br.com.intermedium|debit_unknown_last4|0000']).toBeUndefined();
	});

	it('valor estragado vale como nenhuma regra', () => {
		expect(parseCaptureChoices(null)).toEqual({});
		expect(parseCaptureChoices('[1,2')).toEqual({});
		expect(parseCaptureChoices('[1,2]')).toEqual({});
		expect(parseCaptureChoices('{"a":"b","c":3}')).toEqual({ a: 'b' });
	});
});

describe('o motivo gravado no item', () => {
	it('diz o caso e se foi a regra aprendida', () => {
		expect(ambiguousReason('pix_direction')).toBe('ambiguous_pix_direction');
		expect(learnedReason('invoice_payment')).toBe('learned_invoice_payment');
		expect(ambiguityOfReason('ambiguous_debit_unknown_last4')).toEqual({ case: 'debit_unknown_last4', learned: false });
		expect(ambiguityOfReason('learned_credit_no_last4')).toEqual({ case: 'credit_no_last4', learned: true });
		expect(ambiguityOfReason('rule')).toBeNull();
		expect(ambiguityOfReason(null)).toBeNull();
		expect(ambiguityOfReason('ambiguous_qualquer')).toBeNull();
		// Cabe no `reason` do servidor (64).
		expect(ambiguousReason('debit_unknown_last4').length).toBeLessThanOrEqual(64);
	});
});
