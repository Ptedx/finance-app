/**
 * O aviso de "chegaram preferências pelo sync", para as telas vivas aplicarem sem reiniciar
 * o app (`CurrencyContext`, `LanguageContext`).
 *
 * Num módulo próprio, sem importar nada, pelo mesmo motivo de `utils/billEvents.ts`: o
 * motor do sync avisa daqui, e puxar junto o AsyncStorage (via `sync/preferences.ts`) só
 * para avisar faria todo teste do motor precisar dele.
 */

type PreferencesListener = (keys: string[]) => void;

const listeners = new Set<PreferencesListener>();

/**
 * Escuta as preferências que chegaram pelo sync. Devolve o cancelamento.
 *
 * Quem escuta relê o AsyncStorage (o pull já gravou lá) e aplica; aplicar o que veio da
 * conta não é uma escolha nova, então não grava nada nem pede sync.
 */
export const onPreferencesChanged = (listener: PreferencesListener): (() => void) => {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};

/** Avisa quem escuta. Um ouvinte que falha não impede os outros de ouvir. */
export const emitPreferencesChanged = (keys: string[]): void => {
	if (keys.length === 0) return;
	for (const listener of listeners) {
		try {
			listener(keys);
		} catch (error) {
			console.warn('Preferências: um ouvinte falhou ao aplicar o que veio do sync:', error);
		}
	}
};

/**
 * Todo arquivo sob app/ é tratado como rota pelo expo-router, e uma rota sem export
 * default é um módulo quebrado do ponto de vista dele. Este export existe só para
 * satisfazer essa exigência — nada navega para cá.
 */
export default { onPreferencesChanged, emitPreferencesChanged };
