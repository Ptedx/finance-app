import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	extractCounterparty,
	FOREIGN_CURRENCY_CODES,
	guessCategory,
	merchantKeyOf,
	parseCapture,
	parseNotificationAmount,
	type RawCapture,
} from '../captureParser';

const raw = (overrides: Partial<RawCapture>): RawCapture => ({
	packageName: 'com.nu.production',
	appLabel: 'Nubank',
	title: '',
	text: '',
	postedAt: '2026-09-14T15:04:00.000Z',
	...overrides,
});

describe('parseNotificationAmount', () => {
	it.each([
		['35,90', 3590],
		['1.234,56', 123456],
		['1,234.56', 123456],
		['1.200', 120000], // ponto como milhar
		['1,200', 120000], // vírgula como milhar quando há três dígitos depois
		['12,5', 1250],
		['35', 3500],
		['0,99', 99],
		['1.234.567,89', 123456789],
	])('%s → %d centavos', (input, cents) => {
		expect(parseNotificationAmount(input)).toBe(cents);
	});

	it('recusa zero e lixo', () => {
		expect(parseNotificationAmount('0,00')).toBeNull();
		expect(parseNotificationAmount('abc')).toBeNull();
	});
});

describe('parseCapture — compras no cartão', () => {
	it('Nubank: compra aprovada com estabelecimento e final do cartão', () => {
		const parsed = parseCapture(
			raw({
				title: 'Compra aprovada',
				text: 'Compra de R$ 35,90 APROVADA em IFOOD *IFOOD para o cartão com final 1234.',
			})
		);
		expect(parsed).toEqual({
			amountCents: 3590,
			direction: 'out',
			kind: 'purchase',
			counterparty: 'IFOOD *IFOOD',
			cardLast4: '1234',
			neutral: false,
			installments: null,
		});
	});

	it('compra parcelada: "em 3x" registra o total, "3x de R$" multiplica a parcela', () => {
		const total = parseCapture(
			raw({ title: 'Compra aprovada', text: 'Compra de R$ 300,00 em 3x APROVADA em MAGAZINE LUIZA para o cartão com final 1234.' })
		);
		expect(total).toMatchObject({ amountCents: 30000, installments: 3, counterparty: 'MAGAZINE LUIZA' });

		const perParcel = parseCapture(
			raw({ title: 'Compra aprovada', text: 'Compra parcelada em 3x de R$ 100,00 APROVADA em MAGAZINE LUIZA.' })
		);
		expect(perParcel).toMatchObject({ amountCents: 30000, installments: 3 });

		const single = parseCapture(
			raw({ title: 'Compra aprovada', text: 'Compra de R$ 50,00 em 1x APROVADA em PADARIA.' })
		);
		expect(single).toMatchObject({ amountCents: 5000, installments: null });
	});

	it('Samsung Pay: pagamento aprovado', () => {
		const parsed = parseCapture(
			raw({
				packageName: 'com.samsung.android.spay',
				appLabel: 'Samsung Wallet',
				title: 'Pagamento aprovado',
				text: 'R$ 35,90 em SUPERMERCADO BOM PRECO com Nubank final 1234',
			})
		);
		expect(parsed?.amountCents).toBe(3590);
		expect(parsed?.direction).toBe('out');
		expect(parsed?.kind).toBe('purchase');
		expect(parsed?.counterparty).toBe('SUPERMERCADO BOM PRECO');
	});

	it('Inter: compra aprovada com valor depois do estabelecimento', () => {
		const parsed = parseCapture(
			raw({
				packageName: 'br.com.intermedium',
				title: 'Compra aprovada',
				text: 'Compra aprovada no cartão final 5678: R$ 1.250,00 em MAGAZINE LUIZA',
			})
		);
		expect(parsed?.amountCents).toBe(125000);
		expect(parsed?.counterparty).toBe('MAGAZINE LUIZA');
		expect(parsed?.cardLast4).toBe('5678');
	});

	it('Itaú: compra com separador de traço', () => {
		const parsed = parseCapture(
			raw({
				packageName: 'com.itau',
				title: 'Itaú',
				text: 'Compra aprovada: R$ 89,90 - POSTO SHELL, cartão final 9012.',
			})
		);
		expect(parsed?.amountCents).toBe(8990);
		expect(parsed?.counterparty).toBe('POSTO SHELL');
	});

	it('só o primeiro valor conta: o limite disponível não vira compra', () => {
		const parsed = parseCapture(
			raw({
				title: 'Compra aprovada',
				text: 'Compra de R$ 20,00 aprovada em PADARIA CENTRAL. Limite disponível: R$ 1.980,00',
			})
		);
		expect(parsed?.amountCents).toBe(2000);
		expect(parsed?.counterparty).toBe('PADARIA CENTRAL');
	});
});

