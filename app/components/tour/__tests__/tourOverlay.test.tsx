/**
 * O guia na tela (SPD-129), de verdade: o balão do passo, "Próximo", "Pular", "Entendi" no
 * último, o voltar do Android, o passo sem alvo pulado, e o provider guardando o visto, a
 * abertura automática da instalação nova, o aviso de quem atualizou e o "?" sem nada para
 * apontar. O armazenamento é um Map; os alvos são dublês que respondem `measureInWindow`; as
 * chaves de tradução aparecem cruas.
 */

const mockStorage = new Map<string, string>();
const mockPush = jest.fn();
const mockOnboarding = { done: [] as boolean[], fallback: true };

jest.mock('@react-native-async-storage/async-storage', () => ({
	getItem: jest.fn(async (key: string) => mockStorage.get(key) ?? null),
	setItem: jest.fn(async (key: string, value: string) => {
		mockStorage.set(key, value);
	}),
}));

jest.mock('expo-router', () => ({ router: { push: (...args: unknown[]) => mockPush(...args) } }));

// A primeira leitura é a da carga; as seguintes, as de cada abertura automática.
jest.mock('../../../utils/onboardingUtils', () => ({
	isOnboardingCompleted: jest.fn(
		async () => mockOnboarding.done.shift() ?? mockOnboarding.fallback
	),
}));

jest.mock('react-native-safe-area-context', () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('react-i18next', () => ({
	useTranslation: () => ({
		t: (key: string, params?: Record<string, unknown>) =>
			params ? `${key}${JSON.stringify(params)}` : key,
	}),
}));

import { BackHandler, StyleSheet, Text } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { STORAGE_KEYS } from '../../../utils/storageUtils';
import type { PlannedStep, Rect, TourScreen } from '../../../utils/tour';
import HelpButton from '../HelpButton';
import { clearTourRegistry, registerTarget } from '../registry';
import { useGuideOpen, useScreenTour } from '../TourContext';
import TourNotice from '../TourNotice';
import TourOverlay from '../TourOverlay';
import TourProvider from '../TourProvider';

jest.setTimeout(30_000);

let renderer: ReactTestRenderer | null = null;

const wait = (ms: number) =>
	act(async () => new Promise<void>((resolve) => setTimeout(resolve, ms)));

const texts = (): string[] =>
	(
		renderer?.root.findAll(
			(node) => (node.type as unknown) === Text || (node.type as unknown) === 'Text'
		) ?? []
	).map((node) => [node.props.children].flat().join(''));

/**
 * Espera o texto aparecer (ou sumir). O guia espera a tela assentar (700 + 300) com relógio
 * de verdade, e a primeira montagem no jest demora: um tempo fixo seria frágil.
 */
const waitForText = async (text: string, present = true, timeout = 8_000) => {
	const start = Date.now();
	while (texts().includes(text) !== present && Date.now() - start < timeout) await wait(50);
};

const pressLabel = async (label: string) => {
	const node = renderer?.root.find(
		(candidate: ReactTestInstance) =>
			candidate.props.accessibilityLabel === label && typeof candidate.props.onPress === 'function'
	);
	await act(async () => {
		node?.props.onPress();
	});
};

const step = (screen: TourScreen, id: string, target = `${screen}.${id}`): PlannedStep => ({
	id,
	target,
	titleKey: `tutorial.steps.${screen}.${id}.title`,
	bodyKey: `tutorial.steps.${screen}.${id}.body`,
});

const at = (y: number): Rect => ({ x: 16, y, width: 300, height: 60 });

const fakeNode = (rect: Rect | null) => ({
	measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) =>
		rect ? callback(rect.x, rect.y, rect.width, rect.height) : callback(0, 0, 0, 0),
});

beforeEach(() => {
	mockStorage.clear();
	mockPush.mockClear();
	mockOnboarding.done = [];
	mockOnboarding.fallback = true;
	clearTourRegistry();
});

afterEach(async () => {
	await act(async () => {
		renderer?.unmount();
	});
	renderer = null;
});

