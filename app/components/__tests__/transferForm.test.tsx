/**
 * Transferência manual entre contas suas (E2E-28), como o usuário a vê no aparelho.
 *
 * O "+" só tinha Despesa e Receita: R$ 1.000 da Corrente para a Reserva não tinha como
 * ser registrado. O formulário pede De, Para, Valor, Data e Descrição; De e Para têm de
 * ser contas diferentes, o valor maior que zero, e conta arquivada não aparece. Para um
 * cartão de crédito é o pagamento de fatura (`saveTransfer` manda para `recordCardPayment`).
 *
 * As traduções aparecem como chave crua; o contexto de contas é dublê — a conta do saldo
 * e do mês está em `accountsTransferSql.test.tsx`.
 */

const mockSaveTransfer = jest.fn(async (_input: unknown): Promise<boolean> => true);
const mockRemoveTransfer = jest.fn(async (_id: string) => {});
const mockAccounts = {
	accounts: [] as Account[],
	activeAccounts: [] as Account[],
	saveTransfer: (input: unknown) => mockSaveTransfer(input),
	removeTransfer: (id: string) => mockRemoveTransfer(id),
};

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('react-i18next', () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) => (options ? `${key}|${JSON.stringify(options)}` : key),
	}),
}));

jest.mock('../../contexts/CurrencyContext', () => ({
	useCurrency: () => ({ currentCurrency: { code: 'BRL', symbol: 'R$' } }),
}));

jest.mock('../../contexts/AccountsContext', () => ({
	useAccounts: () => mockAccounts,
}));

import { AccessibilityInfo, Alert, type AlertButton } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { Account, Transfer } from '../../database/schema';
import { configureDateLocale } from '../../utils/dateUtils';
import { configureMoney } from '../../utils/money';
import TransferForm, { transferChoices, validateTransfer } from '../TransferForm';

const account = (overrides: Partial<Account>): Account => ({
	id: 'x',
	name: 'Conta',
	kind: 'checking',
	role: 'main',
	envelopeMonthlyCents: null,
	bankName: null,
	color: '#FF7A00',
	last4: null,
	network: null,
	closingDay: null,
	dueDay: null,
	closingDaysBefore: null,
	creditLimitCents: null,
	cardNames: null,
	packageName: null,
	accountKey: null,
	openingBalanceCents: 0,
	openingBalanceDate: '2026-11-06',
	sortOrder: 0,
	archived: false,
	updatedAt: '',
	...overrides,
});

const CORRENTE = account({ id: 'corrente', name: 'Corrente' });
const RESERVA = account({ id: 'reserva', name: 'Reserva', kind: 'savings', role: 'reserve' });
const NUBANK = account({ id: 'nubank', name: 'Nubank', kind: 'credit_card', role: 'card', closingDay: 25 });
const ANTIGA = account({ id: 'antiga', name: 'Conta antiga', archived: true });

const transfer = (overrides: Partial<Transfer> = {}): Transfer => ({
	id: 't-1',
	fromAccountId: 'corrente',
	toAccountId: 'reserva',
	amountCents: 100_000,
	date: '2026-11-07',
	note: 'CDB',
	updatedAt: '',
	...overrides,
});

let renderer: ReactTestRenderer | null = null;
let announce: jest.SpyInstance;

const render = async (props: Partial<React.ComponentProps<typeof TransferForm>> = {}) => {
	await act(async () => {
		renderer = create(<TransferForm onSubmit={jest.fn()} onCancel={jest.fn()} {...props} />);
	});
	// biome-ignore lint/style/noNonNullAssertion: acabou de ser criado
	return renderer!;
};

const queryTestId = (tree: ReactTestRenderer, testID: string): ReactTestInstance[] =>
	tree.root.findAll((node) => node.props.testID === testID && typeof node.type !== 'string');
const byTestId = (tree: ReactTestRenderer, testID: string): ReactTestInstance => {
	const [found] = queryTestId(tree, testID);
	if (!found) throw new Error(`${testID} não está na tela`);
	return found;
};

const press = async (tree: ReactTestRenderer, testID: string) => {
	await act(async () => {
		await byTestId(tree, testID).props.onPress();
	});
};

const typeAmount = async (tree: ReactTestRenderer, text: string) => {
	await act(async () => {
		byTestId(tree, 'transfer-form-amount').props.onChangeText(text);
	});
};

const summary = (tree: ReactTestRenderer): string => {
	const [node] = queryTestId(tree, 'transfer-form-error-summary');
	return node ? String(node.props.children) : '';
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
	mockSaveTransfer.mockImplementation(async () => true);
	mockAccounts.accounts = [CORRENTE, RESERVA, NUBANK, ANTIGA];
	mockAccounts.activeAccounts = [CORRENTE, RESERVA, NUBANK];
	announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
});

afterEach(() => {
	act(() => renderer?.unmount());
	renderer = null;
	announce.mockRestore();
	jest.useRealTimers();
});

