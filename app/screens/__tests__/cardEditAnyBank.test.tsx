/**
 * O formulário do cartão serve para qualquer banco (SPD-109). No aparelho, editando um
 * cartão do C6, a dica falava do Nubank; o cartão novo já vinha com o Nubank escolhido; e o
 * prazo entre fechamento e vencimento começava em 7, "como no Nubank".
 *
 * Agora: nenhum texto do formulário cita banco (fora a lista de bancos para escolher), o
 * cartão novo começa sem banco e o salvar pede um, e o formulário pergunta o dia do
 * vencimento que a fatura mostra. O prazo gravado (`closingDaysBefore`) sai da fatura aberta
 * de hoje: fecha 28/10 e vence 05/11 são 8 dias.
 *
 * O `t` daqui resolve no idioma de verdade (pt, en ou it), então o teste também falha se a
 * chave não existir. O resto da tela é dublê.
 */

import en from '../../i18n/locales/en';
import itLocale from '../../i18n/locales/it';
import pt from '../../i18n/locales/pt';

const mockLocale: { current: unknown } = { current: pt };

/** `t` mínimo: busca a chave no idioma escolhido e interpola `{{assim}}`, como o i18next. */
const mockT = (key: string, options: Record<string, unknown> = {}): string => {
	const found = key
		.split('.')
		.reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], mockLocale.current);
	if (typeof found !== 'string') throw new Error(`chave de tradução ausente: ${key}`);
	return found.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options[name]));
};

const mockToday = { value: '2026-11-07' };
const mockCreateAccount = jest.fn(async (_draft: Record<string, unknown>) => 'novo');
const mockSaveAccount = jest.fn(async (_account: Record<string, unknown>) => undefined);
const mockAdjustCardInvoices = jest.fn(async () => undefined);
const mockRouter = {
	replace: jest.fn(),
	back: jest.fn(),
	push: jest.fn(),
	dismiss: jest.fn(),
	dismissTo: jest.fn(),
	canGoBack: jest.fn(() => true),
};
const mockAccounts: { accounts: unknown[] } = { accounts: [] };

jest.mock('@react-native-async-storage/async-storage', () =>
	require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('../../database/database', () => ({}));

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
	useTranslation: () => ({ t: mockT }),
}));

jest.mock('../../components/cards/CardFace', () => () => null);

jest.mock('../../contexts/AccountsContext', () => ({
	useAccounts: () => ({
		accounts: mockAccounts.accounts,
		bankAccounts: [],
		createAccount: mockCreateAccount,
		saveAccount: mockSaveAccount,
		removeAccount: jest.fn(),
		adjustCardInvoices: mockAdjustCardInvoices,
		convertCardToDebit: jest.fn(),
		mergeCards: jest.fn(),
	}),
}));

jest.mock('../../contexts/TransactionsContext', () => ({
	useTransactions: () => ({ transactions: [] }),
}));

jest.mock('../../utils/dateUtils', () => ({ ...jest.requireActual('../../utils/dateUtils'), todayISO: () => mockToday.value }));

import { AccessibilityInfo, TextInput } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer, type ReactTestRendererJSON } from 'react-test-renderer';
import type { Account } from '../../database/schema';
import { configureDateLocale } from '../../utils/dateUtils';
import CardEditScreen, { dueDayShown, dueGapFor } from '../CardEditScreen';

jest.setTimeout(20_000);
jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);

// Datas como o app mostra em português: 28/10, outubro.
beforeAll(() => configureDateLocale('pt-BR'));
afterAll(() => configureDateLocale('en-US'));

const C6: Account = {
	id: 'c6',
	name: 'C6 Teste',
	kind: 'credit_card',
	role: 'card',
	envelopeMonthlyCents: null,
	bankName: 'C6 Bank',
	color: '#242424',
	last4: '4444',
	network: null,
	closingDay: 3,
	dueDay: 13,
	closingDaysBefore: 10,
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
};

