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

interface SpendrCapturesNative {
	isEnabled(): boolean;
	openSettings(): void;
	drain(): NativeRawCapture[];
	pendingCount(): number;
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
	addCaptureListener,
};
