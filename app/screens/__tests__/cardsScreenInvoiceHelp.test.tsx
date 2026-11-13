/**
 * O "?" do guia da fatura na lista de cartões (SPD-158).
 *
 * Antes, a Trilha 3 (`cardInvoice`) só abria pelo "?" de dentro de um cartão: sem cartão de
 * crédito, não havia onde começar, e o exemplo do SPD-147 nunca aparecia. Agora a seção
 * "Crédito" da lista (Ajustes › Cartões) tem o "?" dela:
 * - com cartão de crédito, o guia abre no primeiro da lista, sem exemplo;
 * - sem nenhum (só débito, ou só encerrados), abre no cartão de exemplo, e a seção diz isso.
 *
 * O guia é dublê: o teste lê o que o "?" pediu e monta o plano como o `TourProvider` monta,
 * com os registros que o `TrailRecordsSource` daria (os cartões de crédito ativos, em ordem).
 * O caminho inteiro, com o banco de verdade, está em `components/tour/__tests__/trailSampleSql`.
 * As chaves de tradução aparecem cruas, com os valores entre chaves.
 */

import type { Account } from '../../database/schema';

const mockState: { accounts: Account[]; debit: { key: string; last4: string; account: Account }[] } = {
	accounts: [],
	debit: [],
};

jest.mock('expo-router', () => ({
	useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
	Stack: { Screen: () => null },
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('react-native-safe-area-context', () => {
	const { View } = require('react-native');
	return { SafeAreaView: View };
});

jest.mock('react-i18next', () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) => (options ? `${key}${JSON.stringify(options)}` : key),
	}),
}));

jest.mock('../../components/cards/CardFace', () => {
	const { Text } = require('react-native');
	return ({ card }: { card: { name: string } }) => <Text>{`cartão:${card.name}`}</Text>;
});
jest.mock('../../components/cards/DebitCardFace', () => {
	const { Text } = require('react-native');
	return ({ card }: { card: { last4: string } }) => <Text>{`débito:${card.last4}`}</Text>;
});

jest.mock('../../contexts/AccountsContext', () => ({
	useAccounts: () => {
		const active = mockState.accounts.filter((account) => !account.archived);
		return {
			accounts: mockState.accounts,
			creditCards: active.filter((account) => account.kind === 'credit_card'),
			debitCards: mockState.debit,
			cardSummaries: new Map(),
			cardsTotals: { toPayCents: 0, openInvoicesCents: 0, limitAvailableCents: null },
		};
	},
}));

jest.mock('../../contexts/PeriodContext', () => ({
	usePeriod: () => ({ selectedMonth: 11, selectedYear: 2026 }),
}));

import { Text } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { TourContext, type TourContextValue } from '../../components/tour/TourContext';
import { TRAIL_SAMPLE_RECORDS } from '../../utils/trailSample';
import { planTrail, TRAILS, type TrailId, type TrailLocation, type TrailRecords } from '../../utils/trails';
import CardsScreen from '../CardsScreen';

const account = (overrides: Partial<Account>): Account => ({
	id: 'x',
	name: 'Conta',
	kind: 'checking',
	role: 'main',
	envelopeMonthlyCents: null,
	bankName: null,
	color: '#FF7A00',
	last4: null,
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
	openingBalanceDate: '2026-09-30',
	sortOrder: 0,
	archived: false,
	updatedAt: '',
	...overrides,
});

const card = (id: string, name: string, overrides: Partial<Account> = {}) =>
	account({ id, name, kind: 'credit_card', role: 'card', closingDay: 3, dueDay: 10, ...overrides });

const CORRENTE = account({ id: 'corrente', name: 'Corrente Teste', cardNames: 'Débito Teste' });

let renderer: ReactTestRenderer | null = null;
const started: { trail: TrailId; here: TrailLocation; from?: string }[] = [];

const tour: TourContextValue = {
	report: () => undefined,
	startTour: () => undefined,
	openTopic: () => undefined,
	noticeVisible: false,
	answerNotice: () => undefined,
	startTrail: (trail, { here, from }) => {
		started.push({ trail, here, from });
	},
	setTrailRecords: () => () => undefined,
};

const render = async () => {
	await act(async () => {
		renderer = create(
			<TourContext.Provider value={tour}>
				<CardsScreen />
			</TourContext.Provider>
		);
	});
};

