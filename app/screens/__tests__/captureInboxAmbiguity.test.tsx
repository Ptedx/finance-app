/**
 * O aviso ambíguo na revisão (SPD-123): a linha que diz por que ele está ali, a pergunta
 * certa para cada caso — entrou ou saiu; de qual conta saiu o pagamento da fatura, ou não
 * lançar — e o porquê do item que a regra aprendida lançou, no histórico.
 *
 * Os rótulos são testados no português de verdade (falha se a chave não existir); a tela
 * montada usa chaves cruas e dublês dos contextos, como `captureInboxAccount.test.tsx`.
 */

const mockConfirm = jest.fn(async (..._args: unknown[]) => undefined);
const mockAnswerDirection = jest.fn(async (..._args: unknown[]) => undefined);
const mockResolveInvoice = jest.fn(async (..._args: unknown[]) => true);
const mockData: { pending: unknown[]; accounts: unknown[] } = { pending: [], accounts: [] };

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

jest.mock('../../components/HorizontalCategoryPicker', () => () => null);

jest.mock('../../contexts/AccountsContext', () => ({
	useAccounts: () => ({ accounts: mockData.accounts, activeAccounts: mockData.accounts }),
}));

jest.mock('../../contexts/TransactionsContext', () => ({
	useTransactions: () => ({
		transactions: [],
		categories: [
			{ id: 'food', name: 'Alimentação', type: 'expense', color: '#fff', icon: 'pizza' },
			{ id: 'other_income', name: 'Outras receitas', type: 'income', color: '#fff', icon: 'cash' },
		],
	}),
}));

jest.mock('../../contexts/CapturesContext', () => ({
	useCaptures: () => ({
		supported: true,
		enabled: true,
		pending: mockData.pending,
		resolved: [],
		ignoredApps: [],
		isLoading: false,
		lastAction: null,
		refresh: jest.fn(),
		openSettings: jest.fn(),
		confirm: mockConfirm,
		dismiss: jest.fn(),
		markTransfer: jest.fn(),
		answerDuplicate: jest.fn(),
		answerTransfer: jest.fn(),
		answerDirection: mockAnswerDirection,
		resolveInvoicePayment: mockResolveInvoice,
		revert: jest.fn(),
		unignoreApp: jest.fn(),
		undo: jest.fn(),
		clearUndo: jest.fn(),
	}),
}));

import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { Account, Capture } from '../../database/schema';
import pt from '../../i18n/locales/pt';
import { AMBIGUITY_CASES, ambiguousReason, learnedReason } from '../../utils/ambiguityReasons';
import CaptureInboxScreen, { ambiguityLine, resolvedDetail, resolvedReasonLabel } from '../CaptureInboxScreen';

jest.setTimeout(20_000);

/** `t` mínimo no português de verdade, interpolando `{{assim}}`. */
const tPt = (key: string, options: Record<string, unknown> = {}): string => {
	const found = key
		.split('.')
		.reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], pt as unknown);
	if (typeof found !== 'string') throw new Error(`chave de tradução ausente: ${key}`);
	return found.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options[name]));
};

const account = (id: string, name: string, kind: Account['kind']): Account => ({
	id,
	name,
	kind,
	role: kind === 'credit_card' ? 'card' : 'main',
	envelopeMonthlyCents: null,
	bankName: null,
	color: '#15E8FE',
	last4: null,
	network: null,
	closingDay: kind === 'credit_card' ? 10 : null,
	dueDay: null,
	closingDaysBefore: null,
	creditLimitCents: null,
	cardNames: null,
	packageName: null,
	accountKey: null,
	openingBalanceCents: 0,
	openingBalanceDate: '2026-11-01',
	sortOrder: 0,
	archived: false,
	updatedAt: '',
});

const CHECKING = account('conta-a', 'Conta A', 'checking');
const CARD = account('cartao-b', 'Cartão B', 'credit_card');

const capture = (overrides: Partial<Capture> = {}): Capture => ({
	id: 'cap-1',
	fingerprint: 'fp',
	packageName: 'com.example.bank',
	appLabel: 'Banco',
	title: 'Aviso',
	text: 'Texto inventado',
	postedAt: '2026-11-07T15:00:00.000Z',
	amountCents: 2_000,
	direction: 'out',
	kind: 'pix_out',
	counterparty: null,
	merchantKey: null,
	cardLast4: null,
	status: 'pending',
	question: null,
	relatedId: null,
	suggestedCategory: 'food',
	transactionId: null,
	autoConfirmed: false,
	reason: null,
	accountId: null,
	transferId: null,
	installments: null,
	createdAt: '',
	updatedAt: '',
	...overrides,
});

describe('a linha que explica o aviso ambíguo', () => {
	it.each(AMBIGUITY_CASES)('%s: tem texto próprio e o aviso de que a resposta fica guardada', (ambiguity) => {
		const line = ambiguityLine(capture({ reason: ambiguousReason(ambiguity), cardLast4: '4321' }), tPt);
		expect(line.text).not.toBe('');
		expect(line.text).not.toContain('{{');
		expect(line.remember).toBe(tPt('captures.ambiguity.remember'));
	});

	it('o final desconhecido aparece na linha', () => {
		const line = ambiguityLine(capture({ reason: ambiguousReason('debit_unknown_last4'), cardLast4: '4321' }), tPt);
		expect(line.text).toContain('4321');
	});

	it('a regra aprendida diz que decidiu, sem pergunta', () => {
		const line = ambiguityLine(capture({ reason: learnedReason('purchase_no_kind') }), tPt);
		expect(line).toEqual({ text: tPt('captures.ambiguity.learned'), remember: '' });
	});

	it('o item que não é ambíguo não ganha linha', () => {
		expect(ambiguityLine(capture({ reason: 'foreign_currency' }), tPt)).toEqual({ text: '', remember: '' });
		expect(ambiguityLine(capture({ reason: null }), tPt)).toEqual({ text: '', remember: '' });
	});
});

