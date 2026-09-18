import { Ionicons } from '@expo/vector-icons';
import type React from 'react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';
import type { Account, Transfer } from '../database/schema';
import { formatDate } from '../utils/dateUtils';
import { formatCents } from '../utils/money';

/**
 * Uma transferência entre contas suas na lista de lançamentos.
 *
 * Dinheiro trocando de bolso não é gasto nem receita — mandar R$ 1.000 para o envelope ou
 * pagar a fatura muda o saldo das contas e não muda o mês. Por isso a linha é cinza, sem
 * "+" nem "−": sem ela, uma conta com muito movimento e poucas compras parecia vazia.
 */
const TransferItem: React.FC<{ transfer: Transfer; accountsById: Map<string, Account> }> = ({ transfer, accountsById }) => {
	const { t } = useTranslation();
	const nameOf = (id: string | null) => (id ? (accountsById.get(id)?.name ?? t('transactionsList.unknownAccount')) : t('transactionsList.outside'));
	const route = t('transactionsList.transferBetween', { from: nameOf(transfer.fromAccountId), to: nameOf(transfer.toAccountId) });

	return (
		<View
			style={styles.container}
			accessible
			accessibilityLabel={`${t('transactionsList.transfer')}, ${route}, ${formatCents(transfer.amountCents)}, ${formatDate(transfer.date)}`}
		>
			<View style={styles.icon}>
				<Ionicons name="swap-horizontal" size={18} color="#000000" />
			</View>

			<View style={styles.details}>
				<Text style={styles.title} numberOfLines={1}>
					{transfer.note?.trim() || t('transactionsList.transfer')}
				</Text>
				<Text style={styles.route} numberOfLines={1}>
					{route}
				</Text>
			</View>

			<View style={styles.amountContainer}>
				<Text style={styles.amount}>{formatCents(transfer.amountCents)}</Text>
				<Text style={styles.date}>{formatDate(transfer.date)}</Text>
			</View>
		</View>
	);
};

const styles = StyleSheet.create({
	container: {
		flexDirection: 'row',
		alignItems: 'center',
		paddingVertical: 12,
		gap: 12,
		borderBottomWidth: 1,
		borderBottomColor: 'rgba(255,255,255,0.06)',
	},
	icon: {
		width: 36,
		height: 36,
		borderRadius: 18,
		alignItems: 'center',
		justifyContent: 'center',
		backgroundColor: 'rgba(255,255,255,0.55)',
	},
	details: {
		flex: 1,
	},
	title: {
		fontSize: 15,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	route: {
		fontSize: 13,
		color: 'rgba(255,255,255,0.65)',
		marginTop: 2,
	},
	amountContainer: {
		alignItems: 'flex-end',
	},
	amount: {
		fontSize: 15,
		fontWeight: '600',
		color: 'rgba(255,255,255,0.8)',
	},
	date: {
		fontSize: 12,
		color: 'rgba(255,255,255,0.5)',
		marginTop: 2,
	},
});

export default memo(TransferItem);
