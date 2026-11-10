/**
 * O guia na tela (SPD-129): a tela escurece, o botão de verdade fica destacado e um balão
 * diz o que ele faz, passo a passo. Aqui só a parte que não depende de tela: os passos de
 * cada guia, quais aparecem, quando um guia abre sozinho, quando fica visto, o aviso único
 * para quem atualizou e onde o balão cabe. O desenho e a medição moram em
 * `components/tour/`.
 *
 * Instalação nova × atualização: o estado do guia nasce na primeira vez que o app abre com
 * esta versão. Se o onboarding ainda não foi concluído, é instalação nova (ou o app foi
 * apagado): cada guia abre sozinho na primeira visita da sua tela, depois das boas-vindas.
 * Se o onboarding já tinha sido concluído, é quem já usava o app e atualizou: nenhum guia
 * abre sozinho — a tela inicial mostra uma vez "Novo: Como usar o Spendr", e só o "Ver" liga
 * a abertura automática. Os guias também abrem pelo "?" e por Ajustes › Como usar.
 */

/** As telas que têm guia. */
export type TourScreen =
	| 'home'
	| 'add'
	| 'card'
	| 'cardEdit'
	| 'inbox'
	| 'wealth'
	| 'reports'
	| 'settings';

/**
 * Um passo: o texto (`tutorial.steps.<tela>.<id>`) e o elemento que ele aponta. Com mais de
 * um alvo, vale o primeiro que estiver na tela (a conta, ou o backup quando não há conta).
 */
export interface TourStepDef {
	id: string;
	targets: readonly string[];
	/**
	 * O alvo fica fora da rolagem (o cabeçalho, a barra de abas): o guia não tenta rolar até
	 * ele, só o mostra onde está.
	 */
	fixed?: boolean;
}

const step = (screen: TourScreen, id: string, ...targets: string[]): TourStepDef => ({
	id,
	targets: targets.length > 0 ? targets : [`${screen}.${id}`],
});

const fixedStep = (screen: TourScreen, id: string): TourStepDef => ({
	...step(screen, id),
	fixed: true,
});

/** Os passos de cada guia, na ordem em que aparecem. */
export const TOUR_GUIDES: Readonly<Record<TourScreen, readonly TourStepDef[]>> = {
	home: [
		fixedStep('home', 'add'),
		step('home', 'review'),
		step('home', 'bills'),
		step('home', 'month'),
		fixedStep('home', 'settings'),
		fixedStep('home', 'tabs'),
	],
	add: [
		step('add', 'type'),
		step('add', 'transfer'),
		step('add', 'amount'),
		step('add', 'account'),
		step('add', 'installments'),
	],
	card: [
		step('card', 'face'),
		step('card', 'pay'),
		step('card', 'adjust'),
		step('card', 'installments'),
		step('card', 'charge'),
		step('card', 'invoices'),
		step('card', 'duplicates'),
	],
	cardEdit: [step('cardEdit', 'last4'), step('cardEdit', 'days')],
	// O cartão da revisão serve a dois passos: o que ele é e o que fazer com ele.
	inbox: [step('inbox', 'card'), step('inbox', 'actions', 'inbox.card'), step('inbox', 'learned')],
	wealth: [
		step('wealth', 'networth'),
		step('wealth', 'priorities'),
		step('wealth', 'reserve'),
		step('wealth', 'debts'),
	],
	reports: [step('reports', 'freedom'), step('reports', 'health')],
	settings: [
		step('settings', 'accounts'),
		step('settings', 'cards'),
		step('settings', 'bills'),
		step('settings', 'capture'),
		step('settings', 'ownName'),
		step('settings', 'ofx'),
		step('settings', 'backup', 'settings.account', 'settings.backup'),
	],
};

export const TOUR_SCREENS = Object.keys(TOUR_GUIDES) as TourScreen[];

const isTourScreen = (value: unknown): value is TourScreen =>
	typeof value === 'string' && (TOUR_SCREENS as string[]).includes(value);

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Um alvo que não está na tela (`null`) ou que não ocupa espaço (o componente não desenhou nada). */
export const hasSize = (rect: Rect | null | undefined): rect is Rect =>
	Boolean(rect && rect.width > 0 && rect.height > 0);

const stepsOf = (screen: TourScreen, only?: readonly string[]): readonly TourStepDef[] =>
	only ? TOUR_GUIDES[screen].filter((def) => only.includes(def.id)) : TOUR_GUIDES[screen];

