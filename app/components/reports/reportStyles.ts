import { StyleSheet } from 'react-native';
import type { HealthStatus } from '../../utils/healthScore';
import { ACCENT } from '../cards/formParts';

/**
 * Os tokens da tela de Relatórios, os mesmos do resto do app: fundo #121212, cartão
 * #1E1E1E, raio 12, padding 16. Concentrados aqui para as seções não repetirem.
 */
export const INCOME_COLOR = '#4CAF50';
export const EXPENSE_COLOR = '#FF6B6B';
export const WARN_COLOR = '#FFCC5C';
export const MUTED_COLOR = '#8A8A8A';
export { ACCENT };

/** Cor por status, sempre acompanhada de ícone e texto — nunca cor sozinha. */
export const STATUS_COLOR: Record<HealthStatus, string> = {
	good: INCOME_COLOR,
	warn: WARN_COLOR,
	bad: EXPENSE_COLOR,
	unknown: MUTED_COLOR,
};

export const reportStyles = StyleSheet.create({
	card: {
		backgroundColor: '#1E1E1E',
		borderRadius: 12,
		padding: 16,
		marginBottom: 16,
	},
	sectionHeader: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: 8,
		marginBottom: 4,
	},
	sectionTitle: {
		fontSize: 18,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	sectionSubtitle: {
		fontSize: 13,
		color: 'rgba(255, 255, 255, 0.6)',
		marginBottom: 12,
	},
	row: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
		minHeight: 40,
		paddingVertical: 6,
		gap: 12,
	},
	rowLabel: {
		flex: 1,
		fontSize: 15,
		color: 'rgba(255, 255, 255, 0.85)',
	},
	rowValue: {
		fontSize: 15,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	rowSub: {
		fontSize: 12,
		color: 'rgba(255, 255, 255, 0.55)',
		marginTop: 2,
	},
	muted: {
		fontSize: 13,
		color: 'rgba(255, 255, 255, 0.6)',
	},
	empty: {
		fontSize: 14,
		color: 'rgba(255, 255, 255, 0.6)',
		paddingVertical: 12,
		textAlign: 'center',
	},
	track: {
		height: 6,
		borderRadius: 3,
		backgroundColor: 'rgba(255, 255, 255, 0.12)',
		overflow: 'hidden',
	},
	fill: {
		height: 6,
		borderRadius: 3,
		backgroundColor: ACCENT,
	},
	hairline: {
		height: 1,
		backgroundColor: 'rgba(255, 255, 255, 0.1)',
		marginVertical: 8,
	},
	iconButton: {
		width: 48,
		height: 48,
		alignItems: 'center',
		justifyContent: 'center',
		borderRadius: 24,
		marginRight: -12,
	},
	pressed: {
		opacity: 0.6,
	},
});

export default reportStyles;
