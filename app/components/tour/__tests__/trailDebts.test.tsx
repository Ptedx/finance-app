/**
 * A Trilha 9 (SPD-131b) de verdade, cruzando telas: Patrimônio › Nova dívida › a tela de uma
 * dívida › Editar dívida, e de volta ao Patrimônio no fim. O guia navega sozinho (uma pilha de
 * mentira que desenha só a tela do topo), aponta as marcas das telas reais e não salva, cria,
 * altera nem apaga nada: nem dívida, nem amortização, nem a meta da reserva.
 *
 * Os contextos e os hooks de dados são dublês; as chaves de tradução aparecem cruas. Só a
 * medida é de mentira (no jest a `View` não se mede): todo alvo marcado e montado está no meio
 * da tela, e o que não está montado não tem medida.
 */

const mockStorage = new Map<string, string>();
const mockActions: unknown[] = [];
const mockSaving = {
	createDebt: jest.fn(),
	saveDebt: jest.fn(),
	removeDebt: jest.fn(),
	recordExtraPayment: jest.fn(),
	saveReserveGoal: jest.fn(),
	saveRetirementGoal: jest.fn(),
	clearRetirementGoal: jest.fn(),
};
const mockData: { debts: unknown[] } = { debts: [] };

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
jest.mock('../../../utils/dateUtils', () => ({ ...jest.requireActual('../../../utils/dateUtils'), todayISO: () => '2026-11-07' }));

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
jest.mock('../../../utils/balanceUnsetDismissals', () => ({
	getDismissedBalanceUnset: jest.fn(async () => new Set()),
	dismissBalanceUnset: jest.fn(async () => new Set()),
}));
// As folhas (a meta da reserva, a simulação) a trilha nunca abre.
jest.mock('../../wealth/ReserveSheet', () => () => null);
jest.mock('../../debts/AmortizeSheet', () => () => null);

const mockAccount = {
	id: 'corrente',
	name: 'Corrente Teste',
	kind: 'checking',
	role: 'main',
	archived: false,
	color: '#000',
	sortOrder: 0,
};

jest.mock('../../../contexts/AccountsContext', () => ({
	useAccounts: () => ({
		accounts: [mockAccount],
		activeAccounts: [mockAccount],
		bankAccounts: [mockAccount],
		creditCards: [],
		debitCards: [],
		cardSummaries: new Map(),
		cdi: null,
		overview: { cashCents: 100_000, savedCents: 0, netCents: 100_000 },
		refresh: jest.fn(async () => undefined),
	}),
}));

jest.mock('../../../contexts/TransactionsContext', () => ({
	useTransactions: () => ({ transactions: [] }),
}));

jest.mock('../../../contexts/CapturesContext', () => ({
	useCaptures: () => ({ pending: [], supported: false }),
}));

jest.mock('../../../contexts/DebtsContext', () => {
	const { createContext } = require('react');
	const value = {
		get debts() {
			return mockData.debts;
		},
		get activeDebts() {
			return mockData.debts;
		},
		summary: { balanceCents: 0, monthlyCents: 0, weightedRateBp: null, lastPayoffDate: null, releases: [] },
		isLoading: false,
		createDebt: (...args: unknown[]) => mockSaving.createDebt(...args),
		saveDebt: (...args: unknown[]) => mockSaving.saveDebt(...args),
		removeDebt: (...args: unknown[]) => mockSaving.removeDebt(...args),
		recordExtraPayment: (...args: unknown[]) => mockSaving.recordExtraPayment(...args),
		refresh: jest.fn(async () => undefined),
	};
	// As funções chamam os dublês na hora (a fábrica roda antes deles existirem). Sem provider: o valor padrão do contexto é o dublê, para o `TrailRecordsSource` ler as dívidas.
	return { __esModule: true, default: createContext(value), useDebts: () => value, draftOf: (debt: unknown) => debt };
});

jest.mock('../../../hooks/useRetirementGoal', () => ({
	useRetirementGoal: () => ({ goal: null, isLoading: false, save: mockSaving.saveRetirementGoal, clear: mockSaving.clearRetirementGoal }),
}));