describe('o porquê no histórico', () => {
	it.each(AMBIGUITY_CASES)('%s: os dois motivos têm tradução', (ambiguity) => {
		expect(resolvedReasonLabel({ reason: ambiguousReason(ambiguity), appLabel: 'Banco' }, tPt)).not.toBe('');
		expect(resolvedReasonLabel({ reason: learnedReason(ambiguity), appLabel: 'Banco' }, tPt)).not.toBe('');
	});

	it('o lançamento da regra aprendida mostra a categoria e o porquê', () => {
		const reason = resolvedReasonLabel({ reason: learnedReason('debit_unknown_last4'), appLabel: 'Banco' }, tPt);
		expect(resolvedDetail({ status: 'confirmed', reason: learnedReason('debit_unknown_last4') }, 'Mercado', reason)).toBe(
			`Mercado · ${reason}`
		);
	});

	it('o confirmado comum continua só com a categoria; o resto, só o porquê', () => {
		expect(resolvedDetail({ status: 'confirmed', reason: ambiguousReason('purchase_no_kind') }, 'Mercado', 'x')).toBe(
			'Mercado'
		);
		expect(resolvedDetail({ status: 'confirmed', reason: 'rule' }, 'Mercado', 'Aprendido')).toBe('Mercado');
		expect(resolvedDetail({ status: 'ignored', reason: learnedReason('invoice_payment') }, null, 'Fatura')).toBe('Fatura');
	});
});

let renderer: ReactTestRenderer;
let mounted = false;

const mount = async (pending: Capture) => {
	mockData.pending = [pending];
	mockData.accounts = [CHECKING, CARD];
	await act(async () => {
		renderer = create(<CaptureInboxScreen />);
	});
	mounted = true;
};

const pressable = (label: string): ReactTestInstance | undefined =>
	renderer.root.findAll(
		(node) => node.props.accessibilityLabel === label && typeof node.props.onPress === 'function'
	)[0];

const press = async (label: string) => {
	const target = pressable(label);
	if (!target) throw new Error(`nada tocável com o rótulo ${label}`);
	await act(async () => {
		target.props.onPress();
	});
};

const texts = (): string[] =>
	renderer.root
		.findAll((node) => (node.type as unknown) === 'Text')
		.flatMap((node) => node.children.filter((child): child is string => typeof child === 'string'));

beforeEach(() => {
	mockConfirm.mockClear();
	mockAnswerDirection.mockClear();
	mockResolveInvoice.mockClear();
});

afterEach(() => {
	// Os testes de rótulo não montam a tela.
	if (mounted) act(() => renderer.unmount());
	mounted = false;
});

describe('a pergunta "entrou ou saiu" (NOTIF-11)', () => {
	it('aparece no aviso com as duas pistas e manda a resposta', async () => {
		await mount(capture({ reason: ambiguousReason('pix_direction'), accountId: CHECKING.id }));

		expect(texts()).toContain('captures.directionQuestionTitle');
		expect(pressable('captures.directionOut')?.props.accessibilityState).toEqual({ selected: true });
		expect(pressable('captures.directionIn')?.props.accessibilityState).toEqual({ selected: false });

		await press('captures.directionIn');
		expect(mockAnswerDirection).toHaveBeenCalledWith('cap-1', 'in');
	});

	it('a direção respondida troca a categoria sugerida para o lado certo', async () => {
		await mount(capture({ reason: ambiguousReason('pix_direction'), accountId: CHECKING.id }));
		mockData.pending = [
			capture({
				reason: ambiguousReason('pix_direction'),
				accountId: CHECKING.id,
				direction: 'in',
				kind: 'pix_in',
				suggestedCategory: 'other_income',
			}),
		];
		await act(async () => {
			renderer.update(<CaptureInboxScreen />);
		});

		await press('captures.confirm');
		expect(mockConfirm.mock.calls[0]?.[1]).toBe('other_income');
	});

	it('o aviso comum não pergunta', async () => {
		await mount(capture({ accountId: CHECKING.id }));
		expect(texts()).not.toContain('captures.directionQuestionTitle');
		expect(pressable('captures.directionIn')).toBeUndefined();
	});
});

describe('a pergunta do pagamento da fatura (X-2)', () => {
	const invoice = () =>
		capture({ reason: ambiguousReason('invoice_payment'), kind: 'invoice_payment', counterparty: null });

	it('sem categoria nem "confirmar": só lançar de uma conta ou não lançar', async () => {
		await mount(invoice());

		expect(texts()).toContain('captures.invoiceQuestionTitle');
		expect(pressable('captures.invoicePay')).toBeDefined();
		expect(pressable('captures.invoiceSkip')).toBeDefined();
		expect(pressable('captures.confirm')).toBeUndefined();
	});

	it('"não lançar" manda null', async () => {
		await mount(invoice());
		await press('captures.invoiceSkip');
		expect(mockResolveInvoice).toHaveBeenCalledWith('cap-1', null);
	});

	it('lançar sem conta escolhida não manda nada; com a conta, manda ela', async () => {
		await mount(invoice());

		await press('captures.invoicePay');
		expect(mockResolveInvoice).not.toHaveBeenCalled();

		await press(CHECKING.name);
		await press('captures.invoicePay');
		expect(mockResolveInvoice).toHaveBeenCalledWith('cap-1', CHECKING.id);
	});
});
