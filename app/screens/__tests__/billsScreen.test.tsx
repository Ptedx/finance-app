/**
 * "Já paguei" na tela de contas a pagar (E2E-23): antes só marcava a conta como paga, e o
 * saldo da conta e o gasto do mês ficavam sem o pagamento. Agora, quando o app vai lançar a
 * saída, a tela pergunta antes ("Lançar a saída de R$ 120,00 da conta Corrente Teste?"),
 * com a opção de só marcar.
 *
 * O que o "Já paguei" grava é do `BillsContext` (testado lá); aqui ele é um dublê e a
 * pergunta é o que a tela mostra e o que ela pede ao contexto. As chaves de tradução
 * aparecem cruas, com os valores entre chaves.
 */

import type { BillPaymentPlan } from '../../contexts/BillsContext';
import type { Bill } from '../../database/schema';

const mockMarkPaid = jest.fn();
const mockUndoPaid = jest.fn();
const mockPlanPayment = jest.fn();
let mockRows: { bill: Bill; status: string; dueDate: string }[] = [];

jest.mock('expo-router', () => ({
	useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
	Stack: { Screen: () => null },
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('react-native-safe-area-context', () => {
	const { View } = require('react-native');
	return { SafeAreaView: View };
});

jest.mock('react-i18next', () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) => (options ? `${key}${JSON.stringify(options)}` : key),
	}),
}));

jest.mock('../../components/bills/BillStatusPill', () => () => null);

jest.mock('../../contexts/BillsContext', () => ({
	markPaidTransactionId: (id: string, month: string) => `lancamento-${id}-${month}`,
	useBills: () => ({
		bills: mockRows.map((row) => row.bill),
		month: { month: '2026-11', rows: mockRows, dueCents: 0, variableCount: 0, lateCount: 0 },
		isLoading: false,
		planPayment: (id: string) => mockPlanPayment(id),
		markPaid: (id: string, options?: { post?: boolean }) => mockMarkPaid(id, options),
		undoPaid: (id: string) => mockUndoPaid(id),
	}),
}));

jest.mock('../../contexts/AccountsContext', () => ({
	useAccounts: () => ({ accounts: [{ id: 'corrente', name: 'Corrente Teste' }] }),
}));

import { AccessibilityInfo, Alert, type AlertButton } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { formatCents } from '../../utils/money';
import BillsScreen from '../BillsScreen';

jest.setTimeout(20_000);

let renderer: ReactTestRenderer;
const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});

const INTERNET: Bill = {
	id: 'internet',
	name: 'Internet teste',
	dueDay: 10,
	amountCents: 12_000,
	accountId: 'corrente',
	category: 'utilities',
	matchHint: null,
	debtId: null,
	paidThrough: '2026-10',
	paidByRef: null,
	active: true,
	sortOrder: 0,
	updatedAt: '2026-11-01T00:00:00.000Z',
};

const POST: BillPaymentPlan = {
	kind: 'post',
	id: 'lancamento',
	draft: {
		amountCents: 12_000,
		category: 'utilities',
		date: '2026-11-07',
		note: 'Internet teste',
		isIncome: false,
		accountId: 'corrente',
	},
};

const isHostText = (node: ReactTestInstance): boolean => (node.type as unknown) === 'Text';

/** Deixa correr o que o toque disparou até parar (numa pergunta aberta, por exemplo). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Toca no que tem este texto: sobe da etiqueta até quem recebe o toque. Não espera o toque
 * terminar — com a pergunta aberta ele só termina quando um botão dela é apertado.
 */
const press = async (label: string) => {
	const text = renderer.root.find((node) => isHostText(node) && node.props.children === label);
	let target: ReactTestInstance | null = text;
	while (target && !target.props.onPress) target = target.parent;
	if (!target) throw new Error(`nada tocável em ${label}`);
	const onPress = target.props.onPress as () => unknown;
	await act(async () => {
		void onPress();
		await settle();
	});
};

