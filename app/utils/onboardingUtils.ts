import AsyncStorage from '@react-native-async-storage/async-storage';

// Key for storing onboarding status
const ONBOARDING_COMPLETED_KEY = '@spendr_onboarding_completed';

/**
 * Check if onboarding has been completed
 */
export const isOnboardingCompleted = async (): Promise<boolean> => {
	try {
		const value = await AsyncStorage.getItem(ONBOARDING_COMPLETED_KEY);
		return value === 'true';
	} catch (error) {
		console.error('Error getting onboarding status:', error);
		return false;
	}
};

/**
 * Set onboarding as completed
 */
export const setOnboardingCompleted = async (): Promise<void> => {
	try {
		await AsyncStorage.setItem(ONBOARDING_COMPLETED_KEY, 'true');
	} catch (error) {
		console.error('Error saving onboarding status:', error);
	}
};

export default {
	isOnboardingCompleted,
	setOnboardingCompleted,
};
