import {
	answerNotice,
	emptyTourFallback,
	finishTour,
	initialTourState,
	isOnScreen,
	layoutTour,
	markTourSeen,
	needsScroll,
	parseTourState,
	planSteps,
	REQUEST_TTL_MS,
	requestFor,
	serializeTourState,
	shouldAutoOpen,
	shouldShowNotice,
	TOPICS,
	TOUR_GUIDES,
	type TourState,
	targetsOf,
	toOverlayRect,
} from '../tour';

/**
 * O guia na tela (SPD-129): quais passos aparecem, quando o guia abre sozinho, quando fica
 * visto, quem é instalação nova e quem atualizou, o aviso único e onde o balão fica.
 */

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

describe('passos de acordo com os alvos que existem na tela', () => {
	it('alvo que não está na tela, ou com tamanho zero, tira o passo; a ordem é a do guia', () => {
		const steps = planSteps('home', {
			'home.add': rect(150, 700, 60, 60),
			'home.review': null,
			'home.bills': rect(16, 200, 360, 0),
			'home.month': rect(16, 300, 360, 180),
			'home.settings': rect(320, 40, 48, 48),
			'home.tabs': rect(0, 740, 390, 70),
		});

		expect(steps.map((step) => step.id)).toEqual(['add', 'month', 'settings', 'tabs']);
		// O "+", a engrenagem e as abas ficam fora da rolagem: o guia não rola até eles.
		expect(steps.map((step) => Boolean(step.fixed))).toEqual([true, false, true, true]);
		expect(steps[1]).toEqual({
			id: 'month',
			target: 'home.month',
			titleKey: 'tutorial.steps.home.month.title',
			bodyKey: 'tutorial.steps.home.month.body',
		});
	});

	it('sem nenhum alvo, nenhum passo', () => {
		expect(planSteps('inbox', {})).toEqual([]);
	});

	it('um passo com dois alvos usa o primeiro que existe (conta, ou o backup quando não há conta)', () => {
		const withAccount = planSteps('settings', {
			'settings.account': rect(0, 100, 390, 56),
			'settings.backup': rect(0, 600, 390, 56),
		});
		const withoutAccount = planSteps('settings', {
			'settings.account': null,
			'settings.backup': rect(0, 600, 390, 56),
		});

		expect(withAccount.map((step) => step.target)).toEqual(['settings.account']);
		expect(withoutAccount.map((step) => step.target)).toEqual(['settings.backup']);
	});

	it('o mesmo alvo pode servir a dois passos (o cartão da revisão e os botões dele)', () => {
		const steps = planSteps('inbox', {
			'inbox.card': rect(16, 100, 360, 300),
			'inbox.learned': rect(16, 420, 360, 40),
		});

		expect(steps.map((step) => `${step.id}:${step.target}`)).toEqual([
			'card:inbox.card',
			'actions:inbox.card',
			'learned:inbox.learned',
		]);
	});

	it('só os passos pedidos, quando o guia vem de um tópico do "Como usar"', () => {
		const rects = {
			'wealth.networth': rect(16, 100, 360, 200),
			'wealth.priorities': rect(16, 320, 360, 200),
			'wealth.debts': rect(16, 900, 360, 200),
		};

		expect(planSteps('wealth', rects, ['debts']).map((step) => step.id)).toEqual(['debts']);
		expect(planSteps('wealth', rects, ['priorities', 'reserve']).map((step) => step.id)).toEqual([
			'priorities',
		]);
	});

	it('targetsOf lista cada alvo uma vez, para medir', () => {
		expect(targetsOf('inbox')).toEqual(['inbox.card', 'inbox.learned']);
		expect(targetsOf('settings', ['backup'])).toEqual(['settings.account', 'settings.backup']);
	});

	it('cada guia tem passos, e cada tópico com "Mostrar na tela" aponta passos que existem', () => {
		for (const steps of Object.values(TOUR_GUIDES)) expect(steps.length).toBeGreaterThan(0);
		for (const topic of TOPICS) {
			if (!topic.link) continue;
			const ids = TOUR_GUIDES[topic.link.screen].map((step) => step.id);
			for (const only of topic.link.only ?? []) expect(ids).toContain(only);
		}
	});
});

