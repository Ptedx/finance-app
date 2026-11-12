import AsyncStorage from '@react-native-async-storage/async-storage';
import { type Href, router } from 'expo-router';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { isOnboardingCompleted } from '../../utils/onboardingUtils';
import { STORAGE_KEYS } from '../../utils/storageUtils';
import {
	answerNotice as answerNoticeState,
	emptyTourFallback,
	finishTour,
	initialTourState,
	type PlannedStep,
	parseTourState,
	planSteps,
	requestFor,
	serializeTourState,
	shouldAutoOpen,
	shouldShowNotice,
	TOUR_GUIDES,
	type TopicId,
	type TourOrigin,
	type TourRequest,
	type TourScreen,
	type TourState,
	targetsOf,
} from '../../utils/tour';
import { TRAIL_SAMPLE_RECORDS } from '../../utils/trailSample';
import {
	hrefOf,
	type PlannedTrailStep,
	planTrail,
	startIndexOf,
	type TourPlace,
	TRAIL_SCREENS,
	TRAILS,
	type TrailId,
	type TrailLocation,
	type TrailNavAction,
} from '../../utils/trails';
import { measureTarget } from './registry';
import {
	type ScreenReport,
	TourContext,
	type TourContextValue,
	type TrailRecordsSource,
} from './TourContext';
import TourOverlay from './TourOverlay';
import TrailOverlay, { type TrailNavigator } from './TrailOverlay';
import { TrailSampleContext } from './TrailSample';

/**
 * O dono do guia na tela (SPD-129): guarda no aparelho o que já foi visto, decide quando um
 * guia abre e desenha o guia por cima de tudo. Fica no `_layout` raiz, em volta da pilha.
 *
 * Um guia abre quando a tela dele está em foco, carregada e sem folha aberta, e:
 * - foi pedido (o "?", o "Ver" do aviso, o "Mostrar na tela" do Como usar); ou
 * - é a primeira visita e a abertura automática vale (`utils/tour.ts`, `shouldAutoOpen`).
 *
 * Espera um pouco depois do foco antes de medir: a tela acabou de aparecer e ainda está
 * assentando. Nunca dois guias ao mesmo tempo, e nada enquanto a trava por biometria está na
 * tela (`paused`).
 *
 * As trilhas (SPD-131) também moram aqui: o "?" pede uma trilha (`startTrail`), o provider
 * monta o plano com os registros do usuário (quem os sabe se inscreve em `setTrailRecords`) e
 * desenha a `TrailOverlay`, que anda pelas telas. Com uma trilha aberta (e logo depois dela),
 * o guia de primeira visita de cada tela não abre.
 *
 * O modo exemplo (SPD-147) também: o plano recebe os registros de exemplo
 * (`TRAIL_SAMPLE_RECORDS`) e, com algum passo de exemplo, o `TrailSampleContext` fica ligado
 * enquanto a trilha está aberta. Ele desliga um instante depois do fim — o tempo de a tela de
 * exemplo sair da pilha sem piscar "não encontrado". Só estado em memória: fechar o app leva.
 */

/** Depois do foco, quanto esperar a tela assentar antes de abrir o guia sozinho. */
const SETTLE_MS = 700;

/** Depois de uma trilha, quanto tempo o guia de primeira visita ainda espera. */
const TRAIL_QUIET_MS = 1500;
/** Entre duas navegações da trilha, o tempo do `expo-router` trocar de tela. */
const NAV_GAP_MS = 60;
/** Depois da trilha, quanto o exemplo ainda vale: a tela de exemplo está saindo da pilha. */
const SAMPLE_LINGER_MS = 600;

/** O que cada montagem de tela disse por último (a mesma tela pode estar duas vezes na pilha). */
type Reports = Map<number | string, ScreenReport & { screen: TourPlace; instance: number }>;

