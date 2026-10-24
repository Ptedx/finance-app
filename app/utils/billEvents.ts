/**
 * Aviso de "as contas a pagar mudaram", para quem mostra ou agenda a partir delas.
 *
 * Quem grava (a tela, a baixa automática, o pagamento de parcela) chama `emitBillsChanged`
 * depois de gravar; quem lê (o BillsContext) assina com `onBillsChanged` e recarrega. Assim
 * a baixa feita por uma notificação aparece na Home sem trocar de tela.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

/** Assina o aviso. Devolve a função que cancela a assinatura. */
export const onBillsChanged = (listener: Listener): (() => void) => {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};

/** Avisa todos os assinantes. Um assinante que falha não impede os outros. */
export const emitBillsChanged = (): void => {
	for (const listener of listeners) {
		try {
			listener();
		} catch (error) {
			console.error('Error notifying bills change:', error);
		}
	}
};