describe('parseCapture — Pix e transferências', () => {
	it('Pix recebido tem direção de entrada e o nome de quem mandou', () => {
		const parsed = parseCapture(
			raw({
				title: 'Você recebeu um Pix',
				text: 'Você recebeu um Pix de R$ 150,00 de Maria Aparecida Souza.',
			})
		);
		expect(parsed?.direction).toBe('in');
		expect(parsed?.kind).toBe('pix_in');
		expect(parsed?.amountCents).toBe(15000);
		expect(parsed?.counterparty).toBe('Maria Aparecida Souza');
	});

	it('Pix enviado tem direção de saída e o destinatário', () => {
		const parsed = parseCapture(
			raw({
				title: 'Pix enviado',
				text: 'Você enviou R$ 500,00 para Vinicius Costa via Pix.',
			})
		);
		expect(parsed?.direction).toBe('out');
		expect(parsed?.kind).toBe('pix_out');
		expect(parsed?.counterparty).toBe('Vinicius Costa');
	});

	it('transferência recebida', () => {
		const parsed = parseCapture(
			raw({
				packageName: 'br.com.intermedium',
				title: 'Transferência recebida',
				text: 'Transferência recebida de VINICIUS COSTA no valor de R$ 500,00',
			})
		);
		expect(parsed?.direction).toBe('in');
		expect(parsed?.kind).toBe('transfer_in');
		expect(parsed?.counterparty).toBe('VINICIUS COSTA');
	});
});