/** Os alvos a medir antes de abrir o guia, cada um uma vez. */
export const targetsOf = (screen: TourScreen, only?: readonly string[]): string[] => [
	...new Set(stepsOf(screen, only).flatMap((def) => def.targets)),
];

export interface PlannedStep {
	id: string;
	/** O alvo que o passo aponta: o primeiro dos dele que está na tela. */
	target: string;
	titleKey: string;
	bodyKey: string;
	/** Fora da rolagem: não adianta rolar até ele. */
	fixed?: boolean;
}

/**
 * Os passos que aparecem, dada a medida de cada alvo. Passo sem alvo na tela sai (não há
 * cartão, a revisão está vazia, a captura não existe neste aparelho), sem quebrar o guia;
 * `only` restringe aos passos de um tópico do "Como usar".
 */
export const planSteps = (
	screen: TourScreen,
	rects: Readonly<Record<string, Rect | null | undefined>>,
	only?: readonly string[]
): PlannedStep[] =>
	stepsOf(screen, only).flatMap((def) => {
		const target = def.targets.find((id) => hasSize(rects[id]));
		if (!target) return [];
		const key = `tutorial.steps.${screen}.${def.id}`;
		const planned: PlannedStep = {
			id: def.id,
			target,
			titleKey: `${key}.title`,
			bodyKey: `${key}.body`,
		};
		return [def.fixed ? { ...planned, fixed: true } : planned];
	});

// ---------------------------------------------------------------------------
// O que fica guardado no aparelho
// ---------------------------------------------------------------------------

export interface TourState {
	/** Como o app chegou nesta versão: instalado agora, ou atualizado por quem já usava. */
	install: 'fresh' | 'upgrade';
	/** Cada guia abre sozinho na primeira visita da tela. */
	auto: boolean;
	/** O aviso "Novo: Como usar o Spendr": a mostrar, respondido, ou nunca (instalação nova). */
	notice: 'pending' | 'done' | 'none';
	/** Os guias já vistos (terminados com "Entendi" ou "Pular"). */
	seen: TourScreen[];
}

/**
 * O estado da primeira vez. Onboarding concluído antes de existir o guia quer dizer que o
 * usuário já usava o app: ele não recebe todos os guias de uma vez.
 */
export const initialTourState = (onboardingCompleted: boolean): TourState =>
	onboardingCompleted
		? { install: 'upgrade', auto: false, notice: 'pending', seen: [] }
		: { install: 'fresh', auto: true, notice: 'none', seen: [] };

export const serializeTourState = (state: TourState): string => JSON.stringify(state);

/** O estado gravado, ou `null` se não houver ou não for deste formato (aí nasce de novo). */
export const parseTourState = (raw: string | null): TourState | null => {
	if (!raw) return null;
	try {
		const value = JSON.parse(raw) as Partial<TourState>;
		if (value.install !== 'fresh' && value.install !== 'upgrade') return null;
		if (typeof value.auto !== 'boolean') return null;
		if (value.notice !== 'pending' && value.notice !== 'done' && value.notice !== 'none')
			return null;
		if (!Array.isArray(value.seen)) return null;
		return {
			install: value.install,
			auto: value.auto,
			notice: value.notice,
			seen: value.seen.filter(isTourScreen),
		};
	} catch {
		return null;
	}
};

/**
 * O guia abre sozinho? Só com a abertura automática ligada, depois das boas-vindas (a tela
 * inicial monta por baixo do onboarding) e se ainda não foi visto. Carregando, com folha
 * aberta ou com outro guia na tela, quem chama nem pergunta.
 */
export const shouldAutoOpen = ({
	state,
	screen,
	onboardingDone,
}: {
	state: TourState;
	screen: TourScreen;
	onboardingDone: boolean;
}): boolean => state.auto && onboardingDone && !state.seen.includes(screen);

export const markTourSeen = (state: TourState, screen: TourScreen): TourState =>
	state.seen.includes(screen) ? state : { ...state, seen: [...state.seen, screen] };

/**
 * O guia terminou, por "Entendi", "Pular" ou pelo voltar do Android: fica visto. Se nenhum
 * passo chegou a aparecer (nada na tela para apontar), não: ele abre quando houver o que
 * mostrar.
 */
export const finishTour = (state: TourState, screen: TourScreen, shownSteps: number): TourState =>
	shownSteps > 0 ? markTourSeen(state, screen) : state;

