import type { Rect } from '../../utils/tour';
import type { TourPlace } from '../../utils/trails';

/**
 * Onde o guia acha os elementos que aponta (SPD-129).
 *
 * Cada alvo se registra pelo nome (`home.add`, `card.pay`) quando monta e sai quando desmonta;
 * cada tela com rolagem registra a sua `ScrollView`. Fica fora do React de propósito: as
 * telas só marcam os alvos, sem provider nenhum em volta, e quem mede é o guia, na hora de
 * mostrar o passo.
 *
 * Um nome pode estar montado duas vezes (o formulário do "+" e o da edição, um por cima do
 * outro): vale o último a montar, e quando ele sai volta a valer o de baixo.
 */

/** O que o guia precisa de um elemento nativo: medir na janela e em relação a outro. */
export interface Measurable {
	measureInWindow: (
		callback: (x: number, y: number, width: number, height: number) => void
	) => void;
	measureLayout?: (
		relativeTo: never,
		onSuccess: (x: number, y: number, width: number, height: number) => void,
		onFail?: () => void
	) => void;
}

/** O que o guia precisa de uma `ScrollView`. */
export interface Scrollable {
	scrollTo: (options: { x?: number; y?: number; animated?: boolean }) => void;
	getInnerViewRef?: () => unknown;
	getInnerViewNode?: () => unknown;
}

const targets = new Map<string, Measurable[]>();
const scrolls = new Map<TourPlace, Scrollable[]>();

const push = <K, V>(map: Map<K, V[]>, key: K, value: V): (() => void) => {
	map.set(key, [...(map.get(key) ?? []), value]);
	return () => {
		const left = (map.get(key) ?? []).filter((item) => item !== value);
		if (left.length > 0) map.set(key, left);
		else map.delete(key);
	};
};

const last = <K, V>(map: Map<K, V[]>, key: K): V | undefined => {
	const list = map.get(key);
	return list ? list[list.length - 1] : undefined;
};

/** Registra um alvo; devolve quem o tira. */
export const registerTarget = (id: string, node: Measurable): (() => void) =>
	push(targets, id, node);

/** Registra a rolagem de uma tela; devolve quem a tira. */
export const registerScroll = (screen: TourPlace, node: Scrollable): (() => void) =>
	push(scrolls, screen, node);

export const hasTarget = (id: string): boolean => last(targets, id) !== undefined;

/**
 * Quanto esperar a medida. Um elemento que saiu da tela no meio do caminho pode nunca
 * responder; o guia não pode ficar parado esperando.
 */
const MEASURE_TIMEOUT_MS = 500;

/** A posição do alvo na janela, ou `null` se ele não está montado ou não respondeu. */
export const measureTarget = (id: string): Promise<Rect | null> => {
	const node = last(targets, id);
	if (!node || typeof node.measureInWindow !== 'function') return Promise.resolve(null);
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(null), MEASURE_TIMEOUT_MS);
		try {
			node.measureInWindow((x, y, width, height) => {
				clearTimeout(timer);
				resolve(Number.isFinite(x) && Number.isFinite(y) ? { x, y, width, height } : null);
			});
		} catch {
			clearTimeout(timer);
			resolve(null);
		}
	});
};

/**
 * Rola a tela até o alvo, deixando-o a `offset` do topo da rolagem. `false` quando a tela
 * não tem rolagem registrada ou o alvo não está dentro dela (a barra de abas): aí o passo
 * mostra o alvo onde ele está, ou é pulado se estiver fora da tela.
 */
export const scrollToTarget = (screen: TourPlace, id: string, offset: number): Promise<boolean> => {
	const scroll = last(scrolls, screen);
	const node = last(targets, id);
	if (!scroll || !node || typeof node.measureLayout !== 'function') return Promise.resolve(false);
	const inner = scroll.getInnerViewRef?.() ?? scroll.getInnerViewNode?.();
	if (!inner) return Promise.resolve(false);
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(false), MEASURE_TIMEOUT_MS);
		try {
			node.measureLayout?.(
				inner as never,
				(_x, y) => {
					clearTimeout(timer);
					scroll.scrollTo({ y: Math.max(0, y - offset), animated: false });
					resolve(true);
				},
				() => {
					clearTimeout(timer);
					resolve(false);
				}
			);
		} catch {
			clearTimeout(timer);
			resolve(false);
		}
	});
};

/** Para os testes: esquece todos os alvos e rolagens. */
export const clearTourRegistry = (): void => {
	targets.clear();
	scrolls.clear();
};