describe('parseCapture — o que não deve virar lançamento', () => {
	it('pagamento da fatura é neutro: as compras já entraram uma a uma', () => {
		const parsed = parseCapture(
			raw({ title: 'Fatura paga', text: 'Pagamento da fatura de R$ 2.345,67 confirmado.' })
		);
		expect(parsed?.neutral).toBe(true);
		expect(parsed?.kind).toBe('invoice_payment');
	});

	it('confirmações de pagamento da fatura, nos jeitos que os bancos escrevem, são pagamento', () => {
		for (const [title, text] of [
			['Pagamento recebido', 'Recebemos o pagamento de R$ 3.832,80 da sua fatura.'],
			['Nubank', 'Você pagou R$ 3.832,80 da fatura do cartão.'],
			['Fatura', 'Pagamento de R$ 500,00 realizado na fatura com vencimento em 02/10.'],
		]) {
			const parsed = parseCapture(raw({ title, text }));
			expect({ text, kind: parsed?.kind, neutral: parsed?.neutral }).toEqual({ text, kind: 'invoice_payment', neutral: true });
		}
	});

	it('aviso de fatura fechada, vencendo ou disponível não é pagamento nem compra', () => {
		for (const [title, text] of [
			['Sua fatura fechou', 'A fatura do cartão fechou em R$ 3.832,80. O pagamento vence em 02/10.'],
			['Fatura disponível', 'Sua fatura de R$ 3.832,80 está disponível. Vencimento: 02/10.'],
			['Lembrete', 'Sua fatura de R$ 3.832,80 vence amanhã. Faça o pagamento para evitar juros.'],
		]) {
			expect({ text, parsed: parseCapture(raw({ title, text })) }).toEqual({ text, parsed: null });
		}
	});

	it('aplicação e resgate são neutros', () => {
		expect(
			parseCapture(raw({ title: 'Aplicação realizada', text: 'Aplicação de R$ 1.000,00 no CDB.' }))
				?.neutral
		).toBe(true);
		expect(
			parseCapture(raw({ title: 'Resgate', text: 'Resgate de R$ 300,00 concluído.' }))?.kind
		).toBe('investment');
	});

	it('estorno é entrada, não compra, mesmo com a palavra compra no texto', () => {
		const parsed = parseCapture(
			raw({ title: 'Estorno', text: 'Estorno de compra de R$ 35,90 em IFOOD creditado.' })
		);
		expect(parsed?.direction).toBe('in');
		expect(parsed?.kind).toBe('refund');
	});

	// "Não aprovada" contém "aprovada": enquanto a palavra de confirmação ganhava, a compra
	// que não aconteceu virava gasto. Recusada é o mesmo que um aviso de limite: descarta.
	it.each([
		['Compra não aprovada', 'Compra de R$ 349,90 não aprovada em LOJA ONLINE. Saldo insuficiente.'],
		['Compra nao aprovada', 'Compra de R$ 349,90 nao aprovada em LOJA ONLINE.'],
		['Compra recusada', 'Sua compra de R$ 120,00 em POSTO SHELL foi recusada.'],
		['Compra negada', 'Compra de R$ 349,90 negada em LOJA ONLINE.'],
		['Compra não autorizada', 'Compra de R$ 349,90 não autorizada em LOJA ONLINE.'],
		['Compra nao autorizada', 'Compra de R$ 349,90 nao autorizada em LOJA ONLINE.'],
		['Compra RECUSADA', 'Compra de R$ 349,90 RECUSADA em LOJA ONLINE.'],
		['Pix não autorizado', 'Seu Pix de R$ 80,00 para MARIA não foi autorizado.'],
	])('compra ou Pix recusado é descartado: %s', (title, text) => {
		expect(parseCapture(raw({ title, text }))).toBeNull();
	});

	it('compra aprovada que só menciona "não autorizada" no rodapé continua sendo compra', () => {
		const parsed = parseCapture(
			raw({
				title: 'Compra aprovada',
				text: 'Compra de R$ 50,00 APROVADA em PADARIA. Compra não autorizada? Bloqueie o cartão no app.',
			})
		);
		expect(parsed).toMatchObject({ amountCents: 5000, direction: 'out', kind: 'purchase' });
	});

	// Agendado ainda não saiu: lançar agora é gasto que talvez nunca aconteça.
	it.each([
		['Pix agendado', 'Seu Pix agendado de R$ 300,00 para JOAO DA SILVA será enviado em 30/10.'],
		['Pagamento agendado', 'Pagamento de R$ 450,00 agendado para 30/10.'],
		['Pix agendado com sucesso', 'Pix de R$ 300,00 para JOAO DA SILVA agendado com sucesso para 30/10.'],
	])('Pix ou pagamento agendado é descartado: %s', (title, text) => {
		expect(parseCapture(raw({ packageName: 'br.com.intermedium', title, text }))).toBeNull();
	});

	it('agendado que já saiu, ou Pix agendado que chegou, continua valendo', () => {
		expect(
			parseCapture(
				raw({ title: 'Pix enviado', text: 'Seu Pix agendado de R$ 300,00 para JOAO DA SILVA foi enviado.' })
			)
		).toMatchObject({ direction: 'out', kind: 'pix_out', amountCents: 30000 });
		expect(
			parseCapture(
				raw({ title: 'Pix recebido', text: 'Você recebeu um Pix agendado de R$ 100,00 de Maria Souza.' })
			)
		).toMatchObject({ direction: 'in', kind: 'pix_in', amountCents: 10000 });
	});

	// Compra cancelada é dinheiro voltando, como o estorno — não um segundo gasto.
	it('compra cancelada é estorno (entrada), do mesmo tipo dos estornos', () => {
		const cancelled = parseCapture(
			raw({ title: 'Compra cancelada', text: 'A compra de R$ 59,90 em LOJA X foi cancelada.' })
		);
		const refunded = parseCapture(
			raw({ title: 'Estorno', text: 'Estorno de compra de R$ 35,90 em IFOOD creditado.' })
		);
		expect(cancelled).toMatchObject({ amountCents: 5990, direction: 'in', kind: 'refund', neutral: false });
		expect(cancelled?.kind).toBe(refunded?.kind);
		expect(cancelled?.direction).toBe(refunded?.direction);
		expect(
			parseCapture(raw({ title: 'Estorno', text: 'Estorno de compra cancelada de R$ 35,90 em IFOOD.' }))
		).toMatchObject({ direction: 'in', kind: 'refund' });
	});

	it('valor sem movimentação (limite, marketing, saldo) é descartado', () => {
		expect(
			parseCapture(raw({ title: 'Boa notícia', text: 'Seu limite subiu para R$ 5.000,00!' }))
		).toBeNull();
		expect(
			parseCapture(raw({ title: 'Oferta', text: 'Ganhe até R$ 100 de cashback nas compras.' }))
		).toBeNull();
		expect(parseCapture(raw({ title: 'Saldo', text: 'Seu saldo é R$ 1.234,56' }))).toBeNull();
	});

	// Caso real (Mercado Pago): tem "resgate" e "R$ 1", e é propaganda. Chegou a virar
	// item "ignorado como investimento" na caixa de entrada; agora nem entra.
	it('propaganda de investimento com valor no texto não é movimentação', () => {
		expect(
			parseCapture(
				raw({
					packageName: 'com.mercadopago.wallet',
					title: 'Vinícius,  seu dinheiro pode render mais!🔥🤑',
					text: 'Invista a partir de R$ 1 no CDB de liquidez diária e resgate seu dinheiro quando quiser!💸',
				})
			)
		).toBeNull();
	});

	it('um aviso real com chamariz no fim continua sendo aviso', () => {
		const parsed = parseCapture(
			raw({
				title: 'Compra aprovada',
				text: 'Compra de R$ 40,00 APROVADA em MERCADO XYZ. Aproveite: invista seu troco!',
			})
		);
		expect(parsed?.kind).toBe('purchase');
		expect(parsed?.counterparty).toBe('MERCADO XYZ');
	});

	it('resgate e aplicação só contam quando foram feitos', () => {
		expect(parseCapture(raw({ title: 'Resgate realizado', text: 'Resgate de R$ 300,00 na sua conta.' }))?.kind).toBe(
			'investment'
		);
		expect(parseCapture(raw({ title: 'Aplicação', text: 'Aplicação realizada: R$ 200,00 no RDB.' }))?.kind).toBe(
			'investment'
		);
	});

	// A direção é o que diz de que lado da conta o dinheiro saiu ou entrou. Os dois eram
	// "saída", e aí o resgate de R$ 5.000 debitava a conta corrente em vez de creditá-la
	// (achado 7.2, agora que o investimento vira transferência).
	it('aplicação sai da conta; resgate entra nela', () => {
		expect(
			parseCapture(raw({ title: 'Aplicação realizada', text: 'Aplicação de R$ 5.000,00 realizada com sucesso.' }))
				?.direction
		).toBe('out');
		expect(parseCapture(raw({ title: 'Resgate', text: 'Resgate de R$ 5.000,00 concluído.' }))?.direction).toBe('in');
		expect(
			parseCapture(raw({ title: 'Resgate realizado', text: 'Resgate realizado: R$ 300,00 na sua conta.' }))?.direction
		).toBe('in');
	});
});

