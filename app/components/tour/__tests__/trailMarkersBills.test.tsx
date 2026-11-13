/**
 * As marcas das Trilhas 8 (Contas a pagar e lembretes) e 21 (Tela inicial) nas telas de
 * verdade (SPD-131c): cada alvo que essas trilhas apontam existe na tela do passo — o card
 * "Contas do mês", a lista e o cadastro das contas a pagar, os cartões, as contas e o aviso
 * "Proteja seus dados" da tela inicial — com dado e sem dado, e o "?" de cada trilha está
 * onde o texto aprovado diz. Os alvos que outras fases já marcaram ("Revisar", "Este mês", o
 * "+" e as abas) são conferidos no código.
 *
 * As telas são desenhadas com dados de teste inventados; as chaves de tradução aparecem cruas.
 */

import type { Bill } from '../../../database/schema';

type Row = { bill: Bill; status: string; dueDate: string };

const mockState: {
	bills: Bill[];
	rows: Row[];
	creditCards: unknown[];
	debitCards: unknown[];
	bankAccounts: unknown[];
	unassignedNetCents: number;
	showReminder: boolean;
} = {
	bills: [],
	rows: [],
	creditCards: [],
	debitCards: [],
	bankAccounts: [],
	unassignedNetCents: 0,
	showReminder: false,
};

jest.mock('@react-native-async-storage/async-storage', () => ({
	getItem: jest.fn(async () => null),
	setItem: jest.fn(async () => undefined),
	removeItem: jest.fn(async () => undefined),
}));

jest.mock('expo-router', () => {
	const { useEffect } = require('react');
	return {
		router: { push: jest.fn(), back: jest.fn() },
		useRouter: () => ({ replace: jest.fn(), back: jest.fn(), push: jest.fn(), canGoBack: () => true }),
		useLocalSearchParams: () => ({}),
		// A tela está sempre em foco no teste: o efeito roda como um efeito comum.
		useFocusEffect: (effect: () => undefined | (() => void)) => useEffect(effect, [effect]),
		Stack: { Screen: () => null },
	};
});

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('react-native-safe-area-context', () => {
	const { View } = require('react-native');
	return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) };
});

jest.mock('react-i18next', () => ({
	useTranslation: () => ({
		t: (key: string, params?: Record<string, unknown>) => (params ? `${key}${JSON.stringify(params)}` : key),
	}),
}));

jest.mock('../../../database/database', () => ({}));
jest.mock('../../../utils/dateUtils', () => ({ ...jest.requireActual('../../../utils/dateUtils'), todayISO: () => '2026-11-11' }));
jest.mock('../../bills/BillStatusPill', () => () => null);
jest.mock('../../cards/CardFace', () => () => null);
jest.mock('../../cards/DebitCardFace', () => () => null);
jest.mock('../../../utils/balanceUnsetDismissals', () => ({ getDismissedBalanceUnset: jest.fn(async () => new Set()) }));
jest.mock('../../../utils/accountReminder', () => ({
	shouldShowReminder: jest.fn(async () => mockState.showReminder),
	dismissReminder: jest.fn(async () => undefined),
}));

jest.mock('../../../contexts/BillsContext', () => ({
	markPaidTransactionId: (id: string, month: string) => `lancamento-${id}-${month}`,
	useBills: () => ({
		bills: mockState.bills,
		activeBills: mockState.bills.filter((bill) => bill.active),
		payments: [],
		month: { month: '2026-11', rows: mockState.rows, dueCents: 12_000, variableCount: 0, lateCount: 0 },
		today: '2026-11-11',
		isLoading: false,
		planPayment: jest.fn(),
		markPaid: jest.fn(),
		skipMonth: jest.fn(),
		undoPaid: jest.fn(),
		createBill: jest.fn(),
		saveBill: jest.fn(),
		setBillActive: jest.fn(),
		removeBill: jest.fn(),
	}),
}));

jest.mock('../../../contexts/AccountsContext', () => ({
	useAccounts: () => ({
		accounts: mockState.bankAccounts,
		bankAccounts: mockState.bankAccounts,
		creditCards: mockState.creditCards,
		debitCards: mockState.debitCards,
		cardSummaries: new Map(),
		cardsTotals: { toPayCents: 0, openInvoicesCents: 30_000, limitAvailableCents: null },
		balances: new Map(),
		provisionalBalances: new Map(),
		overview: { cashCents: 100_000, savedCents: 0, netCents: 70_000 },
		provisionalOverview: { cashCents: 0, netCents: 0 },
		month: { envelopes: [], reserves: [] },
		unassignedNetCents: mockState.unassignedNetCents,
		isLoading: false,
	}),
}));

jest.mock('../../../contexts/PeriodContext', () => ({ usePeriod: () => ({ selectedMonth: 11, selectedYear: 2026 }) }));

jest.mock('../../../contexts/AuthContext', () => ({ useAuth: () => ({ account: null, isAvailable: true }) }));

