import { Ionicons } from '@expo/vector-icons';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import {
	KeyboardAvoidingView,
	Modal,
	Platform,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * Folha que sobe do rodapé, para ações curtas sobre um cartão.
 *
 * Por que folha e não tela: pagar ou ajustar uma fatura é uma pergunta com um ou dois
 * campos, e o contexto (o cartão) continua visível atrás. Fechar é tocar fora, no X ou
 * usar o voltar do Android.
 *
 * Acessibilidade: `accessibilityViewIsModal` prende o leitor de tela dentro da folha; o
 * título é o primeiro elemento e é cabeçalho; o X tem 48 pontos e rótulo; o fundo que
 * fecha ao toque é escondido do leitor de tela para não virar um botão sem nome.
 */

interface SheetProps {
	visible: boolean;
	title: string;
	subtitle?: string;
	onClose: () => void;
	children: React.ReactNode;
}

const Sheet: React.FC<SheetProps> = ({ visible, title, subtitle, onClose, children }) => {
	const { t } = useTranslation();
	const insets = useSafeAreaInsets();

	return (
		<Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
			<KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
				<Pressable
					style={styles.backdrop}
					onPress={onClose}
					accessible={false}
					importantForAccessibility="no-hide-descendants"
				/>
				<View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]} accessibilityViewIsModal>
					<View style={styles.handle} accessible={false} />
					<View style={styles.header}>
						<View style={styles.titles}>
							<Text style={styles.title} accessibilityRole="header">
								{title}
							</Text>
							{subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
						</View>
						<Pressable
							onPress={onClose}
							accessibilityRole="button"
							accessibilityLabel={t('cards.close')}
							style={({ pressed }) => [styles.close, pressed && styles.pressed]}
						>
							<Ionicons name="close" size={24} color="#FFFFFF" />
						</Pressable>
					</View>
					<ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
						{children}
					</ScrollView>
				</View>
			</KeyboardAvoidingView>
		</Modal>
	);
};

const styles = StyleSheet.create({
	flex: {
		flex: 1,
		justifyContent: 'flex-end',
	},
	backdrop: {
		...StyleSheet.absoluteFillObject,
		backgroundColor: 'rgba(0,0,0,0.6)',
	},
	sheet: {
		backgroundColor: '#1C1C1E',
		borderTopLeftRadius: 20,
		borderTopRightRadius: 20,
		paddingHorizontal: 16,
		paddingTop: 8,
		maxHeight: '90%',
	},
	handle: {
		alignSelf: 'center',
		width: 40,
		height: 4,
		borderRadius: 2,
		backgroundColor: 'rgba(255,255,255,0.3)',
		marginBottom: 8,
	},
	header: {
		flexDirection: 'row',
		alignItems: 'flex-start',
		gap: 8,
		marginBottom: 8,
	},
	titles: {
		flex: 1,
		paddingTop: 10,
	},
	title: {
		fontSize: 20,
		fontWeight: '700',
		color: '#FFFFFF',
	},
	subtitle: {
		fontSize: 14,
		lineHeight: 20,
		color: 'rgba(255,255,255,0.75)',
		marginTop: 4,
	},
	close: {
		width: 48,
		height: 48,
		borderRadius: 24,
		alignItems: 'center',
		justifyContent: 'center',
	},
	pressed: {
		opacity: 0.6,
	},
	body: {
		gap: 14,
		paddingBottom: 8,
	},
});

export default Sheet;
