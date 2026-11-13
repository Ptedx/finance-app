import { miraiSpans } from '../format';

const render = (text: string): string =>
	miraiSpans(text)
		.map((span) => (span.bold ? `[${span.text}]` : span.text))
		.join('');

describe('o markdown simples das respostas (SPD-180)', () => {
	it('negrito vira trecho em negrito, sem os asteriscos', () => {
		expect(render('Sobrou **R$ 242,02** este mês.')).toBe('Sobrou [R$ 242,02] este mês.');
		expect(render('__Atenção__: a fatura vence amanhã.')).toBe('[Atenção]: a fatura vence amanhã.');
	});

	it('itens de lista ganham um marcador, e o negrito dentro deles continua', () => {
		expect(render('- **Receita:** R$ 291,65\n* Gastos: R$ 49,63')).toBe(
			'•  [Receita:] R$ 291,65\n•  Gastos: R$ 49,63'
		);
	});

	it('título vira uma linha em negrito', () => {
		expect(render('## Resumo\nTudo certo.')).toBe('[Resumo\n]Tudo certo.');
	});

	it('itálico e código viram texto normal', () => {
		expect(render('Isso é *importante* e `get_bills` também, e _isto_.')).toBe(
			'Isso é importante e get_bills também, e isto.'
		);
	});

	it('o que não é marca passa como veio', () => {
		expect(render('2 * 3 = 6, e 10% a.m. (1,81% ao mês)')).toBe(
			'2 * 3 = 6, e 10% a.m. (1,81% ao mês)'
		);
		expect(render('Números 1. 2. 3. e um ** solto')).toBe('Números 1. 2. 3. e um ** solto');
		expect(render('nome_do_arquivo e snake_case_aqui')).toBe('nome_do_arquivo e snake_case_aqui');
	});

	it('linhas em branco e quebras ficam', () => {
		expect(render('A\n\nB')).toBe('A\n\nB');
		expect(miraiSpans('')).toEqual([]);
	});
});
