/**
 * O formulário de lançamento (SPD-086), como o usuário o vê no aparelho.
 *
 * - E2E-11: com o app em português o formulário saía todo em inglês, texto fixo no
 *   componente. Aqui as traduções aparecem como chave crua: nenhum texto em inglês pode
 *   sobrar, e cada rótulo tem a sua chave em `transactionForm`.
 * - E2E-13: Salvar sem valor ou sem categoria não fazia nada visível — a mensagem ia para
 *   o topo, fora da tela. Agora o erro aparece junto do botão, a tela rola até o primeiro
 *   campo com erro e o leitor de tela anuncia.
 * - E2E-12: compra parcelada à mão no cartão de crédito. Uma parcela por fatura, valores
 *   que somam o total, nota com "(1/N)" — o mesmo que confirmar uma captura parcelada.
 *
 * Contextos e banco são dublês; o formulário, o seletor de conta e o de categoria rodam de
 * verdade.
 */

const mockAddNewTransaction = jest.fn(async (_draft: unknown) => 'tx-1');
const mockUpdateExistingTransaction = jest.fn(async (_edit: unknown) => {});
const mockRefreshData = jest.fn(async () => {});
const mockAddTransaction = jest.fn(async (_draft: unknown): Promise<string> => 'parcela');
const mockSchedule = jest.fn();
const mockAccounts = {
	activeAccounts: [] as Array<Record<string, unknown>>,
};

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('expo-blur', () => {
	const { View } = require('react-native');
	return { BlurView: View };
});
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));

// A chave e, quando há, as opções: o teste vê qual texto e com quais números.
jest.mock('react-i18next', () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) => (options ? `${key}|${JSON.stringify(options)}` : key),
	}),
}));

jest.mock('../../contexts/TransactionsContext', () => ({
	useTransactions: () => ({
		categories: [
			{ id: 'compras', name: 'Compras', color: '#FF6B6B', icon: 'cart', type: 'expense', nature: 'discretionary', updatedAt: '' },
			{ id: 'salario', name: 'Salário', color: '#4CAF50', icon: 'cash', type: 'income', nature: 'essential', updatedAt: '' },
		],
		addNewTransaction: (draft: unknown) => mockAddNewTransaction(draft),
		updateExistingTransaction: (edit: unknown) => mockUpdateExistingTransaction(edit),
		refreshData: () => mockRefreshData(),
	}),
}));

jest.mock('../../contexts/CurrencyContext', () => ({
	useCurrency: () => ({ currentCurrency: { code: 'BRL', symbol: 'R$' } }),
}));

jest.mock('../../contexts/AccountsContext', () => ({
	useAccounts: () => mockAccounts,
}));

jest.mock('../../database/database', () => ({
	addTransaction: (draft: unknown) => mockAddTransaction(draft),
}));

jest.mock('../../sync/queue', () => ({
	schedule: () => mockSchedule(),
}));

jest.mock('../../utils/categoryEditUtils', () => ({
	generateUniqueId: () => 'grupo-1',
}));

import { AccessibilityInfo, ScrollView, Switch, Text, TextInput } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { Transaction } from '../../database/schema';
import { configureDateLocale } from '../../utils/dateUtils';
import { configureMoney } from '../../utils/money';
import TransactionForm, { installmentPlan, manualInstallmentDrafts } from '../TransactionForm';

// Fechamento dia 25, vencimento 7 dias depois: a compra de 07/11 cai na fatura de novembro.
const CARD = {
	id: 'nubank',
	name: 'Nubank',
	kind: 'credit_card',
	color: '#8A05BE',
	last4: '1234',
	cardNames: null,
	closingDay: 25,
	closingDaysBefore: 7,
	archived: false,
};
const CHECKING = { id: 'inter', name: 'Inter', kind: 'checking', color: '#FF7A00', last4: null, cardNames: null, closingDay: null, closingDaysBefore: null, archived: false };

const ENGLISH = [
	'Transaction Type',
	'Expense',
	'Income',
	'Amount',
	'Date',
	'Note (Optional)',
	'Add a note',
	'Cancel',
	'Save',
	'Update',
	'Please enter a valid amount greater than 0',
	'Please select a category',
];

let renderer: ReactTestRenderer | null = null;
let announce: jest.SpyInstance;

const render = async (props: Partial<React.ComponentProps<typeof TransactionForm>> = {}) => {
	await act(async () => {
		renderer = create(<TransactionForm onSubmit={jest.fn()} onCancel={jest.fn()} {...props} />);
	});
	// biome-ignore lint/style/noNonNullAssertion: acabou de ser criado
	return renderer!;
};

