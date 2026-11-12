import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
	AccessibilityInfo,
	BackHandler,
	Keyboard,
	Pressable,
	StyleSheet,
	Text,
	useWindowDimensions,
	View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
	hasSize,
	isOnScreen,
	layoutTour,
	needsScroll,
	type Rect,
	toOverlayRect,
} from '../../utils/tour';
import {
	dropsOrigin,
	navigateTrail,
	type PlannedTrailStep,
	resolveTrailStep,
	sameLocation,
	type TourPlace,
	TRAIL_SCREENS,
	type TrailLocation,
	type TrailNavAction,
	unionRect,
} from '../../utils/trails';
import { measureTarget, scrollToTarget } from './registry';
import { nextScreenInstance } from './TourContext';

/**
 * A trilha na tela (SPD-131): o guia do SPD-129 (`TourOverlay`) andando por várias telas.
 *
 * A cada passo: vai até a tela do passo (abre por cima, volta na pilha ou troca de aba, como
 * `navigateTrail` manda), espera ela anunciar que está pronta, fecha o teclado, mede os alvos
 * e aponta o primeiro grupo que está na tela, rolando até ele se precisar. Sem alvo, segue o
 * `[sem dado]` do passo: o texto sem apontar, com o resto da tela escurecido, ou pula o passo.
 * Passo "Atenção:" é a mesma caixa, com o rótulo "Atenção" e o contorno âmbar.
 *
 * O contador ("Passo 4 de 7", SPD-151) não muda no meio da trilha: os passos pulados são
 * decididos antes do primeiro balão — pelos dados, no plano (`planTrail`), e pelos alvos da tela
 * onde a trilha abre, olhados de uma vez (`decideSkips`). Depois disso nenhum passo novo sai: o
 * alvo que falta numa tela aberta mais adiante mostra o texto sem apontar, como o `[sem dado]`
 * padrão. Assim o total fica o mesmo do primeiro ao último balão, e o número anda de um em um,
 * para a frente e para trás.
 *
 * Botões: "Voltar" (um passo atrás, voltando de tela se preciso), "Pular" (encerra) e
 * "Próximo" ("Entendi" no último). O voltar do Android é "Pular". No fim, de um jeito ou de
 * outro, o guia volta para a tela onde a trilha começou.
 *
 * A trilha só abre telas e aponta: nada aqui salva, cria, altera ou apaga. O formulário aberto
 * para mostrar os campos fecha como o voltar do app, sem salvar (nenhuma tela das trilhas
 * pergunta antes de sair, e o guia nunca digita nada).
 *
 * Como no `TourOverlay`, é uma camada na mesma janela das telas (não um `Modal`), que pega
 * todo toque: o guia só anda pelos botões do balão. O leitor de tela ouve "Passo 2 de 12",
 * o "Atenção", o título e o texto a cada passo.
 */

/** Quem faz a navegação: o `expo-router` no app, uma pilha de mentira nos testes. */
export interface TrailNavigator {
	run: (action: TrailNavAction) => void | Promise<void>;
}

interface TrailOverlayProps {
	plan: PlannedTrailStep[];
	/** O passo onde a trilha começa. */
	start: number;
	/** A tela onde a trilha começou, e para onde ela volta no fim. */
	origin: TrailLocation;
	navigator: TrailNavigator;
	/** A tela está em foco, pronta e sem folha aberta; `minInstance`: aberta depois disto. */
	isReady: (place: TourPlace, minInstance: number) => boolean;
	/** A trilha acabou e o guia já voltou para a tela de origem. */
	onEnd: () => void;
	/** A trava por biometria está na tela: o guia some, e volta onde estava. */
	hidden?: boolean;
	/** Para os testes: como medir e rolar, e quanto esperar. */
	measure?: (id: string) => Promise<Rect | null>;
	scrollTo?: (place: TourPlace, id: string, offset: number) => Promise<boolean>;
	settleMs?: number;
	readyTimeoutMs?: number;
}

