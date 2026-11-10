import { NavigationContext } from '@react-navigation/native';
import type React from 'react';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { type StyleProp, View, type ViewStyle } from 'react-native';
import type { TopicId, TourOrigin, TourScreen } from '../../utils/tour';
import { type Measurable, registerScroll, registerTarget, type Scrollable } from './registry';

/**
 * O que as telas usam do guia (SPD-129): marcar alvos, dizer se a tela está pronta e pedir o
 * guia pelo "?". Este arquivo não lê o armazenamento nem desenha o guia — isso é do
 * `TourProvider`, que só o `_layout` raiz importa. Sem o provider (nos testes das telas), tudo
 * aqui vira nada: os alvos se registram e ninguém os mede.
 */

/** O que cada tela diz de si: em foco, carregada e sem folha ou seletor aberto por cima. */
export interface ScreenReport {
	focused: boolean;
	ready: boolean;
	blocked: boolean;
}

export interface TourContextValue {
	report: (screen: TourScreen, state: ScreenReport) => void;
	/** Pede o guia de uma tela: abre quando ela estiver em foco e pronta. */
	startTour: (
		screen: TourScreen,
		options?: { only?: readonly string[]; origin?: TourOrigin }
	) => void;
	/** Abre Ajustes › Como usar neste tópico. */
	openTopic: (topic: TopicId) => void;
	/** O aviso "Novo: Como usar o Spendr" está valendo. */
	noticeVisible: boolean;
	answerNotice: (answer: 'see' | 'later') => void;
}

export const TourContext = createContext<TourContextValue | null>(null);

export const useTour = (): TourContextValue | null => useContext(TourContext);

/**
 * A tela com guia se anuncia: o guia abre sozinho na primeira visita (ou quando foi pedido)
 * só com a tela em foco, carregada (`ready`) e sem folha aberta (`blocked`).
 *
 * O foco vem do navegador da tela, lido do contexto sem exigir um: fora de um navegador (num
 * teste) a tela conta como em foco.
 */
export const useScreenTour = (
	screen: TourScreen,
	{ ready = true, blocked = false }: { ready?: boolean; blocked?: boolean } = {}
): void => {
	const tour = useTour();
	const navigation = useContext(NavigationContext);
	const [focused, setFocused] = useState(() => navigation?.isFocused?.() ?? true);

	useEffect(() => {
		if (!navigation) return;
		setFocused(navigation.isFocused());
		const offFocus = navigation.addListener('focus', () => setFocused(true));
		const offBlur = navigation.addListener('blur', () => setFocused(false));
		return () => {
			offFocus();
			offBlur();
		};
	}, [navigation]);

	useEffect(() => {
		tour?.report(screen, { focused, ready, blocked });
	}, [tour, screen, focused, ready, blocked]);

	useEffect(
		() => () => tour?.report(screen, { focused: false, ready: false, blocked: false }),
		[tour, screen]
	);
};

/**
 * Marca um elemento como alvo de um passo: espalhe o retorno no elemento (`<View {...alvo}>`,
 * `<Pressable {...alvo}>`). O `collapsable={false}` impede o Android de achatar a view —
 * view achatada não tem como ser medida. Sem `id`, não marca nada.
 */
export const useTourTarget = (id: string | undefined) => {
	const ref = useCallback(
		(node: unknown) => {
			if (!id || !node) return;
			return registerTarget(id, node as Measurable);
		},
		[id]
	);
	return { ref, collapsable: false as const };
};

/**
 * Um alvo em volta de um componente que não repassa `ref` (os cartões da tela inicial, o
 * patrimônio). É uma `View` comum: na coluna da tela não muda nada do desenho. Componente
 * que não desenha nada fica com tamanho zero, e o passo dele é pulado.
 */
export const TourTarget: React.FC<{
	id: string | undefined;
	style?: StyleProp<ViewStyle>;
	children: React.ReactNode;
}> = ({ id, style, children }) => {
	const target = useTourTarget(id);
	return (
		<View {...target} style={style}>
			{children}
		</View>
	);
};

/**
 * A rolagem da tela, para o guia levar até um alvo que está mais abaixo. Devolve o `ref` da
 * `ScrollView`; com `external`, também mantém esse ref (o formulário já tinha o dele).
 */
export const useTourScroll = <T extends Scrollable>(
	screen: TourScreen,
	external?: { current: T | null }
) =>
	useCallback(
		(node: T | null) => {
			if (external) external.current = node;
			if (!node) return;
			const off = registerScroll(screen, node);
			return () => {
				off();
				if (external && external.current === node) external.current = null;
			};
		},
		[screen, external]
	);