/** O aviso único na tela inicial: só para quem atualizou, depois das boas-vindas, até responder. */
export const shouldShowNotice = (state: TourState, onboardingDone: boolean): boolean =>
	onboardingDone && state.notice === 'pending';

/** "Ver" liga os guias automáticos (e abre o da tela inicial); "Agora não" só some com o aviso. */
export const answerNotice = (state: TourState, answer: 'see' | 'later'): TourState => ({
	...state,
	notice: 'done',
	auto: answer === 'see' ? true : state.auto,
});

// ---------------------------------------------------------------------------
// Pedidos de guia
// ---------------------------------------------------------------------------

/** De onde veio o guia: sozinho, do "?", do "Como usar" ou do "Ver" do aviso. */
export type TourOrigin = 'auto' | 'help' | 'howto' | 'notice';

export interface TourRequest {
	screen: TourScreen;
	only?: readonly string[];
	origin: TourOrigin;
	/** Quando foi pedido (ms). */
	at: number;
}

/**
 * Quanto um pedido espera a tela dele ficar pronta. O "Mostrar na tela" navega e só depois a
 * tela aparece; um pedido esquecido (a tela não abriu) não pode abrir o guia de surpresa
 * numa visita qualquer depois.
 */
export const REQUEST_TTL_MS = 15_000;

export const requestFor = (
	request: TourRequest | null,
	screen: TourScreen,
	now: number
): TourRequest | null =>
	request && request.screen === screen && now - request.at <= REQUEST_TTL_MS ? request : null;

// ---------------------------------------------------------------------------
// Ajustes › Como usar
// ---------------------------------------------------------------------------

export type TopicId =
	| 'accounts'
	| 'add'
	| 'capture'
	| 'cards'
	| 'invoice'
	| 'bills'
	| 'debts'
	| 'reserve'
	| 'budget'
	| 'reports'
	| 'ofx'
	| 'backup';

export interface TopicDef {
	id: TopicId;
	/** O guia que o "Mostrar na tela" abre, e quais passos dele. Sem `link`, o tópico é só leitura. */
	link?: { screen: TourScreen; only?: readonly string[] };
	/** Só faz sentido onde há captura (Android com o serviço). */
	needsCapture?: boolean;
	/** Precisa de um cartão de crédito cadastrado para abrir a tela dele. */
	needsCard?: boolean;
}

/** Os tópicos, na ordem do texto aprovado (`tutorial.topics.<id>`). */
export const TOPICS: readonly TopicDef[] = [
	{ id: 'accounts', link: { screen: 'settings', only: ['accounts'] } },
	{ id: 'add', link: { screen: 'add' } },
	{ id: 'capture', link: { screen: 'settings', only: ['capture', 'ownName'] }, needsCapture: true },
	{ id: 'cards', link: { screen: 'cardEdit' } },
	{ id: 'invoice', link: { screen: 'card' }, needsCard: true },
	{ id: 'bills', link: { screen: 'home', only: ['bills'] } },
	{ id: 'debts', link: { screen: 'wealth', only: ['debts'] } },
	{ id: 'reserve', link: { screen: 'wealth', only: ['priorities', 'reserve'] } },
	{ id: 'budget', link: { screen: 'home', only: ['month'] } },
	{ id: 'reports', link: { screen: 'reports' } },
	{ id: 'ofx', link: { screen: 'settings', only: ['ofx'] } },
	{ id: 'backup', link: { screen: 'settings', only: ['backup'] } },
];

export const isTopicId = (value: unknown): value is TopicId =>
	TOPICS.some((topic) => topic.id === value);

/** O tópico que o "?" de cada tela abre quando não há o que apontar nela. */
export const HELP_TOPIC: Readonly<Partial<Record<TourScreen, TopicId>>> = {
	card: 'invoice',
	cardEdit: 'cards',
	inbox: 'capture',
};

/**
 * Nada para apontar na tela. Pelo "?", o usuário pediu ajuda: abre o tópico. Sozinho ou pelo
 * "Como usar" (que é de onde ele veio), não abre nada.
 */
export const emptyTourFallback = (origin: TourOrigin, screen: TourScreen): TopicId | null =>
	origin === 'help' ? (HELP_TOPIC[screen] ?? null) : null;

// ---------------------------------------------------------------------------
// Onde o destaque e o balão ficam
// ---------------------------------------------------------------------------

