import type React from 'react';
import MiraiActivationSheet from './MiraiActivationSheet';
import MiraiButton from './MiraiButton';
import MiraiChatSheet from './MiraiChatSheet';

/**
 * O Mirai por cima da pilha (SPD-163): o botão flutuante, a tela de ativação e a conversa. O
 * `_layout` raiz monta uma vez, dentro do `MiraiProvider` e do guia na tela.
 */
const MiraiLayer: React.FC<{ locked?: boolean }> = ({ locked = false }) => (
	<>
		<MiraiButton locked={locked} />
		<MiraiActivationSheet />
		<MiraiChatSheet />
	</>
);

export default MiraiLayer;