describe('transferChoices', () => {
	it('cartão de crédito só é destino; arquivada fica fora das duas pontas', () => {
		const { from, to } = transferChoices([CORRENTE, RESERVA, NUBANK], [CORRENTE, RESERVA, NUBANK, ANTIGA]);
		expect(from.map((a) => a.id)).toEqual(['corrente', 'reserva']);
		expect(to.map((a) => a.id)).toEqual(['corrente', 'reserva', 'nubank']);
	});

	it('na edição, a conta arquivada que a transferência já usa continua na lista', () => {
		const { from, to } = transferChoices([CORRENTE, RESERVA], [CORRENTE, RESERVA, ANTIGA], { fromAccountId: 'antiga', toAccountId: 'reserva' });
		expect(from.map((a) => a.id)).toEqual(['corrente', 'reserva', 'antiga']);
		expect(to.map((a) => a.id)).toEqual(['corrente', 'reserva', 'antiga']);
	});
});

describe('validateTransfer', () => {
	it('De igual a Para não passa', () => {
		expect(validateTransfer({ amountText: '1.000,00', fromAccountId: 'corrente', toAccountId: 'corrente' })).toEqual({ to: 'sameAccount' });
	});

	it('sem valor, sem De e sem Para: um erro em cada campo', () => {
		expect(validateTransfer({ amountText: '0,00', fromAccountId: null, toAccountId: null })).toEqual({
			amount: 'amountRequired',
			from: 'fromRequired',
			to: 'toRequired',
		});
	});

	it('ponta "fora do app" só vale quando a transferência já era assim', () => {
		expect(validateTransfer({ amountText: '50,00', fromAccountId: null, toAccountId: 'reserva', outsideFrom: true })).toEqual({});
	});

	it('R$ 1.000 da Corrente para a Reserva passa', () => {
		expect(validateTransfer({ amountText: '1.000,00', fromAccountId: 'corrente', toAccountId: 'reserva' })).toEqual({});
	});
});

