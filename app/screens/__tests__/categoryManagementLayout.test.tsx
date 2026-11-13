/**
 * Gerenciar categorias (SPD-121): a pilha da raiz não desenha cabeçalho, e a tela não tinha
 * voltar — chega-se a ela pelo "Editar categorias" do formulário de lançamento. Agora desenha
 * o seu, como o detalhe do lançamento (SPD-110). E o "Adicionar categoria", preso no pé da
 * tela, ficava embaixo da barra de gestos do Android: sobe com `insets.bottom`. As chaves de
 * tradução aparecem cruas.
 */

const mockBack = jest.fn();
const mockInsets = { top: 24, right: 0, bottom: 34, left: 0 };

jest.mock('expo-router', () => ({
	useRouter: () => ({ back: mockBack }),
	Stack: { Screen: () => null },
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('react-native-safe-area-context', () => {
	const { View } = require('react-native');
	return { SafeAreaView: View, useSafeAreaInsets: () => mockInsets };
});

jest.mock('react-i18next', () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock('../../components/CategoryEditorModal', () => () => null);

const mockCategories = [
	{ id: 'food', name: 'Mercado', color: '#50E3C2', icon: 'cart', type: 'expense', nature: 'essential', updatedAt: '' },
];

jest.mock('../../contexts/TransactionsContext', () => ({
	useTransactions: () => ({
		categories: mockCategories,
		transactions: [],
		addCategory: jest.fn(),
		updateCategory: jest.fn(),
		deleteCategory: jest.fn(),
	}),
}));

import { FlatList, StyleSheet } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import CategoryManagementScreen from '../CategoryManagementScreen';

jest.setTimeout(20_000);

let renderer: ReactTestRenderer;

const isHostText = (node: ReactTestInstance): boolean => (node.type as unknown) === 'Text';

const render = async () => {
	await act(async () => {
		renderer = create(<CategoryManagementScreen />);
	});
};

const headerTitles = (): string[] =>
	renderer.root
		.findAll((node) => isHostText(node) && node.props.accessibilityRole === 'header')
		.map((node) => [node.props.children].flat().join(''));

const pressable = (label: string): ReactTestInstance | undefined =>
	renderer.root.findAll((node) => node.props.accessibilityLabel === label && typeof node.props.onPress === 'function')[0];

/** O espaço embaixo do "Adicionar categoria", somado em quem o envolve. */
const paddingBelowAdd = (): number => {
	const text = renderer.root.find((node) => isHostText(node) && node.props.children === 'categoryManagement.add');
	let total = 0;
	for (let up = text.parent; up; up = up.parent) {
		if (typeof up.type !== 'string') continue;
		const style = StyleSheet.flatten(up.props.style) ?? {};
		if (style.position === 'absolute') {
			total += Number(style.paddingBottom ?? style.paddingVertical ?? style.padding ?? 0);
			return total + Number(style.bottom ?? 0);
		}
	}
	throw new Error('o botão não está preso no pé da tela');
};

beforeEach(() => {
	mockBack.mockClear();
	mockInsets.bottom = 34;
});

afterEach(() => {
	act(() => renderer.unmount());
});

it('tem cabeçalho com o título e a seta de voltar, que volta para o formulário', async () => {
	await render();

	expect(headerTitles()).toEqual(['categoryManagement.title']);
	const back = pressable('categoryManagement.back');
	expect(back?.props.accessibilityRole).toBe('button');
	await act(async () => {
		back?.props.onPress();
	});
	expect(mockBack).toHaveBeenCalledTimes(1);
});

it('o topo fica por conta da área segura, sem os 60 fixos', async () => {
	await render();

	const safeArea = renderer.root.find((node) => Array.isArray(node.props.edges));
	expect(safeArea.props.edges).toEqual(['top', 'left', 'right']);
	expect(Number(StyleSheet.flatten(safeArea.props.style)?.paddingTop ?? 0)).toBe(0);
});

it.each([0, 34, 48])('"Adicionar categoria" fica acima da barra de gestos (%i pontos), e a lista rola até passar dele', async (bottom) => {
	mockInsets.bottom = bottom;
	await render();

	expect(paddingBelowAdd()).toBe(bottom + 16);
	const list = renderer.root.find((node) => (node.type as unknown) === FlatList);
	expect(Number(StyleSheet.flatten(list.props.contentContainerStyle)?.paddingBottom)).toBe(bottom + 80);
});
