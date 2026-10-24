/**
 * "Exportar diagnóstico" (SPD-013): junta o diário num único `.jsonl` e abre o compartilhar
 * do sistema, para o usuário mandar a quem for depurar.
 *
 * O arquivo pode conter texto de notificação de banco (DEC-11 b); a tela pede confirmação
 * antes de chamar isto. Vai para o cache do app, que o sistema limpa sozinho.
 */

import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { readEvents } from './diary';

export interface ExportDiagnosticsResult {
	/** `empty`: diário sem nada; `unavailable`: o aparelho não tem compartilhar. */
	status: 'shared' | 'empty' | 'unavailable';
	count: number;
}

/** "20261024-031500", em UTC, como o `at` dos eventos. */
const stamp = (): string =>
	new Date()
		.toISOString()
		.replace(/\.\d+Z$/, '')
		.replace(/[-:]/g, '')
		.replace('T', '-');

/** Lança só se a escrita ou o compartilhar falharem; a tela mostra o erro. */
export const exportDiagnostics = async (dialogTitle?: string): Promise<ExportDiagnosticsResult> => {
	const events = await readEvents();
	if (events.length === 0) return { status: 'empty', count: 0 };
	if (!(await Sharing.isAvailableAsync())) return { status: 'unavailable', count: events.length };

	// Reescrito a partir do lido, e não copiado: linha corrompida não vai para o arquivo.
	const file = new File(Paths.cache, `spendr-diagnostico-${stamp()}.jsonl`);
	file.write(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`);

	await Sharing.shareAsync(file.uri, {
		mimeType: 'text/plain',
		dialogTitle,
		UTI: 'public.plain-text',
	});
	return { status: 'shared', count: events.length };
};
