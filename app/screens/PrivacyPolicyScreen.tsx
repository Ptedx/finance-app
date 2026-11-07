import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { type PolicySection, privacyPolicyFor } from '../utils/privacyPolicy';

/**
 * A política de privacidade (SPD-078), no idioma do app (SPD-118). O texto de cada idioma
 * está em `utils/privacyPolicyText/`, e o mesmo texto está em `docs/privacy-policy.html` (pt),
 * `docs/privacy-policy.en.html` e `docs/privacy-policy.it.html`: mudar um é mudar os outros.
 */

export default function PrivacyPolicyScreen() {
	// O idioma do i18next, o mesmo dos textos do resto do app: trocar o idioma em Ajustes
	// redesenha a tela já na versão nova.
	const { t, i18n } = useTranslation();
	const policy = privacyPolicyFor(i18n.language);

	return (
		<SafeAreaView style={styles.container}>
			<StatusBar style="light" />
			<Stack.Screen
				options={{
					title: t('settings.privacyPolicy'),
					headerStyle: { backgroundColor: '#1A1A1A' },
					headerTintColor: '#FFFFFF',
					headerShadowVisible: false,
				}}
			/>

			<ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
				<Text style={styles.title}>
					{policy.title}
					{'\n'}
					<Text style={styles.accent}>{policy.accent}</Text>
				</Text>
				<Text style={styles.intro}>{policy.intro}</Text>
				<Text style={styles.updated}>{policy.updated}</Text>

				<View style={styles.pillRow}>
					{policy.pills.map(({ icon, label }) => (
						<View key={label} style={styles.pill}>
							<Text style={styles.pillIcon}>{icon}</Text>
							<Text style={styles.pillLabel}>{label}</Text>
						</View>
					))}
				</View>

				{policy.sections.map((section) => (
					<Section key={section.title} section={section} />
				))}

				<Text style={styles.footer}>{policy.footer}</Text>
			</ScrollView>
		</SafeAreaView>
	);
}

function Section({ section }: { section: PolicySection }) {
	// Cada parágrafo é único na seção, então o próprio texto (ou o rótulo) serve de chave.
	const paragraphs = [
		...(section.body ?? []).map((text) => ({ key: text, node: text })),
		...(section.list ?? []).map(([label, text]) => ({
			key: label,
			node: (
				<>
					<Text style={styles.bold}>{label}</Text> — {text}
				</>
			),
		})),
		...(section.after ?? []).map((text) => ({ key: text, node: text })),
	];
	return (
		<View style={styles.section}>
			<View style={styles.sectionHeader}>
				<View style={styles.sectionIcon}>
					<Text style={styles.sectionIconText}>{section.icon}</Text>
				</View>
				<Text style={styles.sectionTitle}>{section.title}</Text>
			</View>
			<Text style={styles.sectionBody}>
				{paragraphs.map(({ key, node }, index) => (
					<Text key={key}>
						{index > 0 ? '\n\n' : ''}
						{node}
					</Text>
				))}
			</Text>
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
