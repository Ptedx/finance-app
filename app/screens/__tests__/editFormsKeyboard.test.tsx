/**
 * O teclado sobre o botão nos formulários de cadastro (SPD-121). No Android o
 * `KeyboardAvoidingView` desses formulários não tinha `behavior` (só no iOS): nada encolhia
 * quando o teclado subia, e o "Salvar" no fim da rolagem ficava embaixo dele — era preciso
 * fechar o teclado para achar o botão. Agora, como na `Sheet` e no modal da Conta (SPD-110),
 * a área encolhe (`height`), o salvar vai junto e responde ao 1º toque com o teclado aberto.
 *
 * E o formulário do cartão (E2E-49 e E2E-50): a figura do cartão no topo mostrava "Valor
 * devido R$ 0,00" num cartão que deve (a prévia não tem o resumo), e um prazo entre
 * fechamento e vencimento fora de 1 a 20 dias apagava a linha das datas sem dizer por quê.
 *
 * As chaves de tradução aparecem cruas; o resto da tela é dublê.
 */

jest.mock('@react-native-async-storage/async-storage', () =>
	require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

jest.mock('expo-router', () => ({
	useRouter: () => ({ replace: jest.fn(), back: jest.fn(), push: jest.fn(), dismiss: jest.fn(), dismissTo: jest.fn(), canGoBack: () => true }),
	useLocalSearchParams: () => ({}),
	// SPD-142: o cadastro de conta a pagar ouve o voltar do Android só em foco.
	useFocusEffect: () => undefined,
	Stack: { Screen: () => null },
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('react-native-safe-area-context', () => {
	const { View } = require('react-native');
	return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 24, right: 0, bottom: 34, left: 0 }) };
});

jest.mock('react-i18next', () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock('../../database/database', () => ({}));
jest.mock('../../database/captures', () => ({}));
jest.mock('../../utils/businessFeedPreference', () => ({ getBusinessFeeds: jest.fn(async () => ({})) }));
jest.mock('../../utils/balanceUnsetDismissals', () => ({
	getDismissedBalanceUnset: jest.fn(async () => new Set()),
	dismissBalanceUnset: jest.fn(async () => new Set()),
}));
jest.mock('../../components/TransactionItem', () => () => null);

const mockAccounts: { accounts: unknown[] } = { accounts: [] };

jest.mock('../../contexts/AccountsContext', () => ({
	useAccounts: () => ({
		accounts: mockAccounts.accounts,
		bankAccounts: [],
		balances: new Map(),
		accruedYield: new Map(),
		cdi: { annualBp: 1_365, date: '2026-11-05' },
		periodSpentByAccount: new Map(),
		month: null,
		createAccount: jest.fn(),
		saveAccount: jest.fn(),
		removeAccount: jest.fn(),
		mergeAccounts: jest.fn(),
		takeNotifications: jest.fn(),
		takeBusinessNotifications: jest.fn(),
		adjustAccountMonth: jest.fn(),
		adjustCardInvoices: jest.fn(),
		convertCardToDebit: jest.fn(),
		mergeCards: jest.fn(),
	}),
}));

jest.mock('../../contexts/TransactionsContext', () => ({
	useTransactions: () => ({ transactions: [], categories: [] }),
}));

jest.mock('../../contexts/PeriodContext', () => ({
	usePeriod: () => ({ selectedYear: 2026, selectedMonth: 11 }),
}));

jest.mock('../../contexts/BillsContext', () => ({
	useBills: () => ({ bills: [], createBill: jest.fn(), saveBill: jest.fn(), setBillActive: jest.fn(), removeBill: jest.fn() }),
}));

jest.mock('../../contexts/DebtsContext', () => ({
	useDebts: () => ({ debts: [], createDebt: jest.fn(), saveDebt: jest.fn(), removeDebt: jest.fn() }),
	draftOf: jest.fn(),
}));

jest.mock('../../utils/dateUtils', () => ({ ...jest.requireActual('../../utils/dateUtils'), todayISO: () => '2026-11-07' }));

import type React from 'react';
import { AccessibilityInfo, KeyboardAvoidingView, Platform, ScrollView, TextInput } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { Account } from '../../database/schema';
import AccountEditScreen from '../AccountEditScreen';
import BillEditScreen from '../BillEditScreen';
import CardEditScreen from '../CardEditScreen';
import DebtEditScreen from '../DebtEditScreen';

jest.setTimeout(20_000);
jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);

let renderer: ReactTestRenderer | null = null;
const originalOS = Platform.OS;

const setOS = (os: typeof Platform.OS) => {
	Object.defineProperty(Platform, 'OS', { value: os, configurable: true, writable: true });
};

const root = (): ReactTestInstance => {
	if (!renderer) throw new Error('tela não montada');
	return renderer.root;
};

const mount = async (element: React.ReactElement) => {
	await act(async () => {
		renderer = create(element as Parameters<typeof create>[0]);
	});
};

/** O ancestral mais próximo de `node` que passa no teste. */
const ancestor = (node: ReactTestInstance, test: (candidate: ReactTestInstance) => boolean): ReactTestInstance | null => {
	for (let up = node.parent; up; up = up.parent) if (test(up)) return up;
	return null;
};

/** O botão (o que recebe o toque) com este rótulo. */
const button = (label: string): ReactTestInstance => {
	const [found] = root().findAll((node) => typeof node.props.onPress === 'function' && node.props.accessibilityLabel === label);
	if (!found) throw new Error(`sem o botão ${label}`);
	return found;
};

const isHostText = (node: ReactTestInstance): boolean => (node.type as unknown) === 'Text';
const texts = (): string[] => root().findAll(isHostText).map((node) => [node.props.children].flat().join(''));

const typeInto = async (label: string, text: string) => {
	const [field] = root().findAll((node) => (node.type as unknown) === TextInput && node.props.accessibilityLabel === label);
	if (!field) throw new Error(`sem o campo ${label}`);
	await act(async () => {
		field.props.onChangeText(text);
	});
};

afterEach(() => {
	if (renderer) act(() => renderer?.unmount());
	renderer = null;
	setOS(originalOS);
	mockAccounts.accounts = [];
});

describe.each([
	['conta', () => <AccountEditScreen />, 'accounts.edit.save'],
	['cartão', () => <CardEditScreen />, 'cards.edit.save'],
	['conta a pagar', () => <BillEditScreen />, 'bills.edit.save'],
	['dívida', () => <DebtEditScreen />, 'debts.edit.save'],
])('formulário de %s no Android', (_name, element, saveLabel) => {
	beforeEach(() => setOS('android'));

	it('o salvar fica dentro de algo que encolhe com o teclado, junto com os campos', async () => {
		await mount(element());

		const save = button(saveLabel);
		const avoider = ancestor(save, (candidate) => (candidate.type as unknown) === KeyboardAvoidingView);
		expect(avoider?.props.behavior).toBe('height');
		for (const field of root().findAll((node) => (node.type as unknown) === TextInput)) {
			expect(ancestor(field, (candidate) => candidate === avoider)).toBe(avoider);
		}
	});

	it('o salvar rola com o formulário e responde ao 1º toque com o teclado aberto', async () => {
		await mount(element());

		const scroll = ancestor(button(saveLabel), (candidate) => (candidate.type as unknown) === ScrollView);
		expect(scroll?.props.keyboardShouldPersistTaps).toBe('handled');
	});

	it('nenhum campo se foca sozinho (no Android abre com cursor e sem teclado)', async () => {
		await mount(element());

		for (const field of root().findAll((node) => (node.type as unknown) === TextInput)) {
			expect(field.props.autoFocus).toBeFalsy();
		}
	});
});

it('no iOS continua com o `padding`', async () => {
	setOS('ios');
	await mount(<CardEditScreen />);

	const avoider = ancestor(button('cards.edit.save'), (candidate) => (candidate.type as unknown) === KeyboardAvoidingView);
	expect(avoider?.props.behavior).toBe('padding');
});

const NUBANK: Account = {
	id: 'nubank',
	name: 'Nubank Teste',
	kind: 'credit_card',
	role: 'card',
	envelopeMonthlyCents: null,
	bankName: 'Nubank',
	color: '#820AD1',
	last4: '1111',
	network: null,
	closingDay: 10,
	dueDay: 17,
	closingDaysBefore: 7,
	creditLimitCents: null,
	cardNames: null,
	yieldCdiBp: null,
	reservePurpose: null,
	packageName: null,
	accountKey: null,
	openingBalanceCents: 0,
	openingBalanceDate: '2026-11-06',
	sortOrder: 0,
	archived: false,
	updatedAt: '',
};

describe('E2E-49 — a figura do cartão no formulário', () => {
	it('editando um cartão que deve, a prévia não mostra "Valor devido R$ 0,00": ela não sabe o valor', async () => {
		mockAccounts.accounts = [NUBANK];
		await mount(<CardEditScreen cardId="nubank" />);

		const shown = texts();
		expect(shown).not.toContain('cards.owed');
		expect(shown).not.toContain('cards.openInvoice');
		expect(shown.some((text) => /0[.,]00/.test(text))).toBe(false);
		const face = root().findAll((node) => typeof node.props.accessibilityLabel === 'string' && node.props.accessibilityLabel.includes('Nubank'))[0];
		expect(face?.props.accessibilityLabel).not.toContain('cards.owed');
	});

	it('a figura continua lá, com o banco e o final', async () => {
		mockAccounts.accounts = [NUBANK];
		await mount(<CardEditScreen cardId="nubank" />);

		const shown = texts();
		expect(shown).toContain('Nubank');
	});
});

describe('E2E-50 — prazo fora de 1 a 20 dias enquanto digita', () => {
	it('fecha 10 e vence 5 (25 dias): no lugar da linha das datas, o aviso do porquê, antes de salvar', async () => {
		await mount(<CardEditScreen />);
		await typeInto('cards.edit.closingDay', '10');
		await typeInto('cards.edit.dueDay', '5');

		const warning = root().findAll((node) => isHostText(node) && node.props.children === 'cards.edit.invalidDueGap');
		expect(warning).toHaveLength(1);
		expect(warning[0].props.accessibilityLiveRegion).toBe('polite');
		expect(texts()).not.toContain('cards.edit.cyclePreview');
	});

	it('fecha 10 e vence 17: a linha das datas, sem aviso', async () => {
		await mount(<CardEditScreen />);
		await typeInto('cards.edit.closingDay', '10');
		await typeInto('cards.edit.dueDay', '17');

		expect(texts()).toContain('cards.edit.cyclePreview');
		expect(texts()).not.toContain('cards.edit.invalidDueGap');
	});

	it('depois de salvar com o prazo errado, o aviso aparece uma vez só (no campo)', async () => {
		await mount(<CardEditScreen />);
		await typeInto('cards.edit.closingDay', '10');
		await typeInto('cards.edit.dueDay', '5');
		await act(async () => {
			await button('cards.edit.save').props.onPress();
		});

		expect(texts().filter((text) => text === 'cards.edit.invalidDueGap')).toHaveLength(1);
	});
});
