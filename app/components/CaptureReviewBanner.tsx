import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text } from 'react-native';
import { useCaptures } from '../contexts/CapturesContext';

/**
 * "3 lançamentos para revisar" no topo da tela inicial.
 *
 * Só aparece quando há algo a fazer: sem pendência, sem faixa. Não insiste, não
 * vibra, não manda notificação — o selo na aba e esta faixa são o único aviso, e os
 * itens esperam o tempo que for preciso.
 */
const CaptureReviewBanner: React.FC = () => {
	const { t } = useTranslation();
	const router = useRouter();
	const { pendingCount } = useCaptures();

	if (pendingCount === 0) return null;

	const label = t('captures.homeBanner', { count: pendingCount });

	return (
		<Pressable
			onPress={() => router.push('/inbox')}
			accessibilityRole="button"
			accessibilityLabel={label}
			accessibilityHint={t('captures.homeReviewHint')}
			style={({ pressed }) => [styles.banner, pressed && styles.pressed]}
		>
			<Ionicons name="notifications-outline" size={22} color="#000000" />
			<Text style={styles.text}>{label}</Text>
			<Text style={styles.action}>{t('captures.homeReview')}</Text>
			<Ionicons name="chevron-forward" size={20} color="#000000" />
		</Pressable>
	);
};

const styles = StyleSheet.create({
	banner: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 10,
		minHeight: 52,
		paddingHorizontal: 14,
		paddingVertical: 10,
		borderRadius: 12,
		backgroundColor: '#15E8FE',
		marginBottom: 16,
	},
	pressed: {
		opacity: 0.8,
	},
	text: {
		flex: 1,
		fontSize: 16,
		fontWeight: '600',
		color: '#000000',
	},
	action: {
		fontSize: 15,
		fontWeight: '700',
		color: '#000000',
	},
});

export default CaptureReviewBanner;