/** Folga entre o elemento e o contorno do destaque. */
const HOLE_PADDING = 6;
/** Distância entre o destaque e o balão. */
const BUBBLE_GAP = 12;
/** Margem do balão até as bordas da tela. */
const SIDE_MARGIN = 16;
const EDGE_MARGIN = 8;
const BUBBLE_MAX_WIDTH = 400;

const clamp = (value: number, min: number, max: number): number =>
	Math.min(Math.max(value, min), Math.max(min, max));

export interface TourLayout {
	/** O buraco no escurecido: o alvo com folga, sem passar da tela. */
	hole: Rect;
	bubble: { placement: 'above' | 'below'; top: number; left: number; width: number };
}

/**
 * O buraco e o balão para um alvo medido na janela. O balão vai embaixo do alvo se couber,
 * senão em cima, senão do lado com mais espaço — e nunca sai da tela: fica abaixo da barra
 * de status e acima da barra de gestos (`insets`), com largura de no máximo 400 e 16 de
 * margem dos lados, centrado no alvo quando dá.
 */
export const layoutTour = ({
	target,
	window,
	insets,
	bubbleHeight,
}: {
	target: Rect;
	window: { width: number; height: number };
	insets: { top: number; bottom: number };
	bubbleHeight: number;
}): TourLayout => {
	const left = Math.max(0, target.x - HOLE_PADDING);
	const top = Math.max(0, target.y - HOLE_PADDING);
	const right = Math.min(window.width, target.x + target.width + HOLE_PADDING);
	const bottom = Math.min(window.height, target.y + target.height + HOLE_PADDING);
	const hole = {
		x: left,
		y: top,
		width: Math.max(0, right - left),
		height: Math.max(0, bottom - top),
	};

	const width = Math.min(window.width - SIDE_MARGIN * 2, BUBBLE_MAX_WIDTH);
	const centerX = hole.x + hole.width / 2;
	const bubbleLeft = clamp(centerX - width / 2, SIDE_MARGIN, window.width - SIDE_MARGIN - width);

	const minTop = insets.top + EDGE_MARGIN;
	const maxTop = window.height - insets.bottom - EDGE_MARGIN - bubbleHeight;
	const belowTop = hole.y + hole.height + BUBBLE_GAP;
	const aboveTop = hole.y - BUBBLE_GAP - bubbleHeight;
	const spaceBelow = window.height - insets.bottom - EDGE_MARGIN - belowTop;
	const spaceAbove = hole.y - BUBBLE_GAP - minTop;

	let placement: 'above' | 'below';
	let bubbleTop: number;
	if (spaceBelow >= bubbleHeight) {
		placement = 'below';
		bubbleTop = belowTop;
	} else if (spaceAbove >= bubbleHeight) {
		placement = 'above';
		bubbleTop = aboveTop;
	} else {
		placement = spaceBelow >= spaceAbove ? 'below' : 'above';
		bubbleTop = clamp(placement === 'below' ? belowTop : aboveTop, minTop, maxTop);
	}

	return { hole, bubble: { placement, top: bubbleTop, left: bubbleLeft, width } };
};

/**
 * Passa um retângulo medido na janela (`measureInWindow`) para as coordenadas da camada do
 * guia, cuja origem também foi medida na janela. As duas medidas têm a mesma referência, seja
 * ela o topo da tela ou o pé da barra de status, com ou sem barras translúcidas, no Android ou
 * no iOS: a diferença é onde o alvo fica dentro da camada, que é onde o destaque é desenhado.
 */
export const toOverlayRect = (rect: Rect, origin: { x: number; y: number }): Rect => ({
	x: rect.x - origin.x,
	y: rect.y - origin.y,
	width: rect.width,
	height: rect.height,
});

/** A faixa visível da tela, em y. */
export interface Viewport {
	top: number;
	bottom: number;
}

/** Ao menos um pedaço do alvo está na faixa visível. */
export const isOnScreen = (rect: Rect, viewport: Viewport): boolean =>
	rect.y < viewport.bottom && rect.y + rect.height > viewport.top;

/**
 * O alvo está cortado ou fora da faixa visível e rolar resolveria. Um alvo mais alto que a
 * tela e que já começa nela não fica melhor rolando.
 */
export const needsScroll = (rect: Rect, viewport: Viewport): boolean => {
	if (rect.height > viewport.bottom - viewport.top)
		return rect.y < viewport.top || rect.y >= viewport.bottom;
	return rect.y < viewport.top || rect.y + rect.height > viewport.bottom;
};
