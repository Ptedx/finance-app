/**
 * A Trilha 1 (SPD-131) de verdade, cruzando telas: Ajustes › Contas › Nova conta › a tela de
 * uma conta › Contas › a conta. O guia navega sozinho (aqui, uma pilha de mentira que desenha
 * só a tela do topo), aponta os elementos marcados nas telas reais e, no fim, volta para onde
 * começou — sem salvar, criar, alterar ou apagar nada, e sem gravar nada além do estado do
 * tutorial. Também: "Voltar" volta um passo (e de tela), "Pular" e o voltar do Android
 * encerram, e o "Ver o guia completo" do Acertar abre a trilha no passo 9, na própria conta.
 *
 * Os contextos são dublês; as chaves de tradução aparecem cruas. As marcas são as das telas de
 * verdade; só a medida é de mentira (no jest a `View` não se mede): todo alvo marcado e montado
 * está no meio da tela, e o que não está montado não tem medida.
 */

const mockStorage = new Map<string, string>();
const mockActions: unknown[] = [];
const mockSaving = {
	createAccount: jest.fn(),
	saveAccount: jest.fn(),
	removeAccount: jest.fn(),
	mergeAccounts: jest.fn(),
	takeNotifications: jest.fn(),
	takeBusinessNotifications: jest.fn(),
	adjustAccountMonth: jest.fn(),
	dismissAutoMergeNotices: jest.fn(),
};
const mockData: { accounts: unknown[] } = { accounts: [] };

jest.mock('@react-native-async-storage/async-storage', () => ({
	getItem: jest.fn(async (key: string) => mockStorage.get(key) ?? null),
	setItem: jest.fn(async (key: string, value: string) => {
		mockStorage.set(key, value);
	}),
	removeItem: jest.fn(async () => undefined),
}));

jest.mock('expo-router', () => ({
	router: { push: jest.fn(), back: jest.fn(), navigate: jest.fn(), dismiss: jest.fn(), dismissAll: jest.fn() },
	useRouter: () => ({ replace: jest.fn(), back: jest.fn(), push: jest.fn(), canGoBack: () => true }),
	useLocalSearchParams: () => ({}),
	useFocusEffect: (effect: () => void) => require('react').useEffect(effect, [effect]),
	Stack: { Screen: () => null },
}));

jest.mock('../registry', () => {
	const actual = jest.requireActual('../registry');
	return {
		...actual,
		measureTarget: async (id: string) => (actual.hasTarget(id) ? { x: 16, y: 200, width: 300, height: 50 } : null),
	};
});

jest.mock('../../../utils/onboardingUtils', () => ({ isOnboardingCompleted: jest.fn(async () => true) }));

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

jest.mock('../../../database/database', () => ({ setPreference: jest.fn() }));
jest.mock('../../../database/captures', () => ({}));
jest.mock('../../../utils/distinctAccounts', () => ({
	getDistinctAccountPairs: jest.fn(async () => []),
	markAccountsDistinct: jest.fn(),
}));
jest.mock('../../../utils/businessFeedPreference', () => ({ getBusinessFeeds: jest.fn(async () => ({})) }));
jest.mock('../../../utils/balanceUnsetDismissals', () => ({
	getDismissedBalanceUnset: jest.fn(async () => new Set()),
	dismissBalanceUnset: jest.fn(async () => new Set()),
}));
jest.mock('../../TransactionItem', () => () => null);

jest.mock('../../../contexts/AccountsContext', () => ({
	useAccounts: () => ({
		accounts: mockData.accounts,
		activeAccounts: mockData.accounts,
		bankAccounts: mockData.accounts,
		creditCards: [],
		debitCards: [],
		balances: new Map(),
		provisionalBalances: new Map(),
		accruedYield: new Map(),
		cdi: null,
		periodSpentByAccount: new Map(),
		overview: { cashCents: 100_000, netCents: 100_000 },
		provisionalOverview: { cashCents: 0, netCents: 0 },
		month: null,
		autoMergeNotices: [],
		...mockSaving,
	}),
}));

jest.mock('../../../contexts/TransactionsContext', () => ({
	useTransactions: () => ({ transactions: [] }),
}));

jest.mock('../../../contexts/CapturesContext', () => ({
	useCaptures: () => ({ pending: [], supported: true }),
}));

