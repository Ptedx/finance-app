/**
 * O `capture_decision` dos avisos ambíguos (SPD-123): o diário diz qual caso foi, se o app
 * perguntou ou aplicou a regra aprendida, e se havia uma regra que deixou de valer. Nunca a
 * chave da regra, o final do cartão, a conta, o valor, o nome nem o texto.
 */

import { captureDecisionData } from '../capture';

const raw = { packageName: 'br.com.intermedium', appLabel: 'Inter' };

describe('capture_decision: o caso ambíguo e a escolha', () => {
	it('perguntou: o caso, "asked" e o motivo gravado no item', () => {
		const data = captureDecisionData({
			raw,
			fingerprint: 'fp',
			parsed: { amountCents: 5000, direction: 'out', kind: 'purchase', counterparty: 'PADARIA EXEMPLO', cardLast4: '0443', neutral: false, installments: null },
			outcome: {
				step: 'decided',
				decision: { action: 'pending', categoryId: 'food' },
				account: 'none',
				captureId: 'cap-1',
				ambiguity: 'debit_unknown_last4',
				choice: 'asked',
				reason: 'ambiguous_debit_unknown_last4',
			},
		});
		expect(data).toMatchObject({
			outcome: 'pending',
			reason: 'ambiguous_debit_unknown_last4',
			ambiguity: 'debit_unknown_last4',
			choice: 'asked',
		});
		expect(data.staleChoice).toBeUndefined();
		const text = JSON.stringify(data);
		for (const forbidden of ['0443', 'PADARIA', 'EXEMPLO', '5000', 'inter-pf', '|']) expect(text).not.toContain(forbidden);
	});

	it('a regra aprendida decidiu: "learned", e o lançamento automático leva o motivo dela', () => {
		const data = captureDecisionData({
			raw,
			fingerprint: 'fp',
			parsed: { amountCents: 5000, direction: 'out', kind: 'purchase', counterparty: 'PADARIA EXEMPLO', cardLast4: '0443', neutral: false, installments: null },
			outcome: {
				step: 'decided',
				decision: { action: 'auto_confirm', categoryId: 'food' },
				account: 'existing',
				captureId: 'cap-2',
				ambiguity: 'debit_unknown_last4',
				choice: 'learned',
				reason: 'learned_debit_unknown_last4',
			},
		});
		expect(data).toMatchObject({ outcome: 'confirmed', reason: 'learned_debit_unknown_last4', choice: 'learned' });
	});

	it('a regra apontava para uma conta que sumiu: perguntou de novo, com a marca', () => {
		const data = captureDecisionData({
			raw: { packageName: 'com.nu.production', appLabel: 'Nubank' },
			fingerprint: 'fp',
			parsed: { amountCents: 150000, direction: 'out', kind: 'invoice_payment', counterparty: null, cardLast4: null, neutral: true, installments: null },
			outcome: {
				step: 'decided',
				decision: { action: 'pending', categoryId: null },
				account: 'none',
				captureId: 'cap-3',
				ambiguity: 'invoice_payment',
				choice: 'asked',
				staleChoice: true,
				reason: 'ambiguous_invoice_payment',
			},
		});
		expect(data).toMatchObject({ ambiguity: 'invoice_payment', choice: 'asked', staleChoice: true, reason: 'ambiguous_invoice_payment' });
	});

	it('a direção em dúvida: o parser diz que viu as duas pistas, nunca quais palavras', () => {
		const data = captureDecisionData({
			raw: { packageName: 'com.picpay', appLabel: 'PicPay' },
			fingerprint: 'fp',
			parsed: {
				amountCents: 2000,
				direction: 'out',
				kind: 'pix_out',
				counterparty: 'Ana Exemplo',
				cardLast4: null,
				neutral: false,
				installments: null,
				ambiguousDirection: 'recebido/enviou',
			},
			outcome: {
				step: 'decided',
				decision: { action: 'pending', categoryId: 'other_expense' },
				account: 'existing',
				captureId: 'cap-4',
				ambiguity: 'pix_direction',
				choice: 'asked',
				reason: 'ambiguous_pix_direction',
			},
		});
		expect(data).toMatchObject({ directionAmbiguous: true, ambiguity: 'pix_direction' });
		const text = JSON.stringify(data);
		for (const forbidden of ['Ana', 'enviou', '2000']) expect(text).not.toContain(forbidden);
	});

	it('aviso sem dúvida nenhuma: nada novo no evento', () => {
		const data = captureDecisionData({
			raw,
			fingerprint: 'fp',
			parsed: { amountCents: 5000, direction: 'out', kind: 'purchase', counterparty: 'X', cardLast4: '5678', neutral: false, installments: null },
			outcome: { step: 'decided', decision: { action: 'pending', categoryId: 'food' }, account: 'existing', captureId: 'cap-5' },
		});
		expect(data.ambiguity).toBeUndefined();
		expect(data.choice).toBeUndefined();
		expect(data.directionAmbiguous).toBeUndefined();
		expect(data.reason).toBeNull();
	});
});