describe('parseCapture — casos reais do aparelho', () => {
	it('Inter: "no débito no BGC BRASILIA o valor de"', () => {
		const parsed = parseCapture(
			raw({
				packageName: 'br.com.intermedium',
				appLabel: 'Inter',
				title: 'Inter',
				text: 'Olá Vinicius, você acaba de comprar no débito no BGC BRASILIA GUARA CEN o valor de R$ 63,80.',
			})
		);
		expect(parsed).toMatchObject({ amountCents: 6380, direction: 'out', kind: 'purchase' });
		expect(parsed?.counterparty).toBe('BGC BRASILIA GUARA CEN');
	});

	it('Nubank: estabelecimento com ponto no nome (APPLE.COM/BILL)', () => {
		const parsed = parseCapture(
			raw({
				title: 'Compra no crédito aprovada',
				text: 'Compra de R$ 5,90 APROVADA em APPLE.COM/BILL para o cartão com final 6422.',
			})
		);
		expect(parsed?.counterparty).toBe('APPLE.COM/BILL');
		expect(parsed?.cardLast4).toBe('6422');
		expect(merchantKeyOf(parsed?.counterparty ?? null)).toBe('apple com bill');
	});

	it('Nubank: Google YouTubePremium', () => {
		const parsed = parseCapture(
			raw({
				title: 'Compra no crédito aprovada',
				text: 'Compra de R$ 26,90 APROVADA em Google YouTubePremium para o cartão com final 2513.',
			})
		);
		expect(parsed?.counterparty).toBe('Google YouTubePremium');
		expect(guessCategory({ direction: 'out', kind: 'purchase', counterparty: parsed?.counterparty ?? null })).toBe(
			'entertainment'
		);
	});

	it('sem valor não há lançamento', () => {
		expect(parseCapture(raw({ title: 'Compra aprovada', text: 'Compra aprovada em LOJA.' }))).toBeNull();
	});
});