jest.mock('../../../contexts/TransactionsContext', () => ({
	useTransactions: () => ({
		transactions: [],
		categories: [{ id: 'utilities', name: 'Contas da casa', color: '#888888', icon: 'home', type: 'expense' }],
	}),
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AccessibilityInfo } from 'react-native';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { act, create } from 'react-test-renderer';
import AccountReminderBanner from '../../../components/AccountReminderBanner';
import AccountsOverview from '../../../components/AccountsOverview';
import BillsMonthCard from '../../../components/bills/BillsMonthCard';
import CardsSection from '../../../components/cards/CardsSection';
import BillEditScreen from '../../../screens/BillEditScreen';
import BillsScreen from '../../../screens/BillsScreen';
import { configureMoney } from '../../../utils/money';
import { TRAILS, type TrailId } from '../../../utils/trails';
import { clearTourRegistry, hasTarget } from '../registry';

// A primeira tela desenhada carrega os módulos: com a suíte em paralelo, passa dos 5 s padrão.
jest.setTimeout(60_000);
jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);

const INTERNET: Bill = {
	id: 'internet',
	name: 'Internet teste',
	dueDay: 20,
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
/** Paga neste mês: tem o "Desfazer". */
const PLANO: Bill = { ...INTERNET, id: 'plano', name: 'Plano teste', dueDay: 5, paidThrough: '2026-11', sortOrder: 1 };

const CORRENTE = { id: 'corrente', name: 'Corrente Teste', kind: 'checking', role: 'main', archived: false, openingBalanceCents: 0 };
const CARTAO = { id: 'cartao', name: 'Cartão Teste', kind: 'credit', archived: false };

let renderer: ReactTestRenderer | null = null;

/** Desenha e devolve os alvos que estavam marcados, entre os candidatos. */
const render = async (element: Parameters<typeof create>[0], candidates: readonly string[]) => {
	clearTourRegistry();
	await act(async () => {
		renderer = create(element);
	});
	return candidates.filter((id) => hasTarget(id));
};

const unmount = async () => {
	await act(async () => {
		renderer?.unmount();
	});
	renderer = null;
};

/** Os "?" na tela: a trilha de cada um, pela dica (o rótulo é o mesmo em todos). */
const helpButtons = (): string[] =>
	(renderer?.root.findAll((node: ReactTestInstance) => typeof node.type !== 'string' && typeof node.props.onPress === 'function' && typeof node.props.accessibilityHint === 'string') ?? [])
		.map((node) => String(node.props.accessibilityHint).match(/"trails\.(\w+)\.title"/)?.[1])
		.filter((trail): trail is string => Boolean(trail));

/** Todos os alvos que as trilhas pedem nas telas do passo dado. */
const targetsOf = (trails: readonly TrailId[], screens: readonly string[]): string[] => {
	const ids = new Set<string>();
	for (const id of trails) {
		for (const step of TRAILS[id].steps) {
			if (!screens.includes(step.screen)) continue;
			for (const group of step.targets ?? []) for (const target of group) ids.add(target);
		}
	}
	return [...ids].sort();
};

beforeEach(() => {
	mockState.bills = [{ ...INTERNET }, { ...PLANO }];
	mockState.rows = [
		{ bill: mockState.bills[1], status: 'paid', dueDate: '2026-11-05' },
		{ bill: mockState.bills[0], status: 'upcoming', dueDate: '2026-11-20' },
	];
	mockState.creditCards = [CARTAO];
	mockState.debitCards = [];
	mockState.bankAccounts = [CORRENTE];
	mockState.unassignedNetCents = -5_000;
	mockState.showReminder = true;
	configureMoney({ locale: 'pt-BR', currencyCode: 'BRL', currencySymbol: 'R$' });
});

afterEach(async () => {
	await unmount();
	configureMoney({ locale: 'en-US', currencyCode: 'USD', currencySymbol: '$' });
});

describe('Trilha 8 — Contas a pagar e lembretes', () => {
	it('"Contas do mês": com contas, o card; sem nenhuma, o "Cadastrar"; o "?" abre a trilha 8 nos dois', async () => {
		expect(await render(<BillsMonthCard />, ['home.billsCard', 'home.billsInvite'])).toEqual(['home.billsCard']);
		expect(helpButtons()).toEqual(['bills']);
		await unmount();

		// Nada vencendo em 7 dias: a linha só, ainda o card.
		mockState.bills = [{ ...PLANO }];
		expect(await render(<BillsMonthCard />, ['home.billsCard', 'home.billsInvite'])).toEqual(['home.billsCard']);
		expect(helpButtons()).toEqual(['bills']);
		await unmount();

		mockState.bills = [];
		mockState.rows = [];
		expect(await render(<BillsMonthCard />, ['home.billsCard', 'home.billsInvite'])).toEqual(['home.billsInvite']);
		expect(helpButtons()).toEqual(['bills']);
	});

	it('Contas a pagar: o "+", a lista, o "Já paguei" e o "Desfazer"; vazia, o "Cadastrar conta"; e o "?"', async () => {
		const wanted = targetsOf(['bills'], ['bills']);
		expect(wanted).toEqual(['bills.add', 'bills.emptyAdd', 'bills.list', 'bills.pay', 'bills.undo']);
		const marked = new Set(await render(<BillsScreen />, wanted));
		expect([...marked].sort()).toEqual(['bills.add', 'bills.list', 'bills.pay', 'bills.undo']);
		expect(helpButtons()).toEqual(['bills']);
		await unmount();

		// Sem nenhuma conta: o "Cadastrar conta"; nada de "Já paguei" nem lista para apontar.
		mockState.bills = [];
		mockState.rows = [];
		const empty = await render(<BillsScreen />, wanted);
		expect(empty.sort()).toEqual(['bills.add', 'bills.emptyAdd']);
		for (const id of empty) marked.add(id);
		expect(wanted.filter((id) => !marked.has(id))).toEqual([]);
	});

	it('Nova conta a pagar: nome, dia, valor, conta que paga, categoria e "Como aparece no banco"', async () => {
		const wanted = targetsOf(['bills'], ['billNew']);
		expect(wanted).toEqual(['billEdit.account', 'billEdit.amount', 'billEdit.category', 'billEdit.dueDay', 'billEdit.match', 'billEdit.name']);
		const marked = await render(<BillEditScreen />, [...wanted, 'billEdit.actions']);
		expect(marked.sort()).toEqual(wanted);
		await unmount();

		// Sem conta cadastrada, "Conta que paga" não aparece: o passo 5 aponta só a categoria.
		mockState.bankAccounts = [];
		const noAccount = await render(<BillEditScreen />, wanted);
		expect(noAccount).not.toContain('billEdit.account');
		expect(noAccount).toContain('billEdit.category');
	});

	it('Editar conta a pagar: "Desativar" e "Apagar" juntos; a conta de uma dívida não tem nenhum dos dois', async () => {
		const wanted = targetsOf(['bills'], ['billEdit']);
		expect(wanted).toEqual(['billEdit.actions']);
		expect(await render(<BillEditScreen billId="plano" />, wanted)).toEqual(wanted);
		await unmount();

		mockState.bills = [{ ...INTERNET, id: 'parcela', debtId: 'carro' }];
		expect(await render(<BillEditScreen billId="parcela" />, wanted)).toEqual([]);
	});
});

describe('Trilha 21 — Tela inicial', () => {
	it('Cartões: o título com "Ver todos" e os totais; sem cartão, o "Adicionar cartão"', async () => {
		const wanted = ['home.cards', 'home.cardsTotals', 'home.cardsAdd'];
		expect(await render(<CardsSection />, wanted)).toEqual(['home.cards', 'home.cardsTotals']);
		await unmount();

		// Só débito: o título, sem os totais (que são das faturas).
		mockState.creditCards = [];
		mockState.debitCards = [{ key: 'corrente:1234', account: CORRENTE, last4: '1234', name: null, periodSpentCents: 0 }];
		expect(await render(<CardsSection />, wanted)).toEqual(['home.cards']);
		await unmount();

		mockState.debitCards = [];
		expect(await render(<CardsSection />, wanted)).toEqual(['home.cardsAdd']);
	});

	it('Contas: o título com "Gerenciar", os totais e "Sem conta"; sem conta, o "Adicionar conta"', async () => {
		const wanted = ['home.accounts', 'home.accountsTotals', 'home.accountsAdd', 'home.unassigned'];
		expect(await render(<AccountsOverview />, wanted)).toEqual(['home.accounts', 'home.accountsTotals', 'home.unassigned']);
		await unmount();

		// Nada sem conta: a linha some, e os passos 7 e 8 saem.
		mockState.unassignedNetCents = 0;
		expect(await render(<AccountsOverview />, wanted)).toEqual(['home.accounts', 'home.accountsTotals']);
		await unmount();

		mockState.bankAccounts = [];
		expect(await render(<AccountsOverview />, wanted)).toEqual(['home.accountsAdd']);
	});

	it('"Proteja seus dados": marcado só quando o aviso aparece', async () => {
		expect(await render(<AccountReminderBanner />, ['home.protect'])).toEqual(['home.protect']);
		await unmount();

		mockState.showReminder = false;
		expect(await render(<AccountReminderBanner />, ['home.protect'])).toEqual([]);
	});

	it('cada alvo da trilha 21 e do passo 1 da trilha 8 tem marca no código das telas', () => {
		const app = join(__dirname, '..', '..', '..');
		const sources = [
			'screens/HomeScreen.tsx',
			'(tabs)/_layout.tsx',
			'components/CaptureReviewBanner.tsx',
			'components/MonthOverviewCard.tsx',
			'components/AccountReminderBanner.tsx',
			'components/AccountsOverview.tsx',
			'components/cards/CardsSection.tsx',
			'components/bills/BillsMonthCard.tsx',
		]
			.map((file) => readFileSync(join(app, file), 'utf8'))
			.join('\n');
		const wanted = targetsOf(['home', 'bills'], ['home']);
		expect(wanted.length).toBeGreaterThan(12);
		expect(wanted.filter((id) => !sources.includes(`'${id}'`) && !sources.includes(`"${id}"`))).toEqual([]);
		// O "?" da tela inicial abre a trilha 21, ao lado do título.
		expect(sources).toContain('<HelpButton trail="home" here={{ screen: \'home\' }} />');
	});
});
