import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * AsyncStorage keys, declared here so the modules that read and write each one cannot
 * drift apart on a string literal.
 */
export const STORAGE_KEYS = {
	budgets: 'monthlyBudgets',
	selectedCurrency: 'selectedCurrency',
} as const;

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
	resetAsyncStorage,
};
