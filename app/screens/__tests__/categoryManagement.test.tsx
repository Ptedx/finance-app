/**
 * A tela de categorias (E2E-33): textos traduzidos, lápis e lixeira com nome para o
 * leitor de tela, e apagar uma categoria em uso diz quantos lançamentos a usam e oferece
 * movê-los para outra do mesmo tipo. As chaves de tradução aparecem cruas, com os valores
 * interpolados depois de "|". O editor de categoria é outro componente e fica de fora.
 */

import type { Category, Transaction } from '../../database/schema';

const mockDeleteCategory = jest.fn(async (_id: string, _moveTo?: string) => undefined);

const category = (id: string, name: string, type: 'expense' | 'income'): Category => ({
	id,
	name,
	color: '#50E3C2',
	icon: 'pricetag',
	type,
	nature: 'discretionary',
	updatedAt: '2026-11-07T12:00:00.000Z',
});

const mockCategories: Category[] = [
	category('food', 'Food', 'expense'),
	category('shopping', 'Shopping', 'expense'),
	category('salary', 'Salary', 'income'),
	category('uncategorized', 'Uncategorized', 'expense'),
];

const mockTransactions = [
	{ id: 'tx-1', amountCents: 20_000, category: 'shopping', date: '2026-11-12', note: '', isIncome: false },
] as Transaction[];

jest.mock('expo-router', () => ({ useRouter: () => ({ back: jest.fn() }), Stack: { Screen: () => null } }));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('react-native-safe-area-context', () => {
	const { View } = require('react-native');
	return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});

jest.mock('react-i18next', () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options ? [key, ...Object.values(options)].join('|') : key,
	}),
}));

jest.mock('../../components/CategoryEditorModal', () => () => null);

jest.mock('../../contexts/TransactionsContext', () => ({
	useTransactions: () => ({
		categories: mockCategories,
		transactions: mockTransactions,
		addCategory: jest.fn(),
		updateCategory: jest.fn(),
		deleteCategory: (id: string, moveTo?: string) => mockDeleteCategory(id, moveTo),
	}),
}));

import { Alert, type AlertButton } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import CategoryManagementScreen from '../CategoryManagementScreen';

jest.setTimeout(20_000);

let renderer: ReactTestRenderer;
const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

const isHostText = (node: ReactTestInstance): boolean => (node.type as unknown) === 'Text';
const texts = (): string[] =>
	renderer.root.findAll(isHostText).map((node) => [node.props.children].flat().join(''));

/**
 * O elemento tocável com este rótulo acessível. O `TouchableOpacity` repassa `onPress` e o
 * rótulo para o que ele desenha; fica só o de fora, um por botão.
 */
const byLabel = (label: string): ReactTestInstance[] => {
	const matches = renderer.root.findAll(
		(node) => typeof node.props.onPress === 'function' && node.props.accessibilityLabel === label
	);
	const inside = (node: ReactTestInstance, outer: ReactTestInstance): boolean => {
		for (let up = node.parent; up; up = up.parent) if (up === outer) return true;
		return false;
	};
	return matches.filter((node) => !matches.some((outer) => outer !== node && inside(node, outer)));
};

const pressLabel = async (label: string) => {
	const [target] = byLabel(label);
	if (!target) throw new Error(`nada tocável com o rótulo ${label}`);
	await act(async () => {
		await target.props.onPress();
	});
};

const pressAlertButton = async (style: AlertButton['style']) => {
	const buttons = alertSpy.mock.calls.at(-1)?.[2] as AlertButton[];
	const button = buttons.find((candidate) => candidate.style === style);
	if (!button?.onPress) throw new Error(`sem botão ${style}`);
	const onPress = button.onPress as () => unknown;
	await act(async () => {
		await onPress();
	});
};

beforeEach(async () => {
	jest.clearAllMocks();
	await act(async () => {
		renderer = create(<CategoryManagementScreen />);
	});
});

afterEach(() => {
	act(() => renderer.unmount());
});

it('não tem texto fixo em inglês', () => {
	const shown = texts();
	for (const english of ['Category Management', 'Add Category', 'Expense', 'Income', 'Essential', 'Discretionary', 'No categories found']) {
		expect(shown.some((text) => text.includes(english))).toBe(false);
	}
	expect(shown).toContain('categoryManagement.title');
	expect(shown).toContain('categoryManagement.add');
	expect(shown).toContain('categoryManagement.expense');
	expect(shown).toContain('categoryManagement.income');
	expect(shown).toContain('categoryManagement.nature.discretionary');
});

it('lápis e lixeira têm rótulo com o nome da categoria', () => {
	expect(byLabel('categoryManagement.editLabel|Food')).toHaveLength(1);
	expect(byLabel('categoryManagement.deleteLabel|Food')).toHaveLength(1);
	expect(byLabel('categoryManagement.editLabel|Salary')).toHaveLength(1);
	expect(byLabel('categoryManagement.deleteLabel|Salary')).toHaveLength(1);
});

it('"Sem categoria" não tem lixeira: o banco recusa apagá-la', () => {
	expect(byLabel('categoryManagement.deleteLabel|Uncategorized')).toHaveLength(0);
});

it('categoria sem lançamentos: o alerta simples basta', async () => {
	await pressLabel('categoryManagement.deleteLabel|Food');
	expect(alertSpy).toHaveBeenCalledTimes(1);
	expect(alertSpy.mock.calls[0][0]).toBe('categoryManagement.deleteTitle');
	expect(alertSpy.mock.calls[0][1]).toBe('categoryManagement.deleteMessage|Food');
	await pressAlertButton('destructive');
	expect(mockDeleteCategory).toHaveBeenCalledWith('food', undefined);
});

it('categoria em uso: diz quantos lançamentos e move para outra do mesmo tipo antes de apagar', async () => {
	await pressLabel('categoryManagement.deleteLabel|Shopping');
	expect(alertSpy).not.toHaveBeenCalled();
	expect(texts()).toContain('categoryManagement.deleteInUse|1|Shopping');

	// O destino é uma lista que abre do campo "Mover para" (SPD-130).
	await pressLabel('categoryManagement.moveTo, select.placeholder');
	const targets = renderer.root
		.findAll((node) => node.props.accessibilityRole === 'radio' && typeof node.props.onPress === 'function')
		.map((node) => node.props.accessibilityLabel);
	// Só despesas, e nunca a própria.
	expect(targets).toEqual(['Food', 'Uncategorized']);

	// Sem destino escolhido, não apaga.
	const [moveButton] = byLabel('categoryManagement.moveAndDelete');
	expect(moveButton.props.accessibilityState).toMatchObject({ disabled: true });

	const food = renderer.root.find((node) => node.props.accessibilityRole === 'radio' && node.props.accessibilityLabel === 'Food' && typeof node.props.onPress === 'function');
	await act(async () => {
		food.props.onPress();
	});
	await pressLabel('categoryManagement.moveAndDelete');
	expect(mockDeleteCategory).toHaveBeenCalledWith('shopping', 'food');
	expect(texts()).not.toContain('categoryManagement.deleteInUse|1|Shopping');
});
