import type React from 'react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, StyleSheet, Text, View } from 'react-native';
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
 *
 * Por isso o app só preenche um campo **enquanto o usuário não digitou nele**. Antes, cada
 * tecla num campo recalculava o outro: numa conta nova o dinheiro do mês é zero, e digitar
 * "gastei 1.200" e depois "tenho 5.000" zerava o gasto (E2E-01). Digitados os dois, valem
 * os dois, e a prévia diz quanto do que não fecha é dinheiro de antes — ponto de partida,
 * não receita do mês.
 *
 * Numa reserva ou investimento não existe "gasto do mês": o dinheiro só entra, sai por
 * transferência e rende. Ali a folha tem um campo só, o saldo de hoje, e acertar nunca
 * lança despesa — antes, digitar o saldo recalculava um "gasto" e o lançava.
 */
const AdjustAccountSheet: React.FC<{
	visible: boolean;
	account: Account;
	/** Gasto que o app já tem no período. */
	spentCents: number;
	/** O mês de onde vem o gasto pré-preenchido, escrito. Ver `accounts.adjust.spent`. */
	monthLabel: string;
	/** Saldo que o app tem hoje. */
	balanceCents: number;
	/** O dinheiro do mês, que liga os dois campos. */
	targetCents: number;
	isEnvelope: boolean;
	/** Reserva ou investimento: só o saldo, sem gasto do mês. */
	balanceOnly?: boolean;
	onClose: () => void;
	onConfirm: (input: { spentCents: number; balanceCents: number }) => Promise<void>;
}> = ({ visible, account, spentCents, monthLabel, balanceCents, targetCents, isEnvelope, balanceOnly = false, onClose, onConfirm }) => {
	const { t } = useTranslation();
	const [spent, setSpent] = useState('');
	const [balance, setBalance] = useState('');
	// Os campos que o usuário já digitou: nesses o app não escreve mais.
	const [typed, setTyped] = useState({ spent: false, balance: false });
	const [error, setError] = useState<string | undefined>();

	useEffect(() => {
		if (!visible) return;
		setSpent(centsToDisplayInput(spentCents));
		setBalance(centsToDisplayInput(balanceCents));
		setTyped({ spent: false, balance: false });
		setError(undefined);
	}, [visible, spentCents, balanceCents]);

	// Sem dinheiro do mês conhecido (conta nova), o par continua sendo o que o app tem.
	const availableCents = targetCents > 0 ? targetCents : spentCents + balanceCents;

	const typedSpent = parseAmountToCents(spent);
	const typedBalance = parseAmountToCents(balance);

	const onSpentChange = (text: string) => {
		const next = formatAmountInput(text);
		setSpent(next);
		setTyped((current) => ({ ...current, spent: true }));
		const value = parseAmountToCents(next);
		if (value !== null && !typed.balance) setBalance(centsToDisplayInput(counterpartCents(availableCents, value)));
	};

	const onBalanceChange = (text: string) => {
		const next = formatAmountInput(text);
		setBalance(next);
		setTyped((current) => ({ ...current, balance: true }));
		if (balanceOnly) return;
		const value = parseAmountToCents(next);
		if (value !== null && !typed.spent) setSpent(centsToDisplayInput(counterpartCents(availableCents, value)));
	};

	const preview =
		typedSpent === null || typedBalance === null
			? null
			: balanceOnly
				? t('accounts.adjust.previewBalanceOnly', { balance: formatCents(typedBalance) })
				: isEnvelope
				? t('accounts.adjust.previewEnvelope', {
						spent: formatCents(typedSpent),
						target: formatCents(typedSpent + typedBalance),
					})
				: t('accounts.adjust.preview', { spent: formatCents(typedSpent), balance: formatCents(typedBalance) });

	// O que não fecha com o que o app sabia: lançada a diferença do gasto, o saldo ainda
	// precisa andar isto para bater, e anda pela âncora (`adjustAccountMonth`), fora do mês.
	const beforeCents =
		balanceOnly || typedSpent === null || typedBalance === null ? 0 : typedBalance + typedSpent - spentCents - balanceCents;
	const beforeNote =
		beforeCents > 0
			? t('accounts.adjust.previewBefore', { amount: formatCents(beforeCents) })
			: beforeCents < 0
				? t('accounts.adjust.previewBeforeLess', { amount: formatCents(-beforeCents) })
				: null;

	return (
		<Sheet
			visible={visible}
			onClose={onClose}
			title={t('accounts.adjust.title', { account: account.name })}
			subtitle={balanceOnly ? t('accounts.adjust.subtitleBalanceOnly') : t('accounts.adjust.subtitle')}
		>
			{balanceOnly ? null : (
			<Field
				label={t('accounts.adjust.spent', { month: monthLabel })}
				hint={t('accounts.adjust.spentHint', { month: monthLabel })}
				value={spent}
				onChangeText={onSpentChange}
				onBlur={() => setSpent(finaliseAmountInput(spent))}
				keyboardType="decimal-pad"
				selectTextOnFocus
			/>
			)}
			<Field
				label={balanceOnly ? t('accounts.adjust.balanceToday') : t('accounts.adjust.balance')}
				hint={balanceOnly ? t('accounts.adjust.balanceTodayHint') : t('accounts.adjust.balanceHint')}
				value={balance}
				onChangeText={onBalanceChange}
				onBlur={() => setBalance(finaliseAmountInput(balance))}
				keyboardType="decimal-pad"
				selectTextOnFocus
				error={error}
			/>
			{preview ? (
				<View style={styles.preview} accessibilityLiveRegion="polite">
					<Text style={styles.previewText}>{preview}</Text>
					{beforeNote ? <Text style={[styles.previewText, styles.previewNote]}>{beforeNote}</Text> : null}
				</View>
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
					// Só saldo: o gasto informado é o que o app já tem, então nada é lançado.
					await onConfirm({ spentCents: balanceOnly ? spentCents : typedSpent, balanceCents: typedBalance });
					AccessibilityInfo.announceForAccessibility(t('accounts.adjust.done'));
				}}
			/>
		</Sheet>
	);
};

const styles = StyleSheet.create({
	preview: {
		backgroundColor: 'rgba(21,232,254,0.1)',
		borderRadius: 12,
		padding: 12,
		gap: 6,
	},
	previewText: {
		fontSize: 15,
		lineHeight: 22,
		color: '#FFFFFF',
	},
	previewNote: {
		fontSize: 14,
		lineHeight: 20,
		color: 'rgba(255,255,255,0.75)',
	},
});

export default AdjustAccountSheet;
