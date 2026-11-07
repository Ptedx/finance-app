import { Ionicons } from '@expo/vector-icons';
import type React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Account } from '../database/schema';
import { ACCOUNT_KIND_ICONS } from './AccountPicker';
import Sheet from './cards/Sheet';

/**
 * Para qual conta ou cartão levar o que está neste, no "Juntar" (E2E-39).
 *
 * Era um Alert com um botão por destino: no Android o Alert mostra no máximo três botões, e
 * com três destinos ou mais algum sumia sem aviso. A folha lista todos, rola quando são
 * muitos, e fecha pelo X, por toque fora ou pelo voltar do Android. Escolher só devolve o
 * destino — quem chamou confirma antes de juntar.
 *
 * Cada linha é um botão de pelo menos 48 pontos com o nome como rótulo; o banco vai embaixo, para
 * separar duas fichas de mesmo nome.
 */

interface MergeTargetSheetProps {
	visible: boolean;
	title: string;
	subtitle: string;
	targets: Account[];
	onPick: (target: Account) => void;
	onClose: () => void;
}

const MergeTargetSheet: React.FC<MergeTargetSheetProps> = ({ visible, title, subtitle, targets, onPick, onClose }) => (
	<Sheet visible={visible} title={title} subtitle={subtitle} onClose={onClose}>
		<View style={styles.list}>
			{targets.map((target) => (
				<Pressable
					key={target.id}
					onPress={() => onPick(target)}
					accessibilityRole="button"
					accessibilityLabel={target.name}
					accessibilityHint={target.bankName && target.bankName !== target.name ? target.bankName : undefined}
					style={({ pressed }) => [styles.row, pressed && styles.pressed]}
				>
					<View style={[styles.icon, { backgroundColor: `${target.color}33` }]}>
						<Ionicons name={ACCOUNT_KIND_ICONS[target.kind]} size={20} color={target.color} />
					</View>
					<View style={styles.texts}>
						<Text style={styles.name} numberOfLines={2}>
							{target.name}
						</Text>
						{target.bankName && target.bankName !== target.name ? (
							<Text style={styles.bank} numberOfLines={1}>
								{target.bankName}
							</Text>
						) : null}
					</View>
					<Ionicons name="chevron-forward" size={20} color="rgba(255,255,255,0.5)" />
				</Pressable>
			))}
		</View>
	</Sheet>
);

const styles = StyleSheet.create({
	list: {
		gap: 8,
	},
	row: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 12,
		minHeight: 56,
		paddingHorizontal: 12,
		paddingVertical: 8,
		borderRadius: 12,
		backgroundColor: 'rgba(255,255,255,0.06)',
	},
	pressed: {
		opacity: 0.6,
	},
	icon: {
		width: 36,
		height: 36,
		borderRadius: 18,
		alignItems: 'center',
		justifyContent: 'center',
	},
	texts: {
		flex: 1,
	},
	name: {
		fontSize: 16,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	bank: {
		fontSize: 13,
		color: 'rgba(255,255,255,0.7)',
		marginTop: 2,
	},
});

export default MergeTargetSheet;
