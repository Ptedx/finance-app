import {
	extractCounterparty,
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
		});
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

	it('valor sem movimentação (limite, marketing, saldo) é descartado', () => {
		expect(
			parseCapture(raw({ title: 'Boa notícia', text: 'Seu limite subiu para R$ 5.000,00!' }))
		).toBeNull();
		expect(
			parseCapture(raw({ title: 'Oferta', text: 'Ganhe até R$ 100 de cashback nas compras.' }))
				?.kind
		).toBe('refund'); // tem "cashback": entra na caixa para o usuário decidir, nunca some sozinho
		expect(parseCapture(raw({ title: 'Saldo', text: 'Seu saldo é R$ 1.234,56' }))).toBeNull();
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
