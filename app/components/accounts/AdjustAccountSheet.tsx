import type React from 'react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, StyleSheet, Text } from 'react-native';
import type { Account } from '../../database/schema';
import { counterpartCents } from '../../utils/accountMath';
import { centsToDisplayInput, finaliseAmountInput, formatAmountInput, formatCents, parseAmountToCents } from '../../utils/money';
import { Button, Field } from '../cards/formParts';
import Sheet from '../cards/Sheet';

/**
 * Acertar uma conta com o app do banco, na primeira vez.
 *
 * Dois campos que são o mesmo dinheiro visto de dois lados: o que já saiu no mês e o que
 * ainda há na conta. Eles se ligam pelo **dinheiro do mês** — no envelope, o teto da barra
 * (a sobra do mês anterior mais o que entrou); nas outras contas, o que o app tem hoje
 * mais o que já viu sair. Digitar "gastei 845,20" com R$ 1.000 no mês mostra "tem 154,80",
 * e digitar quanto tem calcula o gasto de volta.
 *
 * Mexer nos dois é permitido de propósito: quando sobrou dinheiro do mês passado que o app
 * não conhecia, a conta não fecha com o teto de hoje, e é o usuário quem sabe disso. O app
 * então lança o gasto no mês e trata o resto como ponto de partida.
 */
const AdjustAccountSheet: React.FC<{
	visible: boolean;
	account: Account;
	/** Gasto que o app já tem no período. */
	spentCents: number;
	/** Saldo que o app tem hoje. */
	balanceCents: number;
	/** O dinheiro do mês, que liga os dois campos. */
	targetCents: number;
	isEnvelope: boolean;
	onClose: () => void;
	onConfirm: (input: { spentCents: number; balanceCents: number }) => Promise<void>;
}> = ({ visible, account, spentCents, balanceCents, targetCents, isEnvelope, onClose, onConfirm }) => {
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

	// Sem dinheiro do mês conhecido (conta nova), o par continua sendo o que o app tem.
	const availableCents = targetCents > 0 ? targetCents : spentCents + balanceCents;

	const typedSpent = parseAmountToCents(spent);
	const typedBalance = parseAmountToCents(balance);

	const onSpentChange = (text: string) => {
		const next = formatAmountInput(text);
		setSpent(next);
		const value = parseAmountToCents(next);
		if (value !== null) setBalance(centsToDisplayInput(counterpartCents(availableCents, value)));
	};

	const onBalanceChange = (text: string) => {
		const next = formatAmountInput(text);
		setBalance(next);
		const value = parseAmountToCents(next);
		if (value !== null) setSpent(centsToDisplayInput(counterpartCents(availableCents, value)));
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
				onBlur={() => setSpent(finaliseAmountInput(spent))}
				keyboardType="decimal-pad"
				selectTextOnFocus
			/>
			<Field
				label={t('accounts.adjust.balance')}
				hint={t('accounts.adjust.balanceHint')}
				value={balance}
				onChangeText={onBalanceChange}
				onBlur={() => setBalance(finaliseAmountInput(balance))}
				keyboardType="decimal-pad"
				selectTextOnFocus
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
					if (typedSpent === null || typedBalance === null || typedSpent < 0 || typedBalance < 0) {
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