describe('TransferForm — nova transferência', () => {
	it('conta arquivada não aparece; cartão de crédito não é origem', async () => {
		const tree = await render();
		expect(queryTestId(tree, 'transfer-from-antiga')).toHaveLength(0);
		expect(queryTestId(tree, 'transfer-to-antiga')).toHaveLength(0);
		expect(queryTestId(tree, 'transfer-from-nubank')).toHaveLength(0);
		expect(queryTestId(tree, 'transfer-to-nubank').length).toBeGreaterThan(0);
		// Sem "fora do app" na nova: é entre contas suas.
		expect(queryTestId(tree, 'transfer-from-outside')).toHaveLength(0);
	});

	it('escolher a origem a tira de Para: De e Para iguais nem são oferecidos', async () => {
		const tree = await render();
		expect(queryTestId(tree, 'transfer-to-corrente').length).toBeGreaterThan(0);
		await press(tree, 'transfer-from-corrente');
		expect(queryTestId(tree, 'transfer-to-corrente')).toHaveLength(0);
		expect(queryTestId(tree, 'transfer-to-reserva').length).toBeGreaterThan(0);
	});

	it('Para já escolhido e a mesma conta em De: Para fica vazio, pede de novo e nada é gravado', async () => {
		const onSubmit = jest.fn();
		const tree = await render({ onSubmit });
		await press(tree, 'transfer-to-reserva');
		await press(tree, 'transfer-from-reserva');
		expect(queryTestId(tree, 'transfer-to-reserva')).toHaveLength(0);
		await typeAmount(tree, '1000');
		await press(tree, 'transfer-form-save');

		expect(summary(tree)).toBe('transactionForm.transfer.toRequired');
		expect(announce).toHaveBeenCalledWith('transactionForm.transfer.toRequired');
		expect(mockSaveTransfer).not.toHaveBeenCalled();
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it('sem nada preenchido: pede De, Para e valor', async () => {
		const tree = await render();
		await press(tree, 'transfer-form-save');
		expect(summary(tree)).toBe(
			'transactionForm.transfer.fromRequired. transactionForm.transfer.toRequired. transactionForm.amountRequired'
		);
		expect(mockSaveTransfer).not.toHaveBeenCalled();
	});

	it('R$ 1.000 da Corrente para a Reserva em 07/11 vai para saveTransfer e fecha a tela', async () => {
		const onSubmit = jest.fn();
		const tree = await render({ onSubmit });
		await press(tree, 'transfer-from-corrente');
		await press(tree, 'transfer-to-reserva');
		await typeAmount(tree, '1000');
		await act(async () => {
			byTestId(tree, 'transfer-form-note').props.onChangeText('Caixinha');
		});
		await press(tree, 'transfer-form-save');

		expect(mockSaveTransfer).toHaveBeenCalledWith({
			id: undefined,
			fromAccountId: 'corrente',
			toAccountId: 'reserva',
			amountCents: 100_000,
			date: '2026-11-07',
			note: 'Caixinha',
		});
		expect(onSubmit).toHaveBeenCalledTimes(1);
		// O "+" é uma aba: o formulário volta limpo para a próxima.
		expect(byTestId(tree, 'transfer-form-amount').props.value).toBe('');
	});

	it('para o cartão: avisa que é o pagamento de fatura e, se já estava registrado, diz e não fecha', async () => {
		mockSaveTransfer.mockImplementation(async () => false);
		const onSubmit = jest.fn();
		const tree = await render({ onSubmit });
		await press(tree, 'transfer-from-corrente');
		await press(tree, 'transfer-to-nubank');
		expect(queryTestId(tree, 'transfer-form-card-payment')).toHaveLength(1);
		// O pagamento de fatura não guarda descrição: o campo some em vez de ser ignorado.
		expect(queryTestId(tree, 'transfer-form-note')).toHaveLength(0);

		await typeAmount(tree, '1200');
		await press(tree, 'transfer-form-save');

		expect(mockSaveTransfer).toHaveBeenCalledWith(expect.objectContaining({ toAccountId: 'nubank', amountCents: 120_000, note: '' }));
		expect(String(byTestId(tree, 'transfer-form-notice').props.children)).toContain('transactionForm.transfer.cardPaymentAlready');
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it('falha ao gravar: mensagem junto do botão', async () => {
		mockSaveTransfer.mockImplementation(async () => {
			throw new Error('disco cheio');
		});
		jest.spyOn(console, 'error').mockImplementation(() => undefined);
		const tree = await render();
		await press(tree, 'transfer-from-corrente');
		await press(tree, 'transfer-to-reserva');
		await typeAmount(tree, '1000');
		await press(tree, 'transfer-form-save');
		expect(summary(tree)).toBe('transactionForm.saveFailed');
	});
});

describe('TransferForm — editar e apagar a partir de Lançamentos', () => {
	it('abre preenchido e grava a edição com o id da transferência', async () => {
		const onSubmit = jest.fn();
		const tree = await render({ initialTransfer: transfer(), onSubmit });
		expect(byTestId(tree, 'transfer-form-amount').props.value).toBe('1.000,00');
		expect(byTestId(tree, 'transfer-from-corrente').props.accessibilityState).toEqual({ selected: true });
		expect(byTestId(tree, 'transfer-to-reserva').props.accessibilityState).toEqual({ selected: true });

		await typeAmount(tree, '500');
		await press(tree, 'transfer-form-save');
		expect(mockSaveTransfer).toHaveBeenCalledWith({
			id: 't-1',
			fromAccountId: 'corrente',
			toAccountId: 'reserva',
			amountCents: 50_000,
			date: '2026-11-07',
			note: 'CDB',
		});
		expect(onSubmit).toHaveBeenCalledTimes(1);
	});

	it('E2E-42: a conta de origem não aparece em Para, como na criação', async () => {
		const tree = await render({ initialTransfer: transfer() });
		expect(byTestId(tree, 'transfer-from-corrente').props.accessibilityState).toEqual({ selected: true });
		expect(queryTestId(tree, 'transfer-to-corrente')).toHaveLength(0);
		expect(byTestId(tree, 'transfer-to-reserva').props.accessibilityState).toEqual({ selected: true });
		expect(queryTestId(tree, 'transfer-to-nubank').length).toBeGreaterThan(0);
	});

	it('trocar a origem pela conta de destino esvazia Para, e a origem antiga volta a ser destino', async () => {
		const tree = await render({ initialTransfer: transfer() });
		await press(tree, 'transfer-from-reserva');
		expect(queryTestId(tree, 'transfer-to-reserva')).toHaveLength(0);
		expect(byTestId(tree, 'transfer-to-corrente').props.accessibilityState).toEqual({ selected: false });
		await press(tree, 'transfer-form-save');
		expect(summary(tree)).toBe('transactionForm.transfer.toRequired');
		expect(mockSaveTransfer).not.toHaveBeenCalled();
	});

	it('excluir pergunta antes e, confirmado, apaga e fecha', async () => {
		const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
		const onSubmit = jest.fn();
		const tree = await render({ initialTransfer: transfer(), onSubmit });
		await press(tree, 'transfer-form-delete');

		expect(alert).toHaveBeenCalledWith('transactionForm.transfer.deleteTitle', 'transactionForm.transfer.deleteBody', expect.any(Array));
		expect(mockRemoveTransfer).not.toHaveBeenCalled();
		const buttons = alert.mock.calls[0][2] as AlertButton[];
		const confirm = buttons.find((button) => button.style === 'destructive');
		await act(async () => {
			await confirm?.onPress?.();
		});
		expect(mockRemoveTransfer).toHaveBeenCalledWith('t-1');
		expect(onSubmit).toHaveBeenCalledTimes(1);
		alert.mockRestore();
	});

	it('transferência que a captura gravou com uma ponta fora do app: a ponta continua "fora do app"', async () => {
		const tree = await render({ initialTransfer: transfer({ fromAccountId: null }) });
		expect(byTestId(tree, 'transfer-from-outside').props.accessibilityState).toEqual({ selected: true });
		await press(tree, 'transfer-form-save');
		expect(mockSaveTransfer).toHaveBeenCalledWith(expect.objectContaining({ id: 't-1', fromAccountId: null, toAccountId: 'reserva' }));
	});

	it('nova não tem botão de excluir', async () => {
		const tree = await render();
		expect(queryTestId(tree, 'transfer-form-delete')).toHaveLength(0);
	});
});
