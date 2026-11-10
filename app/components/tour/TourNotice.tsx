import { Ionicons } from '@expo/vector-icons';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTour } from './TourContext';

/**
 * "Novo: Como usar o Spendr" no topo da tela inicial, uma vez, para quem já usava o app e
 * atualizou (SPD-129). "Ver" começa o guia da tela inicial e passa a abrir o guia de cada
 * tela na primeira visita; "Agora não" só fecha. Qualquer dos dois some com o aviso para
 * sempre — o guia continua em Ajustes › Como usar.
 */
const TourNotice: React.FC = () => {
	const { t } = useTranslation();
	const tour = useTour();
	if (!tour?.noticeVisible) return null;

	return (
		<View style={styles.card} accessibilityLiveRegion="polite">
			<View style={styles.row}>
				<Ionicons name="sparkles-outline" size={22} color="#15E8FE" />
				<View style={styles.texts}>
					<Text style={styles.title} accessibilityRole="header">
						{t('tutorial.notice.title')}
					</Text>
					<Text style={styles.body}>{t('tutorial.notice.body')}</Text>
				</View>
			</View>
			<View style={styles.buttons}>
				<Pressable
					onPress={() => tour.answerNotice('later')}
					accessibilityRole="button"
					accessibilityLabel={t('tutorial.notice.later')}
					style={({ pressed }) => [styles.button, pressed && styles.pressed]}
				>
					<Text style={styles.laterText}>{t('tutorial.notice.later')}</Text>
				</Pressable>
				<Pressable
					onPress={() => tour.answerNotice('see')}
					accessibilityRole="button"
					accessibilityLabel={t('tutorial.notice.see')}
					accessibilityHint={t('tutorial.notice.seeHint')}
					style={({ pressed }) => [styles.button, styles.primary, pressed && styles.pressed]}
				>
					<Text style={styles.seeText}>{t('tutorial.notice.see')}</Text>
				</Pressable>
			</View>
		</View>
	);
};

const styles = StyleSheet.create({
	card: {
		backgroundColor: '#1E1E1E',
		borderRadius: 16,
		borderWidth: 1,
		borderColor: 'rgba(21,232,254,0.4)',
		padding: 14,
		gap: 10,
		marginBottom: 16,
	},
	row: {
		flexDirection: 'row',
		alignItems: 'flex-start',
		gap: 10,
	},
	texts: {
		flex: 1,
		gap: 2,
	},
	title: {
		fontSize: 16,
		fontWeight: '700',
		color: '#FFFFFF',
	},
	body: {
		fontSize: 14,
		lineHeight: 20,
		color: 'rgba(255,255,255,0.8)',
	},
	buttons: {
		flexDirection: 'row',
		justifyContent: 'flex-end',
		flexWrap: 'wrap',
		gap: 8,
	},
	button: {
		minHeight: 48,
		paddingHorizontal: 16,
		borderRadius: 12,
		alignItems: 'center',
		justifyContent: 'center',
	},
	primary: {
		backgroundColor: '#15E8FE',
	},
	pressed: {
		opacity: 0.7,
	},
	laterText: {
		fontSize: 15,
		fontWeight: '600',
		color: 'rgba(255,255,255,0.85)',
	},
	seeText: {
		fontSize: 15,
		fontWeight: '700',
		color: '#000000',
	},
});

export default TourNotice;
