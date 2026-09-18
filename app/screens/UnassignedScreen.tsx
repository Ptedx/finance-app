import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AccountPicker from '../components/AccountPicker';
import TransactionItem from '../components/TransactionItem';
import { useAccounts } from '../contexts/AccountsContext';
import { useTransactions } from '../contexts/TransactionsContext';
import { formatCents } from '../utils/money';

/**
 * Lançamentos sem conta: os que entraram antes de existirem contas, ou digitados sem
 * escolher uma. Um toque move todos para a conta certa; um por um continua possível
 * pela tela de edição do lançamento.
 */

const ACCENT = '#15E8FE';

const UnassignedScreen = () => {
	const { t } = useTranslation();
	const router = useRouter();
	const { transactions } = useTransactions();
	const { activeAccounts, unassignedNetCents, assignUnassigned } = useAccounts();
	const [targetId, setTargetId] = useState<string | null>(null);
	const [moving, setMoving] = useState(false);

	const unassigned = useMemo(() => transactions.filter((tx) => tx.accountId === null), [transactions]);
	const target = activeAccounts.find((account) => account.id === targetId);

	const handleMove = () => {
		if (!target) return;
		Alert.alert(
			t('accounts.unassignedScreen.confirmTitle'),
			t('accounts.unassignedScreen.confirmBody', { count: unassigned.length, account: target.name }),
			[
				{ text: t('accounts.edit.cancel'), style: 'cancel' },
				{
					text: t('accounts.unassignedScreen.move'),
					onPress: async () => {
						try {
							setMoving(true);
							const changed = await assignUnassigned(target.id);
							AccessibilityInfo.announceForAccessibility(t('accounts.unassignedScreen.moved', { count: changed }));
							router.back();
						} finally {
							setMoving(false);
						}
					},
				},
			]
		);
	};

	return (
		<SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
			<Stack.Screen options={{ headerShown: false }} />
			<View style={styles.header}>
				<Pressable
					onPress={() => router.back()}
					accessibilityRole="button"
					accessibilityLabel={t('accounts.back')}
					hitSlop={12}
					style={styles.backButton}
				>
					<Ionicons name="arrow-back" size={24} color="#FFFFFF" />
				</Pressable>
				<Text style={styles.headerTitle} accessibilityRole="header">
					{t('accounts.unassigned')}
				</Text>
			</View>

			<ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
				<View style={styles.summary} accessible accessibilityLabel={t('accounts.unassignedScreen.summary', { count: unassigned.length, net: formatCents(unassignedNetCents) })}>
					<Text style={styles.summaryText}>
						{t('accounts.unassignedScreen.summary', { count: unassigned.length, net: formatCents(unassignedNetCents) })}
					</Text>
					<Text style={styles.summaryHint}>{t('accounts.unassignedScreen.hint')}</Text>
				</View>

				{unassigned.length > 0 && (
					<>
						<AccountPicker selectedAccountId={targetId} onSelect={setTargetId} />
						<Pressable
							onPress={handleMove}
							disabled={!target || moving}
							accessibilityRole="button"
							accessibilityLabel={t('accounts.unassignedScreen.moveAll', { count: unassigned.length })}
							accessibilityState={{ disabled: !target || moving }}
							style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed, (!target || moving) && styles.disabled]}
						>
							<Text style={styles.primaryButtonText}>{t('accounts.unassignedScreen.moveAll', { count: unassigned.length })}</Text>
						</Pressable>
					</>
				)}

				<View style={styles.list}>
					{unassigned.map((transaction) => (
						<TransactionItem
							key={transaction.id}
							transaction={transaction}
							onPress={(tx) => router.push({ pathname: '/transaction/[id]', params: { id: tx.id } })}
						/>
					))}
				</View>
			</ScrollView>
		</SafeAreaView>
	);
};

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: '#121212',
	},
	header: {
		flexDirection: 'row',
		alignItems: 'center',
		paddingHorizontal: 16,
		paddingVertical: 12,
	},
	backButton: {
		minWidth: 48,
		minHeight: 48,
		justifyContent: 'center',
	},
	headerTitle: {
		flex: 1,
		fontSize: 22,
		fontWeight: 'bold',
		color: '#FFFFFF',
	},
	content: {
		paddingHorizontal: 16,
		paddingBottom: 120,
	},
	summary: {
		backgroundColor: '#1E1E1E',
		borderRadius: 12,
		padding: 16,
		marginBottom: 16,
		gap: 6,
	},
	summaryText: {
		fontSize: 16,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	summaryHint: {
		fontSize: 14,
		lineHeight: 20,
		color: 'rgba(255,255,255,0.75)',
	},
	primaryButton: {
		minHeight: 48,
		borderRadius: 10,
		backgroundColor: ACCENT,
		alignItems: 'center',
		justifyContent: 'center',
		marginBottom: 16,
	},
	primaryButtonText: {
		fontSize: 16,
		fontWeight: '600',
		color: '#000000',
	},
	pressed: {
		opacity: 0.7,
	},
	disabled: {
		opacity: 0.4,
	},
	list: {
		backgroundColor: '#1E1E1E',
		borderRadius: 12,
		paddingHorizontal: 16,
	},
});

export default UnassignedScreen;