const ACCENT = '#15E8FE';
const ATTENTION = '#FFB020';
const SHADE = 'rgba(0,0,0,0.78)';
const BUBBLE_ESTIMATE = 190;
const BOTTOM_BARS = 80;
const LAYER_TIMEOUT_MS = 500;
/** De quanto em quanto tempo olhar se a tela do passo já está pronta. */
const POLL_MS = 50;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface MeasurableLayer {
	measureInWindow?: (
		callback: (x: number, y: number, width: number, height: number) => void
	) => void;
}

/** O passo na tela: apontando (`rect`) ou só o texto. */
interface Shown {
	index: number;
	rect: Rect | null;
	bodyKey: string;
	layer: Rect;
}

const TrailOverlay: React.FC<TrailOverlayProps> = ({
	plan,
	start,
	origin,
	navigator,
	isReady,
	onEnd,
	hidden = false,
	measure = measureTarget,
	scrollTo = scrollToTarget,
	settleMs = 300,
	readyTimeoutMs = 3_000,
}) => {
	const { t } = useTranslation();
	const insets = useSafeAreaInsets();
	const window = useWindowDimensions();
	const [index, setIndex] = useState(start);
	const [shown, setShown] = useState<Shown | null>(null);
	const [ending, setEnding] = useState(false);
	const [bubbleHeight, setBubbleHeight] = useState(BUBBLE_ESTIMATE);
	const rootRef = useRef<View>(null);
	/** O que o guia sabe da pilha: a tela de origem e o que ele abriu por cima. */
	const stack = useRef<TrailLocation[]>([origin]);
	/** Para que lado andar quando um passo é pulado. */
	const direction = useRef<1 | -1>(1);
	/** Os passos que saíram da trilha: decididos antes do primeiro balão, e daí não mudam. */
	const skipped = useRef(new Set<number>());
	/** Algum balão já apareceu: o total já está na tela e não pode mais mudar. */
	const counted = useRef(false);
	const endingRef = useRef(false);
	// O que o efeito assíncrono lê na hora, não o do render que o agendou.
	const props = useRef({ navigator, isReady, onEnd, measure, scrollTo, settleMs, readyTimeoutMs });
	props.current = { navigator, isReady, onEnd, measure, scrollTo, settleMs, readyTimeoutMs };

	/** Vai até a tela; devolve a partir de qual montagem a tela do passo conta como nova. */
	const goTo = async (target: TrailLocation): Promise<number> => {
		const { actions, stack: next } = navigateTrail(stack.current, target);
		stack.current = next;
		// Abrindo uma tela por cima, só vale a tela nova: a de mesmo tipo que saiu ainda pode
		// estar se anunciando.
		const last = actions[actions.length - 1];
		const minInstance = last?.type === 'push' ? nextScreenInstance() : 0;
		for (const action of actions) await props.current.navigator.run(action);
		return minInstance;
	};

	const finish = () => {
		if (endingRef.current) return;
		endingRef.current = true;
		setEnding(true);
		setShown(null);
		(async () => {
			await goTo(origin);
			props.current.onEnd();
		})();
	};
	const finishRef = useRef(finish);
	finishRef.current = finish;

	const move = (from: number, step: 1 | -1) => {
		direction.current = step;
		const next = from + step;
		if (next >= plan.length) finish();
		else if (next < 0) {
			direction.current = 1;
			setIndex(from + 1);
		} else setIndex(next);
	};

	// O voltar do Android é "Pular". Inscrito de novo a cada passo, para valer antes do voltar
	// das telas que a trilha abriu.
	// biome-ignore lint/correctness/useExhaustiveDependencies: inscreve de novo a cada passo mostrado
	useEffect(() => {
		const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
			finishRef.current();
			return true;
		});
		return () => subscription.remove();
	}, [shown?.index]);

	const measureLayer = (): Promise<Rect | null> => {
		const node = rootRef.current as unknown as MeasurableLayer | null;
		const measureInWindow = node?.measureInWindow;
		if (!node || typeof measureInWindow !== 'function') return Promise.resolve(null);
		return new Promise((resolve) => {
			const timer = setTimeout(() => resolve(null), LAYER_TIMEOUT_MS);
			measureInWindow.call(node, (x, y, width, height) => {
				clearTimeout(timer);
				resolve({ x, y, width, height });
			});
		});
	};

	/**
	 * Antes do primeiro balão: os outros passos que podem ser pulados e estão na tela onde a
	 * trilha abre (a "Este mês" inteira fica na tela inicial) são decididos agora, pelos alvos
	 * que existem; e o que seria pulado porque ir até a tela dele perderia o que foi digitado
	 * (`dropsOrigin`) também sai agora. Assim o primeiro total já é o certo.
	 */
	const decideSkips = async (here: TrailLocation, current: number) => {
		const { measure: measureOne } = props.current;
		for (const [item, other] of plan.entries()) {
			if (item === current || other.missing !== 'skip' || skipped.current.has(item)) continue;
			if (dropsOrigin([origin], other.location)) {
				skipped.current.add(item);
				continue;
			}
			if (other.textOnly || !sameLocation(other.location, here)) continue;
			const ids = [...new Set(other.targets.flat())];
			const rects = Object.fromEntries(
				await Promise.all(ids.map(async (id) => [id, await measureOne(id)] as const))
			);
			if (resolveTrailStep(other, rects).kind === 'skip') skipped.current.add(item);
		}
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: anda só quando o passo muda
	useEffect(() => {
		const step = plan[index];
		if (!step) {
			finish();
			return;
		}
		// Já decidido que sai (voltando, ou adiante): segue sem abrir a tela dele.
		if (skipped.current.has(index)) {
			setShown(null);
			move(index, direction.current);
			return;
		}
		let alive = true;
		setShown(null);
		(async () => {
			const {
				isReady: ready,
				measure: measureOne,
				scrollTo: scroll,
				settleMs: settle,
				readyTimeoutMs: timeout,
			} = props.current;
			// Sair da tela de origem perderia o que o usuário digitou nela: o passo fica aqui, sem
			// apontar (o `[sem dado]` dele).
			const stay = dropsOrigin(stack.current, step.location);
			const at = stay ? stack.current[stack.current.length - 1] : step.location;
			const minInstance = stay ? 0 : await goTo(step.location);
			// Encerrada no meio do caminho (o voltar do Android): quem volta é o `finish`.
			const stopped = () => !alive || endingRef.current;
			const place = TRAIL_SCREENS[at.screen].report;
			const started = Date.now();
			while (!ready(place, minInstance) && Date.now() - started < timeout) {
				await wait(POLL_MS);
				if (stopped()) return;
			}
			if (stopped()) return;
			Keyboard.dismiss();
			await wait(settle);
			if (stopped()) return;

			const measuredLayer = await measureLayer();
			const frame: Rect = hasSize(measuredLayer)
				? measuredLayer
				: { x: 0, y: 0, width: window.width, height: window.height };
			const ids = [...new Set(step.targets.flat())];
			const measureAll = async () =>
				Object.fromEntries(
					await Promise.all(
						ids.map(async (id) => {
							const rect = await measureOne(id);
							return [id, hasSize(rect) ? toOverlayRect(rect, frame) : null] as const;
						})
					)
				);

			let rects = step.textOnly || stay ? {} : await measureAll();
			let resolved = resolveTrailStep(step, rects);
			if (resolved.kind === 'point' && !step.fixed) {
				const viewport = { top: insets.top, bottom: frame.height - insets.bottom - BOTTOM_BARS };
				const area = unionRect(resolved.ids.map((id) => rects[id] as Rect));
				if (
					needsScroll(area, viewport) &&
					(await scroll(place, resolved.ids[0], Math.round(frame.height * 0.25)))
				) {
					await wait(settle);
					rects = await measureAll();
					resolved = resolveTrailStep(step, rects);
				}
			}
			if (stopped()) return;

			let rect: Rect | null = null;
			if (resolved.kind === 'point') {
				const area = unionRect(resolved.ids.map((id) => rects[id] as Rect));
				// Fora da tela mesmo depois de rolar: segue o `[sem dado]`, como alvo que não existe.
				if (isOnScreen(area, { top: 0, bottom: frame.height })) rect = area;
				else resolved = resolveTrailStep(step, {});
			}
			if (resolved.kind === 'skip') {
				if (!counted.current) {
					skipped.current.add(index);
					move(index, direction.current);
					return;
				}
				// O total já está na tela: o passo fica, com o texto sem apontar.
				resolved = { kind: 'text', bodyKey: step.altBodyKey ?? step.bodyKey };
			}
			if (!counted.current) {
				await decideSkips(at, index);
				if (stopped()) return;
				counted.current = true;
			}
			setShown({ index, rect, bodyKey: resolved.bodyKey, layer: frame });
		})();
		return () => {
			alive = false;
		};
	}, [index]);

	const step = plan[index];
	const skippedBefore = [...skipped.current].filter((item) => item < index).length;
	const total = plan.length - skipped.current.size;
	const current = index + 1 - skippedBefore;
	// O último que sobra, mesmo que os de depois dele no plano tenham saído.
	const isLast = current === total;

	// A cada passo mostrado, o leitor de tela ouve o passo inteiro.
	// biome-ignore lint/correctness/useExhaustiveDependencies: anuncia só quando aparece um passo novo
	useEffect(() => {
		if (!shown || !step) return;
		const attention = step.attention ? `${t('trails.attention')}. ` : '';
		AccessibilityInfo.announceForAccessibility(
			`${t('tutorial.counterLabel', { current, total })}. ${attention}${t(step.titleKey)}. ${t(shown.bodyKey)}`
		);
	}, [shown]);

	if (ending || hidden) return null;

	const layer = shown?.layer;
	const layout =
		shown?.rect && layer
			? layoutTour({
					target: shown.rect,
					window: { width: layer.width, height: layer.height },
					insets: { top: insets.top, bottom: insets.bottom },
					bubbleHeight,
				})
			: null;
	const hole = layout?.hole;
	const accent = step?.attention ? ATTENTION : ACCENT;

	let bubblePosition: { top: number; left: number; width: number } | null = null;
	if (shown && layer) {
		if (layout) bubblePosition = layout.bubble;
		else {
			const width = Math.min(layer.width - 32, 480);
			bubblePosition = {
				top: Math.max(insets.top + 16, Math.round((layer.height - bubbleHeight) / 2)),
				left: Math.round((layer.width - width) / 2),
				width,
			};
		}
	}

	return (
		<View
			ref={rootRef}
			testID="trail-layer"
			collapsable={false}
			style={[StyleSheet.absoluteFill, styles.layer]}
			accessibilityViewIsModal
			// Pega o toque que cai fora do balão, inclusive no buraco: não chega à tela de trás.
			onStartShouldSetResponder={() => true}
		>
			{hole ? (
				<>
					<View
						importantForAccessibility="no-hide-descendants"
						style={[styles.shade, { top: 0, left: 0, right: 0, height: hole.y }]}
					/>
					<View
						importantForAccessibility="no-hide-descendants"
						style={[styles.shade, { top: hole.y + hole.height, left: 0, right: 0, bottom: 0 }]}
					/>
					<View
						importantForAccessibility="no-hide-descendants"
						style={[styles.shade, { top: hole.y, height: hole.height, left: 0, width: hole.x }]}
					/>
					<View
						importantForAccessibility="no-hide-descendants"
						style={[
							styles.shade,
							{ top: hole.y, height: hole.height, left: hole.x + hole.width, right: 0 },
						]}
					/>
					<View
						testID="trail-outline"
						importantForAccessibility="no-hide-descendants"
						pointerEvents="none"
						style={[
							styles.outline,
							{
								borderColor: accent,
								top: hole.y,
								left: hole.x,
								width: hole.width,
								height: hole.height,
							},
						]}
					/>
				</>
			) : (
				<View
					importantForAccessibility="no-hide-descendants"
					style={[StyleSheet.absoluteFill, styles.shadeFill]}
				/>
			)}
			{shown && step && bubblePosition ? (
				<View
					testID="trail-bubble"
					style={[
						styles.bubble,
						{ borderColor: step.attention ? ATTENTION : styles.bubble.borderColor },
						bubblePosition,
					]}
					onLayout={(event) => {
						const height = Math.round(event.nativeEvent.layout.height);
						if (Math.abs(height - bubbleHeight) > 1) setBubbleHeight(height);
					}}
				>
					<View style={styles.header}>
						<Text
							style={styles.counter}
							accessibilityLabel={t('tutorial.counterLabel', { current, total })}
						>
							{t('tutorial.counter', { current, total })}
						</Text>
						{step.attention ? (
							<View style={styles.attentionTag}>
								<Text style={styles.attentionText}>{t('trails.attention')}</Text>
							</View>
						) : null}
					</View>
					<Text style={styles.title} accessibilityRole="header">
						{t(step.titleKey)}
					</Text>
					<Text style={styles.body}>{t(shown.bodyKey)}</Text>
					<View style={styles.buttons}>
						{current > 1 ? (
							<Pressable
								onPress={() => move(index, -1)}
								accessibilityRole="button"
								accessibilityLabel={t('trails.back')}
								accessibilityHint={t('trails.backHint')}
								style={({ pressed }) => [styles.button, pressed && styles.pressed]}
							>
								<Text style={styles.secondaryText}>{t('trails.back')}</Text>
							</Pressable>
						) : null}
						{isLast ? null : (
							<Pressable
								onPress={finish}
								accessibilityRole="button"
								accessibilityLabel={t('tutorial.skip')}
								accessibilityHint={t('trails.skipHint')}
								style={({ pressed }) => [styles.button, pressed && styles.pressed]}
							>
								<Text style={styles.secondaryText}>{t('tutorial.skip')}</Text>
							</Pressable>
						)}
						<Pressable
							onPress={() => move(index, 1)}
							accessibilityRole="button"
							accessibilityLabel={isLast ? t('tutorial.done') : t('tutorial.next')}
							style={({ pressed }) => [styles.button, styles.primary, pressed && styles.pressed]}
						>
							<Text style={styles.primaryText}>
								{isLast ? t('tutorial.done') : t('tutorial.next')}
							</Text>
						</Pressable>
					</View>
				</View>
			) : null}
		</View>
	);
};

