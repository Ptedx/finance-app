/**
 * A Trilha 7 (SPD-131) na revisão de verdade: o guia aponta o cartão do aviso, a conta, a
 * categoria, os botões, o texto original, a pergunta, a linha do porquê, o "o app aprende", as
 * aprovadas sozinhas e os ignorados, e o histórico — sem confirmar, descartar, responder,
 * desfazer nem mudar nada. Começando pelo "?" da própria revisão, o passo da Início não tira a
 * revisão da pilha (as escolhas feitas nos cartões e não confirmadas se perderiam): mostra o
 * texto ali mesmo, sem apontar.
 *
 * Os contextos são dublês; as chaves de tradução aparecem cruas. As marcas são as das telas de
 * verdade; só a medida é de mentira (no jest a `View` não se mede): todo alvo marcado e montado
 * está no meio da tela, e o que não está montado não tem medida.
 */

const mockStorage = new Map<string, string>();
const mockActions: unknown[] = [];
const mockCaptureActions = {
	refresh: jest.fn(),
	openSettings: jest.fn(),
	confirm: jest.fn(),
	dismiss: jest.fn(),
	markTransfer: jest.fn(),
	answerDuplicate: jest.fn(),
	answerTransfer: jest.fn(),
	answerDirection: jest.fn(),
	resolveInvoicePayment: jest.fn(),
	revert: jest.fn(),
	unignoreApp: jest.fn(),
	undo: jest.fn(),
	clearUndo: jest.fn(),
};
const mockData: { pending: unknown[]; resolved: unknown[]; ignoredApps: unknown[] } = {
	pending: [],
	resolved: [],
	ignoredApps: [],
};

jest.mock('@react-native-async-storage/async-storage', () => ({
	getItem: jest.fn(async (key: string) => mockStorage.get(key) ?? null),
	setItem: jest.fn(async (key: string, value: string) => {
		mockStorage.set(key, value);
	}),
	removeItem: jest.fn(async () => undefined),
}));

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
	router: {
		push: jest.fn(),
		back: jest.fn(),
		navigate: jest.fn(),
		dismiss: jest.fn(),
		dismissAll: jest.fn(),
	},
	useRouter: () => ({
		replace: jest.fn(),
		back: jest.fn(),
		push: jest.fn(),
		canGoBack: () => true,
	}),
	useLocalSearchParams: () => ({}),
	useFocusEffect: (effect: () => void) => require('react').useEffect(effect, [effect]),
	Stack: { Screen: () => null },
}));

jest.mock('../registry', () => {
	const actual = jest.requireActual('../registry');
	return {
		...actual,
		measureTarget: async (id: string) =>
			actual.hasTarget(id) ? { x: 16, y: 200, width: 300, height: 50 } : null,
	};
});

