import { router } from 'expo-router';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useMirai } from '../../contexts/MiraiContext';
import MiraiAvatar from './MiraiAvatar';

/** Os pontos que a tela de ativação explica (§7), na ordem. */
export const ACTIVATION_POINTS = [
	'onlyWhenAsked',
	'noNames',
	'noServerHistory',
	'anthropic',
] as const;

/**
 * A tela de ativação do Mirai (SPD-163, D6). O Mirai vem desligado: o primeiro toque no botão
 * abre esta folha, que diz o que ele faz, o que ele consulta, o que sai do aparelho e para
 * onde, com o link para a política. "Ativar" liga e abre a conversa; "Agora não" fecha. O
 * voltar fecha sem escolher.
 */
const MiraiActivationSheet: React.FC = () => {
	const { t } = useTranslation();
	const mirai = useMirai();
	if (!mirai) return null;

	const openPolicy = () => {
		mirai.close();
		router.push('/screens/PrivacyPolicyScreen');
	};

	return (
		<Modal
			visible={mirai.sheet === 'activation'}
			transparent
			animationType="slide"
			onRequestClose={mirai.close}
		>
			<View style={styles.backdrop}>
				<View style={styles.sheet} testID="mirai-activation">
					<ScrollView contentContainerStyle={styles.content}>
						<View style={styles.avatar}>
							<MiraiAvatar expression="normal" size={96} />
						</View>
						<Text style={styles.title} accessibilityRole="header">
							{t('mirai.activation.title')}
						</Text>
						<Text style={styles.intro}>{t('mirai.activation.intro')}</Text>
						{ACTIVATION_POINTS.map((point) => (
							<View key={point} style={styles.point}>
								<Text style={styles.bullet}>•</Text>
								<Text style={styles.pointText}>{t(`mirai.activation.points.${point}`)}</Text>
							</View>
						))}
						<Pressable
							testID="mirai-activation-policy"
							accessibilityRole="link"
							onPress={openPolicy}
							hitSlop={8}
						>
							<Text style={styles.link}>{t('mirai.activation.policy')}</Text>
						</Pressable>
					</ScrollView>
					<View style={styles.actions}>
						<Pressable
							testID="mirai-activation-later"
							accessibilityRole="button"
							onPress={mirai.decline}
							style={[styles.button, styles.secondary]}
						>
							<Text style={styles.secondaryText}>{t('mirai.activation.later')}</Text>
						</Pressable>
						<Pressable
							testID="mirai-activation-activate"
							accessibilityRole="button"
							onPress={mirai.activate}
							style={[styles.button, styles.primary]}
						>
							<Text style={styles.primaryText}>{t('mirai.activation.activate')}</Text>
						</Pressable>
					</View>
				</View>
			</View>
		</Modal>
	);
};

const styles = StyleSheet.create({
	backdrop: {
		flex: 1,
		backgroundColor: 'rgba(0, 0, 0, 0.6)',
		justifyContent: 'flex-end',
	},
	sheet: {
		maxHeight: '92%',
		backgroundColor: '#1A1A1A',
		borderTopLeftRadius: 20,
		borderTopRightRadius: 20,
		paddingBottom: 24,
	},
	content: {
		padding: 24,
		paddingBottom: 8,
	},
	avatar: {
		alignItems: 'center',
		marginBottom: 12,
	},
	title: {
		color: '#FFFFFF',
		fontSize: 22,
		fontWeight: '700',
		textAlign: 'center',
		marginBottom: 12,
	},
	intro: {
		color: 'rgba(255, 255, 255, 0.85)',
		fontSize: 15,
		lineHeight: 21,
		marginBottom: 16,
	},
	point: {
		flexDirection: 'row',
		marginBottom: 10,
	},
	bullet: {
		color: '#26C6DA',
		fontSize: 15,
		lineHeight: 21,
		width: 16,
	},
	pointText: {
		flex: 1,
		color: 'rgba(255, 255, 255, 0.85)',
		fontSize: 14,
		lineHeight: 20,
	},
	link: {
		color: '#15E8FE',
		fontSize: 14,
		textDecorationLine: 'underline',
		marginTop: 6,
	},
	actions: {
		flexDirection: 'row',
		gap: 12,
		paddingHorizontal: 24,
		paddingTop: 12,
	},
	button: {
		flex: 1,
		borderRadius: 12,
		paddingVertical: 14,
		alignItems: 'center',
	},
	primary: {
		backgroundColor: '#15E8FE',
	},
	primaryText: {
		color: '#000000',
		fontSize: 16,
		fontWeight: '700',
	},
	secondary: {
		borderWidth: 1,
		borderColor: 'rgba(255, 255, 255, 0.3)',
	},
	secondaryText: {
		color: '#FFFFFF',
		fontSize: 16,
		fontWeight: '600',
	},
});

export default MiraiActivationSheet;
