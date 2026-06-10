import AsyncStorage from '@react-native-async-storage/async-storage';
import * as LocalAuthentication from 'expo-local-authentication';

// Key for storing biometric authentication preference
const BIOMETRIC_ENABLED_KEY = '@spendr_biometric_enabled';

/**
 * Check if device supports biometric authentication
 */
export const isBiometricAvailable = async (): Promise<boolean> => {
	const hasHardware = await LocalAuthentication.hasHardwareAsync();
	const isEnrolled = await LocalAuthentication.isEnrolledAsync();
	return hasHardware && isEnrolled;
};

/**
 * Get supported authentication types
 */
export const getSupportedAuthTypes = async (): Promise<
	LocalAuthentication.AuthenticationType[]
> => {
	return await LocalAuthentication.supportedAuthenticationTypesAsync();
};

/**
 * Get authentication type name (Fingerprint, Face ID, etc.)
 */
export const getBiometricType = async (): Promise<string> => {
	const types = await getSupportedAuthTypes();

	if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) {
		return 'Face ID';
	} else if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) {
		return 'Fingerprint';
	} else if (types.includes(LocalAuthentication.AuthenticationType.IRIS)) {
		return 'Iris';
	}

	return 'Biometric';
};

/**
 * Check if biometric authentication is enabled in app settings
 */
export const isBiometricEnabled = async (): Promise<boolean> => {
	try {
		const value = await AsyncStorage.getItem(BIOMETRIC_ENABLED_KEY);
		return value === 'true';
	} catch (error) {
		console.error('Error getting biometric preference:', error);
		return false;
	}
};

/**
 * Enable or disable biometric authentication in app settings
 */
export const setBiometricEnabled = async (enabled: boolean): Promise<void> => {
	try {
		await AsyncStorage.setItem(BIOMETRIC_ENABLED_KEY, enabled ? 'true' : 'false');
	} catch (error) {
		console.error('Error saving biometric preference:', error);
	}
};

/**
 * Authenticate using biometrics
 * @param reason Prompt message to show to the user
 */
export const authenticateWithBiometrics = async (
	reason = 'Authenticate to access your data'
): Promise<boolean> => {
	try {
		const result = await LocalAuthentication.authenticateAsync({
			promptMessage: reason,
			fallbackLabel: 'Use passcode',
			cancelLabel: 'Cancel',
			disableDeviceFallback: false,
		});

		return result.success;
	} catch (error) {
		console.error('Biometric authentication error:', error);
		return false;
	}
};

export default {
	isBiometricAvailable,
	getSupportedAuthTypes,
	getBiometricType,
	isBiometricEnabled,
	setBiometricEnabled,
	authenticateWithBiometrics,
};
