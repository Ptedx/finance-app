import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import type React from 'react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useAuth } from '../contexts/AuthContext';
import { useTransactions } from '../contexts/TransactionsContext';
import { dismissReminder, shouldShowReminder } from '../utils/accountReminder';

/**
 * Convite discreto para criar conta, na tela inicial.
 *
 * Aparece uma vez só, depois que o usuário já tem lançamentos suficientes para ter algo
 * a perder. É um aviso, não um bloqueio: o app inteiro continua funcionando sem conta, e
 * o X faz o banner sumir para sempre.
 */
const AccountReminderBanner: React.FC = () => {
	const { t } = useTranslation();
	const { account, isAvailable } = useAuth();
	const { transactions } = useTransactions();
	const [visible, setVisible] = useState(false);

	useEffect(() => {
		if (!isAvailable) return;

		shouldShowReminder({ hasAccount: Boolean(account), transactionCount: transactions.length })
			.then(setVisible)
			.catch(() => setVisible(false));
	}, [account, isAvailable, transactions.length]);

	if (!visible) return null;

	const handleDismiss = async () => {
		setVisible(false);
		await dismissReminder();
	};

	return (
		<View style={styles.banner}>
			<Ionicons name="cloud-upload-outline" size={22} color="#15E8FE" style={styles.icon} />

			<TouchableOpacity
				style={styles.content}
				onPress={() => router.push('/account')}
				accessibilityRole="button"
				accessibilityLabel={t('account.reminderTitle')}
			>
				<Text style={styles.title}>{t('account.reminderTitle')}</Text>
				<Text style={styles.subtitle}>{t('account.reminderSubtitle')}</Text>
			</TouchableOpacity>

			<TouchableOpacity
				onPress={handleDismiss}
				hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
				accessibilityRole="button"
				accessibilityLabel={t('account.reminderDismiss')}
			>
				<Ionicons name="close" size={20} color="#8E8E93" />
			</TouchableOpacity>
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

export default AccountReminderBanner;