describe('instalação nova × atualização', () => {
	it('sem onboarding concluído é instalação nova: guias automáticos, sem o aviso', () => {
		expect(initialTourState(false)).toEqual({
			install: 'fresh',
			auto: true,
			notice: 'none',
			seen: [],
		});
	});

	it('com onboarding concluído é quem já usava o app: nada automático, e o aviso único', () => {
		expect(initialTourState(true)).toEqual({
			install: 'upgrade',
			auto: false,
			notice: 'pending',
			seen: [],
		});
	});

	it('o estado gravado volta igual; texto estragado ou de outro formato vira null', () => {
		const state: TourState = {
			install: 'upgrade',
			auto: true,
			notice: 'done',
			seen: ['home', 'card'],
		};

		expect(parseTourState(serializeTourState(state))).toEqual(state);
		expect(parseTourState(null)).toBeNull();
		expect(parseTourState('{')).toBeNull();
		expect(parseTourState('{"install":"x","auto":true,"notice":"done","seen":[]}')).toBeNull();
		// Tela que não existe mais sai da lista, sem derrubar o resto.
		expect(
			parseTourState('{"install":"fresh","auto":true,"notice":"none","seen":["home","velha"]}')
				?.seen
		).toEqual(['home']);
	});
});

describe('abertura automática', () => {
	const fresh = initialTourState(false);

	it('instalação nova: abre na primeira visita, depois das boas-vindas', () => {
		expect(shouldAutoOpen({ state: fresh, screen: 'home', onboardingDone: true })).toBe(true);
	});

	it('nunca durante as boas-vindas (a tela inicial monta por baixo do onboarding)', () => {
		expect(shouldAutoOpen({ state: fresh, screen: 'home', onboardingDone: false })).toBe(false);
	});

	it('guia visto não abre de novo; os das outras telas continuam valendo', () => {
		const seen = markTourSeen(fresh, 'home');

		expect(shouldAutoOpen({ state: seen, screen: 'home', onboardingDone: true })).toBe(false);
		expect(shouldAutoOpen({ state: seen, screen: 'card', onboardingDone: true })).toBe(true);
	});

	it('quem atualizou não recebe nenhum guia sozinho', () => {
		const upgrade = initialTourState(true);

		for (const screen of Object.keys(TOUR_GUIDES)) {
			expect(
				shouldAutoOpen({
					state: upgrade,
					screen: screen as keyof typeof TOUR_GUIDES,
					onboardingDone: true,
				})
			).toBe(false);
		}
	});

	it('quem atualizou e tocou em "Ver" passa a receber cada guia na primeira visita', () => {
		const answered = answerNotice(initialTourState(true), 'see');

		expect(shouldAutoOpen({ state: answered, screen: 'wealth', onboardingDone: true })).toBe(true);
	});
});

describe('visto: Pular e Entendi marcam; nada mostrado não marca', () => {
	const fresh = initialTourState(false);

	it('terminar com algum passo mostrado marca o guia como visto, uma vez só', () => {
		const once = finishTour(fresh, 'card', 3);
		const twice = finishTour(once, 'card', 1);

		expect(once.seen).toEqual(['card']);
		expect(twice.seen).toEqual(['card']);
	});

	it('um guia sem passo para mostrar (ex. revisão vazia) não fica visto: abre quando houver o que mostrar', () => {
		expect(finishTour(fresh, 'inbox', 0)).toBe(fresh);
	});

	it('vazio pelo "?" abre o tópico da tela; vazio sozinho ou pelo "Como usar" não abre nada', () => {
		expect(emptyTourFallback('help', 'inbox')).toBe('capture');
		expect(emptyTourFallback('help', 'card')).toBe('invoice');
		expect(emptyTourFallback('help', 'cardEdit')).toBe('cards');
		expect(emptyTourFallback('auto', 'inbox')).toBeNull();
		expect(emptyTourFallback('howto', 'inbox')).toBeNull();
	});
});

describe('o aviso único para quem atualizou', () => {
	it('aparece para quem atualizou, depois das boas-vindas', () => {
		expect(shouldShowNotice(initialTourState(true), true)).toBe(true);
		expect(shouldShowNotice(initialTourState(true), false)).toBe(false);
		expect(shouldShowNotice(initialTourState(false), true)).toBe(false);
	});

	it('"Ver" e "Agora não" somem com ele para sempre; só "Ver" liga os guias automáticos', () => {
		const see = answerNotice(initialTourState(true), 'see');
		const later = answerNotice(initialTourState(true), 'later');

		expect(see).toEqual({ install: 'upgrade', auto: true, notice: 'done', seen: [] });
		expect(later).toEqual({ install: 'upgrade', auto: false, notice: 'done', seen: [] });
		expect(shouldShowNotice(see, true)).toBe(false);
		expect(shouldShowNotice(later, true)).toBe(false);
	});
});

