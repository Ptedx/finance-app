import AsyncStorage from '@react-native-async-storage/async-storage';
import { STORAGE_KEYS } from '../utils/storageUtils';
import { parseBcbCdi } from '../utils/yield';

/**
 * A taxa CDI, do Banco Central.
 *
 * Série SGS 4389 — "Taxa de juros CDI anualizada base 252", pública e sem chave. O app
 * consulta no máximo duas vezes por dia e guarda a última resposta: sem internet (ou com a
 * API fora do ar) continua valendo a última taxa conhecida. Sem nenhuma taxa conhecida, as
 * contas simplesmente não somam rendimento — o app não inventa um CDI.
 */

const CDI_URL = 'https://api.bcb.gov.br/dados/serie/bcdata.sgs.4389/dados/ultimos/1?formato=json';
const REFRESH_AFTER_MS = 12 * 60 * 60 * 1000;
const TIMEOUT_MS = 8000;

export interface CdiRate {
	/** CDI ao ano, em pontos-base (1.490 = 14,90%). */
	annualBp: number;
	/** Dia a que a taxa se refere, `YYYY-MM-DD`. */
	date: string;
	/** Quando foi buscada, ISO. */
	fetchedAt: string;
}

export const loadCachedCdi = async (): Promise<CdiRate | null> => {
	try {
		const stored = await AsyncStorage.getItem(STORAGE_KEYS.cdiRate);
		return stored ? (JSON.parse(stored) as CdiRate) : null;
	} catch {
		return null;
	}
};

/**
 * A taxa mais recente: a guardada, se foi buscada há menos de 12 horas; senão, busca de
 * novo. Qualquer falha devolve a guardada.
 */
export const refreshCdi = async (): Promise<CdiRate | null> => {
	const cached = await loadCachedCdi();
	if (cached && Date.now() - new Date(cached.fetchedAt).getTime() < REFRESH_AFTER_MS) return cached;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const response = await fetch(CDI_URL, { signal: controller.signal, headers: { Accept: 'application/json' } });
		if (!response.ok) return cached;
		const parsed = parseBcbCdi(await response.json());
		if (!parsed) return cached;
		const next: CdiRate = { ...parsed, fetchedAt: new Date().toISOString() };
		await AsyncStorage.setItem(STORAGE_KEYS.cdiRate, JSON.stringify(next));
		return next;
	} catch {
		return cached;
	} finally {
		clearTimeout(timer);
	}
};

/**
 * Todo arquivo sob app/ é tratado como rota pelo expo-router, e uma rota sem export
 * default é um módulo quebrado do ponto de vista dele. Este export existe só para
 * satisfazer essa exigência — nada navega para cá.
 */
export default { loadCachedCdi, refreshCdi };
