/**
 * API JavaScript do módulo nativo `SpendrCaptures` (Android).
 *
 * Em iOS e web o módulo não existe, e todas as funções degradam para "não suportado":
 * nenhuma tela precisa checar a plataforma, só perguntar `isCaptureSupported()`.
 */

import { type EventSubscription, requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

/** Uma notificação como o serviço a anotou: texto bruto, sem interpretação. */
export interface NativeRawCapture {
	id: string;
	packageName: string;
	appLabel: string;
	title: string;
	text: string;
	/** Instante ISO 8601 (UTC) em que a notificação foi publicada. */
	postedAt: string;
}

/**
 * Um evento do diário do serviço (conexão, desconexão, descarte pelo filtro). Vai para o
 * diário do app com `area: 'native'` (`app/diagnostics/native.ts`).
 */
export interface NativeDiagnosticEntry {
	id: string;
	/** Instante ISO 8601 (UTC) em que aconteceu no serviço. */
	at: string;
	level: string;
	event: string;
	data: Record<string, unknown>;
	/** Só de app de banco conhecido, com os dígitos trocados por `#` (DEC-11 b). */
	rawText: string | null;
}

interface SpendrCapturesNative {
	isEnabled(): boolean;
	openSettings(): void;
	drain(): NativeRawCapture[];
	pendingCount(): number;
	/** Uma linha JSON por evento. Ausente em binário anterior ao SPD-015. */
	drainDiagnostics?(): string[];
	addListener(
		eventName: 'onCaptured',
		listener: (event: { pending: number }) => void
	): EventSubscription;
}

const native =
	Platform.OS === 'android'
		? requireOptionalNativeModule<SpendrCapturesNative>('SpendrCaptures')
		: null;

/** Verdadeiro quando esta build tem o serviço nativo (Android, build com o módulo). */
export const isCaptureSupported = (): boolean => native !== null;

/** Se o usuário já ligou "Acesso a notificações" para o Spendr nas configurações. */
export const isCaptureEnabled = (): boolean => {
	try {
		return native?.isEnabled() ?? false;
	} catch {
		return false;
	}
};

/** Abre a tela do sistema onde o acesso é ligado. O app não consegue ligar sozinho. */
export const openCaptureSettings = (): void => {
	native?.openSettings();
};

/** Tudo que o serviço anotou desde a última leitura. Esvazia a fila nativa. */
export const drainCaptures = (): NativeRawCapture[] => {
	try {
		return native?.drain() ?? [];
	} catch (error) {
		console.warn('Could not read captured notifications:', error);
		return [];
	}
};

const parseDiagnosticLine = (line: unknown): NativeDiagnosticEntry | null => {
	if (typeof line !== 'string') return null;
	try {
		const value = JSON.parse(line) as Record<string, unknown> | null;
		if (!value || typeof value !== 'object' || typeof value.event !== 'string') return null;
		const data = value.data;
		return {
			id: typeof value.id === 'string' ? value.id : '',
			at: typeof value.at === 'string' ? value.at : '',
			level: typeof value.level === 'string' ? value.level : 'info',
			event: value.event,
			data:
				data && typeof data === 'object' && !Array.isArray(data)
					? (data as Record<string, unknown>)
					: {},
			rawText: typeof value.rawText === 'string' ? value.rawText : null,
		};
	} catch {
		return null;
	}
};

/**
 * O diário do serviço desde a última leitura. Esvazia a fila nativa. Sem módulo, ou num
 * binário que ainda não tem a função (JS novo por OTA sobre build velha), devolve vazio.
 */
export const drainDiagnostics = (): NativeDiagnosticEntry[] => {
	try {
		const lines = native?.drainDiagnostics?.() ?? [];
		return lines
			.map(parseDiagnosticLine)
			.filter((entry): entry is NativeDiagnosticEntry => entry !== null);
	} catch (error) {
		console.warn('Could not read native diagnostics:', error);
		return [];
	}
};

/** Chamado quando chega notificação nova enquanto o app está aberto. */
export const addCaptureListener = (listener: () => void): EventSubscription => {
	if (!native) return { remove: () => {} };
	return native.addListener('onCaptured', listener);
};

export default {
	isCaptureSupported,
	isCaptureEnabled,
	openCaptureSettings,
	drainCaptures,
	drainDiagnostics,
	addCaptureListener,
};
