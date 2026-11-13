jest.mock('@react-native-async-storage/async-storage', () => ({
	getItem: jest.fn(async () => null),
	setItem: jest.fn(async () => undefined),
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	addButtonSpan,
	buttonExpression,
	buttonSpan,
	MIRAI_BUTTON_BOTTOM,
	MIRAI_BUTTON_SIZE,
	MIRAI_LIST_END_SPACE,
	type MiraiButtonState,
	miraiScreenOf,
	shouldShowMiraiButton,
	TAB_BAR_HEIGHT,
} from '../button';
import { EMPTY_GOAL_STATE, nextGoalState } from '../preferences';

/**
 * O botão flutuante do Mirai (SPD-163, §7): onde aparece, onde some, com que cara, e que não
 * cobre o "+" nem o último item das listas.
 */

const visible: MiraiButtonState = {
	enabled: true,
	turnedOff: false,
	pathname: '/',
	keyboardOpen: false,
	guideOpen: false,
	sheetOpen: false,
	locked: false,
};

describe('onde o botão aparece', () => {
	it.each([
		['/', 'home'],
		['/transactions', 'transactions'],
		['/wealth', 'wealth'],
		['/reports', 'reports'],
		['/accounts', 'accounts'],
		['/accounts/unassigned', 'unassigned'],
		['/cards', 'cards'],
		['/cards/c-1', 'card'],
		['/cards/debit/a-1/1234', 'debit_card'],
		['/bills', 'bills'],
		['/debts/d-1', 'debt'],
		['/inbox', 'inbox'],
	])('aparece em %s (tela "%s")', (pathname, screen) => {
		expect(miraiScreenOf(pathname)).toBe(screen);
		expect(shouldShowMiraiButton({ ...visible, pathname })).toBe(true);
	});

	it.each([
		'/add-transaction',
		'/transaction/t-1',
		'/transaction/edit/t-1',
		'/accounts/new',
		'/accounts/a-1',
		'/cards/new',
		'/cards/edit/c-1',
		'/bills/new',
		'/bills/edit/b-1',
		'/debts/new',
		'/debts/edit/d-1',
		'/account',
		'/settings',
		'/howto',
		'/onboarding',
		'/onboarding/security',
		'/screens/PrivacyPolicyScreen',
	])('some em %s (formulário, primeira abertura ou tela sem lista)', (pathname) => {
		expect(miraiScreenOf(pathname)).toBeNull();
		expect(shouldShowMiraiButton({ ...visible, pathname })).toBe(false);
	});

	it.each([
		['GET /status sem enabled', { enabled: false }],
		['desligado em Configurações', { turnedOff: true }],
		['teclado aberto', { keyboardOpen: true }],
		['trilha ou guia do tutorial aberto', { guideOpen: true }],
		['conversa ou ativação já aberta', { sheetOpen: true }],
		['trava por biometria na frente', { locked: true }],
	] as const)('some com %s', (_label, change) => {
		expect(shouldShowMiraiButton({ ...visible, ...change })).toBe(false);
	});
});

describe('a cara do botão', () => {
	const today = '2026-11-12';

	it('normal no dia a dia, thinking durante a consulta, goal no dia da meta', () => {
		expect(buttonExpression({ busy: false, goalDay: null, today })).toBe('normal');
		expect(buttonExpression({ busy: true, goalDay: null, today })).toBe('thinking');
		expect(buttonExpression({ busy: false, goalDay: today, today })).toBe('goal');
		// O goal vale só até o fim daquele dia.
		expect(buttonExpression({ busy: false, goalDay: '2026-11-11', today })).toBe('normal');
	});

	it('nunca worried, sad nem sorry', () => {
		const seen = new Set<string>();
		for (const busy of [false, true])
			for (const goalDay of [null, today, '2026-10-01'])
				seen.add(buttonExpression({ busy, goalDay, today }));
		expect([...seen].sort()).toEqual(['goal', 'normal', 'thinking']);
	});
});

describe('o dia da meta', () => {
	it('só a passagem de incompleta para completa marca o dia', () => {
		// A primeira leitura é o ponto de partida: reserva já cheia não comemora.
		const first = nextGoalState(EMPTY_GOAL_STATE, true, '2026-11-01');
		expect(first).toEqual({ reserveReady: true, goalDay: null });

		const building = nextGoalState(EMPTY_GOAL_STATE, false, '2026-11-01');
		const done = nextGoalState(building, true, '2026-11-12');
		expect(done).toEqual({ reserveReady: true, goalDay: '2026-11-12' });

		// Continua cheia: não remarca. Esvaziou: o dia antigo fica, e vale só para aquele dia.
		expect(nextGoalState(done, true, '2026-11-13')).toEqual(done);
		expect(nextGoalState(done, false, '2026-11-20')).toEqual({
			reserveReady: false,
			goalDay: '2026-11-12',
		});
	});
});

describe('o lugar do botão', () => {
	it.each([320, 360, 393, 412, 480])('numa tela de %i dp, não encosta no "+"', (width) => {
		const mirai = buttonSpan(width);
		const add = addButtonSpan(width);
		expect(mirai.left).toBeGreaterThan(add.right + 8);
		expect(mirai.right).toBeLessThanOrEqual(width);
	});

	it('fica acima da barra de abas', () => {
		expect(MIRAI_BUTTON_BOTTOM).toBeGreaterThan(TAB_BAR_HEIGHT);
	});

	it('a barra de abas tem a altura que o botão supõe', () => {
		const tabs = readFileSync(join(__dirname, '../../../(tabs)/_layout.tsx'), 'utf8');
		expect(tabs).toMatch(new RegExp(`tabBar: \\{[^}]*height: ${TAB_BAR_HEIGHT},`));
	});

	it('o respiro das listas passa do topo do botão', () => {
		expect(MIRAI_LIST_END_SPACE).toBeGreaterThan(MIRAI_BUTTON_BOTTOM + MIRAI_BUTTON_SIZE);
	});

	// As telas onde o botão aparece terminam a lista com o respiro: o último item não fica embaixo dele.
	it.each([
		'HomeScreen',
		'TransactionListScreen',
		'WealthScreen',
		'AccountsScreen',
		'UnassignedScreen',
		'CardsScreen',
		'CardDetailScreen',
		'DebitCardScreen',
		'BillsScreen',
		'DebtDetailScreen',
		'CaptureInboxScreen',
	])('%s termina a lista com o respiro do botão', (screen) => {
		const source = readFileSync(join(__dirname, `../../../screens/${screen}.tsx`), 'utf8');
		expect(source).toMatch(/contentContainerStyle=\{styles\.content\}/);
		expect(source).toMatch(/\n\tcontent: \{[^}]*paddingBottom: MIRAI_LIST_END_SPACE,/);
	});

	it('Relatórios: a lista termina acima do botão (o contêiner já desconta a barra de abas)', () => {
		const source = readFileSync(join(__dirname, '../../../screens/ReportsScreen.tsx'), 'utf8');
		const container = Number(/\n\tcontainer: \{[^}]*paddingBottom: (\d+),/.exec(source)?.[1]);
		const content = Number(/\n\tscrollContent: \{[^}]*paddingBottom: (\d+),/.exec(source)?.[1]);
		expect(container + content).toBeGreaterThanOrEqual(MIRAI_BUTTON_BOTTOM + MIRAI_BUTTON_SIZE);
	});
});
