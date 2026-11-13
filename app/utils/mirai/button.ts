import type { MiraiExpression } from './contract';

/**
 * O botão flutuante do Mirai (SPD-163, §7): onde fica, quando aparece e com que cara.
 *
 * Tudo aqui é puro, para os testes conferirem sem desenhar a tela.
 */

/** Diâmetro do botão. */
export const MIRAI_BUTTON_SIZE = 52;
/** Distância da borda direita. */
export const MIRAI_BUTTON_RIGHT = 16;
/** Altura da barra de abas, a mesma de `app/(tabs)/_layout.tsx` (`styles.tabBar.height`). */
export const TAB_BAR_HEIGHT = 70;
/** O "+" central da barra: 60 de largura, centrado na tela. */
export const ADD_BUTTON_WIDTH = 60;
/** O botão fica acima da barra de abas, com folga. */
export const MIRAI_BUTTON_BOTTOM = TAB_BAR_HEIGHT + 12;

/**
 * O respiro no fim das listas das telas onde o botão aparece: a lista termina acima do topo do
 * botão, e o último item não fica embaixo dele.
 */
export const MIRAI_LIST_END_SPACE = MIRAI_BUTTON_BOTTOM + MIRAI_BUTTON_SIZE + 16;

/** O trecho horizontal que o botão ocupa numa tela desta largura. */
export const buttonSpan = (screenWidth: number): { left: number; right: number } => ({
	left: screenWidth - MIRAI_BUTTON_RIGHT - MIRAI_BUTTON_SIZE,
	right: screenWidth - MIRAI_BUTTON_RIGHT,
});

/** O trecho horizontal do "+" central. */
export const addButtonSpan = (screenWidth: number): { left: number; right: number } => ({
	left: (screenWidth - ADD_BUTTON_WIDTH) / 2,
	right: (screenWidth + ADD_BUTTON_WIDTH) / 2,
});

/**
 * As telas principais onde o botão aparece, pelo caminho do expo-router (sem os grupos), e o
 * nome que vai como `screen` na pergunta. Fora daqui o botão some: formulários de lançar e
 * editar (cobriria o Salvar), o detalhe do lançamento (Editar e Apagar no rodapé), a tela da
 * conta (login), os Ajustes, o "Como usar" e a primeira abertura.
 */
const SCREENS: ReadonlyArray<readonly [RegExp, string]> = [
	[/^\/$/, 'home'],
	[/^\/transactions$/, 'transactions'],
	[/^\/wealth$/, 'wealth'],
	[/^\/reports$/, 'reports'],
	[/^\/accounts$/, 'accounts'],
	[/^\/accounts\/unassigned$/, 'unassigned'],
	[/^\/cards$/, 'cards'],
	[/^\/cards\/debit\/[^/]+\/[^/]+$/, 'debit_card'],
	[/^\/cards\/(?!new$|debit$|edit$)[^/]+$/, 'card'],
	[/^\/bills$/, 'bills'],
	[/^\/debts\/(?!new$|edit$)[^/]+$/, 'debt'],
	[/^\/inbox$/, 'inbox'],
];

/** O nome da tela para o Mirai, ou nulo se o botão não aparece nela. */
export const miraiScreenOf = (pathname: string): string | null => {
	const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
	for (const [pattern, name] of SCREENS) if (pattern.test(path)) return name;
	return null;
};

export interface MiraiButtonState {
	/** `GET /status` disse `enabled` (ou o último que disse, sem rede). */
	enabled: boolean;
	/** A pessoa desligou o Mirai em Configurações. */
	turnedOff: boolean;
	pathname: string;
	keyboardOpen: boolean;
	/** Um guia ou uma trilha do tutorial está aberto. */
	guideOpen: boolean;
	/** A conversa ou a ativação já está aberta por cima. */
	sheetOpen: boolean;
	/** A trava por biometria está na frente. */
	locked: boolean;
}

export const shouldShowMiraiButton = (state: MiraiButtonState): boolean =>
	state.enabled &&
	!state.turnedOff &&
	!state.keyboardOpen &&
	!state.guideOpen &&
	!state.sheetOpen &&
	!state.locked &&
	miraiScreenOf(state.pathname) !== null;

/**
 * A cara do botão. Só três: `thinking` durante a consulta, `goal` no dia em que uma meta ou a
 * reserva completou, `normal` no resto. Preocupado e triste ficam na conversa: ver essa cara
 * todo dia ao abrir o app vira ansiedade (§7.1). `sorry` também: é sobre a resposta.
 */
export const buttonExpression = (state: {
	busy: boolean;
	goalDay: string | null;
	today: string;
}): MiraiExpression => {
	if (state.busy) return 'thinking';
	if (state.goalDay !== null && state.goalDay === state.today) return 'goal';
	return 'normal';
};

/**
 * Todo arquivo sob app/ é tratado como rota pelo expo-router, e uma rota sem export
 * default é um módulo quebrado do ponto de vista dele. Este export existe só para
 * satisfazer essa exigência — nada navega para cá.
 */
export default {
	miraiScreenOf,
	shouldShowMiraiButton,
	buttonExpression,
	buttonSpan,
	addButtonSpan,
};