describe('o balão do guia', () => {
	const mountOverlay = async (
		steps: PlannedStep[],
		rects: Record<string, Rect | null>,
		onFinish = jest.fn()
	) => {
		await act(async () => {
			renderer = create(
				<TourOverlay
					screen="card"
					steps={steps}
					onFinish={onFinish}
					measure={async (id) => rects[id] ?? null}
					scrollTo={async () => false}
					settleMs={0}
				/>
			);
		});
		await wait(10);
		return onFinish;
	};

	it('mostra o passo com o contador, e "Próximo" vai para o seguinte', async () => {
		const steps = [step('card', 'pay'), step('card', 'adjust'), step('card', 'charge')];
		await mountOverlay(steps, {
			'card.pay': at(100),
			'card.adjust': at(200),
			'card.charge': at(300),
		});
		await waitForText('tutorial.steps.card.pay.title');

		expect(texts()).toContain('tutorial.counter{"current":1,"total":3}');
		expect(texts()).toContain('tutorial.steps.card.pay.title');
		expect(texts()).toContain('tutorial.steps.card.pay.body');

		await pressLabel('tutorial.next');
		await waitForText('tutorial.steps.card.adjust.title');

		expect(texts()).toContain('tutorial.counter{"current":2,"total":3}');
		expect(texts()).toContain('tutorial.steps.card.adjust.title');
	});

	it('"Pular" termina o guia, contando os passos que apareceram', async () => {
		const steps = [step('card', 'pay'), step('card', 'adjust')];
		const onFinish = await mountOverlay(steps, { 'card.pay': at(100), 'card.adjust': at(200) });
		await waitForText('tutorial.steps.card.pay.title');

		await pressLabel('tutorial.skip');

		expect(onFinish).toHaveBeenCalledWith(1, 'skip');
	});

	it('no último passo o botão é "Entendi", sem "Pular", e ele termina o guia', async () => {
		const steps = [step('card', 'pay'), step('card', 'adjust')];
		const onFinish = await mountOverlay(steps, { 'card.pay': at(100), 'card.adjust': at(200) });
		await waitForText('tutorial.steps.card.pay.title');

		await pressLabel('tutorial.next');
		await waitForText('tutorial.steps.card.adjust.title');

		expect(texts()).toContain('tutorial.done');
		expect(texts()).not.toContain('tutorial.skip');
		await pressLabel('tutorial.done');
		expect(onFinish).toHaveBeenCalledWith(2, 'done');
	});

	it('passo cujo alvo sumiu é pulado sem quebrar', async () => {
		const steps = [step('card', 'pay'), step('card', 'adjust'), step('card', 'charge')];
		await mountOverlay(steps, { 'card.pay': null, 'card.adjust': at(200), 'card.charge': at(300) });
		await waitForText('tutorial.steps.card.adjust.title');

		expect(texts()).toContain('tutorial.steps.card.adjust.title');
		expect(texts()).not.toContain('tutorial.steps.card.pay.title');
	});

	it('alvo fora da tela e sem rolagem: o passo é pulado', async () => {
		const steps = [step('card', 'pay'), step('card', 'adjust')];
		await mountOverlay(steps, { 'card.pay': at(5000), 'card.adjust': at(200) });
		await waitForText('tutorial.steps.card.adjust.title');

		expect(texts()).toContain('tutorial.steps.card.adjust.title');
	});

	it('alvo abaixo da tela: rola até ele, mede de novo e mostra', async () => {
		let scrolled = false;
		const scrollTo = jest.fn(async () => {
			scrolled = true;
			return true;
		});
		await act(async () => {
			renderer = create(
				<TourOverlay
					screen="card"
					steps={[step('card', 'invoices')]}
					onFinish={jest.fn()}
					measure={async () => (scrolled ? at(300) : at(2000))}
					scrollTo={scrollTo}
					settleMs={0}
				/>
			);
		});
		await waitForText('tutorial.steps.card.invoices.title');

		// A janela do jest tem 1334 de altura: o alvo vai a um quarto dela do topo da rolagem.
		expect(scrollTo).toHaveBeenCalledWith('card', 'card.invoices', 334);
		expect(texts()).toContain('tutorial.steps.card.invoices.title');
	});

	it('alvo fora da rolagem (a barra de abas): não tenta rolar', async () => {
		const scrollTo = jest.fn(async () => true);
		await act(async () => {
			renderer = create(
				<TourOverlay
					screen="home"
					steps={[{ ...step('home', 'tabs'), fixed: true }]}
					onFinish={jest.fn()}
					measure={async () => ({ x: 0, y: 1264, width: 750, height: 70 })}
					scrollTo={scrollTo}
					settleMs={0}
				/>
			);
		});
		await waitForText('tutorial.steps.home.tabs.title');

		expect(scrollTo).not.toHaveBeenCalled();
	});

	it('o voltar do Android pula o guia, e a tela de trás não volta', async () => {
		const handlers: (() => boolean | null | undefined)[] = [];
		const remove = jest.fn();
		const spy = jest
			.spyOn(BackHandler, 'addEventListener')
			.mockImplementation((_event, handler) => {
				handlers.push(handler);
				return { remove };
			});
		const onFinish = await mountOverlay([step('card', 'pay'), step('card', 'adjust')], {
			'card.pay': at(100),
			'card.adjust': at(200),
		});
		await waitForText('tutorial.steps.card.pay.title');

		let handled: boolean | null | undefined;
		await act(async () => {
			handled = handlers[0]?.();
		});

		expect(handled).toBe(true);
		expect(onFinish).toHaveBeenCalledWith(1, 'skip');
		await act(async () => {
			renderer?.unmount();
		});
		renderer = null;
		expect(remove).toHaveBeenCalled();
		spy.mockRestore();
	});

	it('desenha o destaque em relação à camada do guia: camada em y=40, alvo em y=300 fica em 260', async () => {
		await act(async () => {
			renderer = create(
				<TourOverlay
					screen="card"
					steps={[step('card', 'pay')]}
					onFinish={jest.fn()}
					measure={async () => ({ x: 20, y: 300, width: 100, height: 50 })}
					measureLayer={async () => ({ x: 0, y: 40, width: 400, height: 800 })}
					scrollTo={async () => false}
					settleMs={0}
				/>
			);
		});
		await waitForText('tutorial.steps.card.pay.title');

		const styleOf = (testID: string) =>
			StyleSheet.flatten(renderer?.root.find((node) => node.props.testID === testID).props.style);
		// O buraco tem 6 de folga em volta do alvo: 260 - 6.
		expect(styleOf('tour-outline')).toMatchObject({ top: 254, left: 14, width: 112, height: 62 });
		// O balão vai logo abaixo do buraco, também na referência da camada: 254 + 62 + 12.
		expect(styleOf('tour-bubble')).toMatchObject({ top: 328 });
	});

	it('a rolagem usa a altura da camada, e o alvo é visto na referência dela', async () => {
		let scrolled = false;
		const scrollTo = jest.fn(async () => {
			scrolled = true;
			return true;
		});
		await act(async () => {
			renderer = create(
				<TourOverlay
					screen="card"
					steps={[step('card', 'invoices')]}
					onFinish={jest.fn()}
					// Na janela, 820 cabe numa tela de 1334; na camada de 800 que começa em 40, não.
					measure={async () => (scrolled ? at(340) : at(820))}
					measureLayer={async () => ({ x: 0, y: 40, width: 400, height: 800 })}
					scrollTo={scrollTo}
					settleMs={0}
				/>
			);
		});
		await waitForText('tutorial.steps.card.invoices.title');

		expect(scrollTo).toHaveBeenCalledWith('card', 'card.invoices', 200);
		expect(
			StyleSheet.flatten(
				renderer?.root.find((node) => node.props.testID === 'tour-outline').props.style
			)
		).toMatchObject({ top: 294 });
	});
});