let renderer: ReactTestRenderer | null = null;

const mount = async (cardId?: string) => {
	await act(async () => {
		renderer = create(<CardEditScreen cardId={cardId} />);
	});
};

const root = (): ReactTestInstance => {
	if (!renderer) throw new Error('tela não montada');
	return renderer.root;
};

/** Todo texto que a tela mostra ou lê em voz alta, fora a lista de bancos para escolher. */
const visibleTexts = (): string[] => {
	const bankGroup = mockT('cards.edit.bank');
	const out: string[] = [];
	const walk = (node: ReactTestRendererJSON | string | null) => {
		if (node === null) return;
		if (typeof node === 'string') {
			out.push(node);
			return;
		}
		if (node.props.accessibilityRole === 'radiogroup' && node.props.accessibilityLabel === bankGroup) return;
		for (const value of Object.values(node.props)) if (typeof value === 'string') out.push(value);
		for (const child of node.children ?? []) walk(child);
	};
	const json = renderer?.toJSON() ?? null;
	for (const node of Array.isArray(json) ? json : [json]) walk(node);
	return out;
};

/** O campo de texto pelo rótulo. */
const input = (labelKey: string): ReactTestInstance => {
	const label = mockT(labelKey);
	const [found] = root().findAll((node) => (node.type as unknown) === TextInput && node.props.accessibilityLabel === label);
	if (!found) throw new Error(`sem o campo ${label}`);
	return found;
};

const type = async (labelKey: string, text: string) => {
	await act(async () => {
		input(labelKey).props.onChangeText(text);
	});
};

/** Os chips de banco marcados como escolhidos. */
const chosenBanks = (): string[] => {
	const bankGroup = mockT('cards.edit.bank');
	const [group] = root().findAll((node) => node.props.accessibilityRole === 'radiogroup' && node.props.accessibilityLabel === bankGroup);
	if (!group) throw new Error('sem a lista de bancos');
	return group
		.findAll((node) => node.props.accessibilityRole === 'radio' && node.props.accessibilityState?.selected === true && typeof node.props.onPress === 'function')
		.map((node) => node.props.accessibilityLabel as string)
		.filter((label, index, all) => all.indexOf(label) === index);
};

const press = async (label: string) => {
	const [found] = root().findAll((node) => typeof node.props.onPress === 'function' && node.props.accessibilityLabel === label);
	if (!found) throw new Error(`sem o botão ${label}`);
	await act(async () => {
		await found.props.onPress();
	});
};

const save = () => press(mockT('cards.edit.save'));

beforeEach(() => {
	jest.clearAllMocks();
	mockLocale.current = pt;
	mockToday.value = '2026-11-07';
	mockAccounts.accounts = [];
});

afterEach(() => {
	if (renderer) act(() => renderer?.unmount());
	renderer = null;
});

describe('nenhum texto do formulário supõe um banco', () => {
	it.each([
		['pt', pt],
		['en', en],
		['it', itLocale],
	])('cartão do C6 (%s): "Nubank" não aparece em texto nenhum', async (_name, locale) => {
		mockLocale.current = locale;
		mockAccounts.accounts = [C6];
		await mount('c6');
		const texts = visibleTexts();
		expect(texts.length).toBeGreaterThan(10);
		expect(texts.filter((text) => /nubank/i.test(text))).toEqual([]);
	});

	it.each([
		['pt', pt],
		['en', en],
		['it', itLocale],
	])('cartão novo (%s): "Nubank" também não', async (_name, locale) => {
		mockLocale.current = locale;
		await mount();
		expect(visibleTexts().filter((text) => /nubank/i.test(text))).toEqual([]);
	});

	it('a dica diz onde achar os dois dias e que o vencimento em dia não útil passa para o próximo', async () => {
		await mount();
		const hint = pt.cards.edit.cycleHint;
		expect(visibleTexts()).toContain(hint);
		expect(hint).toMatch(/fechamento/);
		expect(hint).toMatch(/vencimento/);
		expect(hint).toMatch(/próximo dia útil/);
	});
});

