import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useBills } from '../../contexts/BillsContext';
import { formatCents } from '../../utils/money';
import BillStatusPill from './BillStatusPill';

/**
 * "Contas do mês" na Home: cada conta ativa com o dia e a situação no mês corrente, e
 * quanto ainda falta pagar até o fim do mês. As de valor variável aparecem como "varia" e
 * ficam fora do total — o rodapé diz quantas, para o total não parecer tudo. Atrasada vem
 * em vermelho, com o texto dizendo "Atrasada".
 *
 * Tocar abre a tela de contas a pagar. Sem contas, um convite curto para cadastrar.
 */

const ACCENT = '#15E8FE';

const BillsMonthCard: React.FC = () => {
	const { t } = useTranslation();
	const router = useRouter();
	const { activeBills, month, isLoading } = useBills();

	if (isLoading) return null;

	const open = () => router.push('/bills/index');

	if (activeBills.length === 0) {
		return (
			<View style={styles.container}>
				<Text style={styles.title} accessibilityRole="header">
					{t('bills.home.title')}
				</Text>
				<View style={styles.invite}>
					<Text style={styles.inviteText}>{t('bills.home.invite')}</Text>
					<Pressable
						onPress={() => router.push('/bills/new')}
						accessibilityRole="button"
						accessibilityLabel={t('bills.home.inviteAction')}
						accessibilityHint={t('bills.home.invite')}
						style={({ pressed }) => [styles.inviteButton, pressed && styles.pressed]}
					>
						<Ionicons name="add" size={16} color={ACCENT} />
						<Text style={styles.inviteButtonText}>{t('bills.home.inviteAction')}</Text>
					</Pressable>
				</View>
			</View>
		);
	}

	const summary = [
		`${t('bills.home.title')}. ${t('bills.toPay')}, ${formatCents(month.dueCents)}`,
		month.variableCount > 0 ? t('bills.variableNote', { count: month.variableCount }) : null,
		month.lateCount > 0 ? t('bills.lateCount', { count: month.lateCount }) : null,
	]
		.filter(Boolean)
		.join('. ');

	return (
		<Pressable
			onPress={open}
			accessibilityRole="button"
			accessibilityLabel={summary}
			accessibilityHint={t('bills.home.open')}
			style={({ pressed }) => [styles.container, pressed && styles.pressed]}
		>
			<View style={styles.header}>
				<Text style={styles.title} accessibilityRole="header">
					{t('bills.home.title')}
				</Text>
				<Ionicons name="chevron-forward" size={20} color="rgba(255,255,255,0.5)" />
			</View>

			{month.rows.map((row) => {
				const late = row.status === 'late';
				return (
					<View key={row.bill.id} style={styles.row}>
						<View style={styles.rowText}>
							<Text style={[styles.rowName, late && styles.late]} numberOfLines={1}>
								{row.bill.name}
							</Text>
							<Text style={styles.rowSub}>
								{t('bills.day', { day: Number(row.dueDate.slice(8, 10)) })} ·{' '}
								{row.bill.amountCents === null
									? t('bills.variable')
									: formatCents(row.bill.amountCents)}
							</Text>
						</View>
						<BillStatusPill status={row.status} />
					</View>
				);
			})}

			<View style={styles.footer}>
				<View style={styles.footerLine}>
					<Text style={styles.footerLabel}>{t('bills.toPay')}</Text>
					<Text style={styles.footerValue}>
						{month.dueCents === 0 && month.variableCount === 0
							? t('bills.allPaid')
							: formatCents(month.dueCents)}
					</Text>
				</View>
				{month.variableCount > 0 ? (
					<Text style={styles.footerSub}>
						{t('bills.variableNote', { count: month.variableCount })}
					</Text>
				) : null}
				{month.lateCount > 0 ? (
					<Text style={[styles.footerSub, styles.late, styles.lateStrong]}>
						{t('bills.lateCount', { count: month.lateCount })}
					</Text>
				) : null}
			</View>
		</Pressable>
	);
};

const styles = StyleSheet.create({
	container: {
		backgroundColor: '#1E1E1E',
		borderRadius: 12,
		padding: 16,
		marginBottom: 20,
	},
	header: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
		marginBottom: 8,
	},
	title: {
		fontSize: 18,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	row: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: 12,
		minHeight: 44,
		paddingVertical: 6,
	},
	rowText: {
		flex: 1,
	},
	rowName: {
		fontSize: 15,
		color: '#FFFFFF',
	},
	rowSub: {
		fontSize: 12,
		color: 'rgba(255,255,255,0.6)',
		marginTop: 2,
	},
	late: {
		color: '#FF6B6B',
	},
	lateStrong: {
		fontWeight: '600',
	},
	footer: {
		marginTop: 8,
		paddingTop: 10,
		borderTopWidth: 1,
		borderTopColor: 'rgba(255,255,255,0.1)',
		gap: 2,
	},
	footerLine: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
	},
	footerLabel: {
		fontSize: 15,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	footerValue: {
		fontSize: 17,
		fontWeight: '700',
		color: '#FFFFFF',
	},
	footerSub: {
		fontSize: 12,
		color: 'rgba(255,255,255,0.6)',
	},
	invite: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: 8,
		marginTop: 8,
	},
	inviteText: {
		flex: 1,
		fontSize: 13,
		fontStyle: 'italic',
		color: 'rgba(255,255,255,0.6)',
	},
	inviteButton: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 6,
		minHeight: 44,
		paddingHorizontal: 12,
		borderRadius: 8,
		backgroundColor: 'rgba(21,232,254,0.12)',
	},
	inviteButtonText: {
		fontSize: 14,
		fontWeight: '600',
		color: ACCENT,
	},
	pressed: {
		opacity: 0.7,
	},
});

export default BillsMonthCard;
