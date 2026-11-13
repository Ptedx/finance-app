/**
 * O aviso de "Lançamento adicionado" diz a conta a pagar e o mês que a confirmação quitou
 * (SPD-153). Desde o SPD-145 a baixa automática quita o mês mais antigo em aberto, que pode
 * não ser o do pagamento: quem pagou "novembro" com outubro em aberto precisa ler que foi
 * outubro. O mês sai no idioma do app; o "Desfazer" continua o mesmo. Em "Aprovados
 * automaticamente", a linha diz a conta que o lançamento quitou, sem o mês: o `paidByRef` não
 * diz o mês com segurança ("Só marcar" avança o mês e mantém a referência). Desde o SPD-146 a
 * baixa grava o registro do mês com o lançamento: com ele, a linha diz o mês ("quitou Aluguel
 * de outubro"); sem ele, continua só o nome. O resto da tela é dublê; as chaves de tradução
 * aparecem cruas.
 */

const mockUndo = jest.fn(async () => undefined);
const mockData: { lastAction: unknown; resolved: unknown[] } = { lastAction: null, resolved: [] };
const mockBills: unknown[] = [];
const mockBillPayments: unknown[] = [];

jest.mock('../../database/database', () => ({
	...jest.requireActual('../../database/database'),
	getBills: jest.fn(async () => [...mockBills]),
	getBillPayments: jest.fn(async () => [...mockBillPayments]),
}));