describe('o banco do cartão', () => {
	it('cartão novo começa sem banco escolhido', async () => {
		await mount();
		expect(chosenBanks()).toEqual([]);
	});

	it('salvar sem banco não cria o cartão e diz que falta o banco', async () => {
		await mount();
		await save();
		expect(mockCreateAccount).not.toHaveBeenCalled();
		expect(visibleTexts()).toContain(pt.cards.edit.bankRequired);
	});

	it('escolhido o C6, cria com o C6', async () => {
		await mount();
		await press('C6 Bank');
		expect(chosenBanks()).toEqual(['C6 Bank']);
		await save();
		expect(mockCreateAccount).toHaveBeenCalledTimes(1);
		expect(mockCreateAccount.mock.calls[0][0]).toMatchObject({ bankName: 'C6 Bank', color: '#242424', closingDay: null, closingDaysBefore: null, dueDay: null });
	});

	it('cartão existente continua com o banco dele', async () => {
		mockAccounts.accounts = [C6];
		await mount('c6');
		expect(chosenBanks()).toEqual(['C6 Bank']);
	});

	it('cartão existente sem banco gravado não ganha o Nubank: fica sem escolha até o dono escolher', async () => {
		mockAccounts.accounts = [{ ...C6, bankName: null }];
		await mount('c6');
		expect(chosenBanks()).toEqual([]);
		await save();
		expect(mockSaveAccount).not.toHaveBeenCalled();
	});
});