jest.mock('../../../hooks/useReserveGoal', () => ({
	useReserveGoal: () => ({ goal: { targetMonths: 12, monthlyCostCents: null }, save: mockSaving.saveReserveGoal }),
}));

jest.mock('../../../hooks/useReportsData', () => ({
	useReportsData: () => ({
		reserve: {
			status: 'unknown',
			monthlyCostCents: null,
			costSource: null,
			targetMonths: 12,
			targetCents: null,
			split: { poolCents: 0, reserveCents: 0, investmentCents: 0 },
			progressBp: 0,
			monthsCovered: null,
			gapCents: 0,
			monthsToFill: null,
			minimumGapCents: 0,
		},
		reserveComputedCostCents: null,
		priorities: [],
		isLoading: false,
		refresh: jest.fn(async () => undefined),
	}),
}));

import type React from 'react';
import { useState } from 'react';
import { AccessibilityInfo, Text } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { Debt } from '../../../database/schema';
import DebtDetailScreen from '../../../screens/DebtDetailScreen';
import DebtEditScreen from '../../../screens/DebtEditScreen';
import WealthScreen from '../../../screens/WealthScreen';
import { configureMoney } from '../../../utils/money';
import { STORAGE_KEYS } from '../../../utils/storageUtils';
import type { TrailLocation, TrailNavAction } from '../../../utils/trails';
import { clearTourRegistry } from '../registry';
import TourProvider from '../TourProvider';
import TrailRecordsSource, { debtRecords } from '../TrailRecordsSource';

jest.setTimeout(60_000);
jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);

