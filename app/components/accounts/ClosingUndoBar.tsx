import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useAccounts } from '../../contexts/AccountsContext';

const ACCENT = '#15E8FE';

interface ClosingUndoBarProps {
	/** A conta ou o cartão desta tela: a barra só aparece para o encerramento dela. */
	accountId: string;
	/** O bloco de textos: `accounts.edit` (conta) ou `cards.edit` (cartão). */
	scope: 'accounts.edit' | 'cards.edit';
}

/**
 * "Desfazer" logo depois de encerrar uma conta ou um cartão (SPD-154), como a barra da caixa
 * de entrada: fica por `CLOSE_UNDO_WINDOW_MS` ou até sair da tela. O toque volta a conta a
 * ativa e apaga a transferência de encerramento (`undoClose`): os números voltam a ser os de
 * antes. Depois disso, o caminho é "Reabrir", que mantém a transferência.
 */
const ClosingUndoBar: React.FC<ClosingUndoBarProps> = ({ accountId, scope }) => {
	const { t } = useTranslation();
	const { closingUndo = null, undoClose, dismissClosingUndo } = useAccounts();
	const mine = closingUndo?.accountId === accountId ? closingUndo : null;
	const [busy, setBusy] = useState(false);

	// Sair da tela tira o "Desfazer" (só o desta conta).
	const leaving = useRef({ mine, dismissClosingUndo });
	leaving.current = { mine, dismissClosingUndo };
	useEffect(
		() => () => {
			if (leaving.current.mine) leaving.current.dismissClosingUndo?.();
		},
		[]
	);

	if (!mine) return null;

	const handleUndo = async () => {
		if (busy) return;
		setBusy(true);
		try {
			await undoClose(accountId);
			AccessibilityInfo.announceForAccessibility(t(`${scope}.closeUndone`));
		} catch (error) {
			// A janela passou (ou a conta mudou no meio): nada foi desfeito.
			console.error('Error undoing the account close:', error);
			Alert.alert(t(`${scope}.undoClose`), t(`${scope}.undoCloseExpired`));
		} finally {
			setBusy(false);
		}
	};

	return (
		<View style={styles.bar} accessibilityLiveRegion="polite">
			<Text style={styles.text}>{t(`${scope}.closed`)}</Text>
			<Pressable
				onPress={handleUndo}
				disabled={busy}
				accessibilityRole="button"
				accessibilityLabel={t(`${scope}.undoClose`)}
				accessibilityHint={t(`${scope}.undoCloseHint`)}
				style={({ pressed }) => [styles.button, pressed && styles.pressed]}
			>
				<Text style={styles.buttonText}>{t(`${scope}.undoClose`)}</Text>
			</Pressable>
		</View>
	);
};

const styles = StyleSheet.create({
	bar: {
		position: 'absolute',
		left: 16,
		right: 16,
		bottom: 24,
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
		backgroundColor: '#2A2A2A',
		borderRadius: 12,
		paddingVertical: 8,
		paddingLeft: 16,
		paddingRight: 8,
		borderWidth: 1,
		borderColor: 'rgba(255,255,255,0.15)',
	},
	text: {
		flex: 1,
		fontSize: 15,
		color: '#FFFFFF',
	},
	button: {
		minHeight: 44,
		paddingHorizontal: 16,
		justifyContent: 'center',
	},
	buttonText: {
		fontSize: 16,
		fontWeight: '700',
		color: ACCENT,
	},
	pressed: {
		opacity: 0.6,
	},
});

export default ClosingUndoBar;
