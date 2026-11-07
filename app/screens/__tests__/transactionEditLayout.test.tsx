/**
 * A tela de editar lançamento (SPD-121): a pilha da raiz não desenha cabeçalho, e no aparelho
 * a tela começava direto em "Tipo de lançamento", sem título nem voltar. Agora desenha o seu,
 * como o detalhe do lançamento (SPD-110). E o espaço embaixo era um número fixo (60), o mesmo
 * em qualquer aparelho: passa a seguir a barra de gestos (`insets.bottom`). O formulário em si
 * é um dublê; as chaves de tradução aparecem cruas.
 */

const mockBack = jest.fn();
// O mesmo roteador a cada render, como o de verdade: a tela o tem como dependência.
const mockRouter = { back: mockBack };
const mockParams: { current: Record<string, string> } = { current: {} };
const mockInsets = { top: 24, right: 0, bottom: 34, left: 0 };

jest.mock('expo-router', () => ({
	useRouter: () => mockRouter,
	useLocalSearchParams: () => mockParams.current,
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

jest.mock('../../components/TransactionForm', () => {
	const { createElement } = require('react');
	return () => createElement('TransactionForm');
});
jest.mock('../../components/TransferForm', () => {
	const { createElement } = require('react');
	return () => createElement('TransferForm');
});

const mockGetTransfer = jest.fn(async (id: string) =>
	id === 'transf'
		? { id, fromAccountId: 'corrente', toAccountId: 'reserva', amountCents: 100_000, date: '2026-11-07', note: '', updatedAt: 'u1', deletedAt: null }
		: null
);
jest.mock('../../database/database', () => ({ getTransfer: (id: string) => mockGetTransfer(id) }));

const mockTransactions = [
	{ id: 'despesa', isIncome: false },
	{ id: 'receita', isIncome: true },
];

jest.mock('../../contexts/TransactionsContext', () => ({
	useTransactions: () => ({ transactions: mockTransactions }),
}));

import { StyleSheet } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import EditTransactionScreen from '../../transaction/edit/[id]';

jest.setTimeout(20_000);

let renderer: ReactTestRenderer;

const isHostText = (node: ReactTestInstance): boolean => (node.type as unknown) === 'Text';

const render = async (params: Record<string, string>) => {
	mockParams.current = params;
	await act(async () => {
		renderer = create(<EditTransactionScreen />);
	});
};

const headerTitles = (): string[] =>
	renderer.root
		.findAll((node) => isHostText(node) && node.props.accessibilityRole === 'header')
		.map((node) => [node.props.children].flat().join(''));

const pressable = (label: string): ReactTestInstance | undefined =>
	renderer.root.findAll((node) => node.props.accessibilityLabel === label && typeof node.props.onPress === 'function')[0];

/** O formulário que a tela desenhou (o dublê). */
const form = (): ReactTestInstance =>
	renderer.root.find((node) => (node.type as unknown) === 'TransactionForm' || (node.type as unknown) === 'TransferForm');

/** Soma de um espaçamento em todos os que envolvem o formulário. */
const paddingAround = (node: ReactTestInstance, side: 'paddingTop' | 'paddingBottom'): number => {
	let total = 0;
	for (let up = node.parent; up; up = up.parent) {
		if (typeof up.type !== 'string') continue;
		const style = StyleSheet.flatten(up.props.style) ?? {};
		total += Number(style[side] ?? style.paddingVertical ?? style.padding ?? 0);
	}
	return total;
};

beforeEach(() => {
	mockBack.mockClear();
	mockInsets.bottom = 34;
});

afterEach(() => {
	act(() => renderer.unmount());
});

describe.each([
	['despesa', { id: 'despesa' }, 'transactionForm.titleEditExpense'],
	['receita', { id: 'receita' }, 'transactionForm.titleEditIncome'],
	['transferência', { id: 'transf', kind: 'transfer' }, 'transactionForm.transfer.titleEdit'],
])('editar %s', (_name, params, title) => {
	it('tem cabeçalho com o título e a seta de voltar, que volta para a tela de antes', async () => {
		await render(params);

		expect(headerTitles()).toEqual([title]);
		const back = pressable('transactionForm.back');
		expect(back?.props.accessibilityRole).toBe('button');
		await act(async () => {
			back?.props.onPress();
		});
		expect(mockBack).toHaveBeenCalledTimes(1);
	});
});

it('o topo fica por conta da área segura (só o lado de cima e os lados), sem os 60 fixos', async () => {
	await render({ id: 'despesa' });

	const safeArea = renderer.root.find((node) => Array.isArray(node.props.edges));
	expect(safeArea.props.edges).toEqual(['top', 'left', 'right']);
	expect(paddingAround(form(), 'paddingTop')).toBe(0);
});

it.each([0, 34, 48])('embaixo, o espaço acompanha a barra de gestos (%i pontos)', async (bottom) => {
	mockInsets.bottom = bottom;
	await render({ id: 'despesa' });

	expect(paddingAround(form(), 'paddingBottom')).toBe(bottom);
});
