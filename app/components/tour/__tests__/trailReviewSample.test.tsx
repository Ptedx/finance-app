/**
 * A Trilha 7 sem nada para revisar (SPD-159): a revisão mostra avisos de exemplo, só em
 * memória e marcados "Exemplo", para os passos 2 a 8 apontarem o aviso, a conta, a categoria,
 * os botões, a notificação original, a pergunta "é o mesmo?" e a linha do aviso incompleto.
 *
 * O critério é confiança: tocar em Confirmar, Transferência, Descartar, nas respostas, na conta
 * ou na categoria do exemplo não chama o `CapturesContext` nem o SQLite, e a contagem de
 * "para revisar" não muda. Com um aviso de verdade não há exemplo; fechando a trilha, ele some.
 *
 * Os contextos são dublês; as chaves de tradução aparecem cruas. Só a medida é de mentira (no
 * jest a `View` não se mede): todo alvo marcado e montado está no meio da tela.
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
const mockDb = {
	execAsync: jest.fn(async () => undefined),
	runAsync: jest.fn(async () => ({ changes: 0, lastInsertRowId: 0 })),
	getFirstAsync: jest.fn(async () => null),
	getAllAsync: jest.fn(async () => []),
	withTransactionAsync: jest.fn(async (body: () => Promise<void>) => body()),
};
const mockData: { pending: unknown[]; accounts: unknown[] } = { pending: [], accounts: [] };

jest.mock('@react-native-async-storage/async-storage', () => ({
	getItem: jest.fn(async (key: string) => mockStorage.get(key) ?? null),
	setItem: jest.fn(async (key: string, value: string) => {
		mockStorage.set(key, value);
	}),
	removeItem: jest.fn(async () => undefined),
}));

jest.mock('expo-sqlite', () => ({ openDatabaseSync: () => mockDb }));

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
	useAccounts: () => ({
		accounts: mockData.accounts,
		activeAccounts: mockData.accounts,
		creditCards: [],
		debitCards: [],
	}),
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
		resolved: [],
		ignoredApps: [],
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
import { configureMoney } from '../../../utils/money';
import { STORAGE_KEYS } from '../../../utils/storageUtils';
import { isSampleId, SAMPLE_IDS } from '../../../utils/trailSample';
import type { TrailLocation, TrailNavAction } from '../../../utils/trails';
import { clearTourRegistry, hasTarget } from '../registry';
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

/** A pilha do app, de mentira: só a tela do topo é desenhada. */
const FakeStack: React.FC<{ initial: TrailLocation[] }> = ({ initial }) => {
	const [stack, update] = useState(initial);
	setStack = update;
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

/** Tudo o que se toca com este rótulo (os três avisos de exemplo têm cada um o seu botão). */
const pressables = (label: string): ReactTestInstance[] =>
	renderer?.root.findAll(
		(candidate: ReactTestInstance) =>
			candidate.props.accessibilityLabel === label && typeof candidate.props.onPress === 'function'
	) ?? [];

const pressLabel = async (label: string) => {
	const node = pressables(label)[0];
	if (!node) throw new Error(`nada tocável com o rótulo ${label}`);
	await act(async () => {
		node.props.onPress();
	});
};

const pressAll = async (label: string) => {
	const nodes = pressables(label);
	if (nodes.length === 0) throw new Error(`nada tocável com o rótulo ${label}`);
	for (const node of nodes)
		await act(async () => {
			node.props.onPress();
		});
	return nodes.length;
};

const pointing = () =>
	(renderer?.root.findAll((node) => node.props.testID === 'trail-outline').length ?? 0) > 0;

const hasBanner = () =>
	(renderer?.root.findAll((node) => node.props.testID === 'trail-sample-banner').length ?? 0) > 0;

/** O cabeçalho da revisão: a contagem de verdade, que o exemplo não muda. */
const headerCount = () =>
	renderer?.root.findAll(
		(node) =>
			typeof node.props.accessibilityLabel === 'string' &&
			node.props.accessibilityLabel.startsWith('captures.pendingCount')
	)[0];

const title = (id: number) => `trails.review.steps.${id}.title`;
const counter = (current: number) => `tutorial.counter{"current":${current},"total":11}`;

const mount = async () => {
	await act(async () => {
		renderer = create(
			<TourProvider trailOptions={{ navigator, settleMs: 0, readyTimeoutMs: 3_000 }}>
				<TrailRecordsSource />
				<FakeStack initial={[{ screen: 'inbox' }]} />
			</TourProvider>
		);
	});
	await wait(50);
};

const writes = () => [
	...Object.entries(mockCaptureActions)
		.filter(([name, fn]) => name !== 'refresh' && fn.mock.calls.length > 0)
		.map(([name]) => name),
	...Object.entries(mockDb)
		.filter(([name, fn]) => name !== 'getAllAsync' && name !== 'getFirstAsync' && fn.mock.calls.length > 0)
		.map(([name]) => `sql.${name}`),
];

beforeEach(() => {
	mockStorage.clear();
	mockActions.length = 0;
	for (const fn of Object.values(mockCaptureActions)) fn.mockClear();
	for (const fn of Object.values(mockDb)) fn.mockClear();
	mockData.pending = [];
	mockData.accounts = [];
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

describe('Trilha 7 sem nada para revisar: os avisos de exemplo (SPD-159)', () => {
	it('fora da trilha, a revisão vazia não tem exemplo', async () => {
		await mount();
		expect(texts()).toContain('captures.empty');
		expect(hasBanner()).toBe(false);
		expect(hasTarget('inbox.card')).toBe(false);
	});

	it('com a trilha aberta: o exemplo marcado, com os alvos dos passos 2 a 8, e cada passo aponta', async () => {
		await mount();
		await pressLabel('trails.help');
		await waitForText(title(1));
		expect(texts()).toContain(counter(1));

		expect(hasBanner()).toBe(true);
		expect(texts()).toContain('trails.sample.banner');
		expect(texts()).not.toContain('captures.empty');
		for (const id of [
			'inbox.card',
			'inbox.account',
			'inbox.category',
			'inbox.buttons',
			'inbox.raw',
			'inbox.question',
			'inbox.ambiguity',
			'inbox.learned',
		])
			expect({ id, registered: hasTarget(id) }).toEqual({ id, registered: true });

		// O aviso: compra, valor, app do banco e hora; na conta de exemplo, com a categoria de exemplo.
		expect(texts()).toContain('− R$ 100,00');
		expect(texts()).toContain('trails.sample.transaction');
		expect(texts().some((line) => line.startsWith('captures.from{"app":"trails.sample.bank"'))).toBe(true);
		expect(texts()).toContain('captures.inAccount{"account":"trails.sample.account"}');
		expect(texts()).toContain('trails.sample.category');
		// A pergunta "é o mesmo?", sobre o aviso de exemplo, e o aviso incompleto, sem conta.
		expect(texts()).toContain('captures.questionDuplicateTitle');
		expect(
			texts().some((line) => line.startsWith('captures.questionDuplicateBody{"app":"trails.sample.bank"'))
		).toBe(true);
		expect(texts()).toContain('captures.ambiguity.credit_no_last4{"last4":""}');
		expect(texts()).toContain('captures.inAccount{"account":"captures.noAccount"}');

		for (const id of [2, 3, 4, 5, 6, 7, 8, 9]) {
			await pressLabel('tutorial.next');
			await waitForText(title(id));
			expect(texts()).toContain(counter(id));
			expect({ id, pointing: pointing() }).toEqual({ id, pointing: true });
			// Os passos do aviso dizem, no balão, que é exemplo.
			expect({ id, tag: texts().includes('trails.sample.tag') }).toEqual({ id, tag: id <= 8 });
		}
		// Nada aprovado sozinho, ignorado nem no histórico: os passos 10 e 11 só com o texto.
		for (const id of [10, 11]) {
			await pressLabel('tutorial.next');
			await waitForText(title(id));
			expect({ id, pointing: pointing() }).toEqual({ id, pointing: false });
		}
		expect(mockActions).toEqual([]);
	});

	it('os botões, as respostas, a conta e a categoria do exemplo não gravam nada nem mudam a contagem', async () => {
		mockData.accounts = [
			{ id: 'corrente', name: 'Corrente', kind: 'checking', archived: false },
		];
		await mount();
		await pressLabel('trails.help');
		await waitForText(title(1));
		expect(hasBanner()).toBe(true);
		expect(headerCount()?.props.accessibilityLabel).toBe('captures.pendingCount{"count":0}');
		expect(headerCount()?.props.children).toBe('');
		for (const fn of Object.values(mockDb)) fn.mockClear();

		// Os três avisos de exemplo têm Confirmar, Transferência e Descartar; o repetido pergunta.
		expect(await pressAll('captures.confirm')).toBe(3);
		expect(await pressAll('captures.transfer')).toBe(3);
		expect(await pressAll('captures.dismiss')).toBe(3);
		await pressAll('captures.sameEntry');
		await pressAll('captures.differentEntries');
		await pressAll('captures.categoryLabel{"category":"trails.sample.category"}');
		// A linha da conta do exemplo não abre a lista, mesmo com contas cadastradas.
		const accountRows = pressables('captures.inAccount{"account":"trails.sample.account"}');
		expect(accountRows.length).toBeGreaterThan(0);
		for (const row of accountRows) expect(row.props.disabled).toBe(true);
		expect(
			renderer?.root.findAll((node) => node.props.visible === true && node.props.options !== undefined) ?? []
		).toEqual([]);

		// A notificação original abre: o texto inventado, no formato de um banco.
		await pressLabel('captures.originalNotification');
		expect(
			texts().some(
				(line) =>
					line.includes('trails.sample.purchaseTitle') && line.includes('trails.sample.purchaseText')
			)
		).toBe(true);

		await wait(50);
		expect(writes()).toEqual([]);
		expect([...mockStorage.keys()].filter((key) => key !== STORAGE_KEYS.tutorial)).toEqual([]);
		// O exemplo segue lá, e a contagem também.
		expect(hasBanner()).toBe(true);
		expect(headerCount()?.props.accessibilityLabel).toBe('captures.pendingCount{"count":0}');
		expect(headerCount()?.props.children).toBe('');
	});

	it('com um aviso de verdade, a revisão mostra o dele e nada de exemplo', async () => {
		mockData.pending = [capture({ id: 'verdade' })];
		await mount();
		await pressLabel('trails.help');
		await waitForText(title(1));
		await pressLabel('tutorial.next');
		await waitForText(title(2));
		expect(pointing()).toBe(true);
		expect(hasBanner()).toBe(false);
		expect(texts()).not.toContain('trails.sample.tag');
		expect(texts()).not.toContain('trails.sample.transaction');
		expect(texts()).toContain('− R$ 20,00');
		expect(texts()).not.toContain('captures.questionDuplicateTitle');
	});

	it('fechando a trilha, o exemplo some e a revisão volta a ficar vazia', async () => {
		await mount();
		await pressLabel('trails.help');
		await waitForText(title(1));
		expect(hasBanner()).toBe(true);

		await pressLabel('tutorial.skip');
		await waitUntil(() => !hasBanner());
		expect(texts()).toContain('captures.empty');
		expect(texts()).not.toContain('trails.sample.transaction');
		expect(hasTarget('inbox.card')).toBe(false);
		expect(writes()).toEqual([]);
	});

	it('os avisos de exemplo têm id de exemplo', async () => {
		await mount();
		await pressLabel('trails.help');
		await waitForText(title(1));
		const shown = (renderer?.root.findAll((node) => node.props.capture?.id !== undefined) ?? []).map(
			(node) => node.props.capture.id as string
		);
		expect([...new Set(shown)]).toStrictEqual([
			'exemplo-aviso',
			'exemplo-aviso-repetido',
			'exemplo-aviso-incompleto',
		]);
		expect([SAMPLE_IDS.capture, SAMPLE_IDS.captureDuplicate, SAMPLE_IDS.captureIncomplete]).toStrictEqual([
			'exemplo-aviso',
			'exemplo-aviso-repetido',
			'exemplo-aviso-incompleto',
		]);
		expect(shown.length).toBeGreaterThan(0);
		expect(shown.every(isSampleId)).toBe(true);
	});
});
