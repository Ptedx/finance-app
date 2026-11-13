import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import type React from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Image, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { isCaptureSupported } from '../../modules/spendr-captures';

/**
 * As boas-vindas da primeira abertura (SPD-129): quatro telas curtas com o que o app faz
 * hoje, com "Pular" em todas menos a última. Depois delas o onboarding segue para a captura
 * e a segurança (a tela antiga "Como funciona" saiu no SPD-134: repetia as boas-vindas).
 *
 * Aberta por Ajustes › Como usar › "Rever as boas-vindas" (`?review=1`), é só para ler:
 * "Pular" e "Começar" voltam para onde o usuário estava.
 */

type Slide = 'money' | 'capture' | 'cards' | 'plan';

const SLIDES: { id: Slide; icon: React.ComponentProps<typeof Ionicons>['name'] }[] = [
	{ id: 'money', icon: 'wallet-outline' },
	{ id: 'capture', icon: 'flash-outline' },
	{ id: 'cards', icon: 'card-outline' },
	{ id: 'plan', icon: 'trending-up-outline' },
];

export default function WelcomeScreen() {
	const router = useRouter();
	const { t } = useTranslation();
	const { review } = useLocalSearchParams<{ review?: string }>();
	const [index, setIndex] = useState(0);
	const slide = SLIDES[index];
	const isLast = index === SLIDES.length - 1;

	// No Android com o serviço nativo, a etapa da captura vem antes das preferências
	// (SPD-021); no iOS e no Expo Go ela não existe.
	const leave = () => {
		if (review === '1') router.back();
		else router.push(isCaptureSupported() ? '/onboarding/captures' : '/onboarding/security');
	};

	const next = () => {
		if (isLast) leave();
		else setIndex(index + 1);
	};

	return (
		<SafeAreaView style={styles.container}>
			<StatusBar style="light" />
			<View style={styles.topBar}>
				{isLast ? (
					<View style={styles.skipPlaceholder} />
				) : (
					<Pressable
						onPress={leave}
						accessibilityRole="button"
						accessibilityLabel={t('welcome.skip')}
						accessibilityHint={t('welcome.skipHint')}
						hitSlop={8}
						style={({ pressed }) => [styles.skip, pressed && styles.pressed]}
					>
						<Text style={styles.skipText}>{t('welcome.skip')}</Text>
					</Pressable>
				)}
			</View>

			<ScrollView contentContainerStyle={styles.content}>
				{index === 0 ? (
					<Image source={require('../../assets/images/icon.png')} style={styles.logo} resizeMode="contain" />
				) : (
					<View style={styles.iconContainer}>
						<Ionicons name={slide.icon} size={40} color="#15E8FE" />
					</View>
				)}
				<Text style={styles.title} accessibilityRole="header">
					{t(`welcome.slides.${slide.id}.title`)}
				</Text>
				<Text style={styles.body}>{t(`welcome.slides.${slide.id}.body`)}</Text>
			</ScrollView>

			<View style={styles.footer}>
				<View style={styles.dots} accessible accessibilityLabel={t('welcome.page', { current: index + 1, total: SLIDES.length })}>
					{SLIDES.map((item, position) => (
						<View key={item.id} style={[styles.dot, position === index && styles.dotActive]} />
					))}
				</View>
				<TouchableOpacity style={styles.button} onPress={next} accessibilityRole="button">
					<Text style={styles.buttonText}>{isLast ? t('welcome.start') : t('welcome.next')}</Text>
					<Ionicons name="arrow-forward" size={20} color="#000000" style={{ marginLeft: 8 }} />
				</TouchableOpacity>
			</View>
		</SafeAreaView>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: '#121212',
	},
	topBar: {
		flexDirection: 'row',
		justifyContent: 'flex-end',
		paddingHorizontal: 16,
		paddingTop: 8,
	},
	skip: {
		minHeight: 48,
		minWidth: 64,
		paddingHorizontal: 12,
		alignItems: 'center',
		justifyContent: 'center',
	},
	skipPlaceholder: {
		height: 48,
	},
	skipText: {
		fontSize: 16,
		fontWeight: '600',
		color: 'rgba(255, 255, 255, 0.8)',
	},
	pressed: {
		opacity: 0.6,
	},
	content: {
		flexGrow: 1,
		alignItems: 'center',
		justifyContent: 'center',
		padding: 24,
	},
	logo: {
		width: 100,
		height: 100,
		marginBottom: 32,
	},
	iconContainer: {
		width: 88,
		height: 88,
		borderRadius: 24,
		backgroundColor: 'rgba(21, 232, 254, 0.15)',
		alignItems: 'center',
		justifyContent: 'center',
		marginBottom: 32,
	},
	title: {
		fontSize: 26,
		fontWeight: '700',
		color: '#FFFFFF',
		textAlign: 'center',
		marginBottom: 16,
	},
	body: {
		fontSize: 17,
		lineHeight: 25,
		color: 'rgba(255, 255, 255, 0.8)',
		textAlign: 'center',
		paddingHorizontal: 8,
	},
	footer: {
		width: '100%',
		padding: 24,
		paddingBottom: 36,
		gap: 20,
	},
	dots: {
		flexDirection: 'row',
		justifyContent: 'center',
		gap: 8,
	},
	dot: {
		width: 8,
		height: 8,
		borderRadius: 4,
		backgroundColor: 'rgba(255, 255, 255, 0.3)',
	},
	dotActive: {
		width: 24,
		backgroundColor: '#15E8FE',
	},
	button: {
		backgroundColor: '#15E8FE',
		paddingVertical: 16,
		borderRadius: 10,
		alignItems: 'center',
		flexDirection: 'row',
		justifyContent: 'center',
		shadowColor: '#15E8FE',
		shadowOpacity: 0.4,
		shadowRadius: 10,
		shadowOffset: { width: 0, height: 4 },
		elevation: 5,
	},
	buttonText: {
		color: '#000000',
		fontSize: 16,
		fontWeight: '600',
	},
});
