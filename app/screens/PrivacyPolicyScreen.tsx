import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function PrivacyPolicyScreen() {
	return (
		<SafeAreaView style={styles.container}>
			<StatusBar style="light" />
			<Stack.Screen
				options={{
					title: 'Privacy Policy',
					headerStyle: { backgroundColor: '#1A1A1A' },
					headerTintColor: '#FFFFFF',
					headerShadowVisible: false,
				}}
			/>

			<ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
				<Text style={styles.title}>Your data stays{'\n'}<Text style={styles.accent}>on your device.</Text></Text>
				<Text style={styles.intro}>
					Spendr is built with privacy by design. We don't collect, share, or sell any personal data — ever.
				</Text>
				<Text style={styles.updated}>Last updated: April 6, 2026</Text>

				<View style={styles.pillRow}>
					{[
						{ icon: '🔒', label: 'No data collected' },
						{ icon: '📡', label: 'No internet required' },
						{ icon: '🗄️', label: 'Local storage only' },
						{ icon: '🚫', label: 'No third parties' },
					].map(({ icon, label }) => (
						<View key={label} style={styles.pill}>
							<Text style={styles.pillIcon}>{icon}</Text>
							<Text style={styles.pillLabel}>{label}</Text>
						</View>
					))}
				</View>

				<Section icon="📋" title="Information We Collect">
					Spendr does not collect any personal information. All data you enter — transactions, categories, budgets, and settings — is stored exclusively in a local SQLite database on your device.{'\n\n'}This data never leaves your device and is never transmitted to any server.
				</Section>

				<Section icon="📤" title="Data Sharing">
					We do not share, sell, rent, or trade your data with any third party, for any purpose, at any time.{'\n\n'}Spendr has no backend, no user accounts, and no cloud sync. There is nothing to share.
				</Section>

				<Section icon="🔐" title="Permissions Used">
					Spendr requests only the permissions strictly necessary to provide its features:{'\n\n'}
					<Text style={styles.bold}>Biometric authentication</Text> — optional lock screen using Face ID or fingerprint, handled entirely by the OS. No biometric data is accessed by the app.{'\n\n'}
					<Text style={styles.bold}>Notifications</Text> — local-only reminders for recurring transactions. No notification data is sent externally.{'\n\n'}
					<Text style={styles.bold}>Storage</Text> — read/write access to export CSV reports to your local files. Files stay on your device.
				</Section>

				<Section icon="👶" title="Children's Privacy">
					Spendr does not knowingly collect any information from anyone, including children under the age of 13. Since no data is collected at all, there is no risk of inadvertent data collection from minors.
				</Section>

				<Section icon="🔄" title="Changes to This Policy">
					If we ever change this privacy policy, the updated version will be published on this page with a new effective date.{'\n\n'}Any future features that involve data collection will be clearly disclosed before they are introduced.
				</Section>

				<Section icon="✉️" title="Contact">
					If you have any questions about this privacy policy, you can open an issue on the project repository or reach out via GitHub.
				</Section>

				<Text style={styles.footer}>
					Spendr by okazakee — open source.
				</Text>
			</ScrollView>
		</SafeAreaView>
	);
}

function Section({ icon, title, children }: { icon: string; title: string; children: React.ReactNode }) {
	return (
		<View style={styles.section}>
			<View style={styles.sectionHeader}>
				<View style={styles.sectionIcon}>
					<Text style={styles.sectionIconText}>{icon}</Text>
				</View>
				<Text style={styles.sectionTitle}>{title}</Text>
			</View>
			<Text style={styles.sectionBody}>{children}</Text>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: '#121212',
	},
	scroll: {
		flex: 1,
	},
	content: {
		padding: 20,
		paddingBottom: 48,
	},
	title: {
		fontSize: 28,
		fontWeight: '800',
		color: '#FFFFFF',
		lineHeight: 34,
		marginBottom: 12,
		marginTop: 8,
	},
	accent: {
		color: '#15E8FE',
	},
	intro: {
		fontSize: 14,
		color: '#9CA3AF',
		lineHeight: 22,
		marginBottom: 12,
	},
	updated: {
		fontSize: 12,
		color: '#9CA3AF',
		marginBottom: 20,
	},
	pillRow: {
		flexDirection: 'row',
		flexWrap: 'wrap',
		gap: 8,
		marginBottom: 24,
	},
	pill: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 6,
		backgroundColor: '#1A1A1A',
		borderWidth: 1,
		borderColor: '#3e3e3e',
		borderRadius: 999,
		paddingVertical: 6,
		paddingHorizontal: 12,
	},
	pillIcon: {
		fontSize: 13,
	},
	pillLabel: {
		fontSize: 12,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	section: {
		backgroundColor: '#1A1A1A',
		borderWidth: 1,
		borderColor: '#3e3e3e',
		borderRadius: 16,
		overflow: 'hidden',
		marginBottom: 12,
	},
	sectionHeader: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 12,
		padding: 16,
		borderBottomWidth: 1,
		borderBottomColor: '#3e3e3e',
	},
	sectionIcon: {
		width: 34,
		height: 34,
		borderRadius: 9,
		backgroundColor: 'rgba(21, 232, 254, 0.12)',
		alignItems: 'center',
		justifyContent: 'center',
	},
	sectionIconText: {
		fontSize: 16,
	},
	sectionTitle: {
		fontSize: 15,
		fontWeight: '700',
		color: '#FFFFFF',
	},
	sectionBody: {
		fontSize: 13.5,
		color: '#9CA3AF',
		lineHeight: 22,
		padding: 16,
	},
	bold: {
		fontWeight: '700',
		color: '#FFFFFF',
	},
	footer: {
		fontSize: 12,
		color: '#9CA3AF',
		textAlign: 'center',
		marginTop: 24,
	},
});
