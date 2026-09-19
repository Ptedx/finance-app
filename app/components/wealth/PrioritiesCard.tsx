import { Ionicons } from '@expo/vector-icons';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';
import { formatCents } from '../../utils/money';
import type { PriorityItem, PriorityStatus } from '../../utils/priorities';
import { ACCENT } from '../cards/formParts';

const ICONS: Record<PriorityStatus, React.ComponentProps<typeof Ionicons>['name']> = {
	done: 'checkmark-circle',
	doing: 'arrow-forward-circle',
	next: 'ellipse-outline',
	setup: 'help-circle-outline',
};

const COLORS: Record<PriorityStatus, string> = {
	done: '#4CAF50',
	doing: ACCENT,
	next: 'rgba(255,255,255,0.4)',
	setup: '#FFB74D',
};

/**
 * "Por onde começar": a ordem do que fazer com o próximo real que sobrar, com o degrau de
 * agora em destaque. Cada linha diz o que falta; os degraus de baixo esperam a vez.
 */
const PrioritiesCard: React.FC<{ items: PriorityItem[]; reserveMonths: number }> = ({ items, reserveMonths }) => {
	const { t } = useTranslation();

	return (
		<View style={styles.card}>
			<Text style={styles.title} accessibilityRole="header">
				{t('priorities.title')}
			</Text>
			<Text style={styles.subtitle}>{t('priorities.subtitle')}</Text>
			{items.map((item, index) => {
				const label = t(`priorities.${item.id}.label`, { months: reserveMonths });
				const detail =
					item.status === 'done'
						? t(`priorities.${item.id}.done`)
						: item.status === 'setup'
							? t(`priorities.${item.id}.setup`)
							: t(`priorities.${item.id}.missing`, { amount: formatCents(item.missingCents ?? 0) });
				return (
					<View
						key={item.id}
						style={[styles.row, item.status === 'doing' && styles.rowCurrent]}
						accessible
						accessibilityLabel={`${index + 1}. ${label}. ${t(`priorities.status.${item.status}`)}. ${detail}`}
					>
						<Ionicons name={ICONS[item.status]} size={22} color={COLORS[item.status]} />
						<View style={styles.rowText}>
							<Text style={[styles.label, item.status === 'next' && styles.dim]}>
								{index + 1}. {label}
							</Text>
							<Text style={[styles.detail, item.status === 'next' && styles.dim]}>{detail}</Text>
						</View>
					</View>
				);
			})}
		</View>
	);
};

const styles = StyleSheet.create({
	card: {
		backgroundColor: '#1E1E1E',
		borderRadius: 12,
		padding: 16,
		marginBottom: 16,
		gap: 8,
	},
	title: {
		fontSize: 18,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	subtitle: {
		fontSize: 13,
		lineHeight: 18,
		color: 'rgba(255,255,255,0.65)',
	},
	row: {
		flexDirection: 'row',
		alignItems: 'flex-start',
		gap: 12,
		paddingVertical: 8,
		paddingHorizontal: 8,
		borderRadius: 10,
	},
	rowCurrent: {
		backgroundColor: 'rgba(21, 232, 254, 0.08)',
	},
	rowText: {
		flex: 1,
		gap: 2,
	},
	label: {
		fontSize: 15,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	detail: {
		fontSize: 13,
		lineHeight: 18,
		color: 'rgba(255,255,255,0.7)',
	},
	dim: {
		color: 'rgba(255,255,255,0.45)',
	},
});

export default PrioritiesCard;
