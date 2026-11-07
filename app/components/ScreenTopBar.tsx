import { Ionicons } from '@expo/vector-icons';
import type React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

/**
 * A barra de topo das telas da pilha: a seta de voltar e o título.
 *
 * A pilha da raiz não desenha cabeçalho (`RootStack`, `headerShown: false`) e os
 * `<Stack.Screen options>` das telas não aparecem: quem não desenha o seu fica sem título e
 * sem voltar na tela (SPD-121). O desenho é o do detalhe do lançamento e da Conta (SPD-110).
 */

interface ScreenTopBarProps {
	title: string;
	/** O nome da seta para o leitor de tela ("Voltar"). */
	backLabel: string;
	onBack: () => void;
}

const ScreenTopBar: React.FC<ScreenTopBarProps> = ({ title, backLabel, onBack }) => (
	<View style={styles.topBar}>
		<Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel={backLabel} style={styles.iconButton}>
			<Ionicons name="arrow-back" size={24} color="#FFFFFF" />
		</Pressable>
		<Text style={styles.topBarTitle} accessibilityRole="header" numberOfLines={1}>
			{title}
		</Text>
	</View>
);

const styles = StyleSheet.create({
	topBar: {
		flexDirection: 'row',
		alignItems: 'center',
		paddingHorizontal: 8,
		paddingVertical: 4,
		gap: 4,
	},
	iconButton: {
		width: 48,
		height: 48,
		alignItems: 'center',
		justifyContent: 'center',
	},
	topBarTitle: {
		flex: 1,
		fontSize: 22,
		fontWeight: '700',
		color: '#FFFFFF',
	},
});

export default ScreenTopBar;
