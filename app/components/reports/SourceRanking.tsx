import { Ionicons } from '@expo/vector-icons';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';
import { formatCents } from '../../utils/money';
import type { SpendSourceKind, SpendSourceRow } from '../../utils/reportSeries';
import { ACCENT, reportStyles } from './reportStyles';

const KIND_ICON: Record<SpendSourceKind, React.ComponentProps<typeof Ionicons>['name']> = {
	card: 'card',
	debit: 'card-outline',
	pix: 'flash',
	envelope: 'wallet',
	unassigned: 'help-circle-outline',
};

/**
 * De onde saiu o gasto do mês: cada cartão de crédito, cada cartão de débito pelo final,
 * o Pix da conta, os envelopes e o que não tem conta. É o "qual cartão gasta mais".
 */
const SourceRanking: React.FC<{ rows: SpendSourceRow[] }> = ({ rows }) => {
	const { t } = useTranslation();

	const labelOf = (row: SpendSourceRow): string => {
		switch (row.kind) {
			case 'debit':
				return `${row.name ?? ''} •${row.last4 ?? ''}`.trim();
			case 'pix':
				return t('reports.sources.kind.pix', { account: row.name ?? '' });
			case 'unassigned':
				return t('reports.sources.kind.unassigned');
			default:
				return row.name ?? '';
		}
	};

	return (
		<View style={reportStyles.card}>
			<Text style={reportStyles.sectionTitle} accessibilityRole="header">
				{t('reports.sources.title')}
			</Text>
			<Text style={reportStyles.sectionSubtitle}>{t('reports.sources.subtitle')}</Text>

			{rows.length === 0 ? (
				<Text style={reportStyles.empty}>{t('reports.sources.empty')}</Text>
			) : (
				rows.map((row) => {
					const label = labelOf(row);
					const share = `${Math.round(row.shareBp / 100)}%`;
					return (
						<View key={row.key} style={styles.row} accessible accessibilityLabel={`${t(`reports.sources.kind.${row.kind}`, { account: row.name ?? '' })}, ${label}: ${formatCents(row.cents)}, ${share}`}>
							<View style={styles.rowHeader}>
								<Ionicons name={KIND_ICON[row.kind]} size={16} color={ACCENT} />
								<Text style={styles.name} numberOfLines={1}>
									{label}
								</Text>
								<Text style={reportStyles.rowValue}>{formatCents(row.cents)}</Text>
							</View>
							<View style={reportStyles.track} accessible={false}>
								<View style={[reportStyles.fill, { width: `${Math.max(1, row.shareBp / 100)}%` }]} />
							</View>
							<Text style={reportStyles.rowSub}>{share}</Text>
						</View>
					);
				})
			)}
		</View>
	);
};

const styles = StyleSheet.create({
	row: {
		paddingVertical: 8,
	},
	rowHeader: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 8,
		marginBottom: 6,
	},
	name: {
		flex: 1,
		fontSize: 15,
		color: '#FFFFFF',
	},
});

export default SourceRanking;
