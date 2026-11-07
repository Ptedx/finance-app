/**
 * A folha "Definir orçamento" (E2E-31): o mês no idioma do app, a folha sobe com o
 * teclado e o Salvar responde com ele aberto, e o mês que herda o orçamento diz de onde
 * ele vem. As chaves de tradução aparecem cruas, com os valores interpolados depois de "|".
 */

const mockSetBudget = jest.fn(async (_cents: number) => undefined);
const mockClearBudget = jest.fn(async () => undefined);
const mockBudget: {
	currentBudgetCents: number | null;
	budgetInheritedFrom: { year: number; month: number } | null;
} = { currentBudgetCents: null, budgetInheritedFrom: null };

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('react-native-safe-area-context', () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('react-i18next', () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options ? [key, ...Object.values(options)].join('|') : key,
	}),
}));

jest.mock('../../contexts/BudgetContext', () => ({
	useBudget: () => ({
		...mockBudget,
		setBudgetForCurrentPeriod: (cents: number) => mockSetBudget(cents),
		clearBudgetForCurrentPeriod: () => mockClearBudget(),
	}),
}));

// O nome em maiúsculas e em inglês é o que o `PeriodContext` entregava preso no arranque.
jest.mock('../../contexts/PeriodContext', () => ({
	usePeriod: () => ({ selectedMonth: 11, selectedYear: 2026, selectedMonthName: 'NOVEMBER' }),
}));

jest.mock('../../contexts/CurrencyContext', () => ({
	useCurrency: () => ({ currentCurrency: { code: 'BRL', symbol: 'R$' } }),
}));

import { KeyboardAvoidingView, ScrollView } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { configureDateLocale } from '../../utils/dateUtils';
import BudgetEditor from '../BudgetEditor';

jest.setTimeout(20_000);

let renderer: ReactTestRenderer;
const onClose = jest.fn();

const isHostText = (node: ReactTestInstance): boolean => (node.type as unknown) === 'Text';

const texts = (): string[] =>
	renderer.root.findAll(isHostText).map((node) => [node.props.children].flat().join(''));

const press = async (label: string) => {
	const text = renderer.root.find((node) => isHostText(node) && node.props.children === label);
	let target: ReactTestInstance | null = text;
	while (target && !target.props.onPress) target = target.parent;
	if (!target) throw new Error(`nada tocável em ${label}`);
	const onPress = target.props.onPress as () => unknown;
	await act(async () => {
		await onPress();
	});
};

const render = async () => {
	await act(async () => {
		renderer = create(<BudgetEditor isVisible onClose={onClose} />);
	});
};

beforeEach(() => {
	configureDateLocale('pt-BR');
	mockBudget.currentBudgetCents = null;
	mockBudget.budgetInheritedFrom = null;
	jest.clearAllMocks();
});

afterEach(() => {
	act(() => renderer.unmount());
	configureDateLocale('en-US');
});

it('mostra o mês no idioma do app, não "NOVEMBER"', async () => {
	await render();
	expect(texts()).toContain('budgetEditor.period|novembro|2026');
	expect(texts().some((text) => text.includes('NOVEMBER'))).toBe(false);
});

it('a folha sobe com o teclado e os toques passam com ele aberto', async () => {
	await render();
	expect(renderer.root.findAll((node) => node.type === (KeyboardAvoidingView as unknown)).length).toBeGreaterThan(0);
	const scrolls = renderer.root.findAll((node) => node.type === (ScrollView as unknown));
	expect(scrolls.some((scroll) => scroll.props.keyboardShouldPersistTaps === 'handled')).toBe(true);
});

it('Salvar grava o valor digitado, sem precisar fechar o teclado antes', async () => {
	await render();
	const input = renderer.root.find((node) => (node.type as unknown) === 'TextInput');
	await act(async () => {
		input.props.onChangeText('5000');
	});
	await press('budgetEditor.save');
	expect(mockSetBudget).toHaveBeenCalledWith(500_000);
	expect(onClose).toHaveBeenCalled();
});

it('no mês que herda, diz de onde vem e não oferece Limpar', async () => {
	mockBudget.currentBudgetCents = 500_000;
	mockBudget.budgetInheritedFrom = { year: 2026, month: 10 };
	await render();
	expect(texts()).toContain('budgetEditor.inheritedFrom|outubro|2026');
	expect(texts()).not.toContain('budgetEditor.clear');
});

it('no mês com orçamento próprio, Limpar continua lá', async () => {
	mockBudget.currentBudgetCents = 500_000;
	await render();
	expect(texts()).toContain('budgetEditor.clear');
	await press('budgetEditor.clear');
	expect(mockClearBudget).toHaveBeenCalled();
});
