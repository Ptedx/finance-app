import type React from 'react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, StyleSheet, Text } from 'react-native';
import type { Account } from '../../database/schema';
import { centsToDisplayInput, formatCents, parseAmountToCents } from '../../utils/money';
import { Button, Field } from '../cards/formParts';
import Sheet from '../cards/Sheet';

/**
 * Acertar uma conta com o app do banco, na primeira vez.
 *
 * Dois campos que são o mesmo dinheiro visto de dois lados: o que já saiu no mês e o que
 * ainda há na conta. Mexer num muda o outro, porque o total do mês é a soma dos dois —
 * digitar "gastei 845,20" já mostra "tem 154,80". O usuário pode corrigir o que tem na
 * conta quando sobrou dinheiro do mês anterior, e aí o teto do mês sobe sozinho.
 *
 * Sem escolher "modo": o app decide o que é gasto (entra no mês) e o que é sobra de antes
 * (só ponto de partida).
 */
const AdjustAccountSheet: React.FC<{
	visible: boolean;
	account: Account;
	spentCents: number;
	balanceCents: number;
	isEnvelope: boolean;
	onClose: () => void;
	onConfirm: (input: { spentCents: number; balanceCents: number }) => Promise<void>;
}> = ({ visible, account, spentCents, balanceCents, isEnvelope, onClose, onConfirm }) => {
	const { t } = useTranslation();
	const [spent, setSpent] = useState('');
	const [balance, setBalance] = useState('');
	const [error, setError] = useState<string | undefined>();

	useEffect(() => {
		if (!visible) return;
		setSpent(centsToDisplayInput(spentCents));
		setBalance(centsToDisplayInput(balanceCents));
		setError(undefined);
	}, [visible, spentCents, balanceCents]);

	// O dinheiro do mês: o que já saiu mais o que ainda está lá.
	const availableCents = spentCents + balanceCents;
	const typedSpent = parseAmountToCents(spent);
	const typedBalance = parseAmountToCents(balance);

	const onSpentChange = (text: string) => {
		setSpent(text);
		const value = parseAmountToCents(text);
		if (value !== null) setBalance(centsToDisplayInput(Math.max(0, availableCents - value)));
	};

	const onBalanceChange = (text: string) => {
		setBalance(text);
		const value = parseAmountToCents(text);
		if (value !== null) setSpent(centsToDisplayInput(Math.max(0, availableCents - value)));
	};

	const preview =
		typedSpent === null || typedBalance === null
			? null
			: isEnvelope
				? t('accounts.adjust.previewEnvelope', {
						spent: formatCents(typedSpent),
						target: formatCents(typedSpent + typedBalance),
					})
				: t('accounts.adjust.preview', { spent: formatCents(typedSpent), balance: formatCents(typedBalance) });

	return (
		<Sheet
			visible={visible}
			onClose={onClose}
			title={t('accounts.adjust.title', { account: account.name })}
			subtitle={t('accounts.adjust.subtitle')}
		>
			<Field
				label={t('accounts.adjust.spent')}
				hint={t('accounts.adjust.spentHint')}
				value={spent}
				onChangeText={onSpentChange}
				keyboardType="decimal-pad"
			/>
			<Field
				label={t('accounts.adjust.balance')}
				hint={t('accounts.adjust.balanceHint')}
				value={balance}
				onChangeText={onBalanceChange}
				keyboardType="decimal-pad"
				error={error}
			/>
			{preview ? (
				<Text style={styles.preview} accessibilityLiveRegion="polite">
					{preview}
				</Text>
			) : null}
			<Button
				label={t('accounts.adjust.confirm')}
				icon="checkmark"
				onPress={async () => {
					if (typedSpent === null || typedBalance === null || typedSpent < 0) {
						setError(t('accounts.edit.invalidAmount'));
						AccessibilityInfo.announceForAccessibility(t('accounts.edit.invalidAmount'));
						return;
					}
					await onConfirm({ spentCents: typedSpent, balanceCents: typedBalance });
					AccessibilityInfo.announceForAccessibility(t('accounts.adjust.done'));
				}}
			/>
		</Sheet>
	);
};

const styles = StyleSheet.create({
	preview: {
		fontSize: 15,
		lineHeight: 22,
		color: '#FFFFFF',
		backgroundColor: 'rgba(21,232,254,0.1)',
		borderRadius: 12,
		padding: 12,
	},
});

export default AdjustAccountSheet;
