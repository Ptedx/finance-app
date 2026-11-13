/**
 * A tela de moeda fala o idioma do app e a troca só do símbolo não mexe em valor (SPD-140).
 *
 * O achado da conferência das trilhas: o seletor tinha todos os textos fixos em inglês
 * ("Select Currency", "Convert amounts", "Keep amounts as they are?", "Invalid Rate"…), num
 * app em português. Aqui o `t` devolve a chave (e os parâmetros), então todo texto na tela
 * tem de ser uma chave do bloco `currency` — ou um código de moeda e o símbolo.
 *
 * E depois de converter, as dívidas, as contas a pagar e a caixa de entrada são relidas: os
 * valores mudaram no banco, e esses contextos só releem no próximo sync.
 */

const mockSetCurrency = jest.fn(async () => undefined);
const mockConvertBudgets = jest.fn(async () => undefined);
const mockRefreshData = jest.fn(async () => undefined);
const mockConvertAllAmounts = jest.fn(async (_rate: number) => undefined);
const mockRefreshDebts = jest.fn(async () => undefined);
const mockRefreshBills = jest.fn(async () => undefined);
const mockRefreshCaptures = jest.fn(async () => undefined);

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-i18next', () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) => (options ? `${key}|${JSON.stringify(options)}` : key),
	}),
}));
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
jest.mock('../../contexts/DebtsContext', () => ({ useDebts: () => ({ refresh: mockRefreshDebts }) }));
jest.mock('../../contexts/BillsContext', () => ({ useBills: () => ({ refresh: mockRefreshBills }) }));
jest.mock('../../contexts/CapturesContext', () => ({ useCaptures: () => ({ refresh: mockRefreshCaptures }) }));
jest.mock('../../database/database', () => ({
	hasFinancialData: jest.fn(async () => true),
	convertAllAmounts: (rate: number) => mockConvertAllAmounts(rate),
}));

import { Alert, type AlertButton } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import CurrencySelector from '../CurrencySelector';

// A primeira montagem carrega o seletor inteiro; com outras suítes rodando junto, passa dos 5 s.
jest.setTimeout(20_000);

let renderer: ReactTestRenderer | null = null;

const isHostText = (node: ReactTestInstance): boolean => (node.type as unknown) === 'Text';
const textOf = (node: ReactTestInstance): string => [node.props.children].flat().join('');
const texts = (): string[] => (renderer as ReactTestRenderer).root.findAll(isHostText).map(textOf);

/** Toca no que tem o texto: sobe do `Text` até o primeiro com `onPress`. */
const press = async (text: string) => {
	const label = renderer?.root.findAll(isHostText).find((node) => textOf(node) === text);
	if (!label) throw new Error(`"${text}" não está na tela: ${JSON.stringify(texts())}`);
	let target: ReactTestInstance | null = label;
	while (target && !target.props.onPress) target = target.parent;
	if (!target) throw new Error(`"${text}" não é tocável`);
	await act(async () => {
		await target.props.onPress();
	});
};

const typeRate = async (value: string) => {
	const input = (renderer as ReactTestRenderer).root.find((node) => (node.type as unknown) === 'TextInput');
	await act(async () => {
		input.props.onChangeText(value);
	});
};

const open = async () => {
	await act(async () => {
		renderer = create(<CurrencySelector isVisible onClose={jest.fn()} />);
	});
};

/** O nome da moeda como o `t` simulado devolve: a chave, com o inglês como reserva. */
const nameKey = (code: string, name: string) => `currency.names.${code}|${JSON.stringify({ defaultValue: name })}`;

beforeEach(() => {
	jest.clearAllMocks();
	jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
});

afterEach(() => {
	act(() => renderer?.unmount());
	renderer = null;
	jest.restoreAllMocks();
});