/** Um financiamento de teste, em dia: tem veredito e "Simular". */
const car: Debt = {
	id: 'carro',
	name: 'Carro Teste',
	kind: 'financing',
	system: 'price',
	openingBalanceCents: 3_000_000,
	openingBalanceDate: '2026-10-07',
	installmentCents: 100_000,
	remainingAtOpening: 40,
	installmentsTotal: 48,
	dueDay: 10,
	rateBp: 1_500,
	feeCents: 0,
	adminFeeBp: null,
	accountId: null,
	category: null,
	archived: false,
	sortOrder: 0,
	updatedAt: '',
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
	const key = `${stack.length}:${top.screen}:${top.params?.id ?? top.params?.exemplo ?? ''}`;
	if (top.screen === 'wealth') return <WealthScreen key={key} />;
	// O `exemplo=1` da rota, como `app/debts/new.tsx` repassa (SPD-147).
	if (top.screen === 'debtNew') return <DebtEditScreen key={key} sampleForm={top.params?.exemplo} />;
	if (top.screen === 'debt') return <DebtDetailScreen key={key} debtId={top.params?.id ?? ''} />;
	if (top.screen === 'debtEdit') return <DebtEditScreen key={key} debtId={top.params?.id} />;
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

const press = async (match: (props: Record<string, unknown>) => boolean, what: string) => {
	const node = renderer?.root.findAll(
		(candidate: ReactTestInstance) => match(candidate.props) && typeof candidate.props.onPress === 'function'
	)[0];
	if (!node) throw new Error(`nada tocável: ${what}`);
	await act(async () => {
		node.props.onPress();
	});
};

const pressLabel = (label: string) => press((props) => props.accessibilityLabel === label, label);

/** O "?" de uma trilha: no Patrimônio há um por card, e o rótulo é o mesmo; a dica diz qual. */
const pressHelp = (trail: string) => {
	const hint = `trails.helpHint${JSON.stringify({ trail: `trails.${trail}.title` })}`;
	return press((props) => props.accessibilityHint === hint, hint);
};

/** O guia aponta um alvo (o contorno em volta dele), em vez de só mostrar o texto. */
const pointing = () => (renderer?.root.findAll((node) => node.props.testID === 'trail-outline').length ?? 0) > 0;

const shownSteps: [number, boolean][] = [];
const showStep = async (id: number) => {
	await waitForText(title(id));
	shownSteps.push([id, pointing()]);
};

const title = (id: number) => `trails.debts.steps.${id}.title`;
const body = (id: number) => `trails.debts.steps.${id}.body`;
const counter = (current: number, total = 12) => `tutorial.counter{"current":${current},"total":${total}}`;
const top = () => currentStack[currentStack.length - 1];
/** O cadastro aberto pela trilha com o exemplo, e a dívida de exemplo (SPD-147). */
const sampleForm: TrailLocation = { screen: 'debtNew', params: { exemplo: '1' } };
const sampleDebtAt: TrailLocation = { screen: 'debt', params: { id: 'exemplo-divida' } };
const saveButton = () =>
	renderer?.root.findAll((node) => node.props.accessibilityLabel === 'debts.edit.save' && node.props.accessibilityState !== undefined)[0];

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
	mockData.debts = [car];
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

describe('Trilha 9 — Dívidas, cruzando telas', () => {
	it('a dívida que a trilha abre é a primeira ainda sendo paga; as quitadas vêm depois', () => {
		const archived = { ...car, id: 'arquivada', archived: true };
		// Todas as parcelas já venceram: quitada no prazo, mesmo sem arquivar.
		const settled = { ...car, id: 'no-prazo', openingBalanceDate: '2020-01-07', remainingAtOpening: 2, installmentsTotal: 2 };
		expect(debtRecords([archived, settled, car], '2026-11-07')).toEqual([{ id: 'carro' }, { id: 'arquivada' }, { id: 'no-prazo' }]);
		expect(debtRecords([], '2026-11-07')).toEqual([]);
	});

	it('anda por Patrimônio › Nova dívida › a dívida › Editar e volta ao Patrimônio, sem salvar nada', async () => {
		await mount([{ screen: 'wealth' }]);
		await pressHelp('debts');

		await showStep(1);
		expect(texts()).toContain(counter(1));
		expect(top()).toEqual({ screen: 'wealth' });

		// Passo 2: o guia abriu a Nova dívida, de verdade — preenchida com o exemplo (SPD-147), que
		// o formulário vazio não mostrava a prévia. O "Salvar" fica desligado.
		await pressLabel('tutorial.next');
		await showStep(2);
		expect(top()).toEqual(sampleForm);
		expect(texts()).toContain('debts.edit.newTitle');
		expect(texts()).toContain('trails.sample.banner');
		expect(texts()).toContain('trails.sample.tag');
		expect(saveButton()?.props.accessibilityState).toEqual({ disabled: true });

		for (const id of [3, 4, 5, 6, 7, 8]) {
			await pressLabel('tutorial.next');
			await showStep(id);
			expect(top()).toEqual(sampleForm);
			expect(texts()).toContain('trails.sample.tag');
			// Passo 7 ("Atenção", consórcio): o formulário segue em financiamento; o guia aponta o tipo.
			if (id === 7) expect(texts()).toContain('trails.attention');
		}

		// Passo 9: o formulário fecha sem salvar e abre a dívida da lista.
		await pressLabel('tutorial.next');
		await showStep(9);
		expect(top()).toEqual({ screen: 'debt', params: { id: 'carro' } });
		expect(texts()).toContain('Carro Teste');
		expect(texts()).toContain(body(9));
		// A dívida é a do usuário: sem exemplo.
		expect(texts()).not.toContain('trails.sample.tag');
		expect(texts()).not.toContain('trails.sample.banner');

		await pressLabel('tutorial.next');
		await showStep(10);
		await pressLabel('tutorial.next');
		await showStep(11);
		expect(top()).toEqual({ screen: 'debt', params: { id: 'carro' } });

		// Passo 12: Editar dívida, com Quitada e Excluir — sem tocar em nenhum dos dois.
		await pressLabel('tutorial.next');
		await showStep(12);
		expect(top()).toEqual({ screen: 'debtEdit', params: { id: 'carro' } });
		expect(texts()).toContain(counter(12));

		// A prévia só aparece com o formulário preenchido: com o exemplo, o passo 6 aponta para ela.
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
			[11, true],
			[12, true],
		]);

		await pressLabel('tutorial.done');
		await waitUntil(() => !texts().includes(title(12)));
		await waitUntil(() => top()?.screen === 'wealth');
		expect(currentStack).toEqual([{ screen: 'wealth' }]);

		expectNothingSaved();
		expect(mockActions).toEqual([
			{ type: 'push', location: sampleForm },
			{ type: 'pop', count: 1 },
			{ type: 'push', location: { screen: 'debt', params: { id: 'carro' } } },
			{ type: 'push', location: { screen: 'debtEdit', params: { id: 'carro' } } },
			{ type: 'pop', count: 2 },
		]);
	});

	it('sem dívida: os passos 9 a 12 andam na dívida de exemplo e apontam; ao sair, o exemplo some (SPD-147)', async () => {
		mockData.debts = [];
		await mount([{ screen: 'wealth' }]);
		await pressHelp('debts');
		await showStep(1);
		for (const id of [2, 3, 4, 5, 6, 7, 8, 9]) {
			await pressLabel('tutorial.next');
			await showStep(id);
		}
		// O passo 9 na tela da dívida de exemplo, com o texto do passo (não o do [sem dado]).
		expect(top()).toEqual(sampleDebtAt);
		expect(texts()).toContain(body(9));
		expect(texts()).not.toContain('trails.debts.steps.9.missing');
		expect(texts()).toContain('trails.sample.debt');
		expect(texts()).toContain('trails.sample.banner');
		expect(texts()).toContain('trails.sample.tag');
		for (const id of [10, 11]) {
			await pressLabel('tutorial.next');
			await showStep(id);
			expect(top()).toEqual(sampleDebtAt);
		}
		await pressLabel('tutorial.next');
		await showStep(12);
		expect(top()).toEqual({ screen: 'debtEdit', params: { id: 'exemplo-divida' } });
		expect(texts()).toContain('trails.sample.banner');
		expect(saveButton()?.props.accessibilityState).toEqual({ disabled: true });
		expect(shownSteps.slice(5)).toEqual([
			[6, true],
			[7, true],
			[8, true],
			[9, true],
			[10, true],
			[11, true],
			[12, true],
		]);

		// Os botões que gravam não fazem nada com o exemplo, mesmo tocados.
		await pressLabel('debts.edit.archive');
		await pressLabel('debts.edit.delete');

		await pressLabel('tutorial.done');
		await waitUntil(() => top()?.screen === 'wealth');
		expect(currentStack).toEqual([{ screen: 'wealth' }]);
		expectNothingSaved();

		// Fora da trilha, a dívida de exemplo não existe mais: a mesma tela diz que não achou.
		await wait(800);
		await act(async () => {
			setStack?.((stack) => [...stack, sampleDebtAt]);
		});
		await waitForText('debts.detail.missing');
		expect(texts()).not.toContain('trails.sample.debt');
		expect(texts()).not.toContain('trails.sample.banner');
	});

	it('o "?" da tela de uma dívida abre no passo 9, ali mesmo, e termina nela', async () => {
		await mount([{ screen: 'wealth' }, { screen: 'debt', params: { id: 'carro' } }]);
		await pressHelp('debts');

		await showStep(9);
		expect(texts()).toContain(counter(9));
		expect(top()).toEqual({ screen: 'debt', params: { id: 'carro' } });
		expect(mockActions).toEqual([]);

		await pressLabel('tutorial.next');
		await showStep(10);
		await pressLabel('tutorial.next');
		await showStep(11);
		await pressLabel('tutorial.next');
		await showStep(12);
		expect(top()).toEqual({ screen: 'debtEdit', params: { id: 'carro' } });

		await pressLabel('tutorial.done');
		await waitUntil(() => top()?.screen === 'debt');
		expect(currentStack).toEqual([{ screen: 'wealth' }, { screen: 'debt', params: { id: 'carro' } }]);
		expectNothingSaved();
	});

	it('o "?" da Nova dívida abre no passo 2, no próprio formulário', async () => {
		await mount([{ screen: 'wealth' }, { screen: 'debtNew' }]);
		await pressHelp('debts');

		await showStep(2);
		expect(texts()).toContain(counter(2));
		expect(top()).toEqual({ screen: 'debtNew' });
		expect(mockActions).toEqual([]);

		await pressLabel('tutorial.skip');
		await waitUntil(() => !texts().includes(title(2)));
		expect(currentStack).toEqual([{ screen: 'wealth' }, { screen: 'debtNew' }]);
		expectNothingSaved();
	});
});
