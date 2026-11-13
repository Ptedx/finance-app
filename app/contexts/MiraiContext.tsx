import { createContext, useContext } from 'react';
import type { MiraiExpression, MiraiToolName } from '../utils/mirai/contract';
import type { MiraiFailure } from '../utils/mirai/loop';
import type { MiraiChoice } from '../utils/mirai/preferences';

/**
 * O que as telas usam do Mirai (SPD-163c). Este arquivo não carrega nada pesado (só tipos e o
 * contexto): o `MiraiProvider`, que fala com o servidor e com o armazenamento, só o `_layout`
 * raiz importa. Sem o provider (nos testes das telas), `useMirai` devolve nulo.
 */

/** Uma linha da conversa, como a tela mostra. O histórico no formato da API fica à parte. */
export type MiraiEntry =
	| { id: string; role: 'user'; text: string }
	| {
			id: string;
			role: 'mirai';
			/** `refusal` e `incomplete` têm texto próprio na tela quando a resposta veio vazia. */
			kind: 'answer' | 'refusal' | 'incomplete';
			text: string;
			expression: MiraiExpression;
	  }
	| { id: string; role: 'error'; failure: MiraiFailure };

export type MiraiSheet = 'none' | 'activation' | 'chat';

export interface MiraiContextValue {
	/** O servidor ligou o Mirai para esta conta (`GET /status`), ou foi o último que disse, sem rede. */
	enabled: boolean;
	choice: MiraiChoice | null;
	sheet: MiraiSheet;
	entries: MiraiEntry[];
	busy: boolean;
	/** A ferramenta rodando agora, para o "consultando…". */
	currentTool: MiraiToolName | null;
	draft: string;
	setDraft: (text: string) => void;
	/** O dia (`YYYY-MM-DD`) em que a reserva ficou completa pela última vez. */
	goalDay: string | null;
	/** O toque no botão: sem a ativação, abre a tela de ativação; com ela, a conversa. */
	openFromButton: (screen: string | null) => void;
	activate: () => void;
	decline: () => void;
	/** A chave de Configurações. Ligar passa pela tela de ativação. */
	setTurnedOn: (on: boolean) => void;
	ask: (text?: string) => Promise<void>;
	clear: () => void;
	close: () => void;
	/** As telas que calculam a reserva avisam se ela está completa (o dia da meta). */
	noteReserveReady: (ready: boolean) => void;
}

export const MiraiContext = createContext<MiraiContextValue | null>(null);

/** O Mirai, ou nulo fora do provider (as telas nos testes, que não o montam). */
export const useMirai = (): MiraiContextValue | null => useContext(MiraiContext);

/**
 * Todo arquivo sob app/ é tratado como rota pelo expo-router, e uma rota sem export
 * default é um módulo quebrado do ponto de vista dele. Este export existe só para
 * satisfazer essa exigência — nada navega para cá.
 */
export default MiraiContext;