it('a lista e o pedido da taxa só têm textos do bloco currency (fora códigos e símbolos)', async () => {
	await open();
	await press('USD');

	const allowed = new Set(['BRL', 'USD', 'R$', '$', 'BRL → USD']);
	const shown = texts();
	expect(shown.filter((text) => !allowed.has(text) && !text.startsWith('currency.'))).toEqual([]);

	expect(shown).toEqual(
		expect.arrayContaining([
			'currency.title',
			nameKey('BRL', 'Brazilian Real'),
			nameKey('USD', 'US Dollar'),
			`currency.rateExplanation|${JSON.stringify({ name: nameKey('BRL', 'Brazilian Real') })}`,
			`currency.rateLabel|${JSON.stringify({ from: 'BRL', to: 'USD' })}`,
			'currency.convert',
			'currency.symbolOnly',
			'currency.cancel',
		])
	);
	const input = (renderer as ReactTestRenderer).root.find((node) => (node.type as unknown) === 'TextInput');
	expect(input.props.placeholder).toBe('currency.ratePlaceholder');
});

it('taxa inválida avisa pelo i18n e não converte nada', async () => {
	await open();
	await press('USD');
	await typeRate('0');
	await press('currency.convert');

	expect(Alert.alert).toHaveBeenCalledWith('currency.invalidRateTitle', 'currency.invalidRateBody');
	expect(mockConvertAllAmounts).not.toHaveBeenCalled();
	expect(mockSetCurrency).not.toHaveBeenCalled();
});

it('converter a 0,20 relê dívidas, contas a pagar e a caixa de entrada', async () => {
	await open();
	await press('USD');
	await typeRate('0,20');
	await press('currency.convert');

	expect(mockConvertAllAmounts).toHaveBeenCalledWith(0.2);
	expect(mockSetCurrency).toHaveBeenCalledWith({ code: 'USD', symbol: '$', name: 'US Dollar' });
	expect(mockRefreshData).toHaveBeenCalledTimes(1);
	expect(mockRefreshDebts).toHaveBeenCalledTimes(1);
	expect(mockRefreshBills).toHaveBeenCalledTimes(1);
	expect(mockRefreshCaptures).toHaveBeenCalledTimes(1);
	expect(Alert.alert).not.toHaveBeenCalled();
});

it('a falha ao converter avisa pelo i18n', async () => {
	mockConvertAllAmounts.mockRejectedValueOnce(new Error('disco cheio'));
	jest.spyOn(console, 'error').mockImplementation(() => undefined);
	await open();
	await press('USD');
	await typeRate('0,20');
	await press('currency.convert');

	expect(Alert.alert).toHaveBeenCalledWith('currency.conversionFailedTitle', 'currency.conversionFailedBody');
	expect(mockSetCurrency).not.toHaveBeenCalled();
});

it('só trocar o símbolo: pergunta pelo i18n e não toca em valor nenhum', async () => {
	await open();
	await press('USD');
	await press('currency.symbolOnly');

	expect(Alert.alert).toHaveBeenCalledTimes(1);
	const [title, body, buttons] = (Alert.alert as jest.Mock).mock.calls[0] as [string, string, AlertButton[]];
	expect(title).toBe('currency.keepTitle');
	expect(body).toBe(`currency.keepBody|${JSON.stringify({ code: 'USD', name: nameKey('USD', 'US Dollar') })}`);
	expect(buttons.map((button) => button.text)).toEqual(['currency.cancel', 'currency.keepConfirm']);

	await act(async () => {
		await buttons[1].onPress?.();
	});

	expect(mockConvertAllAmounts).not.toHaveBeenCalled();
	expect(mockConvertBudgets).not.toHaveBeenCalled();
	expect(mockSetCurrency).toHaveBeenCalledWith({ code: 'USD', symbol: '$', name: 'US Dollar' });
	// Nada mudou no banco além da moeda: não há o que reler fora dos lançamentos.
	expect(mockRefreshDebts).not.toHaveBeenCalled();
});
