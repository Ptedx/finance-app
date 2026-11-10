/**
 * "Juntar com outro cartão" na edição do cartão (E2E-34, SPD-097).
 *
 * O botão só existe quando há outro cartão para receber as compras. O toque abre uma folha
 * com todos os cartões que podem receber (E2E-39: o Alert do Android mostra no máximo três
 * botões, e o quarto cartão sumia), confirma dizendo o que fica e o que sai, e só então
 * chama `mergeCards(este, escolhido)`.
 *
 * Depois de juntar, excluir ou levar para o débito, a tela do cartão que sumiu não fica na
 * pilha (E2E-40): o voltar caía em "Cartão não encontrado" sem saída. O router é dublê e a
 * pergunta é quais chamadas ele recebe. O resto da tela é dublê; as chaves de tradução
 * aparecem cruas.
 */

const mockMergeCards = jest.fn(async (_fromId: string, _intoId: string) => undefined);
const mockRemoveAccount = jest.fn(async (_id: string) => undefined);
const mockConvertCardToDebit = jest.fn(async (_cardId: string, _accountId: string) => undefined);
const mockRouter = {
	replace: jest.fn(),
	back: jest.fn(),
	push: jest.fn(),
	dismiss: jest.fn(),
	dismissTo: jest.fn(),
	dismissAll: jest.fn(),
	canGoBack: jest.fn(() => true),
};
const mockAccounts: { accounts: unknown[] } = { accounts: [] };
const mockTransactions: { list: unknown[] } = { list: [] };

