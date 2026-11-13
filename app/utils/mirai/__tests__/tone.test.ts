import { readTone } from '../tone';

/**
 * A marca de tom (SPD-163, §7.1): sai do texto e escolhe a expressão do avatar. Sem marca, a
 * expressão é `normal`.
 */
describe('readTone', () => {
	it.each([
		['feliz', 'happy'],
		['neutro', 'normal'],
		['preocupado', 'worried'],
		['triste', 'sad'],
	] as const)('[tom: %s] vira %s e sai do texto', (tone, expression) => {
		expect(readTone(`Sobrou R$ 120,00 este mês.\n\n[tom: ${tone}]`)).toEqual({
			text: 'Sobrou R$ 120,00 este mês.',
			expression,
		});
	});

	it('aceita maiúsculas, espaço a mais e espaço depois da marca', () => {
		expect(readTone('A fatura fecha dia 5. [Tom:  Preocupado]  \n')).toEqual({
			text: 'A fatura fecha dia 5.',
			expression: 'worried',
		});
	});

	it('sem marca, o texto fica e a expressão é normal', () => {
		expect(readTone('Importe o extrato em Ajustes.  ')).toEqual({
			text: 'Importe o extrato em Ajustes.',
			expression: 'normal',
		});
	});

	it('marca no meio do texto não conta: só a do fim', () => {
		const raw = 'Escreva [tom: feliz] no fim, ele disse.';
		expect(readTone(raw)).toEqual({ text: raw, expression: 'normal' });
	});

	it('marca desconhecida não vira expressão', () => {
		expect(readTone('Ok. [tom: bravo]')).toEqual({
			text: 'Ok. [tom: bravo]',
			expression: 'normal',
		});
	});
});
