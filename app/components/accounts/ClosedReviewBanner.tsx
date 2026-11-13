import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useAccounts } from '../../contexts/AccountsContext';

/**
 * Aviso curto na tela inicial que leva à tela de Contas (SPD-149/150).
 *
 * Aparece quando uma conta apagada voltou como encerrada e o aviso ainda não foi lido, ou
 * quando há encerradas com saldo que a tela de Contas ainda não mostrou. Não tem X: some
 * sozinho depois que a tela de Contas mostrou o que havia para mostrar. A decisão sobre o
 * saldo continua lá enquanto houver saldo.
 */
const ClosedReviewBanner: React.FC = () => {
	const { t } = useTranslation();
	const { closedReview = [], closedReviewUnseen = false, revivalNotices = [] } = useAccounts();

	const revived = revivalNotices.length > 0;
	if (!revived && !closedReviewUnseen) return null;

	const title = closedReview.length > 0 ? t('accounts.closedReview.bannerTitle', { count: closedReview.length }) : t('accounts.closedReview.revivedTitle', { count: 1 });
	const body = revived ? t('accounts.closedReview.bannerRevived') : t('accounts.closedReview.bannerBody');

	return (
		<View style={styles.banner}>
			<Ionicons name="archive-outline" size={22} color="#15E8FE" style={styles.icon} />
			<TouchableOpacity
				style={styles.content}
				onPress={() => router.push('/accounts')}
				accessibilityRole="button"
				accessibilityLabel={`${title}. ${body}`}
				accessibilityHint={t('accounts.closedReview.bannerHint')}
			>
				<Text style={styles.title}>{title}</Text>
				<Text style={styles.subtitle}>{body}</Text>
			</TouchableOpacity>
			<Ionicons name="chevron-forward" size={18} color="#8E8E93" />
		</View>
	);
};

const styles = StyleSheet.create({
	banner: {
		flexDirection: 'row',
		alignItems: 'center',
		backgroundColor: '#1C1C1E',
		borderRadius: 12,
		borderWidth: 1,
		borderColor: '#2C2C2E',
		paddingVertical: 12,
		paddingHorizontal: 14,
		// Sem margem lateral: a Home já aplica seu próprio padding horizontal.
		marginBottom: 12,
	},
	icon: {
		marginRight: 12,
	},
	content: {
		flex: 1,
		marginRight: 8,
	},
	title: {
		color: '#FFFFFF',
		fontSize: 14,
		fontWeight: '600',
		marginBottom: 2,
	},
	subtitle: {
		color: '#8E8E93',
		fontSize: 12,
		lineHeight: 16,
	},
});

export default ClosedReviewBanner;