const styles = StyleSheet.create({
	// Por cima da pilha de telas e da barra de abas, como o guia do SPD-129.
	layer: {
		zIndex: 1000,
	},
	shade: {
		position: 'absolute',
		backgroundColor: SHADE,
	},
	shadeFill: {
		backgroundColor: SHADE,
	},
	outline: {
		position: 'absolute',
		borderWidth: 2,
		borderRadius: 14,
	},
	bubble: {
		position: 'absolute',
		backgroundColor: '#1E1E1E',
		borderRadius: 16,
		padding: 16,
		gap: 6,
		borderWidth: 1,
		borderColor: 'rgba(21,232,254,0.4)',
	},
	header: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 8,
	},
	counter: {
		fontSize: 13,
		fontWeight: '600',
		color: ACCENT,
	},
	attentionTag: {
		borderRadius: 8,
		paddingHorizontal: 8,
		paddingVertical: 2,
		backgroundColor: 'rgba(255,176,32,0.18)',
	},
	attentionText: {
		fontSize: 13,
		fontWeight: '700',
		color: ATTENTION,
	},
	title: {
		fontSize: 18,
		fontWeight: '700',
		color: '#FFFFFF',
	},
	body: {
		fontSize: 15,
		lineHeight: 21,
		color: 'rgba(255,255,255,0.85)',
	},
	buttons: {
		flexDirection: 'row',
		justifyContent: 'flex-end',
		flexWrap: 'wrap',
		gap: 8,
		marginTop: 8,
	},
	button: {
		minHeight: 48,
		minWidth: 64,
		paddingHorizontal: 16,
		borderRadius: 12,
		alignItems: 'center',
		justifyContent: 'center',
	},
	primary: {
		backgroundColor: ACCENT,
	},
	pressed: {
		opacity: 0.7,
	},
	secondaryText: {
		fontSize: 16,
		fontWeight: '600',
		color: 'rgba(255,255,255,0.85)',
	},
	primaryText: {
		fontSize: 16,
		fontWeight: '700',
		color: '#000000',
	},
});

export default TrailOverlay;
