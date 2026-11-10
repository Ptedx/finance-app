import { CARD_ADJUSTMENT_NOTE } from '../cardMath';
import { mostUsedCategoryIds } from '../categoryUsage';

/**
 * "Mais usadas" no topo da lista de categorias do lançamento (SPD-130).
 *
 * As 4 categorias com mais lançamentos do mesmo lado (despesa ou receita), da mais usada
 * para a menos; empate na ordem da lista; parcelado conta uma vez; o ajuste da fatura não
 * conta; sem histórico, nada.
 */

type Entry = { category: string; isIncome: boolean; note: string; installmentGroup: string | null };

const expense = (category: string, overrides: Partial<Entry> = {}): Entry => ({
	category,
	isIncome: false,
	note: '',
	installmentGroup: null,
	...overrides,
});
const income = (category: string): Entry => ({ ...expense(category), isIncome: true });
const times = (count: number, entry: Entry): Entry[] => Array.from({ length: count }, () => entry);

const EXPENSES = ['mercado', 'restaurante', 'transporte', 'casa', 'saude', 'lazer'].map((id) => ({ id }));
const INCOMES = ['salario', 'freela'].map((id) => ({ id }));

describe('mostUsedCategoryIds', () => {
	it('as 4 com mais lançamentos, da mais usada para a menos', () => {
		const transactions = [
			...times(2, expense('casa')),
			...times(7, expense('mercado')),
			...times(1, expense('lazer')),
			...times(5, expense('restaurante')),
			...times(3, expense('transporte')),
		];
		expect(mostUsedCategoryIds(transactions, EXPENSES, false)).toEqual(['mercado', 'restaurante', 'transporte', 'casa']);
	});

	it('empate fica na ordem da lista, não na ordem dos lançamentos', () => {
		const transactions = [expense('lazer'), expense('saude'), expense('casa'), expense('transporte'), expense('restaurante')];
		expect(mostUsedCategoryIds(transactions, EXPENSES, false)).toEqual(['restaurante', 'transporte', 'casa', 'saude']);
		// A mesma resposta com os lançamentos em outra ordem.
		expect(mostUsedCategoryIds([...transactions].reverse(), EXPENSES, false)).toEqual([
			'restaurante',
			'transporte',
			'casa',
			'saude',
		]);
	});

	it('só conta o lado pedido: receita não puxa categoria de despesa e vice-versa', () => {
		const transactions = [...times(3, income('salario')), income('freela'), ...times(2, expense('mercado'))];
		expect(mostUsedCategoryIds(transactions, INCOMES, true)).toEqual(['salario', 'freela']);
		expect(mostUsedCategoryIds(transactions, EXPENSES, false)).toEqual(['mercado']);
	});

	it('categoria fora da lista (Sem categoria, apagada) não entra', () => {
		const transactions = [...times(9, expense('uncategorized')), ...times(4, expense('apagada')), expense('casa')];
		expect(mostUsedCategoryIds(transactions, EXPENSES, false)).toEqual(['casa']);
	});

	it('compra parcelada conta uma vez; o ajuste com a fatura do banco não conta', () => {
		const transactions = [
			// 12x do celular: uma escolha de "casa".
			...times(12, expense('casa', { installmentGroup: 'celular' })),
			...times(3, expense('mercado')),
			...times(2, expense('lazer')),
			...times(5, expense('saude', { note: CARD_ADJUSTMENT_NOTE })),
		];
		expect(mostUsedCategoryIds(transactions, EXPENSES, false)).toEqual(['mercado', 'lazer', 'casa']);
	});

	it('sem histórico, lista vazia', () => {
		expect(mostUsedCategoryIds([], EXPENSES, false)).toEqual([]);
	});

	it('o limite muda quantas voltam', () => {
		const transactions = [...times(3, expense('mercado')), ...times(2, expense('casa')), expense('lazer')];
		expect(mostUsedCategoryIds(transactions, EXPENSES, false, 2)).toEqual(['mercado', 'casa']);
	});
});