jest.mock('../../../contexts/PeriodContext', () => ({
	usePeriod: () => ({ selectedYear: 2026, selectedMonth: 11 }),
}));

import type React from 'react';
import { useState } from 'react';
import { AccessibilityInfo, BackHandler, Text } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { Account } from '../../../database/schema';
import AccountEditScreen from '../../../screens/AccountEditScreen';
import AccountsScreen from '../../../screens/AccountsScreen';
import { configureMoney } from '../../../utils/money';
import { STORAGE_KEYS } from '../../../utils/storageUtils';
import type { TrailLocation, TrailNavAction } from '../../../utils/trails';
import { clearTourRegistry } from '../registry';
import TourProvider from '../TourProvider';
import TrailRecordsSource from '../TrailRecordsSource';

jest.setTimeout(60_000);
jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);

const base: Account = {
	id: 'corrente',
	name: 'Corrente Teste',
	kind: 'checking',
	role: 'main',
	envelopeMonthlyCents: null,
	network: null,
	bankName: null,
	color: '#000',
	last4: null,
	closingDay: null,
	closingDaysBefore: null,
	dueDay: null,
	creditLimitCents: null,
	cardNames: null,
	packageName: null,
	accountKey: null,
	openingBalanceCents: 100_000,
	openingBalanceDate: '2026-11-01',
	sortOrder: 1,
	archived: false,
	updatedAt: '',
};
/** A conta que a captura criou: nome do banco, app ligado, saldo 0 — mostra "Saldo não informado". */
const fromCapture: Account = {
	...base,
	id: 'captura',
	name: 'Banco Teste',
	bankName: 'Banco Teste',
	packageName: 'br.com.bancoteste',
	openingBalanceCents: 0,
	sortOrder: 0,
};

let renderer: ReactTestRenderer | null = null;
let setStack: React.Dispatch<React.SetStateAction<TrailLocation[]>> | null = null;
let currentStack: TrailLocation[] = [];

/** A pilha do app, de mentira: só a tela do topo é desenhada; abrir monta uma nova. */
const FakeStack: React.FC<{ initial: TrailLocation[] }> = ({ initial }) => {
	const [stack, update] = useState(initial);
	setStack = update;
	currentStack = stack;
	const top = stack[stack.length - 1];
	if (!top) return null;
	const key = `${stack.length}:${top.screen}:${top.params?.id ?? ''}`;
	if (top.screen === 'accounts') return <AccountsScreen key={key} />;
	if (top.screen === 'accountNew') return <AccountEditScreen key={key} />;
	if (top.screen === 'account') return <AccountEditScreen key={key} accountId={top.params?.id} />;
	return <Text key={key}>{`tela ${top.screen}`}</Text>;
};

const navigator = {
	run: (action: TrailNavAction) => {
		mockActions.push(action);
		setStack?.((stack) => {
			if (action.type === 'push') return [...stack, action.location];
			if (action.type === 'pop') return stack.slice(0, Math.max(0, stack.length - action.count));
			if (action.type === 'root') return [];
			return [{ screen: action.screen }];
		});
	},
};

const wait = (ms: number) => act(async () => new Promise<void>((resolve) => setTimeout(resolve, ms)));

const texts = (): string[] =>
	(renderer?.root.findAll((node) => (node.type as unknown) === Text || (node.type as unknown) === 'Text') ?? []).map((node) =>
		[node.props.children].flat().join('')
	);

const waitForText = async (text: string, timeout = 10_000) => {
	const start = Date.now();
	while (!texts().includes(text) && Date.now() - start < timeout) await wait(25);
	if (!texts().includes(text)) throw new Error(`"${text}" não apareceu. Na tela: ${texts().join(' | ')}`);
};

const waitUntil = async (check: () => boolean, timeout = 10_000) => {
	const start = Date.now();
	while (!check() && Date.now() - start < timeout) await wait(25);
	expect(check()).toBe(true);
};

const pressLabel = async (label: string) => {
	const node = renderer?.root.findAll(
		(candidate: ReactTestInstance) => candidate.props.accessibilityLabel === label && typeof candidate.props.onPress === 'function'
	)[0];
	if (!node) throw new Error(`nada tocável com o rótulo ${label}`);
	await act(async () => {
		node.props.onPress();
	});
};