/** O último `Alert.alert`, com o botão pedido apertado. */
const pressAlertButton = async (text: string) => {
	const buttons = alertSpy.mock.calls.at(-1)?.[2] as AlertButton[];
	const button = buttons.find((candidate) => candidate.text === text);
	if (!button) throw new Error(`sem botão ${text}`);
	await act(async () => {
		button.onPress?.();
		await settle();
	});
};

const mount = async () => {
	await act(async () => {
		renderer = create(<BillsScreen />);
	});
};

beforeEach(() => {
	jest.clearAllMocks();
	mockRows = [{ bill: { ...INTERNET }, status: 'upcoming', dueDate: '2026-11-10' }];
	mockPlanPayment.mockResolvedValue(POST);
	mockMarkPaid.mockImplementation(async (_id: string, options?: { post?: boolean }) => ({
		...POST,
		posted: options?.post !== false,
	}));
});

afterEach(async () => {
	await act(async () => {
		renderer?.unmount();
	});
});

describe('"Já paguei" que lança a saída', () => {
	it('pergunta antes, com o valor e a conta que paga', async () => {
		await mount();
		await press('bills.markPaid');

		expect(mockMarkPaid).not.toHaveBeenCalled();
		const [title, body, buttons] = alertSpy.mock.calls.at(-1) ?? [];
		expect(title).toBe('bills.pay.title');
		expect(body).toContain(formatCents(12_000));
		expect(body).toContain('Corrente Teste');
		expect((buttons as AlertButton[]).map((button) => button.text)).toEqual([
			'bills.pay.cancel',
			'bills.pay.onlyMark',
			'bills.pay.post',
		]);
	});

	it('"Lançar e marcar paga" lança', async () => {
		await mount();
		await press('bills.markPaid');
		await pressAlertButton('bills.pay.post');
		expect(mockMarkPaid).toHaveBeenCalledWith('internet', { post: true });
	});

	it('"Só marcar como paga" marca sem lançar', async () => {
		await mount();
		await press('bills.markPaid');
		await pressAlertButton('bills.pay.onlyMark');
		expect(mockMarkPaid).toHaveBeenCalledWith('internet', { post: false });
	});

	it('"Cancelar" não faz nada', async () => {
		await mount();
		await press('bills.markPaid');
		await pressAlertButton('bills.pay.cancel');
		expect(mockMarkPaid).not.toHaveBeenCalled();
	});

	it('conta a pagar sem conta de pagamento: o texto diz que o lançamento fica sem conta', async () => {
		mockPlanPayment.mockResolvedValue({ ...POST, draft: { ...POST.draft, accountId: null } });
		await mount();
		await press('bills.markPaid');
		expect(alertSpy.mock.calls.at(-1)?.[1]).toContain('bills.pay.bodyNoAccount');
	});
});

describe('"Já paguei" que não lança', () => {
	it('já há lançamento que casa: marca direto, sem perguntar, e diz que achou (SPD-145)', async () => {
		const matched = { kind: 'matched', ref: 'pix', amountCents: 12_000, date: '2026-11-05' };
		mockPlanPayment.mockResolvedValue(matched);
		mockMarkPaid.mockResolvedValue({ ...matched, posted: false, month: '2026-11' });
		await mount();
		await press('bills.markPaid');

		expect(mockMarkPaid).toHaveBeenCalledWith('internet', undefined);
		// A única janela vem depois de marcar: é o aviso de que o pagamento já estava lançado.
		expect(alertSpy).toHaveBeenCalledTimes(1);
		const [title, body] = alertSpy.mock.calls[0];
		expect(title).toBe('bills.pay.foundTitle');
		expect(body).toContain(formatCents(12_000));
		expect(body).toContain('"month":"November"');
	});

	it('o aviso do banco está na caixa de entrada: marca e diz que o lançamento vem de lá', async () => {
		mockPlanPayment.mockResolvedValue({ kind: 'inbox' });
		mockMarkPaid.mockResolvedValue({ kind: 'inbox', posted: false });
		await mount();
		await press('bills.markPaid');

		expect(mockMarkPaid).toHaveBeenCalledWith('internet', undefined);
		expect(alertSpy.mock.calls.at(-1)?.[0]).toBe('bills.pay.inboxTitle');
	});

	it('paga: "Desfazer" desfaz', async () => {
		mockRows = [{ bill: { ...INTERNET, paidThrough: '2026-11' }, status: 'paid', dueDate: '2026-11-10' }];
		await mount();
		await press('bills.undoPaid');
		expect(mockUndoPaid).toHaveBeenCalledWith('internet');
		expect(mockPlanPayment).not.toHaveBeenCalled();
	});
});