describe('extractCounterparty', () => {
	it('não confunde o "de R$" do valor com o "de Fulano" da pessoa', () => {
		expect(
			extractCounterparty('Você recebeu uma transferência de R$ 100,00 de João Silva.', 'in')
		).toBe('João Silva');
	});

	it('para na preposição seguinte', () => {
		expect(
			extractCounterparty('Compra de R$ 10,00 aprovada em UBER *TRIP para o cartão final 1', 'out')
		).toBe('UBER *TRIP');
	});
});

describe('merchantKeyOf', () => {
	it('junta variações do mesmo estabelecimento na mesma chave', () => {
		expect(merchantKeyOf('IFOOD *IFOOD BR')).toBe('ifood');
		expect(merchantKeyOf('IFD*IFOOD')).toBe('ifood');
		expect(merchantKeyOf('Ifood')).toBe('ifood');
		expect(merchantKeyOf('PAG*SupermercadoBom')).toBe('supermercadobom');
		expect(merchantKeyOf('UBER *TRIP 1234')).toBe('uber');
	});

	it('limita a três palavras e ignora vazio', () => {
		expect(merchantKeyOf('Posto Shell Avenida Central Ltda')).toBe('posto shell avenida');
		expect(merchantKeyOf('***')).toBeNull();
		expect(merchantKeyOf(null)).toBeNull();
	});
});

describe('guessCategory', () => {
	it('acerta o comum e prefere "outros" ao resto', () => {
		expect(guessCategory({ direction: 'out', kind: 'purchase', counterparty: 'IFOOD *IFOOD' })).toBe('food');
		expect(guessCategory({ direction: 'out', kind: 'purchase', counterparty: 'POSTO SHELL' })).toBe('transport');
		expect(guessCategory({ direction: 'out', kind: 'purchase', counterparty: 'DROGASIL' })).toBe('health');
		expect(guessCategory({ direction: 'out', kind: 'purchase', counterparty: 'LOJA DESCONHECIDA' })).toBe('other_expense');
	});

	it('entradas vão para receita, estorno para reembolso', () => {
		expect(guessCategory({ direction: 'in', kind: 'pix_in', counterparty: 'Maria' })).toBe('other_income');
		expect(guessCategory({ direction: 'in', kind: 'refund', counterparty: 'IFOOD' })).toBe('refund');
	});

	it('palavras curtas exigem fronteira: "oi" não casa com "goiânia"', () => {
		expect(guessCategory({ direction: 'out', kind: 'purchase', counterparty: 'RESTAURANTE GOIANIA' })).toBe('food');
	});
});

