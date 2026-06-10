import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useTranslation } from 'react-i18next';
import { Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function WelcomeScreen() {
	const router = useRouter();
	const { t } = useTranslation();

	const handleGetStarted = () => {
		router.push('/onboarding/info');
	};

	return (
		<SafeAreaView style={styles.container}>
			<StatusBar style="light" />
			<View style={styles.content}>
				<View style={styles.logoContainer}>
					<Image
						source={require('../../assets/images/icon.png')}
						style={styles.logo}
						resizeMode="contain"
					/>
				</View>

				<Text style={styles.title}>{t('welcome.title')}</Text>
				<Text style={styles.subtitle}>{t('welcome.subtitle')}</Text>

				<View style={styles.featuresContainer}>
					<View style={styles.featureItem}>
						<View style={styles.featureIconContainer}>
							<Ionicons name="cash-outline" size={26} color="#15E8FE" />
						</View>
						<View style={styles.featureTextContainer}>
							<Text style={styles.featureTitle}>{t('welcome.trackExpenses')}</Text>
							<Text style={styles.featureDescription}>{t('welcome.trackExpensesDesc')}</Text>
						</View>
					</View>

					<View style={styles.featureItem}>
						<View style={styles.featureIconContainer}>
							<Ionicons name="wallet-outline" size={26} color="#15E8FE" />
						</View>
						<View style={styles.featureTextContainer}>
							<Text style={styles.featureTitle}>{t('welcome.manageBudget')}</Text>
							<Text style={styles.featureDescription}>{t('welcome.manageBudgetDesc')}</Text>
						</View>
					</View>

					<View style={styles.featureItem}>
						<View style={styles.featureIconContainer}>
							<Ionicons name="pie-chart-outline" size={26} color="#15E8FE" />
						</View>
						<View style={styles.featureTextContainer}>
							<Text style={styles.featureTitle}>{t('welcome.insightfulReports')}</Text>
							<Text style={styles.featureDescription}>{t('welcome.insightfulReportsDesc')}</Text>
						</View>
					</View>
				</View>
			</View>

			<View style={styles.footer}>
				<TouchableOpacity style={styles.button} onPress={handleGetStarted}>
					<Text style={styles.buttonText}>{t('welcome.getStarted')}</Text>
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
	content: {
		flex: 1,
		alignItems: 'center',
		justifyContent: 'center',
		padding: 24,
	},
	logoContainer: {
		alignItems: 'center',
		marginBottom: 32,
	},
	logo: {
		width: 100,
		height: 100,
	},
	title: {
		fontSize: 28,
		fontWeight: '700',
		color: '#FFFFFF',
		textAlign: 'center',
		marginBottom: 16,
	},
	subtitle: {
		fontSize: 16,
		color: 'rgba(255, 255, 255, 0.7)',
		textAlign: 'center',
		marginBottom: 48,
		paddingHorizontal: 16,
	},
	featuresContainer: {
		width: '100%',
		marginBottom: 48,
	},
	featureItem: {
		flexDirection: 'row',
		alignItems: 'center',
		marginBottom: 24,
	},
	featureIconContainer: {
		width: 50,
		height: 50,
		borderRadius: 12,
		backgroundColor: 'rgba(21, 232, 254, 0.15)',
		alignItems: 'center',
		justifyContent: 'center',
		marginRight: 16,
		elevation: 3,
	},
	featureTextContainer: {
		flex: 1,
	},
	featureTitle: {
		fontSize: 16,
		fontWeight: '600',
		color: '#FFFFFF',
		marginBottom: 4,
	},
	featureDescription: {
		fontSize: 14,
		color: 'rgba(255, 255, 255, 0.7)',
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
