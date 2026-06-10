import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function InfoScreen() {
	const router = useRouter();
	const { t } = useTranslation();

	const handleContinue = () => {
		router.push('/onboarding/security');
	};

	return (
		<SafeAreaView style={styles.container}>
			<StatusBar style="light" />
			<View style={styles.header}>
				<TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
					<Ionicons name="arrow-back" size={24} color="#FFFFFF" />
				</TouchableOpacity>
				<Text style={styles.headerTitle}>{t('info.screenTitle')}</Text>
				<View style={styles.headerRight} />
			</View>

			<ScrollView style={styles.content} contentContainerStyle={styles.contentContainer}>
				<View style={styles.section}>
					<View style={styles.iconContainer}>
						<Ionicons name="card-outline" size={32} color="#15E8FE" />
					</View>
					<Text style={styles.sectionTitle}>{t('info.addTransactions')}</Text>
					<Text style={styles.sectionDescription}>{t('info.addTransactionsDesc')}</Text>
				</View>

				<View style={styles.section}>
					<View style={styles.iconContainer}>
						<Ionicons name="repeat-outline" size={32} color="#15E8FE" />
					</View>
					<Text style={styles.sectionTitle}>{t('info.recurringTransactions')}</Text>
					<Text style={styles.sectionDescription}>{t('info.recurringTransactionsDesc')}</Text>
				</View>

				<View style={styles.section}>
					<View style={styles.iconContainer}>
						<Ionicons name="wallet-outline" size={32} color="#15E8FE" />
					</View>
					<Text style={styles.sectionTitle}>{t('info.monthlyBudget')}</Text>
					<Text style={styles.sectionDescription}>{t('info.monthlyBudgetDesc')}</Text>
				</View>

				<View style={styles.section}>
					<View style={styles.iconContainer}>
						<Ionicons name="pie-chart-outline" size={32} color="#15E8FE" />
					</View>
					<Text style={styles.sectionTitle}>{t('info.insightfulReports')}</Text>
					<Text style={styles.sectionDescription}>{t('info.insightfulReportsDesc')}</Text>
				</View>
			</ScrollView>

			<View style={styles.footer}>
				<TouchableOpacity style={styles.button} onPress={handleContinue}>
					<Text style={styles.buttonText}>{t('info.continue')}</Text>
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
	},
	section: {
		marginBottom: 32,
		alignItems: 'center',
	},
	iconContainer: {
		width: 64,
		height: 64,
		borderRadius: 32,
		backgroundColor: 'rgba(21, 232, 254, 0.1)',
		alignItems: 'center',
		justifyContent: 'center',
		marginBottom: 16,
	},
	sectionTitle: {
		fontSize: 20,
		fontWeight: '600',
		color: '#FFFFFF',
		textAlign: 'center',
		marginBottom: 12,
	},
	sectionDescription: {
		fontSize: 16,
		color: 'rgba(255, 255, 255, 0.7)',
		textAlign: 'center',
		lineHeight: 24,
	},
	footer: {
		width: '100%',
		padding: 24,
		paddingBottom: 36,
	},
	button: {
		backgroundColor: '#15E8FE',
		paddingVertical: 16,
		borderRadius: 8,
		alignItems: 'center',
	},
	buttonText: {
		color: '#000000',
		fontSize: 16,
		fontWeight: '600',
	},
});
