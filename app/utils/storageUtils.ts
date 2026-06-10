import AsyncStorage from '@react-native-async-storage/async-storage';

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
	resetAsyncStorage,
};
