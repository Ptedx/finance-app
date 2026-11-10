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
	type PlannedStep,
	type Rect,
	type TourScreen,
	toOverlayRect,
} from '../../utils/tour';
import { measureTarget, scrollToTarget } from './registry';

/**
 * O guia na tela (SPD-129): o resto escurece, o elemento de verdade fica num buraco com
 * contorno e um balão diz o que ele faz, com "2 de 6", "Pular" e "Próximo" ("Entendi" no
 * último).
 *
 * O escurecido são quatro retângulos em volta do alvo, numa camada por cima da pilha de
 * telas, na mesma janela delas. Não é um `Modal`: o `Modal` do Android é outra janela, que
 * começa no topo da tela, enquanto a medida dos alvos pode começar abaixo da barra de status
 * — no aparelho, o destaque saía uma barra de status acima do alvo. Aqui, a camada mede a
 * própria origem na janela (`measureInWindow`) e cada alvo é desenhado em relação a ela
 * (`toOverlayRect`): as duas medidas têm a mesma referência, com ou sem barras translúcidas,
 * no Android e no iOS. O tamanho da camada (não o da janela) é a tela para o balão e para a
 * rolagem.
 *
 * A camada pega todo toque, inclusive no buraco: tocar fora do balão não faz nada, de
 * propósito. Avançar no toque faria pular passo com um esbarrão, e tocar no botão destacado
 * abriria outra tela no meio do guia; o guia só anda pelos botões do balão. O voltar do
 * Android é "Pular".
 *
 * A cada passo: fecha o teclado (o "+" abre com ele), espera a tela assentar, mede a camada e
 * o alvo e, se ele está fora da faixa visível, rola até ele e mede de novo. Alvo que sumiu ou
 * ficou fora da tela tem o passo pulado. Girar a tela ou mudar o tamanho mede de novo.
 *
 * Leitor de tela: a camada é modal para ele (no iOS por `accessibilityViewIsModal`; no
 * Android o provider esconde a pilha de telas enquanto o guia está aberto); a cada passo o
 * app anuncia "2 de 6", o título e o texto, e os botões têm rótulo.
 */

export type TourFinishReason = 'done' | 'skip';

interface TourOverlayProps {
	screen: TourScreen;
	steps: PlannedStep[];
	/** `shown`: quantos passos chegaram a aparecer. */
	onFinish: (shown: number, reason: TourFinishReason) => void;
	/** Para os testes: como medir e rolar, e quanto esperar a tela assentar. */
	measure?: (id: string) => Promise<Rect | null>;
	scrollTo?: (screen: TourScreen, id: string, offset: number) => Promise<boolean>;
	/** Para os testes: onde a camada do guia está na janela (por padrão, `measureInWindow`). */
	measureLayer?: () => Promise<Rect | null>;
	settleMs?: number;
}

const ACCENT = '#15E8FE';
const SHADE = 'rgba(0,0,0,0.78)';
/** Antes de medir o balão, uma altura que cabe o texto mais comum. */
const BUBBLE_ESTIMATE = 190;
/** O que fica embaixo da tela e esconde conteúdo (a barra de abas, botões fixos). */
const BOTTOM_BARS = 80;
/** Sem resposta da medida da camada em tanto tempo, desenha como se ela começasse na janela. */
const LAYER_TIMEOUT_MS = 500;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface MeasurableLayer {
	measureInWindow?: (
		callback: (x: number, y: number, width: number, height: number) => void
	) => void;
}