describe('pedido de guia (o "?", o "Ver", o "Mostrar na tela")', () => {
	const request = { screen: 'card' as const, origin: 'help' as const, at: 1_000 };

	it('vale para a tela pedida, dentro do prazo', () => {
		expect(requestFor(request, 'card', 1_000 + REQUEST_TTL_MS)).toBe(request);
		expect(requestFor(request, 'home', 1_000)).toBeNull();
	});

	it('vencido não vale: o guia não abre de surpresa numa visita depois', () => {
		expect(requestFor(request, 'card', 1_001 + REQUEST_TTL_MS)).toBeNull();
		expect(requestFor(null, 'card', 1_000)).toBeNull();
	});
});

describe('do que foi medido na janela para a camada do guia', () => {
	it('camada que começa em y=40 (abaixo da barra de status): alvo em y=300 é desenhado em 260', () => {
		expect(toOverlayRect(rect(20, 300, 100, 50), { x: 0, y: 40 })).toEqual(rect(20, 260, 100, 50));
	});

	it('camada na origem da janela: nada muda', () => {
		expect(toOverlayRect(rect(20, 300, 100, 50), { x: 0, y: 0 })).toEqual(rect(20, 300, 100, 50));
	});

	it('camada que começa acima da origem das medidas: o destaque desce o mesmo tanto', () => {
		expect(toOverlayRect(rect(16, 176, 300, 158), { x: 0, y: -108 })).toEqual(
			rect(16, 284, 300, 158)
		);
	});
});

describe('onde o destaque e o balão ficam', () => {
	const window = { width: 390, height: 844 };
	const insets = { top: 40, bottom: 24 };

	it('alvo no alto: buraco com folga em volta e o balão embaixo, centrado no alvo', () => {
		const layout = layoutTour({
			target: rect(100, 100, 100, 50),
			window,
			insets,
			bubbleHeight: 160,
		});

		expect(layout.hole).toEqual(rect(94, 94, 112, 62));
		expect(layout.bubble).toEqual({ placement: 'below', top: 168, left: 16, width: 358 });
	});

	it('alvo embaixo (a barra de abas): o balão vai para cima', () => {
		const layout = layoutTour({ target: rect(0, 774, 390, 70), window, insets, bubbleHeight: 160 });

		expect(layout.bubble.placement).toBe('above');
		// O buraco não passa da tela; o balão termina 12 acima dele.
		expect(layout.hole).toEqual(rect(0, 768, 390, 76));
		expect(layout.bubble.top).toBe(768 - 12 - 160);
	});

	it('alvo maior que o espaço: o balão fica dentro da tela, abaixo da barra de status e acima da de gestos', () => {
		const tall = layoutTour({ target: rect(0, 60, 390, 760), window, insets, bubbleHeight: 200 });

		expect(tall.bubble.top).toBeGreaterThanOrEqual(insets.top + 8);
		expect(tall.bubble.top + 200).toBeLessThanOrEqual(window.height - insets.bottom - 8);
	});

	it('tela estreita: o balão ocupa a largura menos as margens e não sai pela direita', () => {
		const narrow = layoutTour({
			target: rect(300, 100, 20, 20),
			window: { width: 320, height: 568 },
			insets: { top: 20, bottom: 0 },
			bubbleHeight: 180,
		});

		expect(narrow.bubble.width).toBe(288);
		expect(narrow.bubble.left).toBe(16);
	});

	it('tela larga (tablet): balão de até 400, perto do alvo e dentro da tela', () => {
		const wide = layoutTour({
			target: rect(900, 100, 48, 48),
			window: { width: 1000, height: 800 },
			insets,
			bubbleHeight: 150,
		});

		expect(wide.bubble.width).toBe(400);
		expect(wide.bubble.left).toBe(1000 - 16 - 400);
	});

	it('na tela, fora da tela e quando rolar', () => {
		const viewport = { top: 40, bottom: 820 };

		expect(isOnScreen(rect(0, 100, 100, 100), viewport)).toBe(true);
		expect(isOnScreen(rect(0, 900, 100, 100), viewport)).toBe(false);
		expect(needsScroll(rect(0, 100, 100, 100), viewport)).toBe(false);
		// Metade para fora embaixo: rola para mostrar inteiro.
		expect(needsScroll(rect(0, 760, 100, 100), viewport)).toBe(true);
		expect(needsScroll(rect(0, 1200, 100, 100), viewport)).toBe(true);
		// Maior que a tela e começando nela: não adianta rolar.
		expect(needsScroll(rect(0, 60, 100, 900), viewport)).toBe(false);
	});
});