// `findAllByType` não aceita os componentes do React Native pelos tipos (duas cópias do
// `@types/react`); a comparação direta faz o mesmo.
const ofType = (scope: ReactTestInstance, type: unknown): ReactTestInstance[] =>
	scope.findAll((node) => (node.type as unknown) === type);

const textOf = (node: ReactTestInstance): string => {
	const children = node.props.children;
	const flat = Array.isArray(children) ? children : [children];
	return flat.filter((child) => typeof child === 'string' || typeof child === 'number').join('');
};

const allTexts = (tree: ReactTestRenderer): string[] => [
	...ofType(tree.root, Text).map(textOf),
	...ofType(tree.root, TextInput)
		.map((input) => input.props.placeholder)
		.filter((value): value is string => typeof value === 'string'),
];

const byTestId = (tree: ReactTestRenderer, testID: string): ReactTestInstance =>
	tree.root.find((node) => node.props.testID === testID && typeof node.type !== 'string');

const queryTestId = (tree: ReactTestRenderer, testID: string): ReactTestInstance[] =>
	tree.root.findAll((node) => node.props.testID === testID && typeof node.type !== 'string');

/** A rolagem do formulário (o seletor de conta tem as suas, horizontais). */
const formScroll = (tree: ReactTestRenderer): ReactTestInstance =>
	tree.root.find((node) => (node.type as unknown) === ScrollView && node.props.testID === 'transaction-form-scroll');

const press = async (node: ReactTestInstance) => {
	await act(async () => {
		await node.props.onPress();
	});
};

const typeAmount = async (tree: ReactTestRenderer, text: string) => {
	const input = byTestId(tree, 'transaction-form-amount');
	await act(async () => {
		input.props.onChangeText(text);
	});
};

const pickCategory = async (tree: ReactTestRenderer, name: string) => {
	const label = ofType(tree.root, Text).find((node) => textOf(node) === name);
	if (!label) throw new Error(`categoria ${name} não está na tela`);
	let node: ReactTestInstance | null = label;
	while (node && typeof node.props.onPress !== 'function') node = node.parent;
	if (!node) throw new Error('categoria sem toque');
	await press(node);
};

const pickAccount = async (tree: ReactTestRenderer, name: string) => {
	const chip = tree.root.find((node) => node.props.accessibilityRole === 'radio' && node.props.accessibilityLabel === name && typeof node.props.onPress === 'function');
	await press(chip);
};

beforeAll(() => {
	configureDateLocale('pt-BR');
	configureMoney({ locale: 'pt-BR', currencyCode: 'BRL', currencySymbol: 'R$' });
});

beforeEach(() => {
	// Só o relógio é falso (hoje = 07/11/2026): com os timers falsos o `act` do React não termina.
	jest.useFakeTimers({
		now: new Date(2026, 10, 7, 12, 0, 0),
		doNotFake: [
			'hrtime',
			'nextTick',
			'performance',
			'queueMicrotask',
			'requestAnimationFrame',
			'cancelAnimationFrame',
			'requestIdleCallback',
			'cancelIdleCallback',
			'setImmediate',
			'clearImmediate',
			'setInterval',
			'clearInterval',
			'setTimeout',
			'clearTimeout',
		],
	});
	jest.clearAllMocks();
	mockAccounts.activeAccounts = [CARD, CHECKING];
	announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
});

afterEach(() => {
	act(() => renderer?.unmount());
	renderer = null;
	announce.mockRestore();
	jest.useRealTimers();
});

describe('TransactionForm — idioma (E2E-11)', () => {
	it('nenhum texto fixo em inglês no lançamento novo', async () => {
		const tree = await render();
		const texts = allTexts(tree);
		for (const english of ENGLISH) expect(texts).not.toContain(english);
		for (const key of ['type', 'expense', 'income', 'amount', 'date', 'note', 'notePlaceholder', 'cancel', 'save']) {
			expect(texts).toContain(`transactionForm.${key}`);
		}
	});

	it('na edição o botão é "Salvar alterações", também traduzido', async () => {
		const tree = await render({ initialTransaction: transaction() });
		const texts = allTexts(tree);
		for (const english of ENGLISH) expect(texts).not.toContain(english);
		expect(texts).toContain('transactionForm.update');
	});
});

