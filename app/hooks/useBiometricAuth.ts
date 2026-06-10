import { useCallback, useState } from 'react';
import * as biometricUtils from '../utils/biometricUtils';

export const useBiometricAuth = () => {
	const [isAuthenticating, setIsAuthenticating] = useState(false);

	const authenticate = useCallback(
		async (reason?: string, onSuccess?: () => void, onFailure?: () => void) => {
			try {
				const available = await biometricUtils.isBiometricAvailable();
				const enabled = available && (await biometricUtils.isBiometricEnabled());

				// If biometrics aren't available or enabled, consider it a success
				if (!available || !enabled) {
					if (onSuccess) onSuccess();
					return true;
				}

				setIsAuthenticating(true);
				const biometricType = await biometricUtils.getBiometricType();
				const promptReason = reason || `Authenticate with ${biometricType}`;

				const success = await biometricUtils.authenticateWithBiometrics(promptReason);

				if (success) {
					if (onSuccess) onSuccess();
				} else {
					if (onFailure) onFailure();
				}

				setIsAuthenticating(false);
				return success;
			} catch (error) {
				console.error('Authentication error:', error);
				setIsAuthenticating(false);
				if (onFailure) onFailure();
				return false;
			}
		},
		[]
	);

	return {
		authenticate,
		isAuthenticating,
	};
};

export default useBiometricAuth;