/** Alguma montagem da tela está em foco, carregada e sem folha aberta (aberta a partir de `minInstance`). */
const isReady = (reports: Reports, screen: TourPlace, minInstance = 0): boolean => {
	for (const report of reports.values())
		if (
			report.screen === screen &&
			report.instance >= minInstance &&
			report.focused &&
			report.ready &&
			!report.blocked
		)
			return true;
	return false;
};

/** As telas com guia de primeira visita (SPD-129); as outras só as trilhas visitam. */
const hasGuide = (screen: TourPlace): screen is TourScreen => Object.hasOwn(TOUR_GUIDES, screen);

/** A navegação de verdade das trilhas, pelo `expo-router`. */
const routerNavigator: TrailNavigator = {
	run: async (action: TrailNavAction) => {
		if (action.type === 'push') router.push(hrefOf(action.location) as Href);
		else if (action.type === 'pop') router.dismiss(action.count);
		else if (action.type === 'root') router.dismissAll();
		else router.navigate(TRAIL_SCREENS[action.screen].path as Href);
		await new Promise<void>((resolve) => setTimeout(resolve, NAV_GAP_MS));
	},
};

export interface TrailOptions {
	/** Para os testes: quem navega, e quanto esperar a tela assentar e ficar pronta. */
	navigator?: TrailNavigator;
	settleMs?: number;
	readyTimeoutMs?: number;
}

interface ActiveTrail {
	plan: PlannedTrailStep[];
	start: number;
	origin: TrailLocation;
	key: number;
}

interface ActiveTour {
	screen: TourScreen;
	steps: PlannedStep[];
	origin: TourOrigin;
	/** Muda a cada guia, para o balão começar do passo 1. */
	key: number;
}