describe('TransactionForm — erro visível ao salvar (E2E-13)', () => {
	it('sem valor e sem categoria: mensagem junto do botão, anúncio e rolagem até o valor', async () => {
		const tree = await render();
		const scroll = formScroll(tree);
		const scrollTo = jest.fn();
		scroll.instance.scrollTo = scrollTo;

		// Onde os campos estão na tela: o valor em y=120, a categoria em y=300.
		act(() => {
			byTestId(tree, 'transaction-form-amount-group').props.onLayout({ nativeEvent: { layout: { x: 0, y: 120, width: 300, height: 80 } } });
			byTestId(tree, 'transaction-form-category-group').props.onLayout({ nativeEvent: { layout: { x: 0, y: 300, width: 300, height: 200 } } });
		});

		await press(byTestId(tree, 'transaction-form-save'));

		expect(mockAddNewTransaction).not.toHaveBeenCalled();
		const summary = byTestId(tree, 'transaction-form-error-summary');
		expect(textOf(summary)).toBe('transactionForm.amountRequired. transactionForm.categoryRequired');
		expect(summary.props.accessibilityLiveRegion).toBe('polite');
		expect(announce).toHaveBeenCalledWith('transactionForm.amountRequired. transactionForm.categoryRequired');
		expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ y: 120 - 16 }));
	});

	it('com valor e sem categoria: rola até a categoria', async () => {
		const tree = await render();
		const scroll = formScroll(tree);
		const scrollTo = jest.fn();
		scroll.instance.scrollTo = scrollTo;
		act(() => {
			byTestId(tree, 'transaction-form-amount-group').props.onLayout({ nativeEvent: { layout: { x: 0, y: 120, width: 300, height: 80 } } });
			byTestId(tree, 'transaction-form-category-group').props.onLayout({ nativeEvent: { layout: { x: 0, y: 300, width: 300, height: 200 } } });
		});

		await typeAmount(tree, '50');
		await press(byTestId(tree, 'transaction-form-save'));

		expect(textOf(byTestId(tree, 'transaction-form-error-summary'))).toBe('transactionForm.categoryRequired');
		expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ y: 300 - 16 }));

		// Escolher a categoria tira o erro, inclusive o de junto do botão.
		await pickCategory(tree, 'Compras');
		expect(queryTestId(tree, 'transaction-form-error-summary')).toHaveLength(0);
	});
});

describe('TransactionForm — parcelas no cartão (E2E-12)', () => {
	it('o campo de parcelas só aparece em despesa nova no cartão de crédito', async () => {
		const tree = await render();
		expect(queryTestId(tree, 'transaction-form-installments')).toHaveLength(0);

		await pickAccount(tree, 'Inter');
		expect(queryTestId(tree, 'transaction-form-installments')).toHaveLength(0);

		await pickAccount(tree, 'Nubank');
		expect(queryTestId(tree, 'transaction-form-installments')).toHaveLength(1);
		// Padrão 1, à vista.
		expect(byTestId(tree, 'transaction-form-installments').props.value).toBe('1');

		// Receita no cartão (estorno) não é compra parcelada.
		const [toggle] = ofType(tree.root, Switch);
		await act(async () => toggle.props.onValueChange(true));
		expect(queryTestId(tree, 'transaction-form-installments')).toHaveLength(0);
	});

	it('na edição não oferece parcelas, nem com cartão', async () => {
		const tree = await render({ initialTransaction: transaction({ accountId: 'nubank' }) });
		expect(queryTestId(tree, 'transaction-form-installments')).toHaveLength(0);
		expect(queryTestId(tree, 'transaction-form-editing-installment')).toHaveLength(0);
	});

	it('editar uma parcela avisa que a mudança vale só para ela, e grava só ela', async () => {
		const tree = await render({
			initialTransaction: transaction({
				accountId: 'nubank',
				amountCents: 10000,
				note: 'Notebook (2/3)',
				installmentGroup: 'grupo-1',
				installmentIndex: 2,
				installmentCount: 3,
			}),
		});
		expect(textOf(byTestId(tree, 'transaction-form-editing-installment'))).toBe(
			'transactionForm.editingInstallment|{"index":2,"count":3}'
		);
		await press(byTestId(tree, 'transaction-form-save'));
		expect(mockAddTransaction).not.toHaveBeenCalled();
		expect(mockUpdateExistingTransaction).toHaveBeenCalledTimes(1);
		expect(mockUpdateExistingTransaction).toHaveBeenCalledWith(expect.objectContaining({ id: 'tx-9', amountCents: 10000 }));
	});

	it('R$ 300 em 3x no Nubank: prévia e três parcelas, uma por fatura, nota (1/3)', async () => {
		const onSubmit = jest.fn();
		const tree = await render({ onSubmit });
		await typeAmount(tree, '300');
		await pickCategory(tree, 'Compras');
		await pickAccount(tree, 'Nubank');
		await act(async () => {
			byTestId(tree, 'transaction-form-installments').props.onChangeText('3');
		});
		const note = tree.root.find((node) => node.props.testID === 'transaction-form-note' && typeof node.type !== 'string');
		await act(async () => note.props.onChangeText('Notebook'));

		const preview = textOf(byTestId(tree, 'transaction-form-installments-preview'));
		expect(preview.startsWith('transactionForm.installmentsPreview|')).toBe(true);
		const options = JSON.parse(preview.slice(preview.indexOf('|') + 1));
		expect(options).toEqual({ count: 3, amount: 'R$ 100,00', first: 'nov', last: 'jan' });

		await press(byTestId(tree, 'transaction-form-save'));

		expect(mockAddNewTransaction).not.toHaveBeenCalled();
		expect(mockAddTransaction.mock.calls.map(([draft]: [unknown]) => draft)).toEqual([
			parcel('2026-11-07', 1),
			parcel('2026-12-07', 2),
			parcel('2027-01-07', 3),
		]);
		expect(mockSchedule).toHaveBeenCalledTimes(1);
		expect(mockRefreshData).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledTimes(1);
	});

	it('1 parcela (à vista) segue o caminho de sempre', async () => {
		const tree = await render();
		await typeAmount(tree, '300');
		await pickCategory(tree, 'Compras');
		await pickAccount(tree, 'Nubank');
		await press(byTestId(tree, 'transaction-form-save'));

		expect(mockAddTransaction).not.toHaveBeenCalled();
		expect(mockAddNewTransaction).toHaveBeenCalledWith(
			expect.objectContaining({ amountCents: 30000, accountId: 'nubank', date: '2026-11-07' })
		);
		expect(mockAddNewTransaction.mock.calls[0][0]).not.toHaveProperty('installmentGroup');
	});

	it('parcelas fora de 1 a 48 não salvam e o erro aparece', async () => {
		const tree = await render();
		await typeAmount(tree, '300');
		await pickCategory(tree, 'Compras');
		await pickAccount(tree, 'Nubank');
		await act(async () => {
			byTestId(tree, 'transaction-form-installments').props.onChangeText('49');
		});
		await press(byTestId(tree, 'transaction-form-save'));

		expect(mockAddTransaction).not.toHaveBeenCalled();
		expect(mockAddNewTransaction).not.toHaveBeenCalled();
		expect(textOf(byTestId(tree, 'transaction-form-error-summary'))).toBe('transactionForm.installmentsInvalid|{"max":48}');
	});
});