describe('o provider do guia', () => {
	const Screen = ({ screen }: { screen: TourScreen }) => {
		useScreenTour(screen);
		return (
			<>
				<TourNotice />
				<HelpButton screen={screen} />
			</>
		);
	};

	const mount = async (screen: TourScreen) => {
		await act(async () => {
			renderer = create(
				<TourProvider>
					<Screen screen={screen} />
				</TourProvider>
			);
		});
	};

	/** Mais que o tempo de a tela assentar (700) e o balão medir (300): para ver que nada abriu. */
	const settle = () => wait(2_000);

	const stored = () => JSON.parse(mockStorage.get(STORAGE_KEYS.tutorial) ?? 'null');

	it('instalação nova: depois das boas-vindas o guia abre sozinho, pula o alvo ausente, e "Entendi" marca visto', async () => {
		// Na carga o onboarding ainda não foi concluído; quando a tela abre, já foi.
		mockOnboarding.done = [false];
		registerTarget('cardEdit.days', fakeNode(at(300)));
		registerTarget('cardEdit.last4', fakeNode(null));
		await mount('cardEdit');
		await waitForText('tutorial.steps.cardEdit.days.title');

		expect(texts()).toContain('tutorial.counter{"current":1,"total":1}');
		expect(texts()).toContain('tutorial.steps.cardEdit.days.title');
		expect(stored()).toEqual({ install: 'fresh', auto: true, notice: 'none', seen: [] });

		await pressLabel('tutorial.done');

		expect(stored().seen).toEqual(['cardEdit']);
		expect(texts()).not.toContain('tutorial.steps.cardEdit.days.title');
	});

	it('com o guia aberto, useGuideOpen diz que está aberto (o botão do Mirai sai da frente, SPD-163)', async () => {
		mockOnboarding.done = [false];
		registerTarget('cardEdit.days', fakeNode(at(300)));
		const GuideFlag = () => <Text>{useGuideOpen() ? 'guia-aberto' : 'guia-fechado'}</Text>;
		await act(async () => {
			renderer = create(
				<TourProvider>
					<Screen screen="cardEdit" />
					<GuideFlag />
				</TourProvider>
			);
		});
		expect(texts()).toContain('guia-fechado');

		await waitForText('tutorial.steps.cardEdit.days.title');
		expect(texts()).toContain('guia-aberto');

		await pressLabel('tutorial.done');
		await waitForText('guia-fechado');
		expect(texts()).toContain('guia-fechado');
	});

	it('guia visto não abre de novo sozinho', async () => {
		mockStorage.set(
			STORAGE_KEYS.tutorial,
			JSON.stringify({ install: 'fresh', auto: true, notice: 'none', seen: ['cardEdit'] })
		);
		registerTarget('cardEdit.days', fakeNode(at(300)));
		await mount('cardEdit');
		await settle();

		expect(texts()).not.toContain('tutorial.steps.cardEdit.days.title');
	});

	it('"Pular" também marca visto', async () => {
		mockOnboarding.done = [false];
		registerTarget('cardEdit.last4', fakeNode(at(200)));
		registerTarget('cardEdit.days', fakeNode(at(300)));
		await mount('cardEdit');
		await waitForText('tutorial.steps.cardEdit.last4.title');

		await pressLabel('tutorial.skip');

		expect(stored().seen).toEqual(['cardEdit']);
	});

	it('quem atualizou: nada abre sozinho, o aviso aparece, e "Ver" o apaga e abre o guia da tela inicial', async () => {
		registerTarget('home.add', fakeNode(at(700)));
		await mount('home');
		await settle();

		expect(texts()).not.toContain('tutorial.steps.home.add.title');
		expect(texts()).toContain('tutorial.notice.title');
		expect(stored()).toEqual({ install: 'upgrade', auto: false, notice: 'pending', seen: [] });

		await pressLabel('tutorial.notice.see');
		await waitForText('tutorial.steps.home.add.title');

		expect(texts()).not.toContain('tutorial.notice.title');
		expect(texts()).toContain('tutorial.steps.home.add.title');
		expect(stored()).toEqual({ install: 'upgrade', auto: true, notice: 'done', seen: [] });
	});

	it('"Agora não" apaga o aviso para sempre, sem ligar os guias', async () => {
		await mount('home');
		await wait(50);

		await pressLabel('tutorial.notice.later');

		expect(texts()).not.toContain('tutorial.notice.title');
		expect(stored()).toEqual({ install: 'upgrade', auto: false, notice: 'done', seen: [] });
	});

	it('o "?" abre o guia da tela mesmo já visto', async () => {
		mockStorage.set(
			STORAGE_KEYS.tutorial,
			JSON.stringify({ install: 'upgrade', auto: false, notice: 'done', seen: ['card'] })
		);
		registerTarget('card.pay', fakeNode(at(200)));
		await mount('card');
		await wait(50);

		await pressLabel('tutorial.help');
		await waitForText('tutorial.steps.card.pay.title');

		expect(texts()).toContain('tutorial.steps.card.pay.title');
	});

	it('o "?" sem nada para apontar (revisão vazia) abre o tópico em Como usar', async () => {
		await mount('inbox');
		await wait(50);

		await pressLabel('tutorial.help');
		await wait(400);

		expect(mockPush).toHaveBeenCalledWith({ pathname: '/howto', params: { topic: 'capture' } });
		expect(stored().seen).toEqual([]);
	});
});