describe('chamariz no fim do aviso não descarta o aviso', () => {
	const raw = (text: string) => ({
		packageName: 'br.com.intermedium',
		appLabel: 'Inter',
		title: 'Inter',
		text,
		postedAt: '2026-10-11T12:00:00.000Z',
	});

	it('Pix enviado com "Toque para ver o comprovante" é um gasto, não propaganda', () => {
		const parsed = parseCapture(raw('Pix enviado: R$ 1.200,00 para JOAO SILVA. Toque para ver o comprovante.'));

		expect(parsed).not.toBeNull();
		expect(parsed?.amountCents).toBe(120000);
		expect(parsed?.direction).toBe('out');
	});

	it('compra no débito com "Toque para ver detalhes" também passa', () => {
		const parsed = parseCapture(raw('Compra no debito de R$ 26,47 no ATACADAO. Toque para ver detalhes.'));

		expect(parsed?.amountCents).toBe(2647);
		expect(parsed?.direction).toBe('out');
	});

	it('débito de assinatura com "Clique para gerenciar" também passa', () => {
		expect(parseCapture(raw('Debito de R$ 89,90 - NETFLIX. Clique para gerenciar sua assinatura.'))?.amountCents).toBe(8990);
	});

	it('propaganda continua sendo descartada, com chamariz ou sem', () => {
		expect(parseCapture(raw('Invista a partir de R$ 1 no CDB e resgate quando quiser! Toque para saber mais.'))).toBeNull();
		expect(parseCapture(raw('Ganhe até R$ 100 de cashback no seu próximo mês. Saiba mais.'))).toBeNull();
		expect(parseCapture(raw('Simule seu empréstimo de até R$ 20.000. Clique aqui.'))).toBeNull();
	});
});

// Convite, cupom, "ganhe", "aproveite": o banco fala com o usuário, mas não mexeu no dinheiro
// dele. "Você recebeu um cupom" tem "você recebeu", e enquanto a palavra de confirmação
// salvava qualquer propaganda, o cupom virava receita para revisar (NOTIF-09).
describe('promoção forte não é salva por palavra de confirmação', () => {
	it.each([
		['Inter Loop', 'Aproveite: compras aprovadas no crédito ganham cashback de até R$ 50,00!'],
		['Indique amigos', 'Você recebeu um convite! Ganhe R$ 20,00 para cada amigo indicado.'],
		['Inter Shop', 'Você recebeu um cupom de R$ 15,00 de desconto para usar hoje.'],
		['Parabéns', 'Você ganhou um cupom de R$ 30,00, aprovado para a sua próxima compra.'],
		['Cashback', 'Ganhe R$ 10,00 de cashback creditado na sua conta na primeira compra.'],
		['Cashback', 'Receba até R$ 50,00 de cashback: compras aprovadas entram na sua conta. Aproveite!'],
		['Indique e ganhe', 'Seu amigo foi aprovado! Indique mais amigos e receba R$ 20,00 por indicação.'],
	])('descarta: %s — %s', (title, text) => {
		expect(parseCapture(raw({ title, text }))).toBeNull();
	});

	it('cashback que caiu na conta continua sendo entrada, mesmo com propaganda junto', () => {
		expect(
			parseCapture(
				raw({ title: 'Cashback', text: 'Você recebeu R$ 2,35 de cashback na sua conta. Aproveite e ganhe mais no Inter Shop!' })
			)
		).toMatchObject({ amountCents: 235, direction: 'in', kind: 'refund' });
		expect(
			parseCapture(raw({ title: 'Cashback', text: 'Cashback de R$ 5,00 creditado na sua conta. Aproveite!' }))
		).toMatchObject({ amountCents: 500, direction: 'in', kind: 'refund' });
		expect(
			parseCapture(raw({ title: 'Cashback', text: 'Seu cashback de R$ 12,40 caiu na sua conta. Aproveite!' }))
		).toMatchObject({ amountCents: 1240, direction: 'in', kind: 'refund' });
		// Sem propaganda nenhuma, o aviso curto de cashback segue sendo entrada, como antes.
		expect(parseCapture(raw({ title: 'Cashback', text: 'Cashback de R$ 5,00 do Inter Shop.' }))).toMatchObject({
			amountCents: 500,
			direction: 'in',
			kind: 'refund',
		});
	});

	it('cashback prometido ou futuro não é cashback creditado', () => {
		expect(
			parseCapture(raw({ title: 'Cashback', text: 'Seu cashback de R$ 12,40 será creditado em até 30 dias. Aproveite!' }))
		).toBeNull();
	});

	it('movimento real com propaganda forte no rodapé não é descartado', () => {
		expect(
			parseCapture(
				raw({ title: 'Pix enviado', text: 'Pix enviado: R$ 80,00 para MARIA OLIVEIRA. Aproveite e indique o Inter para seus amigos!' })
			)
		).toMatchObject({ amountCents: 8000, direction: 'out', kind: 'pix_out' });
		expect(
			parseCapture(
				raw({
					title: 'Compra aprovada',
					text: 'Compra de R$ 120,00 APROVADA em LOJA X com cupom de desconto para o cartão com final 1534.',
				})
			)
		).toMatchObject({ amountCents: 12000, direction: 'out', kind: 'purchase', cardLast4: '1534' });
		expect(
			parseCapture(
				raw({ title: 'Pix recebido', text: 'Você recebeu um Pix de R$ 50,00 de JOSE SANTOS. Indique o Nubank e ganhe!' })
			)
		).toMatchObject({ amountCents: 5000, direction: 'in', kind: 'pix_in' });
	});

	// A palavra "cashback" solta decidia que era estorno: o gasto com propaganda de cashback
	// no fim virava dinheiro entrando.
	it('gasto com propaganda de cashback no rodapé continua gasto', () => {
		expect(
			parseCapture(raw({ title: 'Pagamento aprovado', text: 'Você pagou R$ 32,50 para LOJA DO ZE. Ganhe cashback na próxima!' }))
		).toMatchObject({ amountCents: 3250, direction: 'out', kind: 'purchase' });
		expect(
			parseCapture(raw({ title: 'Compra aprovada', text: 'Compra de R$ 35,90 APROVADA em IFOOD. Aproveite seu cashback!' }))
		).toMatchObject({ amountCents: 3590, direction: 'out', kind: 'purchase' });
	});
});