describe('prazo entre fechamento e vencimento, pelo dia do vencimento da fatura', () => {
	it('dueGapFor: fecha 28 e vence 5, contado na fatura aberta de hoje', () => {
		// Em 10/10 a fatura aberta fecha 28/10 e vence 05/11: 8 dias (outubro tem 31).
		expect(dueGapFor(28, 5, '2026-10-10')).toBe(8);
		// Em 07/11 fecha 28/11 e vence 05/12: 7 dias.
		expect(dueGapFor(28, 5, '2026-11-07')).toBe(7);
		// Em fevereiro fecha 28/02 e vence 05/03: 5 dias.
		expect(dueGapFor(28, 5, '2027-02-10')).toBe(5);
		// No mesmo mês: fecha 3, vence 13.
		expect(dueGapFor(3, 13, '2026-11-07')).toBe(10);
		// Fechamento 31 em novembro cai em 30/11; vence 07/12.
		expect(dueGapFor(31, 7, '2026-11-07')).toBe(7);
		// Vence no mesmo dia em que fecha: o vencimento é o do mês seguinte (30 dias).
		expect(dueGapFor(28, 28, '2026-11-07')).toBe(30);
	});

	it('dueDayShown: o dia gravado, ou o que sai do fechamento e do prazo', () => {
		expect(dueDayShown({ closingDay: 28, closingDaysBefore: 8, dueDay: 5 }, '2026-11-07')).toBe('5');
		// Sem o dia gravado (cartão de versão antiga): fecha 28/11 + 7 = 05/12.
		expect(dueDayShown({ closingDay: 28, closingDaysBefore: 7, dueDay: null }, '2026-11-07')).toBe('5');
		expect(dueDayShown({ closingDay: null, closingDaysBefore: null, dueDay: null }, '2026-11-07')).toBe('');
		// Vencimento sem fechamento não monta fatura: em branco, e o salvar não pede o fechamento.
		expect(dueDayShown({ closingDay: null, closingDaysBefore: null, dueDay: 10 }, '2026-11-07')).toBe('');
	});

	it('cartão sem fechamento e com um vencimento antigo gravado: salvar sem mexer funciona', async () => {
		mockAccounts.accounts = [{ ...C6, closingDay: null, closingDaysBefore: null, dueDay: 10 }];
		await mount('c6');
		await save();
		expect(mockSaveAccount).toHaveBeenCalledTimes(1);
		expect(mockSaveAccount.mock.calls[0][0]).toMatchObject({ closingDay: null, closingDaysBefore: null, dueDay: null });
	});

	it('cartão novo: o vencimento começa em branco, sem prazo suposto', async () => {
		await mount();
		expect(input('cards.edit.dueDay').props.value).toBe('');
	});

	it('fecha 28 e vence 5 em outubro: grava 8 dias e o dia 5, e a prévia mostra 28/10 e 05/11', async () => {
		mockToday.value = '2026-10-10';
		await mount();
		await press('C6 Bank');
		await type('cards.edit.closingDay', '28');
		await type('cards.edit.dueDay', '5');
		expect(visibleTexts()).toContain(mockT('cards.edit.cyclePreview', { month: 'outubro', closing: '28/10', due: '05/11' }));
		await save();
		expect(mockCreateAccount).toHaveBeenCalledTimes(1);
		expect(mockCreateAccount.mock.calls[0][0]).toMatchObject({ closingDay: 28, closingDaysBefore: 8, dueDay: 5 });
	});

	it('reabrir o cartão mostra fechamento 28 e vencimento 5; salvar sem mexer mantém os 8 dias, mesmo um mês depois', async () => {
		mockToday.value = '2026-11-20';
		mockAccounts.accounts = [{ ...C6, closingDay: 28, closingDaysBefore: 8, dueDay: 5 }];
		await mount('c6');
		expect(input('cards.edit.closingDay').props.value).toBe('28');
		expect(input('cards.edit.dueDay').props.value).toBe('5');
		await save();
		expect(mockSaveAccount).toHaveBeenCalledTimes(1);
		expect(mockSaveAccount.mock.calls[0][0]).toMatchObject({ id: 'c6', closingDay: 28, closingDaysBefore: 8, dueDay: 5 });
	});

	it('a prévia vence no dia digitado, não no prazo gravado: em fevereiro, com os 8 dias de outubro, 05/03 (não 08/03)', async () => {
		mockToday.value = '2027-02-10';
		mockAccounts.accounts = [{ ...C6, closingDay: 28, closingDaysBefore: 8, dueDay: 5 }];
		await mount('c6');
		expect(visibleTexts()).toContain(mockT('cards.edit.cyclePreview', { month: 'fevereiro', closing: '28/02', due: '05/03' }));
	});

	it('trocar o vencimento de um cartão existente recalcula o prazo: C6 fecha 3, vence 13 → 15 são 12 dias', async () => {
		mockAccounts.accounts = [C6];
		await mount('c6');
		expect(input('cards.edit.dueDay').props.value).toBe('13');
		await type('cards.edit.dueDay', '15');
		await save();
		expect(mockSaveAccount.mock.calls[0][0]).toMatchObject({ closingDay: 3, closingDaysBefore: 12, dueDay: 15 });
	});

	it('vence no mesmo dia em que fecha: prazo longo demais, não salva e diz o porquê', async () => {
		await mount();
		await press('C6 Bank');
		await type('cards.edit.closingDay', '28');
		await type('cards.edit.dueDay', '28');
		await save();
		expect(mockCreateAccount).not.toHaveBeenCalled();
		expect(visibleTexts()).toContain(pt.cards.edit.invalidDueGap);
	});

	it('fechamento sem vencimento: pede o vencimento', async () => {
		await mount();
		await press('C6 Bank');
		await type('cards.edit.closingDay', '28');
		await save();
		expect(mockCreateAccount).not.toHaveBeenCalled();
		expect(visibleTexts()).toContain(pt.cards.edit.dueNeeded);
	});

	it('vencimento sem fechamento: pede o fechamento', async () => {
		await mount();
		await press('C6 Bank');
		await type('cards.edit.dueDay', '5');
		await save();
		expect(mockCreateAccount).not.toHaveBeenCalled();
		expect(visibleTexts()).toContain(pt.cards.edit.closingNeeded);
	});
});
