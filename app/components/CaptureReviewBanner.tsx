import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type React from 'react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useCaptures } from '../contexts/CapturesContext';
import { STORAGE_KEYS } from '../utils/storageUtils';

/**
 * "3 lançamentos para revisar" no topo da tela inicial.
 *
 * Só aparece quando há algo a fazer: sem pendência, sem faixa. Não insiste, não
 * vibra, não manda notificação — o selo na aba e esta faixa são o único aviso, e os
 * itens esperam o tempo que for preciso.
 *
 * E o contrário: quando o Android não está entregando notificações a este app, a faixa
 * avisa. O acesso se perde a cada reinstalação, e o app de desenvolvimento aparece ao lado
 * na lista do sistema — sem aviso, a captura parava em silêncio. Dá para dispensar.
 */
const CaptureReviewBanner: React.FC = () => {
	const { t } = useTranslation();
	const router = useRouter();
	const { pendingCount, supported, enabled, openSettings } = useCaptures();
	const [dismissed, setDismissed] = useState(true);

	useEffect(() => {
		AsyncStorage.getItem(STORAGE_KEYS.captureAccessDismissed)
			.then((value) => setDismissed(value === '1'))
			.catch(() => setDismissed(false));
	}, []);

	if (supported && !enabled && !dismissed) {
		return (
			<View style={[styles.banner, styles.warning]}>
				<Ionicons name="notifications-off-outline" size={22} color="#000000" />
				<Pressable
					onPress={openSettings}
					accessibilityRole="button"
					accessibilityLabel={`${t('captures.accessOff')}. ${t('captures.accessOffAction')}`}
					accessibilityHint={t('captures.accessOffHint')}
					style={({ pressed }) => [styles.warningBody, pressed && styles.pressed]}
				>
					<Text style={styles.text}>{t('captures.accessOff')}</Text>
					<Text style={styles.action}>{t('captures.accessOffAction')}</Text>
				</Pressable>
				<Pressable
					onPress={() => {
						setDismissed(true);
						AsyncStorage.setItem(STORAGE_KEYS.captureAccessDismissed, '1').catch(() => {});
					}}
					accessibilityRole="button"
					accessibilityLabel={t('captures.accessOffDismiss')}
					hitSlop={12}
					style={({ pressed }) => [styles.dismiss, pressed && styles.pressed]}
				>
					<Ionicons name="close" size={20} color="#000000" />
				</Pressable>
			</View>
		);
	}

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
	warning: {
		backgroundColor: '#FFB74D',
	},
	warningBody: {
		flex: 1,
		flexDirection: 'row',
		alignItems: 'center',
		gap: 10,
	},
	dismiss: {
		minWidth: 32,
		minHeight: 44,
		alignItems: 'center',
		justifyContent: 'center',
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