jest.mock('@react-native-async-storage/async-storage', () =>
	require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
// O "Não é repetido" grava pela preferência que sobe no sync (SPD-100); aqui, só o AsyncStorage.
jest.mock('../../database/database', () => ({
	setPreference: (key: string, value: string) =>
		require('@react-native-async-storage/async-storage/jest/async-storage-mock').setItem(key, value),
}));

jest.mock('expo-router', () => ({
	useRouter: () => mockRouter,
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

jest.mock('../../contexts/AccountsContext', () => ({
	useAccounts: () => ({
		accounts: mockAccounts.accounts,
		bankAccounts: (mockAccounts.accounts as Array<{ kind: string }>).filter((account) => account.kind !== 'credit_card'),
		createAccount: jest.fn(),
		saveAccount: jest.fn(),
		removeAccount: mockRemoveAccount,
		adjustCardInvoices: jest.fn(),
		convertCardToDebit: mockConvertCardToDebit,
		mergeCards: mockMergeCards,
	}),
}));

jest.mock('../../contexts/TransactionsContext', () => ({
	useTransactions: () => ({ transactions: mockTransactions.list }),
}));

jest.mock('../../utils/dateUtils', () => ({ ...jest.requireActual('../../utils/dateUtils'), todayISO: () => '2026-11-07' }));

import { AccessibilityInfo, Alert, type AlertButton } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import Sheet from '../../components/cards/Sheet';
import type { Account, Transaction } from '../../database/schema';
import { CARD_ADJUSTMENT_NOTE } from '../../utils/cardMath';
import CardEditScreen from '../CardEditScreen';

jest.setTimeout(20_000);
jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);

const account = (overrides: Partial<Account>): Account => ({
	id: 'x',
	name: 'Cartão',
	kind: 'credit_card',
	role: 'card',
	envelopeMonthlyCents: null,
	bankName: 'Nubank',
	color: '#820AD1',
	last4: '1111',
	network: null,
	closingDay: null,
	dueDay: null,
	closingDaysBefore: null,
	creditLimitCents: null,
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
	...overrides,
});

const NUBANK = account({ id: 'nubank', name: 'Nubank Teste', closingDay: 25, closingDaysBefore: 7, creditLimitCents: 500_000 });
const DUPLICADO = account({ id: 'dup', name: 'NU PAGAMENTOS S.A. · cartão final 1111', bankName: 'NU PAGAMENTOS S.A.', sortOrder: 1 });
const CORRENTE = account({ id: 'corrente', name: 'Corrente', kind: 'checking', role: 'main', last4: null, sortOrder: 2 });
const INTER = account({ id: 'inter', name: 'Inter Teste', bankName: 'Inter', last4: '2222', sortOrder: 3 });
const ITAU = account({ id: 'itau', name: 'Itaú Teste', bankName: 'Itaú', last4: '3333', sortOrder: 4 });
const C6 = account({ id: 'c6', name: 'C6 Teste', bankName: 'C6', last4: '4444', sortOrder: 5 });

let renderer: ReactTestRenderer;

const pressables = (label: string): ReactTestInstance[] =>
	renderer.root.findAll((node) => typeof node.props.onPress === 'function' && node.props.accessibilityLabel === label);

const mount = async (cardId: string) => {
	await act(async () => {
		renderer = create(<CardEditScreen cardId={cardId} />);
	});
};

/** A folha de escolher o destino, se está aberta. */
const openSheet = (): ReactTestInstance | undefined =>
	renderer.root.findAll((node) => node.type === Sheet && node.props.visible === true)[0];

/** Os destinos que a folha oferece, na ordem da tela (o X de fechar fica de fora). */
const targetNames = (): string[] => {
	const sheet = openSheet();
	if (!sheet) return [];
	return sheet
		.findAll((node) => typeof node.props.onPress === 'function' && typeof node.props.accessibilityLabel === 'string')
		.map((node) => node.props.accessibilityLabel as string)
		.filter((label, index, all) => label !== 'cards.close' && all.indexOf(label) === index);
};

const openMerge = async () => {
	await act(async () => {
		pressables('cards.edit.merge')[0].props.onPress();
	});
};

/** Toca no destino dentro da folha. */
const pickTarget = async (name: string) => {
	const sheet = openSheet();
	if (!sheet) throw new Error('a folha de destinos não está aberta');
	const [row] = sheet.findAll((node) => typeof node.props.onPress === 'function' && node.props.accessibilityLabel === name);
	if (!row) throw new Error(`sem ${name} na folha`);
	await act(async () => {
		row.props.onPress();
	});
};

/** O botão de um `Alert.alert` pelo texto, na chamada `call`. */
const alertButton = (call: number, text: string): AlertButton => {
	const buttons = (alertSpy.mock.calls[call]?.[2] ?? []) as AlertButton[];
	const button = buttons.find((candidate) => candidate.text === text);
	if (!button) throw new Error(`sem o botão ${text} no alerta ${call}`);
	return button;
};

beforeEach(() => {
	jest.clearAllMocks();
	mockAccounts.accounts = [];
	mockTransactions.list = [];
});

afterEach(() => {
	act(() => renderer.unmount());
});

describe('E2E-34 — juntar com outro cartão', () => {
	it('com um cartão só (e uma conta corrente), o botão não aparece', async () => {
		mockAccounts.accounts = [NUBANK, CORRENTE];
		await mount('nubank');
		expect(pressables('cards.edit.delete')).toHaveLength(1);
		expect(pressables('cards.edit.merge')).toHaveLength(0);
	});

	it('o outro cartão arquivado não conta: o botão não aparece', async () => {
		mockAccounts.accounts = [NUBANK, { ...DUPLICADO, archived: true }];
		await mount('nubank');
		expect(pressables('cards.edit.merge')).toHaveLength(0);
	});

	it('do duplicado: escolhe o Nubank Teste, confirma, e chama mergeCards(duplicado, Nubank Teste)', async () => {
		mockAccounts.accounts = [NUBANK, DUPLICADO, CORRENTE];
		await mount('dup');
		expect(pressables('cards.edit.merge')).toHaveLength(1);

		await openMerge();
		// Primeiro: para qual cartão. Só os outros cartões — nem ele, nem a conta corrente.
		expect(openSheet()?.props.title).toBe('cards.edit.merge');
		expect(openSheet()?.props.subtitle).toBe(`cards.edit.mergePick ${JSON.stringify({ name: DUPLICADO.name })}`);
		expect(targetNames()).toEqual(['Nubank Teste']);
		expect(alertSpy).not.toHaveBeenCalled();
		expect(mockMergeCards).not.toHaveBeenCalled();

		await pickTarget('Nubank Teste');
		// Depois: a folha fecha e a confirmação diz o que sai e o que fica.
		expect(openSheet()).toBeUndefined();
		expect(alertSpy.mock.calls[0]?.[1]).toBe(
			`cards.edit.mergeConfirm ${JSON.stringify({ from: DUPLICADO.name, into: NUBANK.name })}`
		);
		expect((alertSpy.mock.calls[0]?.[2] as AlertButton[]).map((button) => button.text)).toEqual([
			'cards.cancel',
			'cards.edit.mergeAction',
		]);
		expect(mockMergeCards).not.toHaveBeenCalled();

		await act(async () => {
			await alertButton(0, 'cards.edit.mergeAction').onPress?.();
		});
		expect(mockMergeCards).toHaveBeenCalledTimes(1);
		expect(mockMergeCards).toHaveBeenCalledWith('dup', 'nubank');
	});

	it('E2E-39: com 4 cartões para receber, a folha mostra os 4 (o Alert do Android mostra no máximo 3 botões)', async () => {
		mockAccounts.accounts = [NUBANK, DUPLICADO, CORRENTE, INTER, ITAU, C6];
		await mount('dup');
		await openMerge();
		expect(alertSpy).not.toHaveBeenCalled();
		expect(targetNames()).toEqual(['Nubank Teste', 'Inter Teste', 'Itaú Teste', 'C6 Teste']);

		// O último da lista também se escolhe.
		await pickTarget('C6 Teste');
		expect(alertSpy.mock.calls[0]?.[1]).toBe(`cards.edit.mergeConfirm ${JSON.stringify({ from: DUPLICADO.name, into: C6.name })}`);
		await act(async () => {
			await alertButton(0, 'cards.edit.mergeAction').onPress?.();
		});
		expect(mockMergeCards).toHaveBeenCalledWith('dup', 'c6');
	});

	it('fechar a folha não junta nada', async () => {
		mockAccounts.accounts = [NUBANK, DUPLICADO];
		await mount('dup');
		await openMerge();
		await act(async () => {
			openSheet()?.props.onClose();
		});
		expect(openSheet()).toBeUndefined();
		expect(alertSpy).not.toHaveBeenCalled();
		expect(mockMergeCards).not.toHaveBeenCalled();
	});

	it('cancelar a confirmação não junta nada', async () => {
		mockAccounts.accounts = [NUBANK, DUPLICADO];
		await mount('dup');
		await openMerge();
		await pickTarget('Nubank Teste');
		await act(async () => {
			alertButton(0, 'cards.cancel').onPress?.();
		});
		expect(mockMergeCards).not.toHaveBeenCalled();
		expect(mockRouter.dismissTo).not.toHaveBeenCalled();
	});
});

/** A ordem das chamadas ao router, com os argumentos. */
const routerCalls = (): Array<[string, unknown[]]> =>
	(Object.entries(mockRouter) as Array<[string, jest.Mock]>)
		.flatMap(([name, fn]) => fn.mock.calls.map((args, index) => ({ name, args, order: fn.mock.invocationCallOrder[index] })))
		.filter((call) => call.name !== 'canGoBack')
		.sort((a, b) => a.order - b.order)
		.map((call) => [call.name, call.args]);

describe('E2E-40 — a pilha não guarda a tela do cartão que sumiu', () => {
	it('juntar: volta até a tela do cartão que saiu e a troca pela do que fica, sem empilhar nada', async () => {
		mockAccounts.accounts = [NUBANK, DUPLICADO];
		await mount('dup');
		await openMerge();
		await pickTarget('Nubank Teste');
		await act(async () => {
			await alertButton(0, 'cards.edit.mergeAction').onPress?.();
		});

		expect(mockMergeCards).toHaveBeenCalledWith('dup', 'nubank');
		// Pilha antes: … → cartão duplicado → edição. Volta até a tela do duplicado e a troca
		// pela do Nubank Teste: … → Nubank Teste. O voltar seguinte é o de quem abriu o cartão.
		expect(routerCalls()).toEqual([
			['dismissTo', [{ pathname: '/cards/[id]', params: { id: 'dup' } }]],
			['replace', [{ pathname: '/cards/[id]', params: { id: 'nubank' } }]],
		]);
		expect(mockRouter.push).not.toHaveBeenCalled();
	});

	it('excluir: fecha a edição e a tela do cartão excluído, sem abrir a lista por cima', async () => {
		mockAccounts.accounts = [NUBANK, DUPLICADO];
		await mount('dup');
		await act(async () => {
			pressables('cards.edit.delete')[0].props.onPress();
		});
		expect(mockRemoveAccount).not.toHaveBeenCalled();
		await act(async () => {
			await alertButton(0, 'cards.edit.delete').onPress?.();
		});

		expect(mockRemoveAccount).toHaveBeenCalledWith('dup');
		// Volta até a tela do cartão excluído e a fecha: o voltar seguinte é o de quem abriu o cartão.
		expect(routerCalls()).toEqual([
			['dismissTo', [{ pathname: '/cards/[id]', params: { id: 'dup' } }]],
			['dismiss', []],
		]);
	});

	it('levar para o débito apaga o cartão: a tela dele também sai da pilha', async () => {
		mockAccounts.accounts = [DUPLICADO, CORRENTE];
		await mount('dup');
		await act(async () => {
			pressables('cards.edit.debit')[0].props.onPress();
		});
		await act(async () => {
			pressables('Corrente')[0].props.onPress();
		});
		await act(async () => {
			pressables('cards.edit.debitConvert')[0].props.onPress();
		});
		await act(async () => {
			await alertButton(0, 'cards.edit.debitConvert').onPress?.();
		});

		expect(mockConvertCardToDebit).toHaveBeenCalledWith('dup', 'corrente');
		expect(routerCalls()).toEqual([
			['dismissTo', [{ pathname: '/cards/[id]', params: { id: 'dup' } }]],
			['dismiss', []],
		]);
	});
});

const tx = (id: string, accountId: string, amountCents: number, date: string, note: string, cardLast4: string | null = null): Transaction => ({
	id,
	amountCents,
	category: 'food',
	date,
	note,
	isIncome: false,
	accountId,
	installmentGroup: null,
	installmentIndex: null,
	installmentCount: null,
	cardLast4,
	updatedAt: '',
});

/** Junta o duplicado no Nubank Teste pelo caminho da tela: escolher na folha, confirmar. */
const mergeDuplicateIntoNubank = async () => {
	await mount('dup');
	await openMerge();
	await pickTarget('Nubank Teste');
	await act(async () => {
		await alertButton(0, 'cards.edit.mergeAction').onPress?.();
	});
};

describe('E2E-34 — depois de juntar, os prováveis repetidos (SPD-098)', () => {
	it('a padaria e o mercado à mão no Nubank Teste e do extrato no duplicado: o alerta diz 2', async () => {
		mockAccounts.accounts = [NUBANK, DUPLICADO];
		mockTransactions.list = [
			tx('m-padaria', 'nubank', 5000, '2026-11-01', 'Padaria'),
			tx('m-mercado', 'nubank', 10_000, '2026-11-07', 'Mercado'),
			tx('x-padaria', 'dup', 5000, '2026-11-01', 'PADARIA'),
			tx('x-drogasil', 'dup', 4590, '2026-11-06', 'DROGASIL'),
			tx('x-mercado', 'dup', 10_000, '2026-11-08', 'SUPERMERCADO'),
		];
		await mergeDuplicateIntoNubank();

		expect(mockMergeCards).toHaveBeenCalledWith('dup', 'nubank');
		expect(alertSpy).toHaveBeenCalledTimes(2);
		expect(alertSpy.mock.calls[1][0]).toBe(`cards.edit.merged ${JSON.stringify({ into: NUBANK.name })}`);
		expect(alertSpy.mock.calls[1][1]).toBe(`cards.duplicates.afterMerge ${JSON.stringify({ count: 2, into: NUBANK.name })}`);
		expect(mockRouter.replace).toHaveBeenCalledWith({ pathname: '/cards/[id]', params: { id: 'nubank' } });
	});

	it('sem nada repetido, nenhum alerta a mais: só o aviso de "juntou" para o leitor de tela', async () => {
		mockAccounts.accounts = [NUBANK, DUPLICADO];
		mockTransactions.list = [
			tx('m-mercado', 'nubank', 10_000, '2026-11-07', 'Mercado'),
			tx('x-mercado', 'dup', 10_000, '2026-11-09', 'SUPERMERCADO'),
			// Outro cartão fica fora: o mesmo valor no débito não é repetido do cartão.
			tx('c-mercado', 'corrente', 10_000, '2026-11-07', 'Mercado'),
		];
		await mergeDuplicateIntoNubank();

		expect(mockMergeCards).toHaveBeenCalledTimes(1);
		expect(alertSpy).toHaveBeenCalledTimes(1);
		expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(`cards.edit.merged ${JSON.stringify({ into: NUBANK.name })}`);
	});

	it('o acerto com a fatura do banco do duplicado é apagado ao juntar: não conta como repetido', async () => {
		mockAccounts.accounts = [NUBANK, DUPLICADO];
		mockTransactions.list = [
			tx('m-padaria', 'nubank', 5000, '2026-11-01', 'Padaria'),
			tx('aj', 'dup', 5000, '2026-11-01', CARD_ADJUSTMENT_NOTE),
		];
		await mergeDuplicateIntoNubank();
		expect(alertSpy).toHaveBeenCalledTimes(1);
	});

	it('o final do duplicado passa para o que vem sem final: virtual 2222 no Nubank e 1111 no duplicado são par (SPD-124)', async () => {
		mockAccounts.accounts = [NUBANK, DUPLICADO];
		mockTransactions.list = [
			tx('m-padaria', 'nubank', 5000, '2026-11-01', 'Padaria', '2222'),
			// Sem final no duplicado: ao juntar ganha o 1111 dele, que não é o 2222. O final do
			// extrato não diz o plástico: a mesma padaria continua marcada (SPD-124).
			tx('x-padaria', 'dup', 5000, '2026-11-01', 'PADARIA'),
		];
		await mergeDuplicateIntoNubank();
		expect(alertSpy).toHaveBeenCalledTimes(2);
		expect(alertSpy.mock.calls[1][1]).toBe(`cards.duplicates.afterMerge ${JSON.stringify({ count: 1, into: NUBANK.name })}`);
	});
});
