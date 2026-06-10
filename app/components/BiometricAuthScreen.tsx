import { Ionicons } from '@expo/vector-icons';
import type React from 'react';
import { useEffect, useState } from 'react';
import {
	ActivityIndicator,
	Animated,
	StyleSheet,
	Text,
	TouchableOpacity,
	View,
} from 'react-native';
import * as biometricUtils from '../utils/biometricUtils';

interface BiometricAuthScreenProps {
	onSuccess: () => void;
	onCancel?: () => void;
}

const BiometricAuthScreen: React.FC<BiometricAuthScreenProps> = ({ onSuccess, onCancel }) => {
	const [biometricType, setBiometricType] = useState<string>('Biometric');
	const [isAuthenticating, setIsAuthenticating] = useState<boolean>(false);
	const [authFailed, setAuthFailed] = useState<boolean>(false);
	const fadeAnim = useState(new Animated.Value(0))[0];

	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional one-time effect
	useEffect(() => {
		const initialize = async () => {
			try {
				const available = await biometricUtils.isBiometricAvailable();
				if (!available) {
					console.log('Biometric authentication not available');
					onSuccess();
					return;
				}

				const type = await biometricUtils.getBiometricType();
				setBiometricType(type);

				const isEnabled = await biometricUtils.isBiometricEnabled();
				if (!isEnabled) {
					console.log('Biometric authentication not enabled');
					onSuccess();
					return;
				}

				Animated.timing(fadeAnim, {
					toValue: 1,
					duration: 500,
					useNativeDriver: true,
				}).start();

				// Add a small delay before prompting biometric auth
				setTimeout(() => {
					authenticate();
				}, 500);
			} catch (error) {
				console.error('Error initializing biometric auth:', error);
				onSuccess();
			}
		};

		initialize();
	}, []);

	const authenticate = async () => {
		try {
			setAuthFailed(false);
			setIsAuthenticating(true);

			const success = await biometricUtils.authenticateWithBiometrics(
				`Authenticate using ${biometricType}`
			);

			if (success) {
				onSuccess();
			} else {
				setAuthFailed(true);
				setIsAuthenticating(false);
			}
		} catch (error) {
			console.error('Authentication error:', error);
			setAuthFailed(true);
			setIsAuthenticating(false);
		}
	};

	const getIconName = () => {
		if (biometricType === 'Face ID') {
			return 'scan';
		} else if (biometricType === 'Fingerprint') {
			return 'finger-print';
		}
		return 'lock-closed';
	};

	const handleCancel = () => {
		if (onCancel) {
			onCancel();
		}
	};

	return (
		<Animated.View style={[styles.container, { opacity: fadeAnim }]}>
			<View style={styles.content}>
				<View style={styles.iconContainer}>
					<Ionicons name={getIconName()} size={64} color="#15E8FE" />
				</View>

				<Text style={styles.title}>Authenticate</Text>
				<Text style={styles.subtitle}>
					{authFailed
						? 'Authentication failed. Try again.'
						: `Please authenticate using ${biometricType} to access your data.`}
				</Text>

				{isAuthenticating ? (
					<ActivityIndicator size="large" color="#15E8FE" style={styles.loader} />
				) : (
					<View style={styles.buttonContainer}>
						<TouchableOpacity style={styles.authButton} onPress={authenticate}>
							<Text style={styles.authButtonText}>
								{authFailed ? 'Try Again' : `Use ${biometricType}`}
							</Text>
						</TouchableOpacity>

						{onCancel && (
							<TouchableOpacity style={styles.cancelButton} onPress={handleCancel}>
								<Text style={styles.cancelButtonText}>Cancel</Text>
							</TouchableOpacity>
						)}
					</View>
				)}
			</View>
		</Animated.View>
	);
};

const styles = StyleSheet.create({
	container: {
		position: 'absolute',
		top: 0,
		left: 0,
		right: 0,
		bottom: 0,
		backgroundColor: 'rgba(0, 0, 0, 0.9)',
		justifyContent: 'center',
		alignItems: 'center',
		zIndex: 1000,
	},
	content: {
		width: '85%',
		backgroundColor: '#1A1A1A',
		borderRadius: 16,
		padding: 24,
		alignItems: 'center',
	},
	iconContainer: {
		width: 100,
		height: 100,
		borderRadius: 50,
		backgroundColor: 'rgba(21, 232, 254, 0.1)',
		justifyContent: 'center',
		alignItems: 'center',
		marginBottom: 24,
	},
	title: {
		fontSize: 24,
		fontWeight: '700',
		color: '#FFFFFF',
		marginBottom: 12,
	},
	subtitle: {
		fontSize: 16,
		color: 'rgba(255, 255, 255, 0.7)',
		textAlign: 'center',
		marginBottom: 24,
	},
	loader: {
		marginVertical: 24,
	},
	buttonContainer: {
		width: '100%',
	},
	authButton: {
		backgroundColor: '#15E8FE',
		paddingVertical: 14,
		borderRadius: 8,
		alignItems: 'center',
		marginBottom: 12,
	},
	authButtonText: {
		color: '#000000',
		fontSize: 16,
		fontWeight: '600',
	},
	cancelButton: {
		backgroundColor: 'rgba(255, 255, 255, 0.1)',
		paddingVertical: 14,
		borderRadius: 8,
		alignItems: 'center',
	},
	cancelButtonText: {
		color: '#FFFFFF',
		fontSize: 16,
		fontWeight: '600',
	},
});

export default BiometricAuthScreen;
