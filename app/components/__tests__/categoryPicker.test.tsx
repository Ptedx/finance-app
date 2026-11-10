/**
 * A categoria do lançamento (SPD-130). Era uma grade de duas colunas com ícone, que ocupava a
 * tela com as categorias padrão; agora é um campo que abre a lista, com as 4 mais usadas do
 * lado do lançamento numa seção "Mais usadas" no topo e depois todas. Sem histórico, só a
 * lista. O "Editar categorias" continua ao lado do rótulo.
 */

const mockPush = jest.fn();

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('react-native-safe-area-context', () => ({
	useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('react-i18next', () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

import { Text } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { Category, Transaction } from '../../database/schema';
import CategoryPicker from '../CategoryPicker';

jest.setTimeout(20_000);

const category = (id: string, name: string, type: 'expense' | 'income'): Category => ({
	id,
	name,
	color: '#50E3C2',
	icon: 'pricetag',
	type,
	nature: 'discretionary',
	updatedAt: '',
});

const CATEGORIES = [
	category('mercado', 'Mercado', 'expense'),
	category('restaurante', 'Restaurante', 'expense'),
	category('transporte', 'Transporte', 'expense'),
	category('casa', 'Casa', 'expense'),
	category('lazer', 'Lazer', 'expense'),
	category('salario', 'Salário', 'income'),
	category('uncategorized', 'Sem categoria', 'expense'),
];

const tx = (category: string, isIncome = false): Transaction =>
	({ id: `${category}-${Math.random()}`, category, isIncome, note: '', installmentGroup: null }) as Transaction;
const times = (count: number, entry: () => Transaction) => Array.from({ length: count }, entry);

let renderer: ReactTestRenderer;

const textOf = (node: ReactTestInstance): string => [node.props.children].flat().filter((c) => typeof c === 'string').join('');

/** A lista aberta, de cima para baixo: cabeçalhos entre colchetes, linhas pelo nome. */
const listShown = (): string[] =>
	renderer.root
		.findAll(
			(node) =>
				((node.type as unknown) === Text && node.props.accessibilityRole === 'header' && textOf(node) !== 'transactionForm.category') ||
				(node.props.accessibilityRole === 'radio' && typeof node.props.onPress === 'function')
		)
		.map((node) => (node.props.accessibilityRole === 'header' ? `[${textOf(node)}]` : node.props.accessibilityLabel));

const open = async () => {
	const [field] = renderer.root.findAll(
		(node) =>
			node.props.accessibilityRole === 'button' &&
			typeof node.props.accessibilityLabel === 'string' &&
			node.props.accessibilityLabel.startsWith('transactionForm.category, ') &&
			typeof node.props.onPress === 'function'
	);
	await act(async () => {
		field.props.onPress();
	});
};

const mount = async (props: Partial<React.ComponentProps<typeof CategoryPicker>> = {}) => {
	await act(async () => {
		renderer = create(<CategoryPicker categories={CATEGORIES} selectedCategoryId={null} onSelectCategory={jest.fn()} {...props} />);
	});
};

afterEach(() => {
	act(() => renderer.unmount());
});

describe('CategoryPicker — lista com as mais usadas', () => {
	it('fechado, ocupa uma linha: o campo com o convite, sem a grade de categorias', async () => {
		await mount();
		expect(listShown()).toEqual([]);
		const texts = renderer.root.findAll((node) => (node.type as unknown) === Text).map(textOf);
		expect(texts).toContain('transactionForm.categoryPlaceholder');
		expect(texts).not.toContain('Mercado');
	});

	it('as 4 mais usadas da despesa no topo, depois todas na ordem de sempre', async () => {
		const transactions = [
			...times(1, () => tx('mercado')),
			...times(6, () => tx('lazer')),
			...times(4, () => tx('casa')),
			...times(2, () => tx('restaurante')),
			...times(3, () => tx('transporte')),
			// Receita e "Sem categoria" não entram na conta da despesa.
			...times(9, () => tx('salario', true)),
			...times(9, () => tx('uncategorized')),
		];
		await mount({ transactions });
		await open();
		expect(listShown()).toEqual([
			'[transactionForm.categoryMostUsed]',
			'Lazer',
			'Casa',
			'Transporte',
			'Restaurante',
			'[transactionForm.categoryAll]',
			'Mercado',
			'Restaurante',
			'Transporte',
			'Casa',
			'Lazer',
		]);
	});

	it('receita: só as categorias de receita, e o topo conta só as receitas', async () => {
		await mount({ isIncome: true, transactions: [tx('salario', true), tx('mercado')] });
		await open();
		expect(listShown()).toEqual(['[transactionForm.categoryMostUsed]', 'Salário', '[transactionForm.categoryAll]', 'Salário']);
	});

	it('sem histórico, só a lista', async () => {
		await mount({ transactions: [] });
		await open();
		expect(listShown()).toEqual(['Mercado', 'Restaurante', 'Transporte', 'Casa', 'Lazer']);
	});

	it('escolher na lista avisa o formulário e fecha; "Editar categorias" continua ao lado do rótulo', async () => {
		const onSelectCategory = jest.fn();
		await mount({ onSelectCategory, transactions: [] });
		await open();
		const [row] = renderer.root.findAll((node) => node.props.accessibilityLabel === 'Casa' && typeof node.props.onPress === 'function');
		await act(async () => {
			row.props.onPress();
		});
		expect(onSelectCategory).toHaveBeenCalledWith('casa');
		expect(listShown()).toEqual([]);

		const [edit] = renderer.root.findAll(
			(node) => node.props.accessibilityLabel === 'transactionForm.editCategories' && typeof node.props.onPress === 'function'
		);
		await act(async () => {
			edit.props.onPress();
		});
		expect(mockPush).toHaveBeenCalledWith('/screens/CategoryManagementScreen');
	});
});
