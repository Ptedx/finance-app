import { SYNCED_PREFERENCE_KEYS } from '../utils/storageUtils';

/**
 * As preferências no sync (coleção `preferences`, v21): moeda, idioma, taxa do CDI, o
 * liga/desliga dos lembretes, a dispensa do aviso de contas.
 *
 * Quem as lê continua lendo do AsyncStorage — é lá que a tela inicial, o CDI e os
 * lembretes sempre buscaram. A tabela `preferences` é o que o sync precisa e o
 * AsyncStorage não tem: o `updatedAt` de cada chave (para o último-escreve-vence), a
 * lápide e a marca de "ainda não subiu". As duas coisas andam juntas:
 *
 *  - **subindo**: quem grava pelos contexts (moeda, idioma) usa `setPreference`, que
 *    escreve nos dois lugares. Quem grava direto no AsyncStorage (o CDI, os avisos, o
 *    liga/desliga dos lembretes, a importação de backup) é apanhado pela reconciliação
 *    antes de cada push, que compara as duas pontas e marca o que mudou;
 *  - **descendo**: o pull grava no AsyncStorage antes da tabela e avisa as telas vivas
 *    (`onPreferencesChanged`, em `sync/preferenceEvents.ts`), que releem e aplicam sem
 *    reiniciar o app.
 *
 * Puro: recebe o que foi lido das duas pontas e devolve o que gravar.
 */

/**
 * O carimbo de uma chave **descoberta** — que o AsyncStorage tem e a tabela nunca teve.
 *
 * É o valor de antes do v21, ou um que algum módulo gravou sem passar por aqui: não se
 * sabe quando foi escolhido, e ele não pode atropelar uma escolha datada de outro aparelho.
 * Com o carimbo mais antigo possível, a versão da conta vence; sem versão na conta, este
 * sobe e vale. O mesmo carimbo das categorias padrão (`database.ts`), pelo mesmo motivo.
 */
export const SEED_PREFERENCE_TIMESTAMP = '1970-01-01T00:00:00.000Z';

/** Uma linha de `preferences`, no que a reconciliação precisa dela. */
export interface PreferenceRow {
	key: string;
	value: string;
	updatedAt: string;
	deletedAt: string | null;
}

/** O que gravar numa linha de `preferences`, sempre suja. */
export interface PreferenceWrite {
	key: string;
	value: string;
	updatedAt: string;
	deletedAt: string | null;
}

/**
 * Agora, ou logo depois do carimbo que a linha já tem — o que vier por último.
 *
 * Um celular com o relógio atrasado em relação ao aparelho que gravou a linha carimbaria
 * a edição daqui como **mais antiga**: o servidor a recusaria por `stale`, o pull seguinte
 * traria a versão de lá e a escolha do usuário desfaria sozinha. Mesma ideia do carimbo
 * da substituição (`sync/replace.ts`).
 */
export const stampAfter = (now: string, previous: string | null | undefined): string => {
	if (!previous || previous < now) return now;
	return new Date(new Date(previous).getTime() + 1).toISOString();
};

/**
 * O que a tabela precisa gravar para refletir o AsyncStorage, chave a chave.
 *
 * - só o AsyncStorage tem: descoberta, com o carimbo de semente;
 * - os dois têm, com valores diferentes (ou a tabela tem lápide): mudou por fora, agora;
 * - só a tabela tem viva: a chave foi apagada (o "apagar meus dados", por exemplo) e
 *   vira lápide — com o último valor, que a validação do servidor exige;
 * - igual dos dois lados: nada.
 *
 * Só as chaves que viajam (`SYNCED_PREFERENCE_KEYS`): o resto do AsyncStorage — a
 * biometria, o token de push, o aviso de captura — não é da conta.
 */
export const planPreferenceReconcile = (
	rows: PreferenceRow[],
	stored: Record<string, string | null | undefined>,
	now: string
): PreferenceWrite[] => {
	const byKey = new Map(rows.map((row) => [row.key, row]));
	const writes: PreferenceWrite[] = [];

	for (const key of SYNCED_PREFERENCE_KEYS) {
		const value = typeof stored[key] === 'string' ? (stored[key] as string) : null;
		const row = byKey.get(key);

		if (!row) {
			if (value !== null) writes.push({ key, value, updatedAt: SEED_PREFERENCE_TIMESTAMP, deletedAt: null });
			continue;
		}

		const alive = !row.deletedAt;
		if (value === null) {
			if (!alive) continue;
			const stamp = stampAfter(now, row.updatedAt);
			writes.push({ key, value: row.value, updatedAt: stamp, deletedAt: stamp });
			continue;
		}

		if (alive && row.value === value) continue;
		writes.push({ key, value, updatedAt: stampAfter(now, row.updatedAt), deletedAt: null });
	}

	return writes;
};

/** Se o pull pode escrever esta chave no AsyncStorage. Ver `importPreferences`. */
export const isMirroredPreference = (key: string): boolean => SYNCED_PREFERENCE_KEYS.includes(key);

/**
 * Todo arquivo sob app/ é tratado como rota pelo expo-router, e uma rota sem export
 * default é um módulo quebrado do ponto de vista dele. Este export existe só para
 * satisfazer essa exigência — nada navega para cá.
 */
export default { planPreferenceReconcile, stampAfter, isMirroredPreference };
