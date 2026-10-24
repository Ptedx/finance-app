import { Ionicons } from '@expo/vector-icons';
import { Redirect, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppState, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
	isCaptureEnabled,
	isCaptureSupported,
	openCaptureSettings,
} from '../../modules/spendr-captures';

/**
 * A captura automática, entre "Como funciona" e as preferências (SPD-021, AUTO-02).
 *
 * Só no Android com o serviço nativo: no iOS e no Expo Go a etapa não existe, e quem chega
 * aqui mesmo assim segue para as preferências. O app não consegue ligar o acesso sozinho;
 * a etapa explica e abre a tela do sistema. Ao voltar de lá o acesso é conferido de novo.
 * Dá para pular: a tela inicial avisa enquanto o acesso estiver desligado.
 */
export default function CaptureStepScreen() {
	const router = useRouter();
	const { t } = useTranslation();
	const [supported] = useState(() => isCaptureSupported());
	const [enabled, setEnabled] = useState(() => isCaptureEnabled());

	useEffect(() => {
		const subscription = AppState.addEventListener('change', (state) => {
			if (state === 'active') setEnabled(isCaptureEnabled());
		});
		return () => subscription.remove();
	}, []);

	if (!supported) return <Redirect href="/onboarding/security" />;

	const handleNext = () => {
		router.push('/onboarding/security');
	};

	return (
		<SafeAreaView style={styles.container}>
			<StatusBar style="light" />
			<View style={styles.header}>
				<TouchableOpacity
					style={styles.backButton}
					onPress={() => router.back()}
					accessibilityRole="button"
					accessibilityLabel={t('captures.back')}
				>
					<Ionicons name="arrow-back" size={24} color="#FFFFFF" />
				</TouchableOpacity>
				<Text style={styles.headerTitle}>{t('onboardingCaptures.screenTitle')}</Text>
				<View style={styles.headerRight} />
			</View>

			<ScrollView style={styles.content} contentContainerStyle={styles.contentContainer}>
				<View style={styles.iconContainer}>
					<Ionicons name="notifications-outline" size={40} color="#15E8FE" />
				</View>
				<Text style={styles.title}>{t('onboardingCaptures.title')}</Text>
				<Text style={styles.body}>{t('onboardingCaptures.body')}</Text>
				<Text style={styles.body}>{t('onboardingCaptures.keepsOnly')}</Text>

				{enabled ? (
					<View style={styles.status}>
						<Ionicons name="checkmark-circle" size={22} color="#50E3C2" />
						<Text style={styles.statusText}>{t('onboardingCaptures.enabled')}</Text>
					</View>
				) : (
					<Text style={styles.hint}>{t('captures.setupHint')}</Text>
				)}
			</ScrollView>

			<View style={styles.footer}>
				{enabled ? (
					<TouchableOpacity style={styles.button} onPress={handleNext} accessibilityRole="button">
						<Text style={styles.buttonText}>{t('onboardingCaptures.continue')}</Text>
					</TouchableOpacity>
				) : (
					<>
						<TouchableOpacity
							style={styles.button}
							onPress={openCaptureSettings}
							accessibilityRole="button"
						>
							<Text style={styles.buttonText}>{t('captures.setupButton')}</Text>
						</TouchableOpacity>
						<TouchableOpacity
							style={styles.skipButton}
							onPress={handleNext}
							accessibilityRole="button"
						>
							<Text style={styles.skipText}>{t('onboardingCaptures.skip')}</Text>
						</TouchableOpacity>
					</>
				)}
			</View>
		</SafeAreaView>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: '#121212',
	},
	header: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
		paddingHorizontal: 16,
		paddingTop: 60,
		paddingBottom: 20,
	},
	backButton: {
		padding: 8,
	},
	headerTitle: {
		fontSize: 18,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	headerRight: {
		width: 40,
	},
	content: {
		flex: 1,
	},
	contentContainer: {
		padding: 24,
		paddingTop: 12,
		alignItems: 'center',
	},
	iconContainer: {
		width: 80,
		height: 80,
		borderRadius: 40,
		backgroundColor: 'rgba(21, 232, 254, 0.1)',
		alignItems: 'center',
		justifyContent: 'center',
		marginBottom: 24,
	},
	title: {
		fontSize: 24,
		fontWeight: '700',
		color: '#FFFFFF',
		textAlign: 'center',
		marginBottom: 16,
	},
	body: {
		fontSize: 16,
		color: 'rgba(255, 255, 255, 0.7)',
		textAlign: 'center',
		lineHeight: 24,
		marginBottom: 16,
	},
	hint: {
		fontSize: 15,
		color: '#FFFFFF',
		textAlign: 'center',
		lineHeight: 22,
		marginTop: 8,
	},
	status: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 8,
		marginTop: 8,
	},
	statusText: {
		flexShrink: 1,
		fontSize: 15,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	footer: {
		width: '100%',
		padding: 24,
		paddingBottom: 36,
	},
	button: {
		backgroundColor: '#15E8FE',
		paddingVertical: 16,
		borderRadius: 10,
		alignItems: 'center',
	},
	buttonText: {
		color: '#000000',
		fontSize: 16,
		fontWeight: '600',
	},
	skipButton: {
		paddingVertical: 14,
		marginTop: 8,
		alignItems: 'center',
	},
	skipText: {
		color: 'rgba(255, 255, 255, 0.7)',
		fontSize: 16,
		fontWeight: '600',
	},
});