const pressText = async (label: string) => {
	let node: ReactTestInstance | null =
		renderer?.root.findAll((candidate) => (candidate.type as unknown) === 'Text' && candidate.props.children === label)[0] ?? null;
	while (node && typeof node.props.onPress !== 'function') node = node.parent;
	if (!node) throw new Error(`nada tocável em ${label}`);
	const target = node;
	await act(async () => {
		target.props.onPress();
	});
};

/** O guia aponta um alvo (o contorno em volta dele), em vez de só mostrar o texto. */
const pointing = () => (renderer?.root.findAll((node) => node.props.testID === 'trail-outline').length ?? 0) > 0;

/** Os passos mostrados e se cada um apontou, na ordem. */
const shownSteps: [number, boolean][] = [];
const showStep = async (id: number) => {
	await waitForText(title(id));
	shownSteps.push([id, pointing()]);
};

const title = (id: number) => `trails.accounts.steps.${id}.title`;
const counter = (current: number) => `tutorial.counter{"current":${current},"total":12}`;
const top = () => currentStack[currentStack.length - 1];

const mount = async (initial: TrailLocation[]) => {
	await act(async () => {
		renderer = create(
			<TourProvider trailOptions={{ navigator, settleMs: 0, readyTimeoutMs: 3_000 }}>
				<TrailRecordsSource />
				<FakeStack initial={initial} />
			</TourProvider>
		);
	});
	await wait(50);
};

/** Nada salvo, criado, alterado ou apagado; no aparelho, só o estado do tutorial. */
const expectNothingSaved = () => {
	for (const fn of Object.values(mockSaving)) expect(fn).not.toHaveBeenCalled();
	expect([...mockStorage.keys()].filter((key) => key !== STORAGE_KEYS.tutorial)).toEqual([]);
};

beforeEach(() => {
	mockStorage.clear();
	mockActions.length = 0;
	shownSteps.length = 0;
	for (const fn of Object.values(mockSaving)) fn.mockClear();
	mockData.accounts = [base, fromCapture];
	clearTourRegistry();
	configureMoney({ locale: 'pt-BR', currencyCode: 'BRL', currencySymbol: 'R$' });
});

afterEach(async () => {
	await act(async () => {
		renderer?.unmount();
	});
	renderer = null;
	configureMoney({ locale: 'en-US', currencyCode: 'USD', currencySymbol: '$' });
});

