/**
 * Os eventos mínimos do diário (SPD-013): `app_start` ao abrir e `app_foreground` ao voltar
 * ao primeiro plano, e nas duas vezes a fila do serviço nativo entra no diário (SPD-015).
 * Ao ir para o fundo a fila é gravada, porque é ali que o sistema costuma matar o app.
 *
 * Chamado uma vez, do `_layout.tsx`. Os outros pontos de registro (captura, sync, sessão)
 * são do SPD-014.
 */

import { AppState, type AppStateStatus, Platform } from 'react-native';
import { flushDiary, logEvent } from './diary';
import { ingestNativeDiagnostics } from './native';

/** `app_start` uma vez por execução do JS, mesmo que o layout monte duas vezes (modo estrito). */
let startLogged = false;

/** Liga os registros. Devolve a função que desliga o ouvinte do AppState. */
export const startDiagnostics = (): (() => void) => {
	try {
		if (!startLogged) {
			startLogged = true;
			logEvent('app', 'app_start', { data: { osVersion: String(Platform.Version) } });
		}
		void ingestNativeDiagnostics();

		let previous: AppStateStatus = AppState.currentState;
		const subscription = AppState.addEventListener('change', (next: AppStateStatus) => {
			if (next === 'active' && previous !== 'active') {
				logEvent('app', 'app_foreground', { data: { from: previous } });
				void ingestNativeDiagnostics();
			} else if (next === 'background' || next === 'inactive') {
				void flushDiary();
			}
			previous = next;
		});

		return () => subscription.remove();
	} catch {
		return () => {};
	}
};

/** Só para testes. */
export const resetLifecycleForTests = (): void => {
	startLogged = false;
};