// "US$ 15,99" virava R$ 15,99, e "USD 15,99" nem chegava ao app (NOTIF-04). O número de
// outra moeda não é real: quando o aviso traz o valor em reais, é ele que vale; quando não
// traz, a captura sai marcada com a moeda original.
describe('moeda estrangeira não vira real', () => {
	const NATIVE_SERVICE = path.join(
		__dirname,
		'../../../modules/spendr-captures/android/src/main/java/expo/modules/spendrcaptures/CaptureListenerService.kt'
	);

	/** O filtro do serviço nativo, lido do próprio Kotlin para os dois não divergirem. */
	const nativeFilter = (): RegExp => {
		const match = /val AMOUNT\s*=\s*Regex\("""(.+?)"""\)/.exec(fs.readFileSync(NATIVE_SERVICE, 'utf8'));
		if (!match) throw new Error('filtro do serviço nativo não encontrado');
		return new RegExp(match[1]);
	};

	const purchase = (text: string) => parseCapture(raw({ title: 'Compra no crédito aprovada', text }));

	it('só o valor em dólar: fica o número, marcado como dólar', () => {
		const parsed = purchase('Compra de US$ 15,99 APROVADA em NETFLIX.COM para o cartão com final 1534.');
		expect(parsed).toMatchObject({
			amountCents: 1599,
			kind: 'purchase',
			direction: 'out',
			cardLast4: '1534',
			foreign: { currency: 'USD', amountCents: 1599, inBrl: false },
		});
	});

	it.each([
		['USD 15,99', 'USD', 1599],
		['USD15,99', 'USD', 1599],
		['U$ 15,99', 'USD', 1599],
		['€ 20,00', 'EUR', 2000],
		['EUR 20,00', 'EUR', 2000],
		['£ 8,50', 'GBP', 850],
		['$ 15.99', '$', 1599],
	])('"%s" é %s', (amount, currency, cents) => {
		expect(purchase(`Compra de ${amount} APROVADA em NETFLIX.COM para o cartão com final 1534.`)?.foreign).toEqual({
			currency,
			amountCents: cents,
			inBrl: false,
		});
	});

	it.each([
		['Compra de US$ 15,99 (R$ 87,10) APROVADA em NETFLIX.COM para o cartão com final 1534.', 'USD', 1599],
		['Compra de US$ 15,99 (aprox. R$ 87,10) APROVADA em NETFLIX.COM.', 'USD', 1599],
		['Compra internacional de € 16,00, equivalente a R$ 87,10, aprovada em SPOTIFY.', 'EUR', 1600],
		['Compra de USD 15,99 = R$ 87,10 aprovada em NETFLIX.COM.', 'USD', 1599],
		['Compra de R$ 87,10 (US$ 15,99) APROVADA em NETFLIX.COM.', 'USD', 1599],
	])('com o valor em reais junto, vale o valor em reais: %s', (text, currency, foreignCents) => {
		const parsed = purchase(text);
		expect(parsed?.amountCents).toBe(8710);
		expect(parsed?.foreign).toEqual({ currency, amountCents: foreignCents, inBrl: true });
	});

	it('valor em reais que não é a conversão (limite, cotação, IOF) não substitui o valor', () => {
		for (const text of [
			'Compra de US$ 15,99 APROVADA em NETFLIX.COM. Limite disponível R$ 1.200,00.',
			'Compra de US$ 15,99 (cotação R$ 5,45) APROVADA em NETFLIX.COM.',
			'Compra de US$ 15,99 + IOF R$ 0,56 APROVADA em NETFLIX.COM.',
		]) {
			expect(purchase(text)).toMatchObject({ amountCents: 1599, foreign: { currency: 'USD', inBrl: false } });
		}
	});

	it('parcelada em dólar: o total e a moeda batem', () => {
		expect(purchase('Compra parcelada em 10x de US$ 12,00 APROVADA em LOJA.')).toMatchObject({
			amountCents: 12000,
			installments: 10,
			foreign: { currency: 'USD', amountCents: 12000, inBrl: false },
		});
	});

	it('o código da moeda não vira estabelecimento nem pessoa', () => {
		expect(purchase('Compra aprovada: USD 9,99 - SPOTIFY, cartão final 9012.')?.counterparty).toBe('SPOTIFY');
		expect(
			parseCapture(raw({ title: 'Transferência recebida', text: 'Você recebeu uma transferência de USD 100,00 de JOHN SMITH.' }))
				?.counterparty
		).toBe('JOHN SMITH');
	});

	it('compra em reais não tem moeda estrangeira', () => {
		expect(purchase('Compra de R$ 35,90 APROVADA em IFOOD para o cartão com final 1534.')?.foreign).toBeUndefined();
		expect(
			purchase('Compra de R$ 35,90 APROVADA em IFOOD. Limite disponível US$ 1.200,00.')?.foreign
		).toBeUndefined();
	});

	it('todo aviso de valor que o parser lê passa no filtro do serviço nativo', () => {
		const filter = nativeFilter();
		const texts = [
			'Compra de R$ 35,90 APROVADA em IFOOD.',
			'Compra de US$ 15,99 APROVADA em NETFLIX.COM.',
			'Compra de U$ 15,99 APROVADA em NETFLIX.COM.',
			'Compra de € 20,00 APROVADA em SPOTIFY.',
			'Compra de £ 8,50 APROVADA em BBC.',
			...FOREIGN_CURRENCY_CODES.map((code) => `Compra de ${code} 12,00 APROVADA em LOJA.`),
			...FOREIGN_CURRENCY_CODES.map((code) => `Compra de ${code}12,00 APROVADA em LOJA.`),
		];
		for (const text of texts) {
			expect({ text, parsed: purchase(text) !== null }).toEqual({ text, parsed: true });
			expect({ text, native: filter.test(text) }).toEqual({ text, native: true });
		}
		for (const code of FOREIGN_CURRENCY_CODES) {
			expect(purchase(`Compra de ${code} 12,00 APROVADA em LOJA.`)?.foreign?.currency).toBe(code);
		}
	});
});