/**
 * SPD-145: com outubro em aberto, o "Já paguei" do mês atual quita outubro primeiro — e diz
 * isso antes, no botão e na pergunta ("Quitar outubro?").
 */
describe('"Já paguei" com outubro em aberto', () => {
	beforeEach(() => {
		mockRows = [{ bill: { ...INTERNET, paidThrough: '2026-09' }, status: 'upcoming', dueDate: '2026-11-10' }];
	});

	const markOlder = 'bills.markPaidOlder{"month":"October"}';

	it('o botão diz que quita outubro', async () => {
		await mount();
		const shown = renderer.root.findAll(isHostText).map((node) => node.props.children);
		expect(shown).toContain(markOlder);
		expect(shown).not.toContain('bills.markPaid');
	});

	it('lançar: a pergunta tem o mês no título, e "Lançar" marca', async () => {
		await mount();
		await press(markOlder);

		expect(mockMarkPaid).not.toHaveBeenCalled();
		const [title, body, buttons] = alertSpy.mock.calls.at(-1) ?? [];
		expect(title).toBe('bills.pay.titleMonth{"month":"October"}');
		expect(body).toContain('bills.pay.olderBody');
		expect(body).toContain(formatCents(12_000));
		expect((buttons as AlertButton[]).map((button) => button.text)).toEqual([
			'bills.pay.cancel',
			'bills.pay.onlyMark',
			'bills.pay.post',
		]);
		await pressAlertButton('bills.pay.post');
		expect(mockMarkPaid).toHaveBeenCalledWith('internet', { post: true });
	});

	it('pagamento de outubro já lançado: pergunta, dizendo o que achou, antes de marcar', async () => {
		const matched = { kind: 'matched', ref: 'pix', amountCents: 12_000, date: '2026-10-20' };
		mockPlanPayment.mockResolvedValue(matched);
		mockMarkPaid.mockResolvedValue({ ...matched, posted: false, month: '2026-10' });
		await mount();
		await press(markOlder);

		expect(mockMarkPaid).not.toHaveBeenCalled();
		const [title, body, buttons] = alertSpy.mock.calls.at(-1) ?? [];
		expect(title).toBe('bills.pay.titleMonth{"month":"October"}');
		expect(body).toContain('bills.pay.foundBody');
		expect((buttons as AlertButton[]).map((button) => button.text)).toEqual([
			'bills.pay.cancel',
			'bills.pay.confirmMonth{"month":"October"}',
		]);
		await pressAlertButton('bills.pay.confirmMonth{"month":"October"}');
		expect(mockMarkPaid).toHaveBeenCalledWith('internet', undefined);
		// Já disse o que achou na pergunta: não repete depois.
		expect(alertSpy).toHaveBeenCalledTimes(1);
	});

	it('valor que varia: pergunta e, cancelado, não marca', async () => {
		mockPlanPayment.mockResolvedValue({ kind: 'none' });
		await mount();
		await press(markOlder);

		expect(alertSpy.mock.calls.at(-1)?.[1]).toContain('bills.pay.olderBody');
		await pressAlertButton('bills.pay.cancel');
		expect(mockMarkPaid).not.toHaveBeenCalled();
	});
});