jest.mock('../../../utils/onboardingUtils', () => ({
	isOnboardingCompleted: jest.fn(async () => true),
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('react-native-safe-area-context', () => {
	const { View } = require('react-native');
	return {
		SafeAreaView: View,
		useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
	};
});

jest.mock('react-i18next', () => ({
	useTranslation: () => ({
		t: (key: string, params?: Record<string, unknown>) =>
			params ? `${key}${JSON.stringify(params)}` : key,
	}),
}));

jest.mock('../../../database/captures', () => ({
	getStatementClaimedCaptureIds: jest.fn(async () => new Set<string>()),
}));
jest.mock('../../../utils/balanceUnsetDismissals', () => ({
	getDismissedBalanceUnset: jest.fn(async () => new Set()),
}));

jest.mock('../../../contexts/AccountsContext', () => ({
	useAccounts: () => ({ accounts: [], activeAccounts: [], creditCards: [], debitCards: [] }),
}));

jest.mock('../../../contexts/TransactionsContext', () => ({
	useTransactions: () => ({
		transactions: [],
		categories: [
			{ id: 'food', name: 'Alimentação', type: 'expense', color: '#fff', icon: 'pizza' },
		],
	}),
}));

jest.mock('../../../contexts/CapturesContext', () => ({
	useCaptures: () => ({
		supported: true,
		enabled: true,
		pending: mockData.pending,
		resolved: mockData.resolved,
		ignoredApps: mockData.ignoredApps,
		isLoading: false,
		lastAction: null,
		...mockCaptureActions,
	}),
}));

import type React from 'react';
import { useState } from 'react';
import { AccessibilityInfo, Text } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { Capture } from '../../../database/schema';
import CaptureInboxScreen from '../../../screens/CaptureInboxScreen';
import { ambiguousReason } from '../../../utils/ambiguityReasons';
import { configureMoney } from '../../../utils/money';
import { STORAGE_KEYS } from '../../../utils/storageUtils';
import type { TrailLocation, TrailNavAction } from '../../../utils/trails';
import { clearTourRegistry } from '../registry';
import TourProvider from '../TourProvider';
import TrailRecordsSource from '../TrailRecordsSource';

jest.setTimeout(60_000);
jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);

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

let renderer: ReactTestRenderer | null = null;
let setStack: React.Dispatch<React.SetStateAction<TrailLocation[]>> | null = null;
let currentStack: TrailLocation[] = [];

/** A pilha do app, de mentira: só a tela do topo é desenhada. */
const FakeStack: React.FC<{ initial: TrailLocation[] }> = ({ initial }) => {
	const [stack, update] = useState(initial);
	setStack = update;
	currentStack = stack;
	const top = stack[stack.length - 1];
	if (!top) return null;
	const key = `${stack.length}:${top.screen}`;
	if (top.screen === 'inbox') return <CaptureInboxScreen key={key} />;
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

const wait = (ms: number) =>
	act(async () => new Promise<void>((resolve) => setTimeout(resolve, ms)));

const texts = (): string[] =>
	(
		renderer?.root.findAll(
			(node) => (node.type as unknown) === Text || (node.type as unknown) === 'Text'
		) ?? []
	).map((node) => [node.props.children].flat().join(''));

const waitForText = async (text: string, timeout = 10_000) => {
	const start = Date.now();
	while (!texts().includes(text) && Date.now() - start < timeout) await wait(25);
	if (!texts().includes(text))
		throw new Error(`"${text}" não apareceu. Na tela: ${texts().join(' | ')}`);
};

const waitUntil = async (check: () => boolean, timeout = 10_000) => {
	const start = Date.now();
	while (!check() && Date.now() - start < timeout) await wait(25);
	expect(check()).toBe(true);
};

const pressLabel = async (label: string) => {
	const node = renderer?.root.findAll(
		(candidate: ReactTestInstance) =>
			candidate.props.accessibilityLabel === label && typeof candidate.props.onPress === 'function'
	)[0];
	if (!node) throw new Error(`nada tocável com o rótulo ${label}`);
	await act(async () => {
		node.props.onPress();
	});
};

/** O guia aponta um alvo (o contorno em volta dele), em vez de só mostrar o texto. */
const pointing = () =>
	(renderer?.root.findAll((node) => node.props.testID === 'trail-outline').length ?? 0) > 0;

const title = (id: number) => `trails.review.steps.${id}.title`;
const counter = (current: number) => `tutorial.counter{"current":${current},"total":11}`;

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

beforeEach(() => {
	mockStorage.clear();
	mockActions.length = 0;
	for (const fn of Object.values(mockCaptureActions)) fn.mockClear();
	mockData.pending = [
		capture({ id: 'simples' }),
		capture({ id: 'repetido', question: 'duplicate' }),
		capture({ id: 'ambiguo', kind: 'card_purchase', reason: ambiguousReason('credit_no_last4') }),
	];
	mockData.resolved = [
		capture({
			id: 'sozinha',
			status: 'confirmed',
			autoConfirmed: true,
			updatedAt: new Date().toISOString(),
		}),
	];
	mockData.ignoredApps = [{ packageName: 'com.example.loja', appLabel: 'Loja Teste' }];
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

describe('Trilha 7 — Revisar, na revisão', () => {
	it('anda pelos 11 passos sem confirmar, descartar, responder nem desfazer nada, e sem sair da revisão', async () => {
		await mount([{ screen: 'inbox' }]);
		await pressLabel('trails.help');

		// Passo 1 é na Início: sair tiraria a revisão da pilha. O texto aparece aqui, sem apontar.
		await waitForText(title(1));
		expect(texts()).toContain(counter(1));
		expect(pointing()).toBe(false);
		expect(currentStack).toEqual([{ screen: 'inbox' }]);

		for (const id of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
			await pressLabel('tutorial.next');
			await waitForText(title(id));
			expect(texts()).toContain(counter(id));
			// Todos os alvos existem na revisão montada: cada passo aponta o seu.
			expect({ id, pointing: pointing() }).toEqual({ id, pointing: true });
			expect(texts().includes('trails.attention')).toBe(id === 7 || id === 8);
		}

		await pressLabel('tutorial.done');
		await waitUntil(() => !texts().includes(title(11)));

		expect(mockActions).toEqual([]);
		expect(currentStack).toEqual([{ screen: 'inbox' }]);
		for (const fn of Object.values(mockCaptureActions)) {
			if (fn !== mockCaptureActions.refresh) expect(fn).not.toHaveBeenCalled();
		}
		expect([...mockStorage.keys()].filter((key) => key !== STORAGE_KEYS.tutorial)).toEqual([]);
	});

	it('sem nada para revisar: os 11 passos, com os avisos de exemplo (SPD-159; detalhes em trailReviewSample)', async () => {
		mockData.pending = [];
		await mount([{ screen: 'inbox' }]);
		await pressLabel('trails.help');

		await waitForText(title(1));
		expect(texts()).toContain(counter(1));
		expect(pointing()).toBe(false);
		for (const id of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
			await pressLabel('tutorial.next');
			await waitForText(title(id));
			expect({ id, pointing: pointing() }).toEqual({ id, pointing: true });
		}
		await pressLabel('tutorial.done');
		await waitUntil(() => !texts().includes(title(11)));
		expect(mockActions).toEqual([]);
		for (const fn of Object.values(mockCaptureActions)) {
			if (fn !== mockCaptureActions.refresh) expect(fn).not.toHaveBeenCalled();
		}
	});
});