export const TourProvider: React.FC<{
	paused?: boolean;
	trailOptions?: TrailOptions;
	children: React.ReactNode;
}> = ({ paused = false, trailOptions, children }) => {
	const [state, setState] = useState<TourState | null>(null);
	const [onboardingDone, setOnboardingDone] = useState(false);
	const [active, setActive] = useState<ActiveTour | null>(null);
	const [trail, setTrail] = useState<ActiveTrail | null>(null);
	// O exemplo das trilhas (SPD-147): ligado enquanto a trilha aberta tem passo de exemplo.
	const [sampleOn, setSampleOn] = useState(false);
	const sampleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	// O que as decisões assíncronas leem: o valor da hora, não o do render que as agendou.
	const stateRef = useRef<TourState | null>(null);
	const activeRef = useRef<ActiveTour | null>(null);
	const pausedRef = useRef(paused);
	const startingRef = useRef(false);
	const reports = useRef<Reports>(new Map());
	const trailRef = useRef<ActiveTrail | null>(null);
	const trailStarting = useRef(false);
	const quietUntil = useRef(0);
	const recordSources = useRef<TrailRecordsSource[]>([]);
	const request = useRef<TourRequest | null>(null);
	const timers = useRef(new Map<TourScreen, ReturnType<typeof setTimeout>>());
	const counter = useRef(0);
	pausedRef.current = paused;

	const save = useCallback((next: TourState) => {
		stateRef.current = next;
		setState(next);
		AsyncStorage.setItem(STORAGE_KEYS.tutorial, serializeTourState(next)).catch(() => {});
	}, []);

	const openTopic = useCallback((topic: TopicId) => {
		router.push({ pathname: '/howto', params: { topic } });
	}, []);

	const evaluate = useCallback(
		async (screen: TourScreen) => {
			if (
				!stateRef.current ||
				activeRef.current ||
				pausedRef.current ||
				startingRef.current ||
				trailRef.current ||
				trailStarting.current ||
				Date.now() < quietUntil.current ||
				!isReady(reports.current, screen)
			)
				return;
			const asked = requestFor(request.current, screen, Date.now());
			let origin: TourOrigin = 'auto';
			if (asked) {
				origin = asked.origin;
			} else {
				const done = await isOnboardingCompleted();
				setOnboardingDone(done);
				const current = stateRef.current;
				if (!current || !shouldAutoOpen({ state: current, screen, onboardingDone: done })) return;
			}

			startingRef.current = true;
			try {
				const only = asked?.only;
				const ids = targetsOf(screen, only);
				const rects = Object.fromEntries(
					await Promise.all(ids.map(async (id) => [id, await measureTarget(id)] as const))
				);
				// Enquanto media, a tela pode ter perdido o foco, aberto uma folha ou uma trilha.
				if (
					activeRef.current ||
					pausedRef.current ||
					trailRef.current ||
					!isReady(reports.current, screen)
				)
					return;
				if (asked) request.current = null;

				const steps = planSteps(screen, rects, only);
				if (steps.length === 0) {
					const topic = emptyTourFallback(origin, screen);
					if (topic) openTopic(topic);
					return;
				}
				counter.current += 1;
				const next = { screen, steps, origin, key: counter.current };
				activeRef.current = next;
				setActive(next);
			} finally {
				startingRef.current = false;
			}
		},
		[openTopic]
	);

	const schedule = useCallback(
		(screen: TourScreen, delay: number) => {
			const previous = timers.current.get(screen);
			if (previous) clearTimeout(previous);
			timers.current.set(
				screen,
				setTimeout(() => {
					timers.current.delete(screen);
					evaluate(screen);
				}, delay)
			);
		},
		[evaluate]
	);

	const report = useCallback(
		(screen: TourPlace, next: ScreenReport, instance?: number) => {
			const key = instance ?? screen;
			if (next.gone) reports.current.delete(key);
			else reports.current.set(key, { ...next, screen, instance: instance ?? 0 });
			if (!hasGuide(screen)) return;
			if (isReady(reports.current, screen)) {
				schedule(screen, SETTLE_MS);
			} else {
				const timer = timers.current.get(screen);
				if (timer) clearTimeout(timer);
				timers.current.delete(screen);
			}
		},
		[schedule]
	);

	const startTour = useCallback(
		(screen: TourScreen, options?: { only?: readonly string[]; origin?: TourOrigin }) => {
			request.current = {
				screen,
				only: options?.only,
				origin: options?.origin ?? 'help',
				at: Date.now(),
			};
			// A tela já em foco (o "?") abre na hora; outra tela abre quando chegar o foco dela.
			if (isReady(reports.current, screen)) schedule(screen, 50);
		},
		[schedule]
	);

	const setTrailRecords = useCallback((source: TrailRecordsSource) => {
		recordSources.current = [...recordSources.current, source];
		return () => {
			recordSources.current = recordSources.current.filter((item) => item !== source);
		};
	}, []);

	const startTrail = useCallback(
		(id: TrailId, { here, from }: { here: TrailLocation; from?: string }) => {
			if (trailRef.current || trailStarting.current || activeRef.current) return;
			trailStarting.current = true;
			// O guia de primeira visita não abre por cima da trilha.
			request.current = null;
			for (const timer of timers.current.values()) clearTimeout(timer);
			timers.current.clear();
			(async () => {
				try {
					const source = recordSources.current[recordSources.current.length - 1];
					const records = source ? await source().catch(() => ({})) : {};
					const plan = planTrail(TRAILS[id], records, here, TRAIL_SAMPLE_RECORDS);
					if (plan.length === 0) return;
					if (plan.some((step) => step.sample)) {
						if (sampleTimer.current) clearTimeout(sampleTimer.current);
						sampleTimer.current = null;
						setSampleOn(true);
					}
					counter.current += 1;
					const next: ActiveTrail = {
						plan,
						start: startIndexOf(plan, from),
						origin: here,
						key: counter.current,
					};
					trailRef.current = next;
					setTrail(next);
				} finally {
					trailStarting.current = false;
				}
			})();
		},
		[]
	);

	const handleTrailEnd = useCallback(() => {
		trailRef.current = null;
		quietUntil.current = Date.now() + TRAIL_QUIET_MS;
		setTrail(null);
		// O guia já voltou para a tela de origem: o exemplo some assim que a de exemplo sair.
		if (sampleTimer.current) clearTimeout(sampleTimer.current);
		sampleTimer.current = setTimeout(() => {
			sampleTimer.current = null;
			setSampleOn(false);
		}, SAMPLE_LINGER_MS);
	}, []);

	const trailReady = useCallback(
		(place: TourPlace, minInstance: number) => isReady(reports.current, place, minInstance),
		[]
	);

	const answerNotice = useCallback(
		(answer: 'see' | 'later') => {
			const current = stateRef.current;
			if (!current) return;
			save(answerNoticeState(current, answer));
			if (answer === 'see') startTour('home', { origin: 'notice' });
		},
		[save, startTour]
	);

	const handleFinish = useCallback(
		(shown: number) => {
			const finished = activeRef.current;
			activeRef.current = null;
			setActive(null);
			if (!finished) return;
			const current = stateRef.current;
			if (current) {
				const next = finishTour(current, finished.screen, shown);
				if (next !== current) save(next);
			}
			if (shown === 0) {
				const topic = emptyTourFallback(finished.origin, finished.screen);
				if (topic) openTopic(topic);
			}
		},
		[save, openTopic]
	);

	// O estado nasce na primeira abertura desta versão: instalação nova ou atualização.
	useEffect(() => {
		let alive = true;
		(async () => {
			const [raw, done] = await Promise.all([
				AsyncStorage.getItem(STORAGE_KEYS.tutorial).catch(() => null),
				isOnboardingCompleted(),
			]);
			if (!alive) return;
			const stored = parseTourState(raw);
			setOnboardingDone(done);
			if (stored) {
				stateRef.current = stored;
				setState(stored);
			} else {
				save(initialTourState(done));
			}
		})();
		return () => {
			alive = false;
		};
	}, [save]);

	// Carregado o estado, ou destravada a biometria, as telas que já estão prontas são avaliadas.
	const loaded = state !== null;
	useEffect(() => {
		if (!loaded || paused) return;
		for (const { screen } of reports.current.values())
			if (hasGuide(screen) && isReady(reports.current, screen)) schedule(screen, SETTLE_MS);
	}, [loaded, paused, schedule]);

	useEffect(
		() => () => {
			for (const timer of timers.current.values()) clearTimeout(timer);
			if (sampleTimer.current) clearTimeout(sampleTimer.current);
		},
		[]
	);

	const value = useMemo<TourContextValue>(
		() => ({
			report,
			startTour,
			openTopic,
			noticeVisible: state ? shouldShowNotice(state, onboardingDone) : false,
			answerNotice,
			startTrail,
			setTrailRecords,
		}),
		[report, startTour, openTopic, state, onboardingDone, answerNotice, startTrail, setTrailRecords]
	);

	const showing = Boolean((active || trail) && !paused);

	return (
		<TourContext.Provider value={value}>
			{/* Com o guia aberto, o leitor de tela do Android só alcança o balão (no iOS, a camada do
			    guia já é modal para ele). */}
			<View
				style={styles.screens}
				importantForAccessibility={showing ? 'no-hide-descendants' : 'auto'}
			>
				<TrailSampleContext.Provider value={sampleOn}>{children}</TrailSampleContext.Provider>
			</View>
			{active && !paused ? (
				<TourOverlay
					key={active.key}
					screen={active.screen}
					steps={active.steps}
					onFinish={handleFinish}
				/>
			) : null}
			{trail ? (
				<TrailOverlay
					key={trail.key}
					plan={trail.plan}
					start={trail.start}
					origin={trail.origin}
					navigator={trailOptions?.navigator ?? routerNavigator}
					isReady={trailReady}
					onEnd={handleTrailEnd}
					hidden={paused}
					settleMs={trailOptions?.settleMs}
					readyTimeoutMs={trailOptions?.readyTimeoutMs}
				/>
			) : null}
		</TourContext.Provider>
	);
};

const styles = StyleSheet.create({
	screens: {
		flex: 1,
	},
});

export default TourProvider;
