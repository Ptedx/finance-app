import AsyncStorage from '@react-native-async-storage/async-storage';
import { setPreference } from '../database/database';
import {
	type CaptureChoiceStore,
	type CaptureChoices,
	parseCaptureChoices,
	serializeCaptureChoices,
} from './captureChoices';
import { STORAGE_KEYS } from './storageUtils';

/**
 * Onde moram as escolhas que o app aprende nos avisos ambíguos (SPD-123): uma preferência
 * que sobe no sync e vai no backup, sem coluna nova nem mudança no servidor. As regras ficam
 * em `captureChoices.ts`.
 *
 * Preferência, e não `merchantRules`: a regra de estabelecimento tem chave de loja e guarda
 * categoria, tratamento e contagem — não há onde pôr uma conta ou uma direção sem mudar o
 * que o servidor aceita. A preferência é chave/valor livre (até 2.000 caracteres).
 */

const KEY = STORAGE_KEYS.captureChoices;

export const getCaptureChoices = async (): Promise<CaptureChoices> => {
	try {
		return parseCaptureChoices(await AsyncStorage.getItem(KEY));
	} catch {
		return {};
	}
};

/** O lugar das regras para as respostas da revisão (`captureActions`). */
export const captureChoiceStore: CaptureChoiceStore = {
	read: getCaptureChoices,
	write: (next) => setPreference(KEY, serializeCaptureChoices(next)),
};

export default { getCaptureChoices, captureChoiceStore };
