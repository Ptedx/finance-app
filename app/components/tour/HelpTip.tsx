import { Ionicons } from '@expo/vector-icons';
import type React from 'react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, Alert, Pressable, StyleSheet, Text, View } from 'react-native';

/**
 * A dica rápida de um "?" (SPD-135): uma ou duas frases sobre o que aquilo faz, ali mesmo, e
 * um link "Ver o guia completo" para o tópico de Ajustes › Como usar.
 *
 * Antes o "?" do Acertar fechava a folha e abria o tópico direto, e o que estava digitado se
 * perdia sem aviso. Com `confirmLeave` (há algo digitado e não salvo), o link pergunta antes
 * de sair; sem nada digitado, vai direto.
 *
 * Quem abre e fecha a dica é quem a mostra (a `Sheet`, pela prop `help`). Ao abrir, o leitor
 * de tela lê a dica.
 */
const HelpTip: React.FC<{
	text: string;
	/** Abre o guia completo (o tópico em Como usar). */
	onOpenGuide: () => void;
	/** Há algo digitado e não salvo: o link pergunta antes de sair. */
	confirmLeave?: boolean;
}> = ({ text, onOpenGuide, confirmLeave = false }) => {
	const { t } = useTranslation();

	useEffect(() => {
		AccessibilityInfo.announceForAccessibility(text);
	}, [text]);

	const openGuide = () => {
		if (!confirmLeave) {
			onOpenGuide();
			return;
		}
		Alert.alert(
			t('tutorial.tip.leaveTitle'),
			t('tutorial.tip.leaveBody'),
			[
				{ text: t('tutorial.tip.stay'), style: 'cancel' },
				{ text: t('tutorial.tip.leave'), style: 'destructive', onPress: onOpenGuide },
			],
			{ cancelable: true }
		);
	};

	return (
		<View style={styles.tip}>
			<View style={styles.row}>
				<Ionicons name="information-circle-outline" size={20} color="#15E8FE" />
				<Text style={styles.text}>{text}</Text>
			</View>
			<Pressable
				onPress={openGuide}
				accessibilityRole="button"
				accessibilityLabel={t('tutorial.tip.fullGuide')}
				accessibilityHint={t('tutorial.helpTopicHint')}
				hitSlop={4}
				style={({ pressed }) => [styles.link, pressed && styles.pressed]}
			>
				<Text style={styles.linkText}>{t('tutorial.tip.fullGuide')}</Text>
				<Ionicons name="arrow-forward" size={16} color="#15E8FE" />
			</Pressable>
		</View>
	);
};

const styles = StyleSheet.create({
	tip: {
		backgroundColor: 'rgba(21,232,254,0.1)',
		borderRadius: 12,
		paddingHorizontal: 12,
		paddingTop: 12,
		marginBottom: 8,
	},
	row: {
		flexDirection: 'row',
		alignItems: 'flex-start',
		gap: 8,
	},
	text: {
		flex: 1,
		fontSize: 15,
		lineHeight: 22,
		color: '#FFFFFF',
	},
	link: {
		minHeight: 48,
		flexDirection: 'row',
		alignItems: 'center',
		alignSelf: 'flex-start',
		gap: 6,
		paddingLeft: 28,
	},
	linkText: {
		fontSize: 15,
		fontWeight: '600',
		color: '#15E8FE',
	},
	pressed: {
		opacity: 0.6,
	},
});

export default HelpTip;
