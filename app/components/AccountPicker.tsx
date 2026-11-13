import { Ionicons } from '@expo/vector-icons';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useAccounts } from '../contexts/AccountsContext';
import type { Account, AccountKind } from '../database/schema';
import { parseCardNames } from '../utils/cardNames';
import { SelectField, type SelectOption } from './SelectField';
import { TourTarget } from './tour/TourContext';

/**
 * De qual conta ou cartão saiu (ou entrou) o dinheiro. Um campo que abre a lista das contas
 * (`SelectField`, SPD-130 — antes, uma linha de fichas), com "sem conta" como primeira linha:
 * a conta é opcional, e um lançamento sem ela só fica fora do saldo por conta — nunca fora
 * dos relatórios.
 *
 * Com um cartão de crédito escolhido, uma segunda linha pergunta **qual cartão** fez a
 * compra: o físico e os virtuais já vistos nessa conta (pelo final), ou um final novo
 * digitado. Todos caem na mesma fatura; o final só diz de qual cartão foi.
 */

export const ACCOUNT_KIND_ICONS: Record<AccountKind, React.ComponentProps<typeof Ionicons>['name']> = {
	checking: 'wallet-outline',
	savings: 'leaf-outline',
	investment: 'trending-up-outline',
	cash: 'cash-outline',
	credit_card: 'card-outline',
};

/**
 * As contas como opções de lista: ícone do tipo, cor da conta e o banco embaixo quando o nome
 * não o diz (separa duas fichas de mesmo nome).
 */
export const accountSelectOptions = (accounts: Account[]): SelectOption<string>[] =>
	accounts.map((account) => ({
		value: account.id,
		label: account.name,
		color: account.color,
		icon: ACCOUNT_KIND_ICONS[account.kind],
		description: account.bankName && account.bankName !== account.name ? account.bankName : undefined,
	}));

interface AccountPickerProps {
	selectedAccountId: string | null;
	onSelect: (accountId: string | null) => void;
	/** Final do cartão que fez a compra. Sem `onSelectLast4`, a linha dos cartões não aparece. */
	selectedLast4?: string | null;
	onSelectLast4?: (last4: string | null) => void;
}

const AccountPicker: React.FC<AccountPickerProps> = ({ selectedAccountId, onSelect, selectedLast4 = null, onSelectLast4 }) => {
	const { t } = useTranslation();
	const { activeAccounts } = useAccounts();

	if (activeAccounts.length === 0) return null;

	const selectedAccount = activeAccounts.find((account) => account.id === selectedAccountId);
	const showCards = Boolean(onSelectLast4) && selectedAccount?.kind === 'credit_card';
	const names = parseCardNames(selectedAccount?.cardNames);
	const knownCards = [...new Set([...(selectedAccount?.last4 ? [selectedAccount.last4] : []), ...Object.keys(names)])];
	const isNewCard = selectedLast4 !== null && !knownCards.includes(selectedLast4);

	const pickAccount = (value: string | null) => {
		if (value !== selectedAccountId) onSelectLast4?.(null);
		onSelect(value);
	};

	const cardChip = (last4: string | null, label: string) => {
		const selected = selectedLast4 === last4;
		const color = selectedAccount?.color ?? '#15E8FE';
		return (
			<Pressable
				key={last4 ?? 'unknown'}
				onPress={() => onSelectLast4?.(last4)}
				accessibilityRole="radio"
				accessibilityState={{ selected }}
				accessibilityLabel={label}
				style={({ pressed }) => [styles.chip, selected && { borderColor: color, backgroundColor: `${color}22` }, pressed && styles.pressed]}
			>
				<Ionicons name={selected ? 'checkmark-circle' : 'card-outline'} size={18} color={selected ? color : 'rgba(255,255,255,0.8)'} />
				<Text style={[styles.chipLabel, selected && { color }]} numberOfLines={1}>
					{label}
				</Text>
			</Pressable>
		);
	};

	return (
		<>
		<View style={styles.group}>
			<SelectField
				label={t('accounts.picker.label')}
				hint={t('accounts.picker.hint')}
				options={accountSelectOptions(activeAccounts)}
				selected={selectedAccountId}
				onSelect={pickAccount}
				clearLabel={t('accounts.picker.none')}
				onClear={() => pickAccount(null)}
			/>
		</View>
		{showCards ? (
			<TourTarget id="add.whichCard" style={styles.group}>
				<Text style={styles.label}>{t('accounts.picker.cardLabel')}</Text>
				<Text style={styles.hint}>{t('accounts.picker.cardHint')}</Text>
				<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row} accessibilityRole="radiogroup" accessibilityLabel={t('accounts.picker.cardLabel')}>
					{cardChip(null, t('accounts.picker.cardUnknown'))}
					{knownCards.map((last4) => cardChip(last4, names[last4] ? `${names[last4]} · ${last4}` : t('accounts.picker.cardEnding', { last4 })))}
				</ScrollView>
				<TextInput
					style={styles.last4Input}
					value={isNewCard ? (selectedLast4 ?? '') : ''}
					onChangeText={(text) => {
						const digits = text.replace(/\D/g, '').slice(0, 4);
						onSelectLast4?.(digits === '' ? null : digits);
					}}
					keyboardType="number-pad"
					maxLength={4}
					placeholder={t('accounts.picker.cardOther')}
					placeholderTextColor="rgba(255,255,255,0.35)"
					accessibilityLabel={t('accounts.picker.cardOther')}
				/>
			</TourTarget>
		) : null}
		</>
	);
};

const styles = StyleSheet.create({
	last4Input: {
		minHeight: 48,
		marginTop: 10,
		paddingHorizontal: 14,
		borderRadius: 10,
		borderWidth: 1,
		borderColor: 'rgba(255,255,255,0.2)',
		color: '#FFFFFF',
		fontSize: 16,
	},
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