const texts = (): string[] =>
	(renderer?.root.findAll((node) => (node.type as unknown) === Text || (node.type as unknown) === 'Text') ?? []).map(
		(node) => [node.props.children].flat().join('')
	);

const helpFor = (trail: TrailId): ReactTestInstance[] =>
	renderer?.root.findAll(
		(node) =>
			typeof node.props.onPress === 'function' &&
			node.props.accessibilityHint === `trails.helpHint${JSON.stringify({ trail: `trails.${trail}.title` })}`
	) ?? [];

/** Toca o "?" e monta o plano como o `TourProvider`, com os cartões que o `TrailRecordsSource` daria. */
const pressInvoiceHelp = async () => {
	const [button] = helpFor('cardInvoice');
	if (!button) throw new Error('sem "?" do guia da fatura');
	started.length = 0;
	await act(async () => {
		button.props.onPress();
	});
	expect(started).toHaveLength(1);
	const [{ trail, here, from }] = started;
	const credit = mockState.accounts.filter((item) => item.kind === 'credit_card' && !item.archived);
	const records: TrailRecords = { card: credit.map((item) => ({ id: item.id })) };
	return { trail, here, from, plan: planTrail(TRAILS[trail], records, here, TRAIL_SAMPLE_RECORDS) };
};

afterEach(async () => {
	await act(async () => {
		renderer?.unmount();
	});
	renderer = null;
	mockState.accounts = [];
	mockState.debit = [];
});

describe('SPD-158 — o "?" do guia da fatura na lista de cartões', () => {
	it('sem cartão nenhum: o "?" da seção Crédito abre o guia da fatura no cartão de exemplo', async () => {
		await render();
		expect(helpFor('cardInvoice')).toHaveLength(1);
		expect(texts()).toContain('cards.credit.sectionTitle');
		expect(texts()).toContain('cards.credit.sampleHint');

		const { trail, here, from, plan } = await pressInvoiceHelp();
		expect(trail).toBe('cardInvoice');
		// Começa no passo 1 e, no fim, volta para a lista de cartões.
		expect(here).toEqual({ screen: 'cards' });
		expect(from).toBeUndefined();
		expect(plan).toHaveLength(12);
		expect(plan[0]).toMatchObject({
			id: '1',
			location: { screen: 'card', params: { id: 'exemplo-cartao' } },
			sample: true,
		});
		expect(plan.every((step) => step.sample && step.location.params?.id === 'exemplo-cartao')).toBe(true);
	});

	it('só cartão de débito ou de crédito encerrado: ainda é o exemplo', async () => {
		mockState.accounts = [CORRENTE, card('velho', 'Cartão Encerrado Teste', { archived: true })];
		mockState.debit = [{ key: 'corrente:4321', last4: '4321', account: CORRENTE }];
		await render();
		expect(texts()).toContain('cards.credit.sampleHint');

		const { plan } = await pressInvoiceHelp();
		expect(plan[0]).toMatchObject({ location: { screen: 'card', params: { id: 'exemplo-cartao' } }, sample: true });
	});

	it('com cartão de crédito: o guia abre no primeiro da lista, sem exemplo', async () => {
		mockState.accounts = [CORRENTE, card('roxo', 'Cartão Roxo Teste'), card('laranja', 'Cartão Laranja Teste', { sortOrder: 1 })];
		await render();
		expect(helpFor('cardInvoice')).toHaveLength(1);
		expect(texts()).toContain('cards.credit.sectionTitle');
		expect(texts()).not.toContain('cards.credit.sampleHint');

		const { trail, here, plan } = await pressInvoiceHelp();
		expect(trail).toBe('cardInvoice');
		expect(here).toEqual({ screen: 'cards' });
		expect(plan).toHaveLength(12);
		expect(plan[0]).toMatchObject({ id: '1', location: { screen: 'card', params: { id: 'roxo' } }, sample: false });
		expect(plan.some((step) => step.sample)).toBe(false);
	});

	it('os outros "?" da tela continuam: o do cadastro no topo e o do débito na seção Débito', async () => {
		mockState.accounts = [CORRENTE, card('roxo', 'Cartão Roxo Teste')];
		mockState.debit = [{ key: 'corrente:4321', last4: '4321', account: CORRENTE }];
		await render();
		expect(helpFor('cardSetup')).toHaveLength(1);
		expect(helpFor('cardExtras')).toHaveLength(1);
		expect(helpFor('cardInvoice')).toHaveLength(1);
	});
});
