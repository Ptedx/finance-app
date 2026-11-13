/**
 * Trocar a moeda funciona sem o contexto das recorrências (SPD-138).
 *
 * O seletor pedia `refreshTransactions` ao `RecurringTransactionsProvider` depois de converter
 * os valores, para reler uma lista de regras antigas que nenhuma tela mostra. O provider saiu;
 * aqui o seletor é montado sem ele, e a conversão de R$ para US$ a 0,20 segue inteira:
 * valores, orçamentos, moeda e a recarga dos lançamentos.
 */

const mockSetCurrency = jest.fn(async () => undefined);
const mockConvertBudgets = jest.fn(async () => undefined);
const mockRefreshData = jest.fn(async () => undefined);
const mockConvertAllAmounts = jest.fn(async (_rate: number) => undefined);

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
// Os textos vêm do i18n desde o SPD-140: aqui a tela mostra a chave.
jest.mock('react-i18next', () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock('../../contexts/DebtsContext', () => ({ useDebts: () => ({ refresh: async () => undefined }) }));
jest.mock('../../contexts/BillsContext', () => ({ useBills: () => ({ refresh: async () => undefined }) }));
jest.mock('../../contexts/CapturesContext', () => ({ useCaptures: () => ({ refresh: async () => undefined }) }));
jest.mock('../../contexts/CurrencyContext', () => ({
	AVAILABLE_CURRENCIES: [
		{ code: 'BRL', symbol: 'R$', name: 'Brazilian Real' },
		{ code: 'USD', symbol: '$', name: 'US Dollar' },
	],
	useCurrency: () => ({
		currentCurrency: { code: 'BRL', symbol: 'R$', name: 'Brazilian Real' },
		setCurrency: mockSetCurrency,
	}),
}));
jest.mock('../../contexts/BudgetContext', () => ({
	useBudget: () => ({ convertBudgets: mockConvertBudgets }),
}));
jest.mock('../../contexts/TransactionsContext', () => ({
	useTransactions: () => ({ refreshData: mockRefreshData }),
}));
jest.mock('../../database/database', () => ({
	hasFinancialData: jest.fn(async () => true),
	convertAllAmounts: (rate: number) => mockConvertAllAmounts(rate),
}));

import { Alert } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import CurrencySelector from '../CurrencySelector';

// A primeira montagem carrega o seletor inteiro; com outras suítes rodando junto, passa dos 5 s.
jest.setTimeout(20_000);

let renderer: ReactTestRenderer | null = null;

const isHostText = (node: ReactTestInstance): boolean => (node.type as unknown) === 'Text';
const textOf = (node: ReactTestInstance): string => [node.props.children].flat().join('');

/** Toca no que tem o texto: sobe do `Text` até o primeiro com `onPress`. */
const press = async (text: string) => {
	const label = renderer?.root.findAll(isHostText).find((node) => textOf(node) === text);
	if (!label) throw new Error(`"${text}" não está na tela`);
	let target: ReactTestInstance | null = label;
	while (target && !target.props.onPress) target = target.parent;
	if (!target) throw new Error(`"${text}" não é tocável`);
	await act(async () => {
		await target.props.onPress();
	});
};

beforeEach(() => {
	jest.clearAllMocks();
	jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
});

afterEach(() => {
	act(() => renderer?.unmount());
	renderer = null;
	jest.restoreAllMocks();
});

it('converter de BRL para USD a 0,20 sem o provider das recorrências', async () => {
	const onClose = jest.fn();
	await act(async () => {
		renderer = create(<CurrencySelector isVisible onClose={onClose} />);
	});

	await press('USD');
	const rate = (renderer as ReactTestRenderer).root.find((node) => (node.type as unknown) === 'TextInput');
	await act(async () => {
		rate.props.onChangeText('0.20');
	});
	await press('currency.convert');

	expect(mockConvertAllAmounts).toHaveBeenCalledWith(0.2);
	expect(mockConvertBudgets).toHaveBeenCalledWith(0.2);
	expect(mockSetCurrency).toHaveBeenCalledWith({ code: 'USD', symbol: '$', name: 'US Dollar' });
	expect(mockRefreshData).toHaveBeenCalledTimes(1);
	expect(onClose).toHaveBeenCalledTimes(1);
	expect(Alert.alert).not.toHaveBeenCalled();
});
