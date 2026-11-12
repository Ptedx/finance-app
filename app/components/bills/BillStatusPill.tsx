import type React from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';
import type { BillStatus } from '../../utils/billReminders';

/**
 * A situação de uma conta no mês, em texto e cor — nunca só a cor: "Atrasada" se lê
 * mesmo sem distinguir o vermelho.
 */

export const STATUS_COLORS: Record<BillStatus, string> = {
	paid: '#4CAF50',
	// O mês pulado (SPD-146): nem verde de pago, nem vermelho de atraso.
	skipped: 'rgba(255,255,255,0.6)',
	upcoming: 'rgba(255,255,255,0.75)',
	due_today: '#FFB74D',
	late: '#FF6B6B',
};

const STATUS_BACKGROUNDS: Record<BillStatus, string> = {
	paid: 'rgba(76,175,80,0.14)',
	skipped: 'rgba(255,255,255,0.05)',
	upcoming: 'rgba(255,255,255,0.08)',
	due_today: 'rgba(255,183,77,0.16)',
	late: 'rgba(255,107,107,0.18)',
};

const BillStatusPill: React.FC<{ status: BillStatus }> = ({ status }) => {
	const { t } = useTranslation();
	return (
		<View style={[styles.pill, { backgroundColor: STATUS_BACKGROUNDS[status] }]}>
			<Text style={[styles.text, { color: STATUS_COLORS[status] }]}>
				{t(`bills.status.${status}`)}
			</Text>
		</View>
	);
};

const styles = StyleSheet.create({
	pill: {
		paddingHorizontal: 10,
		paddingVertical: 4,
		borderRadius: 12,
	},
	text: {
		fontSize: 12,
		fontWeight: '700',
	},
});

export default BillStatusPill;