describe('Trilha 1 — Contas, cruzando telas', () => {
	it('anda por Contas › Nova conta › a conta › Contas e volta a Contas no fim, sem salvar nada', async () => {
		await mount([{ screen: 'accounts' }]);
		await pressLabel('trails.help');

		await showStep(1);
		expect(texts()).toContain(counter(1));
		expect(top()).toEqual({ screen: 'accounts' });

		await pressLabel('tutorial.next');
		await showStep(2);

		// Passo 3: o guia abriu a Nova conta, de verdade.
		await pressLabel('tutorial.next');
		await showStep(3);
		expect(top()).toEqual({ screen: 'accountNew' });
		expect(texts()).toContain('accounts.edit.newTitle');

		for (const id of [4, 5, 6, 7, 8]) {
			await pressLabel('tutorial.next');
			await showStep(id);
			expect(top()).toEqual({ screen: 'accountNew' });
		}

		// Passo 9: o formulário fecha sem salvar e abre a primeira conta da lista.
		await pressLabel('tutorial.next');
		await showStep(9);
		expect(top()).toEqual({ screen: 'account', params: { id: 'corrente' } });
		expect(texts()).toContain('Corrente Teste');

		// Passo 10 ("Atenção"): a conta criada pela captura, com o "Saldo não informado".
		await pressLabel('tutorial.next');
		await showStep(10);
		expect(top()).toEqual({ screen: 'account', params: { id: 'captura' } });
		expect(texts()).toContain('accounts.balanceUnset.badge');
		expect(texts()).toContain('trails.attention');

		// "Voltar": um passo atrás, e de tela.
		await pressLabel('trails.back');
		await showStep(9);
		expect(top()).toEqual({ screen: 'account', params: { id: 'corrente' } });
		expect(texts()).not.toContain('trails.attention');

		await pressLabel('tutorial.next');
		await showStep(10);
		await pressLabel('tutorial.next');
		await showStep(11);
		expect(top()).toEqual({ screen: 'accounts' });

		await pressLabel('tutorial.next');
		await showStep(12);
		expect(top()).toEqual({ screen: 'account', params: { id: 'corrente' } });
		expect(texts()).toContain(counter(12));
		expect(texts()).not.toContain('tutorial.skip');
		// Cada passo aponta a marca da tela de verdade; o 11 (as contas parecidas) não tem par
		// parecido aqui e segue o `[sem dado]`: o texto sem apontar.
		expect(shownSteps).toEqual([
			[1, true],
			[2, true],
			[3, true],
			[4, true],
			[5, true],
			[6, true],
			[7, true],
			[8, true],
			[9, true],
			[10, true],
			[9, true],
			[10, true],
			[11, false],
			[12, true],
		]);

		await pressLabel('tutorial.done');
		await waitUntil(() => !texts().includes(title(12)));
		await waitUntil(() => top()?.screen === 'accounts');
		expect(currentStack).toEqual([{ screen: 'accounts' }]);

		expectNothingSaved();
		expect(mockActions).toEqual([
			{ type: 'push', location: { screen: 'accountNew' } },
			{ type: 'pop', count: 1 },
			{ type: 'push', location: { screen: 'account', params: { id: 'corrente' } } },
			{ type: 'pop', count: 1 },
			{ type: 'push', location: { screen: 'account', params: { id: 'captura' } } },
			{ type: 'pop', count: 1 },
			{ type: 'push', location: { screen: 'account', params: { id: 'corrente' } } },
			{ type: 'pop', count: 1 },
			{ type: 'push', location: { screen: 'account', params: { id: 'captura' } } },
			{ type: 'pop', count: 1 },
			{ type: 'push', location: { screen: 'account', params: { id: 'corrente' } } },
			{ type: 'pop', count: 1 },
		]);
	});

	it('"Pular" no meio da Nova conta encerra e fecha o formulário, sem salvar', async () => {
		await mount([{ screen: 'accounts' }]);
		await pressLabel('trails.help');
		await waitForText(title(1));
		await pressLabel('tutorial.next');
		await waitForText(title(2));
		await pressLabel('tutorial.next');
		await waitForText(title(3));
		await pressLabel('tutorial.next');
		await waitForText(title(4));

		await pressLabel('tutorial.skip');
		await waitUntil(() => top()?.screen === 'accounts');
		await waitUntil(() => !texts().includes(title(4)));
		expect(currentStack).toEqual([{ screen: 'accounts' }]);
		expectNothingSaved();
	});

	it('o voltar do Android também encerra, e volta para onde começou', async () => {
		const handlers: (() => boolean | null | undefined)[] = [];
		const spy = jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, handler) => {
			handlers.push(handler);
			return { remove: () => undefined };
		});
		await mount([{ screen: 'accounts' }]);
		await pressLabel('trails.help');
		await waitForText(title(1));
		await pressLabel('tutorial.next');
		await waitForText(title(2));
		await pressLabel('tutorial.next');
		await waitForText(title(3));

		// Como o Android: do último inscrito para o primeiro, até alguém tratar.
		let handled = false;
		await act(async () => {
			handled = [...handlers].reverse().some((handler) => handler() === true);
		});
		// O guia segura o voltar: a tela de trás não volta sozinha no meio da trilha.
		expect(handled).toBe(true);
		await waitUntil(() => top()?.screen === 'accounts');
		await waitUntil(() => !texts().includes(title(3)));
		expectNothingSaved();
		spy.mockRestore();
	});

	it('o "Ver o guia completo" do Acertar abre a trilha no passo 9, na própria conta, sem acertar nada', async () => {
		await mount([{ screen: 'account', params: { id: 'captura' } }]);
		await pressText('accounts.edit.setBalance');
		await pressLabel('tutorial.help');
		await pressLabel('tutorial.tip.fullGuide');

		await waitForText(title(9));
		expect(texts()).toContain(counter(9));
		expect(top()).toEqual({ screen: 'account', params: { id: 'captura' } });
		expect(mockActions).toEqual([]);

		await pressLabel('tutorial.skip');
		await waitUntil(() => !texts().includes(title(9)));
		expect(currentStack).toEqual([{ screen: 'account', params: { id: 'captura' } }]);
		expectNothingSaved();
	});
});