describe('installmentPlan / manualInstallmentDrafts — as contas', () => {
	const rule = { closingDay: 25, dueDaysAfter: 7 };

	it('R$ 300 em 3: R$ 100 cada, de nov a jan', () => {
		expect(installmentPlan(30000, 3, '2026-11-07', rule)).toEqual({
			parts: [10000, 10000, 10000],
			dates: ['2026-11-07', '2026-12-07', '2027-01-07'],
			firstMonth: '2026-11',
			lastMonth: '2027-01',
		});
	});

	it('R$ 100,01 em 3: o centavo a mais na primeira, e a soma volta ao total', () => {
		const plan = installmentPlan(10001, 3, '2026-11-07', rule);
		expect(plan.parts).toEqual([3335, 3333, 3333]);
		expect(plan.parts.reduce((sum, part) => sum + part, 0)).toBe(10001);
	});

	it('compra depois do fechamento já começa na fatura seguinte', () => {
		// 26/11 é depois do fechamento de 25/11: primeira parcela na fatura de dezembro.
		expect(installmentPlan(30000, 3, '2026-11-26', rule)).toMatchObject({ firstMonth: '2026-12', lastMonth: '2027-02' });
	});

	it('nota vazia vira só a marca da parcela', () => {
		const drafts = manualInstallmentDrafts(
			{ amountCents: 20000, category: 'compras', date: '2026-11-07', note: '', isIncome: false, accountId: 'nubank', cardLast4: null },
			2,
			rule,
			'grupo-1'
		);
		expect(drafts.map((draft) => draft.note)).toEqual(['(1/2)', '(2/2)']);
	});
});

function parcel(date: string, index: number) {
	return {
		amountCents: 10000,
		category: 'compras',
		date,
		note: `Notebook (${index}/3)`,
		isIncome: false,
		accountId: 'nubank',
		cardLast4: null,
		installmentGroup: 'grupo-1',
		installmentIndex: index,
		installmentCount: 3,
	};
}

function transaction(overrides: Partial<Transaction> = {}): Transaction {
	return {
		id: 'tx-9',
		amountCents: 5000,
		category: 'compras',
		date: '2026-11-01',
		note: 'Padaria',
		isIncome: false,
		accountId: null,
		installmentGroup: null,
		installmentIndex: null,
		installmentCount: null,
		cardLast4: null,
		updatedAt: '',
		deletedAt: null,
		...overrides,
	} as Transaction;
}
