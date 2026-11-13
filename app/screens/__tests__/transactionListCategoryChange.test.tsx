/**
 * Trocar a categoria tocando no ícone, na lista de Lançamentos (SPD-178): o toque abre a lista
 * das categorias do lado do lançamento; escolher grava na hora e mostra "Categoria trocada para
 * X" com "Desfazer", sem confirmação. Desfazer volta a categoria de antes; o aviso some sozinho.
 */

jest.mock('expo-router', () => ({
	useRouter: () => ({ push: jest.fn() }),
	useLocalSearchParams: () => ({}),
}));

jest.mock('react-native-safe-area-context', () => {
	const { View } = require('react-native');
	return { SafeAreaView: View };
});

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('react-i18next', () => ({
	useTranslation: () => ({
		t: (key: string, options?: { name?: string }) =>
			options?.name ? `${key}:${options.name}` : key,
	}),
}));

jest.mock('../../components/PeriodSelector', () => () => null);
jest.mock('../../components/TransferItem', () => () => null);
// A linha: só o ícone, que chama a troca da categoria.
jest.mock('../../components/TransactionItem', () => {
	const { Pressable } = require('react-native');
	return ({
		transaction,
		onCategoryPress,
	}: {
		transaction: { id: string };
		onCategoryPress?: (t: unknown) => void;
	}) => (
		<Pressable testID={`icon-${transaction.id}`} onPress={() => onCategoryPress?.(transaction)} />
	);
});
// A folha: uma linha por opção, quando aberta.
jest.mock('../../components/SelectField', () => {
	const { Pressable, View } = require('react-native');
	return {
		SelectField: () => null,
		SelectSheet: ({
			visible,
			options,
			onSelect,
			onClose,
		}: {
			visible: boolean;
			options: { value: string }[];
			onSelect: (value: string) => void;
			onClose: () => void;
		}) =>
			visible ? (
				<View testID="sheet">
					{options.map((option) => (
						<Pressable
							key={option.value}
							testID={`option-${option.value}`}
							onPress={() => {
								onSelect(option.value);
								onClose();
							}}
						/>
					))}
				</View>
			) : null,
	};
});

jest.mock('../../utils/dateUtils', () => ({
	...jest.requireActual('../../utils/dateUtils'),
	todayISO: () => '2026-11-19',
}));

const tx = (id: string, category: string, isIncome = false) => ({
	id,
	date: '2026-11-18',
	isIncome,
	amountCents: 1_000,
	category,
	accountId: null,
	note: 'Padaria',
});
const mockTransactions = [tx('a', 'outros'), tx('b', 'salario', true)];
const mockCategories = [
	{ id: 'outros', name: 'Outros', type: 'expense', color: '#999', icon: 'help' },
	{ id: 'mercado', name: 'Mercado', type: 'expense', color: '#0f0', icon: 'cart' },
	{ id: 'salario', name: 'Salário', type: 'income', color: '#00f', icon: 'cash' },
];
const mockUpdate = jest.fn(async (_transaction: unknown) => null);
const mockEmpty: never[] = [];

jest.mock('../../contexts/TransactionsContext', () => ({
	useTransactions: () => ({
		transactions: mockTransactions,
		categories: mockCategories,
		isLoading: false,
		refreshData: jest.fn(),
		updateExistingTransaction: mockUpdate,
	}),
}));
jest.mock('../../contexts/AccountsContext', () => ({
	useAccounts: () => ({
		accounts: mockEmpty,
		activeAccounts: mockEmpty,
		periodTransfers: mockEmpty,
	}),
}));
jest.mock('../../contexts/PeriodContext', () => ({
	usePeriod: () => ({ startDate: '2026-11-01', endDate: '2026-11-30', selectedMonth: 11 }),
}));

import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import TransactionListScreen from '../TransactionListScreen';

let renderer: ReactTestRenderer | null = null;

const root = (): ReactTestInstance => (renderer as ReactTestRenderer).root;
const byTestID = (id: string): ReactTestInstance[] =>
	root().findAll((node) => node.props.testID === id && typeof node.type === 'string');
const pressable = (id: string): ReactTestInstance | undefined =>
	root().findAll((node) => node.props.testID === id && typeof node.props.onPress === 'function')[0];
const press = async (id: string) => {
	const node = pressable(id);
	if (!node) throw new Error(`sem ${id}`);
	await act(async () => {
		node.props.onPress();
	});
};
const texts = (): string[] =>
	root()
		.findAll((node) => (node.type as unknown) === 'Text')
		.map((node) => [node.props.children].flat().join(''));

const render = async () => {
	await act(async () => {
		renderer = create(<TransactionListScreen />);
	});
};

beforeEach(() => {
	jest.useFakeTimers();
	mockUpdate.mockClear();
});

afterEach(() => {
	act(() => renderer?.unmount());
	renderer = null;
	jest.useRealTimers();
});

describe('trocar a categoria pelo ícone (SPD-178)', () => {
	it('o ícone abre as categorias do lado do lançamento; escolher grava e mostra o Desfazer', async () => {
		await render();
		expect(byTestID('sheet')).toHaveLength(0);
		await press('icon-a');
		expect(byTestID('sheet')).toHaveLength(1);
		// Despesa: só as de despesa.
		expect(byTestID('option-mercado')).toHaveLength(1);
		expect(byTestID('option-salario')).toHaveLength(0);

		await press('option-mercado');
		expect(mockUpdate).toHaveBeenCalledTimes(1);
		expect(mockUpdate).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'a', category: 'mercado', note: 'Padaria' })
		);
		expect(byTestID('sheet')).toHaveLength(0);
		expect(texts()).toContain('transactionsList.categoryChanged:Mercado');
	});

	it('Desfazer volta a categoria de antes e tira o aviso', async () => {
		await render();
		await press('icon-a');
		await press('option-mercado');
		const [undo] = root().findAll(
			(node) =>
				node.props.accessibilityLabel === 'transactionsList.undo' &&
				typeof node.props.onPress === 'function'
		);
		await act(async () => {
			undo?.props.onPress();
		});
		expect(mockUpdate).toHaveBeenLastCalledWith(
			expect.objectContaining({ id: 'a', category: 'outros' })
		);
		expect(texts()).not.toContain('transactionsList.categoryChanged:Mercado');
	});

	it('o aviso some sozinho depois de alguns segundos', async () => {
		await render();
		await press('icon-a');
		await press('option-mercado');
		expect(texts()).toContain('transactionsList.categoryChanged:Mercado');
		await act(async () => {
			jest.advanceTimersByTime(6000);
		});
		expect(texts()).not.toContain('transactionsList.categoryChanged:Mercado');
		expect(mockUpdate).toHaveBeenCalledTimes(1);
	});

	it('escolher a mesma categoria não grava nem avisa', async () => {
		await render();
		await press('icon-b');
		expect(byTestID('option-salario')).toHaveLength(1);
		expect(byTestID('option-mercado')).toHaveLength(0);
		await press('option-salario');
		expect(mockUpdate).not.toHaveBeenCalled();
		expect(texts().some((text) => text.startsWith('transactionsList.categoryChanged'))).toBe(false);
	});
});
