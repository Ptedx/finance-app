import { Ionicons } from '@expo/vector-icons';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useAccounts } from '../contexts/AccountsContext';
import type { Account, AccountKind } from '../database/schema';

/**
 * De qual conta ou cartão saiu (ou entrou) o dinheiro. Uma linha de fichas, com
 * "sem conta" como primeira opção: a conta é opcional, e um lançamento sem ela só fica
 * fora do saldo por conta — nunca fora dos relatórios.
 *
 * Fichas são botões de rádio para o leitor de tela (`accessibilityRole="radio"` com
 * `selected`), têm 48 pontos de altura e o estado selecionado não depende só de cor:
 * a ficha ativa ganha ícone de check.
 */

export const ACCOUNT_KIND_ICONS: Record<AccountKind, React.ComponentProps<typeof Ionicons>['name']> = {
	checking: 'wallet-outline',
	savings: 'leaf-outline',
	investment: 'trending-up-outline',
	cash: 'cash-outline',
	credit_card: 'card-outline',
};

interface AccountPickerProps {
	selectedAccountId: string | null;
	onSelect: (accountId: string | null) => void;
}

const AccountPicker: React.FC<AccountPickerProps> = ({ selectedAccountId, onSelect }) => {
	const { t } = useTranslation();
	const { activeAccounts } = useAccounts();

	if (activeAccounts.length === 0) return null;

	const chip = (key: string, label: string, icon: React.ComponentProps<typeof Ionicons>['name'], value: string | null, color: string) => {
		const selected = selectedAccountId === value;
		return (
			<Pressable
				key={key}
				onPress={() => onSelect(value)}
				accessibilityRole="radio"
				accessibilityState={{ selected }}
				accessibilityLabel={label}
				style={({ pressed }) => [
					styles.chip,
					selected && { borderColor: color, backgroundColor: `${color}22` },
					pressed && styles.pressed,
				]}
			>
				<Ionicons name={selected ? 'checkmark-circle' : icon} size={18} color={selected ? color : 'rgba(255,255,255,0.8)'} />
				<Text style={[styles.chipLabel, selected && { color }]} numberOfLines={1}>
					{label}
				</Text>
			</Pressable>
		);
	};

	return (
		<View style={styles.group} accessibilityRole="radiogroup" accessibilityLabel={t('accounts.picker.label')}>
			<Text style={styles.label}>{t('accounts.picker.label')}</Text>
			<Text style={styles.hint}>{t('accounts.picker.hint')}</Text>
			<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
				{chip('none', t('accounts.picker.none'), 'remove-circle-outline', null, '#15E8FE')}
				{activeAccounts.map((account: Account) =>
					chip(account.id, account.name, ACCOUNT_KIND_ICONS[account.kind], account.id, account.color)
				)}
			</ScrollView>
		</View>
	);
};

const styles = StyleSheet.create({
	group: {
		marginBottom: 20,
	},
	label: {
		fontSize: 14,
		color: 'rgba(255, 255, 255, 0.7)',
		marginBottom: 2,
	},
	hint: {
		fontSize: 12,
		color: 'rgba(255, 255, 255, 0.5)',
		marginBottom: 8,
	},
	row: {
		gap: 8,
		paddingVertical: 2,
	},
	chip: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 6,
		minHeight: 48,
		paddingHorizontal: 14,
		borderRadius: 24,
		borderWidth: 1.5,
		borderColor: 'rgba(255,255,255,0.2)',
		backgroundColor: 'rgba(255,255,255,0.05)',
		maxWidth: 220,
	},
	chipLabel: {
		fontSize: 14,
		color: '#FFFFFF',
	},
	pressed: {
		opacity: 0.7,
	},
});

export default AccountPicker;
