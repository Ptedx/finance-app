/**
 * O diário do serviço nativo (SPD-015) entrando no diário do app.
 *
 * O serviço de notificações roda quando o app pode nem estar aberto, então ele anota numa
 * fila própria e pequena (`DiagnosticsStore.kt`); o app esvazia essa fila ao abrir e ao
 * voltar ao primeiro plano (`lifecycle.ts`). Cada evento entra com `area: 'native'` e com
 * o id e o instante de lá: o que importa é quando a desconexão aconteceu, não quando o app
 * ficou sabendo.
 */

import { drainDiagnostics } from '../../modules/spendr-captures';
import { flushDiary, recordEvent } from './diary';
import { isKnownBankPackage } from './knownBanks';

/** Esvazia a fila nativa no diário. Devolve quantos entraram; nunca lança. */
export const ingestNativeDiagnostics = async (): Promise<number> => {
	try {
		const entries = drainDiagnostics();
		if (entries.length === 0) return 0;

		for (const entry of entries) {
			// O nativo só guarda texto de banco conhecido (DEC-11 b); confere de novo aqui,
			// porque a lista do Kotlin pode estar num binário mais velho que este JS.
			const pkg = entry.data.package;
			const rawText = typeof pkg === 'string' && isKnownBankPackage(pkg) ? entry.rawText : null;

			recordEvent({
				id: entry.id,
				at: entry.at,
				area: 'native',
				level: entry.level as 'debug' | 'info' | 'warn' | 'error',
				event: entry.event,
				data: entry.data as Record<string, string | number | boolean | null>,
				rawText,
			});
		}

		// A fila nativa já foi esvaziada: grava logo, antes que o sistema mate o app.
		await flushDiary();
		return entries.length;
	} catch {
		return 0;
	}
};
