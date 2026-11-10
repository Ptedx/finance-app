/**
 * "Pagar fatura" recusado aparece na tela (SPD-133).
 *
 * Registrar duas vezes o mesmo pagamento — mesma conta, mesmo valor, até um dia de
 * diferença — não cria outro: `recordCardPayment` devolve falso. Antes a folha fechava e só
 * o leitor de tela ouvia "já estava registrado"; para quem vê, parecia que nada tinha
 * acontecido. Agora a tela do cartão mostra, por alguns segundos, qual pagamento já estava lá
 * (valor, data e conta), ou que o toque completou o que o aviso do banco tinha gravado sem
 * dizer o cartão. O resto da tela é dublê; as chaves de tradução aparecem cruas.
 */

const mockData: {
	transactions: unknown[];
	summaries: Map<string, unknown>;
	accounts: unknown[];
	bankAccounts: unknown[];
	transfers: unknown[];
	record: (cardId: string, fromId: string | null, cents: number, date: string) => Promise<boolean>;
} = {
	transactions: [],
	summaries: new Map(),
	accounts: [],
	bankAccounts: [],
	transfers: [],
	record: async () => true,
};

jest.mock('@react-native-async-storage/async-storage', () =>
	require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('../../database/database', () => ({
	setPreference: (key: string, value: string) =>
		require('@react-native-async-storage/async-storage/jest/async-storage-mock').setItem(key, value),
	getAccountTransfers: async () => mockData.transfers,
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

jest.mock('../../components/cards/CardFace', () => () => null);
jest.mock('../../components/cards/RenameCardSheet', () => () => null);
// A folha aberta mostra o que tem dentro; fechada, nada.
jest.mock('../../components/cards/Sheet', () => {
	const { View } = require('react-native');
	return ({ visible, children }: { visible: boolean; children: React.ReactNode }) => (visible ? <View>{children}</View> : null);
});
jest.mock('../../components/HorizontalCategoryPicker', () => () => null);
// "Pago com" já vem marcado com a corrente do banco do cartão: o teste não toca no seletor.
jest.mock('../../utils/accountResolver', () => ({ findCheckingForCard: async () => ({ id: 'corrente' }) }));

jest.mock('../../components/TransactionItem', () => {
	const { Text } = require('react-native');
	return ({ transaction }: { transaction: { id: string } }) => <Text>{`item:${transaction.id}`}</Text>;
});

jest.mock('../../contexts/AccountsContext', () => ({
	useAccounts: () => ({
		accounts: mockData.accounts,
		bankAccounts: mockData.bankAccounts,
		cardSummaries: mockData.summaries,
		recordCardPayment: (cardId: string, fromId: string | null, cents: number, date: string) => mockData.record(cardId, fromId, cents, date),
		adjustCardInvoices: jest.fn(),
		addCardCharge: jest.fn(),
		addExistingInstallments: jest.fn(),
		renameCard: jest.fn(),
	}),
}));

jest.mock('../../contexts/TransactionsContext', () => ({
	useTransactions: () => ({ transactions: mockData.transactions, categories: [] }),
}));

jest.mock('../../utils/dateUtils', () => ({ ...jest.requireActual('../../utils/dateUtils'), todayISO: () => '2026-11-10' }));

import type React from 'react';
import { AccessibilityInfo } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { Account, Transaction, Transfer } from '../../database/schema';
import { buildCardSummary } from '../../utils/cardMath';
import { formatDayMonth } from '../../utils/dateUtils';
import { formatCents } from '../../utils/money';
import CardDetailScreen from '../CardDetailScreen';

jest.setTimeout(20_000);
jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);

const account = (id: string, name: string, kind: Account['kind']): Account => ({
	id,
	name,
	kind,
	role: kind === 'credit_card' ? 'card' : 'main',
	envelopeMonthlyCents: null,
	bankName: 'Banco Teste',
	color: '#820AD1',
	last4: kind === 'credit_card' ? '1111' : null,
	network: null,
	closingDay: kind === 'credit_card' ? 25 : null,
	dueDay: null,
	closingDaysBefore: kind === 'credit_card' ? 7 : null,
	creditLimitCents: kind === 'credit_card' ? 500_000 : null,
	cardNames: null,
	yieldCdiBp: null,
	reservePurpose: null,
	packageName: null,
	accountKey: null,
	openingBalanceCents: 0,
	openingBalanceDate: '2026-10-31',
	sortOrder: 0,
	archived: false,
	updatedAt: '',
});

const CARD = account('nubank', 'Cartão Teste', 'credit_card');
const CORRENTE = account('corrente', 'Corrente Teste', 'checking');

const PURCHASE: Transaction = {
	id: 'mercado',
	amountCents: 12_000,
	category: 'food',
	date: '2026-11-05',
	note: 'Mercado',
	isIncome: false,
	accountId: 'nubank',
	installmentGroup: null,
	installmentIndex: null,
	installmentCount: null,
	cardLast4: null,
	updatedAt: '',
};

const transfer = (id: string, fromAccountId: string | null, toAccountId: string | null, amountCents: number, date: string): Transfer => ({
	id,
	fromAccountId,
	toAccountId,
	amountCents,
	date,
	note: '',
	updatedAt: '',
});

let renderer: ReactTestRenderer;

const mount = async () => {
	mockData.accounts = [CARD, CORRENTE];
	mockData.bankAccounts = [CORRENTE];
	mockData.transactions = [PURCHASE];
	mockData.summaries = new Map([['nubank', buildCardSummary(CARD, [PURCHASE], [], '2026-11-10')]]);
	await act(async () => {
		renderer = create(<CardDetailScreen cardId="nubank" />);
	});
	await act(async () => {
		await Promise.resolve();
	});
};

const press = async (label: string) => {
	const node = renderer.root.find(
		(candidate: ReactTestInstance) => typeof candidate.type !== 'string' && candidate.props.accessibilityLabel === label && typeof candidate.props.onPress === 'function'
	);
	await act(async () => {
		await node.props.onPress();
	});
};

/** Abre "Pagar fatura", troca o valor sugerido por R$ 50,00 e confirma (hoje, 10/11). */
const payFifty = async () => {
	await press('cards.actions.pay');
	await act(async () => {
		await Promise.resolve();
	});
	const amount = renderer.root.find(
		(node: ReactTestInstance) => typeof node.type === 'string' && typeof node.props.onChangeText === 'function'
	);
	await act(async () => {
		amount.props.onChangeText('50,00');
	});
	await press('cards.pay.confirm');
	await act(async () => {
		await Promise.resolve();
	});
};

const texts = (): string[] =>
	renderer.root.findAll((node) => (node.type as unknown) === 'Text').flatMap((node) =>
		node.children.filter((child): child is string => typeof child === 'string')
	);

const message = (key: string, params: Record<string, unknown>) => `${key} ${JSON.stringify(params)}`;

beforeEach(() => {
	mockData.transfers = [];
	mockData.record = async () => true;
});

afterEach(() => {
	act(() => renderer.unmount());
	jest.useRealTimers();
});

describe('SPD-133 — o "Pagar fatura" recusado aparece na tela', () => {
	it('registrar duas vezes o mesmo pagamento mostra qual já estava: valor, data e conta', async () => {
		// O primeiro "Pagar fatura" (ou o aviso do banco) gravou R$ 50,00 em 09/11, da corrente.
		mockData.transfers = [transfer('p1', 'corrente', 'nubank', 5000, '2026-11-09')];
		const calls: unknown[][] = [];
		mockData.record = async (...args) => {
			calls.push(args);
			return false;
		};
		await mount();
		await payFifty();

		expect(calls).toEqual([['nubank', 'corrente', 5000, '2026-11-10']]);
		const expected = message('cards.pay.alreadyFrom', {
			amount: formatCents(5000),
			date: formatDayMonth('2026-11-09'),
			account: 'Corrente Teste',
		});
		expect(texts()).toContain(expected);
		// A folha fechou: o aviso fica na tela do cartão.
		expect(texts()).not.toContain('cards.pay.confirm');
		expect(AccessibilityInfo.announceForAccessibility).toHaveBeenLastCalledWith(expected);
	});

	it('o que já estava veio de outra conta: diz "de outra conta"', async () => {
		mockData.transfers = [transfer('p1', null, 'nubank', 5000, '2026-11-10')];
		mockData.record = async () => false;
		await mount();
		await payFifty();

		expect(texts()).toContain(message('cards.pay.alreadyOutside', { amount: formatCents(5000), date: formatDayMonth('2026-11-10') }));
	});

	it('completou o pagamento que veio do aviso do banco: diz isso', async () => {
		// O aviso gravou a saída da corrente com destino em branco; o toque completa o destino.
		mockData.record = async () => {
			mockData.transfers = [transfer('aviso', 'corrente', 'nubank', 5000, '2026-11-09')];
			return false;
		};
		await mount();
		await payFifty();

		expect(texts()).toContain(
			message('cards.pay.completed', { amount: formatCents(5000), date: formatDayMonth('2026-11-09'), account: 'Corrente Teste' })
		);
	});

	it('sem achar qual era, fica a frase de antes, agora na tela', async () => {
		mockData.record = async () => false;
		await mount();
		await payFifty();

		expect(texts()).toContain(message('cards.pay.already', { amount: formatCents(5000) }));
	});

	it('o pagamento novo também aparece, curto', async () => {
		await mount();
		await payFifty();

		expect(texts()).toContain(message('cards.pay.done', { amount: formatCents(5000) }));
	});

	it('o aviso some sozinho depois de alguns segundos, e some no toque em fechar', async () => {
		mockData.transfers = [transfer('p1', 'corrente', 'nubank', 5000, '2026-11-09')];
		mockData.record = async () => false;
		await mount();
		await payFifty();
		const shown = () => texts().filter((text) => text.startsWith('cards.pay.alreadyFrom'));
		expect(shown()).toHaveLength(1);

		await press('cards.pay.noticeClose');
		expect(shown()).toEqual([]);

		jest.useFakeTimers();
		await payFifty();
		expect(shown()).toHaveLength(1);
		await act(async () => {
			jest.advanceTimersByTime(7_000);
		});
		expect(shown()).toHaveLength(1);
		await act(async () => {
			jest.advanceTimersByTime(1_500);
		});
		expect(shown()).toEqual([]);
	});
});
