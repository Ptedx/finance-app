import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Lembrete para criar conta.
 *
 * Sem conta, desinstalar o app leva os dados junto — e quem descobre isso ao trocar de
 * celular descobre tarde demais. O lembrete existe para que essa informação chegue antes,
 * uma única vez, e só depois de o usuário ter algo a perder.
 */

const DISMISSED_KEY = '@spendr_account_reminder_dismissed';

/**
 * Quantos lançamentos antes de sugerir a conta.
 *
 * Baixo demais e o aviso vira propaganda no primeiro uso, quando não há nada em risco;
 * alto demais e ele chega depois de meses de dados já expostos. Vinte é o ponto em que
 * o app deixou de ser um teste.
 */
export const REMINDER_THRESHOLD = 20;

export const isReminderDismissed = async (): Promise<boolean> => {
	try {
		return (await AsyncStorage.getItem(DISMISSED_KEY)) === 'true';
	} catch {
		// Na dúvida, não incomoda.
		return true;
	}
};

export const dismissReminder = async (): Promise<void> => {
	try {
		await AsyncStorage.setItem(DISMISSED_KEY, 'true');
	} catch (error) {
		console.warn('Não foi possível guardar a dispensa do lembrete:', error);
	}
};

/**
 * Se o lembrete deve aparecer agora.
 *
 * Some para sempre assim que o usuário o dispensa ou cria a conta: um aviso que volta
 * toda semana é ignorado, e aí deixa de proteger quem quer que seja.
 */
export const shouldShowReminder = async (params: {
	hasAccount: boolean;
	transactionCount: number;
}): Promise<boolean> => {
	if (params.hasAccount) return false;
	if (params.transactionCount < REMINDER_THRESHOLD) return false;

	return !(await isReminderDismissed());
};

export default {
	REMINDER_THRESHOLD,
	shouldShowReminder,
	dismissReminder,
	isReminderDismissed,
};