jest.mock('@react-native-async-storage/async-storage', () =>
	require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

jest.mock('expo-sqlite', () => ({
	openDatabaseSync: () => ({
		execAsync: jest.fn(async () => undefined),
		runAsync: jest.fn(async () => ({ changes: 0, lastInsertRowId: 0 })),
		getFirstAsync: jest.fn(async () => null),
		getAllAsync: jest.fn(async () => []),
		withTransactionAsync: jest.fn(async (body: () => Promise<void>) => body()),
	}),
}));

jest.mock('expo-router', () => ({
	useRouter: () => ({ replace: jest.fn(), back: jest.fn(), push: jest.fn() }),
	Stack: { Screen: () => null },
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('react-native-safe-area-context', () => {
	const { View } = require('react-native');
	return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) };
});

jest.mock('react-i18next', () => ({
	useTranslation: () => ({
		t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
	}),
}));

jest.mock('../../contexts/AccountsContext', () => ({
	useAccounts: () => ({ accounts: [], activeAccounts: [] }),
}));

jest.mock('../../contexts/TransactionsContext', () => ({
	useTransactions: () => ({ transactions: [], categories: [] }),
}));

jest.mock('../../contexts/CapturesContext', () => ({
	useCaptures: () => ({
		supported: true,
		enabled: true,
		pending: [],
		resolved: mockData.resolved,
		ignoredApps: [],
		isLoading: false,
		lastAction: mockData.lastAction,
		refresh: jest.fn(),
		openSettings: jest.fn(),
		confirm: jest.fn(),
		dismiss: jest.fn(),
		markTransfer: jest.fn(),
		answerDuplicate: jest.fn(),
		answerTransfer: jest.fn(),
		revert: jest.fn(),
		unignoreApp: jest.fn(),
		undo: mockUndo,
		clearUndo: jest.fn(),
	}),
}));

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { Bill, BillPayment, Capture } from '../../database/schema';
import { emitBillsChanged } from '../../utils/billEvents';
import { configureDateLocale } from '../../utils/dateUtils';
import CaptureInboxScreen from '../CaptureInboxScreen';

jest.setTimeout(20_000);

let renderer: ReactTestRenderer;

const mount = async (lastAction: unknown) => {
	mockData.lastAction = lastAction;
	await act(async () => {
		renderer = create(<CaptureInboxScreen />);
	});
};

/** O texto da barra do desfazer (a região que o leitor de tela anuncia). */
const undoText = (): string => {
	const bar = renderer.root.findAll((node) => node.props.accessibilityLiveRegion === 'polite')[0];
	if (!bar) throw new Error('a barra do desfazer não apareceu');
	const texts = bar.findAll((node) => typeof node.props.children === 'string');
	return texts[0].props.children as string;
};

const confirmed = (bill: { name: string; month: string } | null) => ({
	kind: 'confirm',
	ids: ['cap-1'],
	at: Date.now(),
	bill,
});

beforeEach(() => {
	mockUndo.mockClear();
	mockData.resolved = [];
	mockBills.length = 0;
	mockBillPayments.length = 0;
	configureDateLocale('pt-BR');
});

afterEach(() => {
	act(() => renderer.unmount());
	configureDateLocale('pt-BR');
});

describe('o aviso da confirmação diz o mês quitado', () => {
	it('outubro em aberto, hoje em novembro: diz a conta e outubro', async () => {
		await mount(confirmed({ name: 'Aluguel', month: '2026-10' }));

		expect(undoText()).toBe(`captures.done.confirmBill ${JSON.stringify({ name: 'Aluguel', month: 'outubro' })}`);
	});

	it('só o mês atual em aberto: diz o mês atual também', async () => {
		await mount(confirmed({ name: 'Aluguel', month: '2026-11' }));

		expect(undoText()).toBe(`captures.done.confirmBill ${JSON.stringify({ name: 'Aluguel', month: 'novembro' })}`);
	});

	it('o mês sai no idioma do app', async () => {
		configureDateLocale('en-US');
		await mount(confirmed({ name: 'Rent', month: '2026-10' }));
		expect(undoText()).toBe(`captures.done.confirmBill ${JSON.stringify({ name: 'Rent', month: 'October' })}`);
		act(() => renderer.unmount());

		configureDateLocale('it-IT');
		await mount(confirmed({ name: 'Affitto', month: '2026-10' }));
		expect(undoText()).toBe(`captures.done.confirmBill ${JSON.stringify({ name: 'Affitto', month: 'ottobre' })}`);
	});

	it('sem conta quitada, o aviso continua o de sempre', async () => {
		await mount(confirmed(null));

		expect(undoText()).toBe('captures.done.confirm');
	});

	it('o "Desfazer" continua no aviso e desfaz', async () => {
		await mount(confirmed({ name: 'Aluguel', month: '2026-10' }));

		const button = renderer.root.findAll(
			(node) => node.props.accessibilityLabel === 'captures.undo' && typeof node.props.onPress === 'function'
		)[0];
		expect(button).toBeDefined();
		await act(async () => {
			button.props.onPress();
		});
		expect(mockUndo).toHaveBeenCalledTimes(1);
	});
});

describe('"Aprovados automaticamente" diz a conta que o lançamento quitou', () => {
	const autoCapture = (overrides: Partial<Capture> = {}): Capture =>
		({
			id: 'cap-auto',
			fingerprint: 'fp',
			packageName: 'com.example.bank',
			appLabel: 'Banco',
			title: 'Pix enviado',
			text: 'Pix enviado para Imobiliaria Exemplo',
			postedAt: '2026-11-05T15:00:00.000Z',
			amountCents: 150_000,
			direction: 'out',
			kind: 'pix_out',
			counterparty: 'IMOBILIARIA EXEMPLO',
			merchantKey: 'imobiliaria exemplo',
			cardLast4: null,
			status: 'confirmed',
			question: null,
			relatedId: null,
			suggestedCategory: null,
			transactionId: 'tx-auto',
			autoConfirmed: true,
			reason: 'rule',
			accountId: null,
			transferId: null,
			installments: null,
			createdAt: '',
			updatedAt: new Date().toISOString(),
			...overrides,
		}) as Capture;

	const bill = (overrides: Partial<Bill> = {}): Bill =>
		({
			id: 'aluguel',
			name: 'Aluguel',
			dueDay: 10,
			amountCents: 150_000,
			accountId: null,
			category: null,
			matchHint: 'imobiliaria',
			debtId: null,
			paidThrough: '2026-10',
			paidByRef: 'tx-auto',
			active: true,
			sortOrder: 0,
			updatedAt: '',
			...overrides,
		}) as Bill;

	/** Todos os textos da tela, cada `Text` com os filhos juntos. */
	const screenTexts = (): string[] =>
		renderer.root
			.findAll((node) => Array.isArray(node.props.children) || typeof node.props.children === 'string')
			.map((node) => {
				const children = node.props.children;
				const flat = Array.isArray(children) ? children : [children];
				return flat.filter((child: unknown) => typeof child === 'string').join('');
			});

	const SETTLED = `captures.settledBill ${JSON.stringify({ name: 'Aluguel' })}`;

	it('o lançamento da captura é o paidByRef da conta: a linha diz "quitou Aluguel", sem o mês', async () => {
		mockData.resolved = [autoCapture()];
		mockBills.push(bill());

		await mount(null);

		expect(screenTexts().some((text) => text.includes(SETTLED))).toBe(true);
		// O mês não aparece: o paidByRef não diz com segurança qual foi.
		expect(screenTexts().some((text) => text.includes('outubro'))).toBe(false);
	});

	it('conta que não foi quitada por ele: nada', async () => {
		mockData.resolved = [autoCapture()];
		mockBills.push(bill({ paidByRef: 'outro-lancamento' }));

		await mount(null);

		expect(screenTexts().some((text) => text.includes('captures.settledBill'))).toBe(false);
	});

	it('a baixa que chega depois aparece sem sair da tela', async () => {
		mockData.resolved = [autoCapture()];

		await mount(null);
		expect(screenTexts().some((text) => text.includes(SETTLED))).toBe(false);

		mockBills.push(bill());
		await act(async () => {
			emitBillsChanged();
		});

		expect(screenTexts().some((text) => text.includes(SETTLED))).toBe(true);
	});

	// SPD-146: o registro do mês guarda o lançamento que o pagou.
	const payment = (overrides: Partial<BillPayment> = {}): BillPayment => ({
		id: 'pagamento-outubro',
		billId: 'aluguel',
		month: '2026-10',
		status: 'paid',
		transactionId: 'tx-auto',
		amountCents: 150_000,
		updatedAt: '',
		...overrides,
	});
	const SETTLED_OCTOBER = `captures.settledBillMonth ${JSON.stringify({ name: 'Aluguel', month: 'outubro' })}`;

	it('com o registro do mês pago pelo lançamento, a linha diz a conta e o mês', async () => {
		mockData.resolved = [autoCapture()];
		// "Só marcar" depois levou paidThrough a novembro: o mês sai do registro, não de paidThrough.
		mockBills.push(bill({ paidThrough: '2026-11' }));
		mockBillPayments.push(payment());

		await mount(null);

		expect(screenTexts().some((text) => text.includes(SETTLED_OCTOBER))).toBe(true);
		expect(screenTexts().some((text) => text.includes(SETTLED))).toBe(false);
	});

	it('o registro diz a conta mesmo quando a última baixa já é de outro lançamento', async () => {
		mockData.resolved = [autoCapture()];
		mockBills.push(bill({ paidByRef: 'outro-lancamento', paidThrough: '2026-11' }));
		mockBillPayments.push(payment());

		await mount(null);

		expect(screenTexts().some((text) => text.includes(SETTLED_OCTOBER))).toBe(true);
	});

	it('registro de outro lançamento não dá mês: só o nome, pela última baixa', async () => {
		mockData.resolved = [autoCapture()];
		mockBills.push(bill());
		mockBillPayments.push(payment({ transactionId: 'outro-lancamento' }));

		await mount(null);

		expect(screenTexts().some((text) => text.includes(SETTLED))).toBe(true);
		expect(screenTexts().some((text) => text.includes('captures.settledBillMonth'))).toBe(false);
	});
});