const TourOverlay: React.FC<TourOverlayProps> = ({
	screen,
	steps,
	onFinish,
	measure = measureTarget,
	scrollTo = scrollToTarget,
	measureLayer,
	settleMs = 300,
}) => {
	const { t } = useTranslation();
	const insets = useSafeAreaInsets();
	const window = useWindowDimensions();
	const [index, setIndex] = useState(0);
	const [rect, setRect] = useState<Rect | null>(null);
	const [layer, setLayer] = useState<Rect | null>(null);
	const [bubbleHeight, setBubbleHeight] = useState(BUBBLE_ESTIMATE);
	const rootRef = useRef<View>(null);
	const shown = useRef(new Set<number>());
	const finished = useRef(false);

	const finish = (reason: TourFinishReason) => {
		if (finished.current) return;
		finished.current = true;
		onFinish(shown.current.size, reason);
	};
	const finishRef = useRef(finish);
	finishRef.current = finish;

	const advance = () => {
		if (index + 1 < steps.length) setIndex(index + 1);
		else finish('done');
	};

	const step = steps[index];
	const total = steps.length;
	const isLast = index === total - 1;

	// O voltar do Android é "Pular" (e não deixa a tela de trás voltar no meio do guia).
	useEffect(() => {
		const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
			finishRef.current('skip');
			return true;
		});
		return () => subscription.remove();
	}, []);

	// Onde a camada está na janela, na mesma referência das medidas dos alvos. Sem medida (a
	// camada ainda não desenhou, ou não respondeu), a camada é a janela.
	const measureOwnLayer = (): Promise<Rect | null> => {
		if (measureLayer) return measureLayer();
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

	// biome-ignore lint/correctness/useExhaustiveDependencies: mede de novo só quando o passo ou o tamanho da tela muda
	useEffect(() => {
		if (!step) {
			finish('done');
			return;
		}
		let alive = true;
		setRect(null);
		Keyboard.dismiss();
		(async () => {
			await wait(settleMs);
			const measuredLayer = await measureOwnLayer();
			const frame: Rect = hasSize(measuredLayer)
				? measuredLayer
				: { x: 0, y: 0, width: window.width, height: window.height };
			const inLayer = async (): Promise<Rect | null> => {
				const measured = await measure(step.target);
				return hasSize(measured) ? toOverlayRect(measured, frame) : null;
			};

			let target = await inLayer();
			const viewport = { top: insets.top, bottom: frame.height - insets.bottom - BOTTOM_BARS };
			if (!step.fixed && hasSize(target) && needsScroll(target, viewport)) {
				if (await scrollTo(screen, step.target, Math.round(frame.height * 0.25))) {
					await wait(settleMs);
					target = await inLayer();
				}
			}
			if (!alive) return;
			if (!hasSize(target) || !isOnScreen(target, { top: 0, bottom: frame.height })) {
				advance();
				return;
			}
			shown.current.add(index);
			setLayer(frame);
			setRect(target);
			AccessibilityInfo.announceForAccessibility(
				`${t('tutorial.counterLabel', { current: index + 1, total })}. ${t(step.titleKey)}. ${t(step.bodyKey)}`
			);
		})();
		return () => {
			alive = false;
		};
	}, [index, step, window.width, window.height]);

	const layout =
		rect && layer
			? layoutTour({
					target: rect,
					window: { width: layer.width, height: layer.height },
					insets: { top: insets.top, bottom: insets.bottom },
					bubbleHeight,
				})
			: null;
	const hole = layout?.hole;

	return (
		<View
			ref={rootRef}
			collapsable={false}
			style={[StyleSheet.absoluteFill, styles.layer]}
			accessibilityViewIsModal
			// Pega o toque que cai fora do balão, inclusive no buraco: não chega à tela de trás.
			onStartShouldSetResponder={() => true}
		>
			{hole && layout ? (
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
						testID="tour-outline"
						importantForAccessibility="no-hide-descendants"
						pointerEvents="none"
						style={[
							styles.outline,
							{ top: hole.y, left: hole.x, width: hole.width, height: hole.height },
						]}
					/>
					<View
						testID="tour-bubble"
						style={[
							styles.bubble,
							{ top: layout.bubble.top, left: layout.bubble.left, width: layout.bubble.width },
						]}
						onLayout={(event) => {
							const height = Math.round(event.nativeEvent.layout.height);
							if (Math.abs(height - bubbleHeight) > 1) setBubbleHeight(height);
						}}
					>
						<Text
							style={styles.counter}
							accessibilityLabel={t('tutorial.counterLabel', { current: index + 1, total })}
						>
							{t('tutorial.counter', { current: index + 1, total })}
						</Text>
						<Text style={styles.title} accessibilityRole="header">
							{t(step.titleKey)}
						</Text>
						<Text style={styles.body}>{t(step.bodyKey)}</Text>
						<View style={styles.buttons}>
							{isLast ? null : (
								<Pressable
									onPress={() => finish('skip')}
									accessibilityRole="button"
									accessibilityLabel={t('tutorial.skip')}
									accessibilityHint={t('tutorial.skipHint')}
									style={({ pressed }) => [styles.button, pressed && styles.pressed]}
								>
									<Text style={styles.skipText}>{t('tutorial.skip')}</Text>
								</Pressable>
							)}
							<Pressable
								onPress={advance}
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
				</>
			) : (
				<View
					importantForAccessibility="no-hide-descendants"
					style={[StyleSheet.absoluteFill, styles.shadeFill]}
				/>
			)}
		</View>
	);
};

const styles = StyleSheet.create({
	// Por cima da pilha de telas e da barra de abas, como a trava por biometria.
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
		borderColor: ACCENT,
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
	counter: {
		fontSize: 13,
		fontWeight: '600',
		color: ACCENT,
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
	skipText: {
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

export default TourOverlay;
