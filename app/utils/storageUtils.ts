import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * AsyncStorage keys, declared here so the modules that read and write each one cannot
 * drift apart on a string literal.
 */
export const STORAGE_KEYS = {
	/** O usuário dispensou o aviso "captura desligada" da tela inicial. */
	captureAccessDismissed: 'captureAccessDismissed',
	budgets: 'monthlyBudgets',
	selectedCurrency: 'selectedCurrency',
	/** A última taxa CDI do Banco Central (ver api/cdi.ts). */
	cdiRate: 'cdiRate',
	/**
	 * O idioma escolhido à mão (`contexts/LanguageContext.tsx`) e a dispensa do aviso de
	 * "ligue suas contas" (`utils/accountReminder.ts`). Os dois módulos leem destas
	 * constantes: o backup precisa saber o nome da chave, e um nome escrito em dois
	 * lugares vira backup salvando a chave errada no dia em que um dos dois mudar.
	 */
	language: '@spendr_language',
	accountReminderDismissed: '@spendr_account_reminder_dismissed',
	/**
	 * O liga/desliga dos lembretes (`utils/notificationUtils.ts`). A permissão do sistema
	 * não mora aqui e não viaja: cada aparelho pede a sua.
	 */
	notificationsEnabled: '@spendr_notifications_enabled',
	/**
	 * Id aleatório desta instalação, para o diário de diagnóstico (`diagnostics/diary.ts`).
	 * Não viaja no backup nem no sync: identifica este aparelho, e um outro com o mesmo id
	 * misturaria os diários dos dois.
	 */
	diagnosticsInstallId: '@spendr_diagnostics_install_id',
} as const;

/**
 * As preferências que viajam no backup.
 *
 * É escolha do usuário que o aparelho novo não tem como redescobrir: moeda, idioma, a
 * taxa do CDI que o app guardou e os avisos que ele já dispensou (reaparecer um aviso
 * dispensado é barato; perder a moeda reescreve todo valor na tela).
 *
 * De fora, de propósito:
 * - `@spendr_biometric_enabled`: é segurança deste aparelho. Um arquivo não liga
 *   biometria em celular nenhum, e um backup não pode destrancar nada.
 * - `@spendr_push_token`, `@spendr_scheduled_notifications`: identificam **este**
 *   aparelho e os alarmes agendados nele; restaurar num outro aponta para o vazio.
 * - `monthlyBudgets`: só a migração v3 -> v4 lê essa chave, e uma instalação nova já
 *   nasce na v18. Os orçamentos viajam na tabela `budgets`, que é a que vale.
 */
export const BACKED_UP_PREFERENCE_KEYS: readonly string[] = [
	STORAGE_KEYS.selectedCurrency,
	STORAGE_KEYS.cdiRate,
	STORAGE_KEYS.captureAccessDismissed,
	STORAGE_KEYS.language,
	STORAGE_KEYS.accountReminderDismissed,
	STORAGE_KEYS.notificationsEnabled,
];

/**
 * As preferências que viajam **no sync** (coleção `preferences`, v21): logado numa conta,
 * outro aparelho abre com a mesma moeda, o mesmo idioma, os mesmos lembretes ligados.
 *
 * As do backup menos uma: `captureAccessDismissed`. O que esse aviso diz — "o Android não
 * está entregando notificações a este app" — é de cada aparelho, e o acesso que ele pede
 * não viaja. Levar a dispensa para o celular novo esconderia ali o único caminho até a
 * tela do sistema onde o acesso é ligado. Reaparecer um aviso dispensado é barato.
 *
 * A ordem é a da reconciliação (`sync/preferences.ts`); não tem outro significado.
 */
export const SYNCED_PREFERENCE_KEYS: readonly string[] = [
	STORAGE_KEYS.selectedCurrency,
	STORAGE_KEYS.cdiRate,
	STORAGE_KEYS.language,
	STORAGE_KEYS.accountReminderDismissed,
	STORAGE_KEYS.notificationsEnabled,
];

/**
 * Lê as preferências para o backup. Chave sem valor não entra no arquivo — `null` ali
 * seria indistinguível de "o usuário escolheu nada", e é o padrão que deve prevalecer.
 */
export const exportPreferences = async (): Promise<Record<string, string>> => {
	const pairs = await AsyncStorage.multiGet([...BACKED_UP_PREFERENCE_KEYS]);
	const preferences: Record<string, string> = {};

	for (const [key, value] of pairs) {
		if (typeof value === 'string') preferences[key] = value;
	}

	return preferences;
};

/**
 * Regrava as preferências de um backup.
 *
 * Só as chaves da lista, e só valores string: o arquivo vem do disco e pode ter sido
 * editado à mão. Escrever chave desconhecida seria deixar um arquivo mandar no
 * AsyncStorage do app — e é justamente onde mora o estado de segurança.
 *
 * Devolve quantas chaves entraram, para a importação poder dizer o que restaurou.
 */
export const importPreferences = async (preferences: unknown): Promise<number> => {
	if (!preferences || typeof preferences !== 'object') return 0;

	const entries = Object.entries(preferences as Record<string, unknown>).filter(
		(entry): entry is [string, string] =>
			BACKED_UP_PREFERENCE_KEYS.includes(entry[0]) && typeof entry[1] === 'string'
	);

	if (entries.length === 0) return 0;

	await AsyncStorage.multiSet(entries);
	return entries.length;
};

/**
 * Reset AsyncStorage data while preserving specified keys
 * @param keysToPreserve Array of keys to preserve in AsyncStorage
 */
export const resetAsyncStorage = async (keysToPreserve: string[] = []): Promise<void> => {
	try {
		// Get all keys from AsyncStorage
		const allKeys = await AsyncStorage.getAllKeys();

		// Filter out keys to preserve
		const keysToRemove = allKeys.filter((key) => !keysToPreserve.includes(key));

		// Remove keys
		if (keysToRemove.length > 0) {
			await AsyncStorage.multiRemove(keysToRemove);
		}

		console.log('AsyncStorage reset successfully');
	} catch (error) {
		console.error('Error resetting AsyncStorage:', error);
		throw error;
	}
};

export default {
	STORAGE_KEYS,
	BACKED_UP_PREFERENCE_KEYS,
	SYNCED_PREFERENCE_KEYS,
	exportPreferences,
	importPreferences,
	resetAsyncStorage,
};
