/**
 * Transferência manual entre contas suas (E2E-28), como o usuário a vê no aparelho.
 *
 * O "+" só tinha Despesa e Receita: R$ 1.000 da Corrente para a Reserva não tinha como
 * ser registrado. O formulário pede De, Para, Valor, Data e Descrição; De e Para têm de
 * ser contas diferentes, o valor maior que zero, e conta arquivada não aparece. Para um
 * cartão de crédito é o pagamento de fatura (`saveTransfer` manda para `recordCardPayment`).
 *
 * As traduções aparecem como chave crua; o contexto de contas é dublê — a conta do saldo
 * e do mês está em `accountsTransferSql.test.tsx`. De e Para são listas que abrem de baixo
 * (SPD-130): escolher é tocar no campo e depois na conta.
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

jest.mock('react-native-safe-area-context', () => ({
	useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

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

// A primeira lista aberta carrega a folha (Modal): com a suíte inteira rodando, passa dos 5 s.
jest.setTimeout(20_000);

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

/** O controle tocável com o testID (o campo de lista também leva o testID, sem toque). */
const control = (tree: ReactTestRenderer, testID: string): ReactTestInstance => {
	const [found] = tree.root.findAll((node) => node.props.testID === testID && typeof node.props.onPress === 'function');
	if (!found) throw new Error(`${testID} não está na tela`);
	return found;
};

const press = async (tree: ReactTestRenderer, testID: string) => {
	await act(async () => {
		await control(tree, testID).props.onPress();
	});
};

const closeList = async (tree: ReactTestRenderer) => {
	const [close] = tree.root.findAll((node) => node.props.accessibilityLabel === 'cards.close' && typeof node.props.onPress === 'function');
	await act(async () => {
		close.props.onPress();
	});
};

/** As contas da lista de De ou Para: abre o campo, lê as linhas e fecha. */
const listed = async (tree: ReactTestRenderer, side: 'from' | 'to'): Promise<string[]> => {
	await press(tree, `transfer-form-${side}`);
	const ids = [
		...new Set(
			tree.root
				.findAll((node) => typeof node.props.testID === 'string' && node.props.testID.startsWith(`transfer-${side}-`))
				.map((node) => node.props.testID.slice(`transfer-${side}-`.length))
		),
	];
	await closeList(tree);
	return ids;
};

/** Escolhe a conta em De ou Para: toca o campo e a linha. */
const choose = async (tree: ReactTestRenderer, side: 'from' | 'to', id: string) => {
	await press(tree, `transfer-form-${side}`);
	await press(tree, `transfer-${side}-${id}`);
};

/** O que o campo De ou Para mostra (o rótulo do botão: nome do campo e valor). */
const shown = (tree: ReactTestRenderer, side: 'from' | 'to'): string => control(tree, `transfer-form-${side}`).props.accessibilityLabel;

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
		// Sem "fora do app" na nova: é entre contas suas.
		expect(await listed(tree, 'from')).toEqual(['corrente', 'reserva']);
		expect(await listed(tree, 'to')).toEqual(['corrente', 'reserva', 'nubank']);
	});

	it('escolher a origem a tira de Para: De e Para iguais nem são oferecidos', async () => {
		const tree = await render();
		expect(await listed(tree, 'to')).toContain('corrente');
		await choose(tree, 'from', 'corrente');
		expect(await listed(tree, 'to')).toEqual(['reserva', 'nubank']);
	});

	it('Para já escolhido e a mesma conta em De: Para fica vazio, pede de novo e nada é gravado', async () => {
		const onSubmit = jest.fn();
		const tree = await render({ onSubmit });
		await choose(tree, 'to', 'reserva');
		await choose(tree, 'from', 'reserva');
		expect(await listed(tree, 'to')).not.toContain('reserva');
		expect(shown(tree, 'to')).toBe('transactionForm.transfer.to, select.placeholder');
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
		await choose(tree, 'from', 'corrente');
		await choose(tree, 'to', 'reserva');
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
		await choose(tree, 'from', 'corrente');
		await choose(tree, 'to', 'nubank');
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
		await choose(tree, 'from', 'corrente');
		await choose(tree, 'to', 'reserva');
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
		expect(shown(tree, 'from')).toBe('transactionForm.transfer.from, Corrente');
		expect(shown(tree, 'to')).toBe('transactionForm.transfer.to, Reserva');

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
		expect(shown(tree, 'from')).toBe('transactionForm.transfer.from, Corrente');
		expect(await listed(tree, 'to')).toEqual(['reserva', 'nubank']);
		// Na lista aberta, a de destino vem marcada.
		await press(tree, 'transfer-form-to');
		expect(control(tree, 'transfer-to-reserva').props.accessibilityState).toEqual({ selected: true });
		expect(control(tree, 'transfer-to-nubank').props.accessibilityState).toEqual({ selected: false });
	});

	it('trocar a origem pela conta de destino esvazia Para, e a origem antiga volta a ser destino', async () => {
		const tree = await render({ initialTransfer: transfer() });
		await choose(tree, 'from', 'reserva');
		expect(shown(tree, 'to')).toBe('transactionForm.transfer.to, select.placeholder');
		expect(await listed(tree, 'to')).toEqual(['corrente', 'nubank']);
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
		expect(shown(tree, 'from')).toBe('transactionForm.transfer.from, transactionForm.transfer.outside');
		await press(tree, 'transfer-form-from');
		expect(control(tree, 'transfer-from-outside').props.accessibilityState).toEqual({ selected: true });
		await closeList(tree);
		await press(tree, 'transfer-form-save');
		expect(mockSaveTransfer).toHaveBeenCalledWith(expect.objectContaining({ id: 't-1', fromAccountId: null, toAccountId: 'reserva' }));
	});

	it('nova não tem botão de excluir', async () => {
		const tree = await render();
		expect(queryTestId(tree, 'transfer-form-delete')).toHaveLength(0);
	});
});
