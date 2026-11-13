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
			/**
			 * `refusal` e `incomplete` têm texto próprio na tela quando a resposta veio vazia; `cut` saiu
			 * cortada pelo teto de saída e leva um aviso no fim (SPD-169).
			 */
			kind: 'answer' | 'refusal' | 'incomplete' | 'cut';
			text: string;
			expression: MiraiExpression;
	  }
	/** A pergunta que falhou vai junto, para o "Tentar de novo" (SPD-172). */
	| { id: string; role: 'error'; failure: MiraiFailure; question?: string };

/**
 * O tamanho da conversa (SPD-171): ela não é cortada (o histórico mudaria e o cache e o
 * raciocínio das respostas anteriores se perderiam). `long` sugere começar outra; `full` exige.
 */
export type MiraiConversationSize = 'ok' | 'long' | 'full';

/** As perguntas da conversa a partir das quais ela é `long` e `full`. */
export const MIRAI_LONG_CONVERSATION = 10;
export const MIRAI_FULL_CONVERSATION = 20;

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
	/** "Nova conversa": apaga a conversa (e abandona a pergunta em andamento). */
	clear: () => void;
	/** Fecha a folha. A conversa continua até o app fechar ou a conta mudar (SPD-171). */
	close: () => void;
	/** "Parar": abandona a pergunta em andamento e devolve o texto ao campo (SPD-172). */
	stop: () => void;
	/** "Tentar de novo" numa linha de erro: manda a mesma pergunta (SPD-172). */
	retry: (entryId: string) => void;
	conversationSize: MiraiConversationSize;
	/** Perguntas que restam hoje, do último status ou resposta; nulo antes de saber (SPD-174). */
	remainingToday: number | null;
	/** A tela de onde a conversa foi aberta pela última vez, para as sugestões (SPD-173). */
	screen: string | null;
	/**
	 * Como a pessoa quer ser chamada (SPD-163e). `nameAsked` falso: o app ainda não perguntou;
	 * nulo: ainda lendo do aparelho.
	 */
	name: string | null;
	nameAsked: boolean | null;
	/** O primeiro nome da conta, sugerido na pergunta. */
	suggestedName: string;
	/** Grava o apelido; nulo é "Agora não" ou tirar o nome. */
	saveName: (name: string | null) => void;
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
