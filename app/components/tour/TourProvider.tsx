import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
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
	type TopicId,
	type TourOrigin,
	type TourRequest,
	type TourScreen,
	type TourState,
	targetsOf,
} from '../../utils/tour';
import { measureTarget } from './registry';
import { type ScreenReport, TourContext, type TourContextValue } from './TourContext';
import TourOverlay from './TourOverlay';

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
 */

/** Depois do foco, quanto esperar a tela assentar antes de abrir o guia sozinho. */
const SETTLE_MS = 700;

/** A tela está em foco, carregada e sem folha aberta. */
const isReady = (reports: ReadonlyMap<TourScreen, ScreenReport>, screen: TourScreen): boolean => {
	const report = reports.get(screen);
	return Boolean(report?.focused && report.ready && !report.blocked);
};

interface ActiveTour {
	screen: TourScreen;
	steps: PlannedStep[];
	origin: TourOrigin;
	/** Muda a cada guia, para o balão começar do passo 1. */
	key: number;
}

export const TourProvider: React.FC<{ paused?: boolean; children: React.ReactNode }> = ({
	paused = false,
	children,
}) => {
	const [state, setState] = useState<TourState | null>(null);
	const [onboardingDone, setOnboardingDone] = useState(false);
	const [active, setActive] = useState<ActiveTour | null>(null);

	// O que as decisões assíncronas leem: o valor da hora, não o do render que as agendou.
	const stateRef = useRef<TourState | null>(null);
	const activeRef = useRef<ActiveTour | null>(null);
	const pausedRef = useRef(paused);
	const startingRef = useRef(false);
	const reports = useRef(new Map<TourScreen, ScreenReport>());
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
				// Enquanto media, a tela pode ter perdido o foco ou aberto uma folha.
				if (activeRef.current || pausedRef.current || !isReady(reports.current, screen)) return;
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
		(screen: TourScreen, next: ScreenReport) => {
			reports.current.set(screen, next);
			if (next.focused && next.ready && !next.blocked) {
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
		for (const screen of reports.current.keys())
			if (isReady(reports.current, screen)) schedule(screen, SETTLE_MS);
	}, [loaded, paused, schedule]);

	useEffect(
		() => () => {
			for (const timer of timers.current.values()) clearTimeout(timer);
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
		}),
		[report, startTour, openTopic, state, onboardingDone, answerNotice]
	);

	const showing = Boolean(active && !paused);

	return (
		<TourContext.Provider value={value}>
			{/* Com o guia aberto, o leitor de tela do Android só alcança o balão (no iOS, a camada do
			    guia já é modal para ele). */}
			<View
				style={styles.screens}
				importantForAccessibility={showing ? 'no-hide-descendants' : 'auto'}
			>
				{children}
			</View>
			{active && !paused ? (
				<TourOverlay
					key={active.key}
					screen={active.screen}
					steps={active.steps}
					onFinish={handleFinish}
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
