/**
 * O detalhe de um lançamento (SPD-110): a pilha da raiz não desenha cabeçalho, então a tela
 * desenha o seu (título e seta de voltar), como Dívida, Cartão e Configurações. E o fim da
 * tela rola e para acima da barra de gestos do Android (`insets.bottom`): "Editar" e
 * "Apagar" ficavam embaixo dela. As chaves de tradução aparecem cruas.
 */

const mockBack = jest.fn();
const mockTransactions = [
	{ id: 'tx-1', amountCents: 20_000, category: 'shopping', date: '2026-11-12', note: 'Geladeira', isIncome: false, accountId: null },
];
const mockCategories = [{ id: 'shopping', name: 'Compras', color: '#50E3C2', icon: 'cart', type: 'expense', nature: 'discretionary' }];
const mockAccounts: never[] = [];
const mockT = (key: string) => key;
let mockId = 'tx-1';

jest.mock('expo-router', () => ({
	Stack: { Screen: () => null },
	useLocalSearchParams: () => ({ id: mockId }),
	useRouter: () => ({ push: jest.fn(), back: mockBack }),
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

// Um aparelho com barra de gestos: 34 pontos embaixo.
jest.mock('react-native-safe-area-context', () => {
	const { View } = require('react-native');
	return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 24, right: 0, bottom: 34, left: 0 }) };
});

jest.mock('react-i18next', () => ({
	useTranslation: () => ({ t: mockT }),
}));

jest.mock('../../contexts/AccountsContext', () => ({
	useAccounts: () => ({ accounts: mockAccounts }),
}));

jest.mock('../../contexts/TransactionsContext', () => ({
	useTransactions: () => ({
		transactions: mockTransactions,
		categories: mockCategories,
		removeTransaction: jest.fn(),
		removeInstallmentGroup: jest.fn(),
	}),
}));

import { ScrollView, StyleSheet } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import TransactionDetailScreen from '../../transaction/[id]';

jest.setTimeout(20_000);

let renderer: ReactTestRenderer;

const isHostText = (node: ReactTestInstance): boolean => (node.type as unknown) === 'Text';

const render = async (id: string) => {
	mockId = id;
	await act(async () => {
		renderer = create(<TransactionDetailScreen />);
	});
};

/** O que recebe o toque com este rótulo acessível. */
const pressable = (label: string): ReactTestInstance | undefined =>
	renderer.root.findAll((node) => node.props.accessibilityLabel === label && typeof node.props.onPress === 'function')[0];

/** O texto marcado como cabeçalho da tela. */
const headerTitles = (): string[] =>
	renderer.root
		.findAll((node) => isHostText(node) && node.props.accessibilityRole === 'header')
		.map((node) => [node.props.children].flat().join(''));

/** Algum ancestral de `node` passa no teste? */
const hasAncestor = (node: ReactTestInstance, test: (candidate: ReactTestInstance) => boolean): boolean => {
	let current = node.parent;
	while (current) {
		if (test(current)) return true;
		current = current.parent;
	}
	return false;
};

beforeEach(() => {
	mockBack.mockClear();
});

afterEach(() => {
	act(() => renderer.unmount());
});

it('tem cabeçalho com o título e a seta de voltar, que volta para a tela de antes', async () => {
	await render('tx-1');

	expect(headerTitles()).toEqual(['transactionDetail.titleExpense']);
	const back = pressable('transactionDetail.back');
	expect(back).toBeDefined();
	expect(back?.props.accessibilityRole).toBe('button');

	await act(async () => {
		back?.props.onPress();
	});
	expect(mockBack).toHaveBeenCalledTimes(1);
});

it('lançamento que não existe mais: ainda tem como voltar', async () => {
	await render('sumiu');

	expect(headerTitles()).toEqual(['transactionDetail.title']);
	await act(async () => {
		pressable('transactionDetail.back')?.props.onPress();
	});
	expect(mockBack).toHaveBeenCalledTimes(1);
});

it('"Editar" e "Apagar" ficam numa área que rola e termina acima da barra de gestos', async () => {
	await render('tx-1');

	const scroll = renderer.root.find((node) => (node.type as unknown) === ScrollView);
	const padding = StyleSheet.flatten(scroll.props.contentContainerStyle) ?? {};
	expect(Number(padding.paddingBottom)).toBeGreaterThanOrEqual(34);

	for (const label of ['transactionDetail.edit', 'transactionDetail.delete']) {
		const text = renderer.root.find((node) => isHostText(node) && node.props.children === label);
		expect(hasAncestor(text, (candidate) => candidate === scroll)).toBe(true);
	}
});
