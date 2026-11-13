import type React from 'react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { MIRAI_NAME_MAX_LENGTH } from '../../utils/mirai/contract';

/**
 * Trocar como o Mirai chama a pessoa, em Configurações (SPD-163e). Salvar com o campo vazio é o
 * mesmo que "Tirar o nome": o Mirai fala sem nome e o app não pergunta de novo.
 */
const MiraiNameDialog: React.FC<{
	visible: boolean;
	current: string | null;
	suggested: string;
	onSave: (name: string | null) => void;
	onClose: () => void;
}> = ({ visible, current, suggested, onSave, onClose }) => {
	const { t } = useTranslation();
	const [value, setValue] = useState(current ?? suggested);

	useEffect(() => {
		if (visible) setValue(current ?? suggested);
	}, [visible, current, suggested]);

	const save = () => {
		onSave(value.trim().length > 0 ? value : null);
		onClose();
	};

	return (
		<Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
			<View style={styles.backdrop}>
				<View style={styles.card} testID="mirai-name-dialog">
					<Text style={styles.title}>{t('mirai.nameSetting.label')}</Text>
					<Text style={styles.hint}>{t('mirai.nameSetting.hint')}</Text>
					<TextInput
						testID="mirai-name-dialog-input"
						style={styles.input}
						value={value}
						onChangeText={setValue}
						placeholder={t('mirai.nameSetting.placeholder')}
						placeholderTextColor="rgba(255, 255, 255, 0.4)"
						maxLength={MIRAI_NAME_MAX_LENGTH}
						autoCapitalize="words"
						autoFocus
						returnKeyType="done"
						onSubmitEditing={save}
					/>
					<View style={styles.buttons}>
						{current ? (
							<Pressable
								testID="mirai-name-dialog-remove"
								accessibilityRole="button"
								onPress={() => {
									onSave(null);
									onClose();
								}}
								hitSlop={8}
								style={styles.remove}
							>
								<Text style={styles.link}>{t('mirai.nameSetting.remove')}</Text>
							</Pressable>
						) : null}
						<Pressable
							testID="mirai-name-dialog-cancel"
							accessibilityRole="button"
							onPress={onClose}
							hitSlop={8}
						>
							<Text style={styles.link}>{t('mirai.nameSetting.cancel')}</Text>
						</Pressable>
						<Pressable
							testID="mirai-name-dialog-save"
							accessibilityRole="button"
							onPress={save}
							style={styles.save}
						>
							<Text style={styles.saveText}>{t('mirai.nameSetting.save')}</Text>
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
		justifyContent: 'center',
		padding: 24,
	},
	card: {
		backgroundColor: '#1A1A1A',
		borderRadius: 16,
		padding: 20,
		gap: 12,
	},
	title: {
		color: '#FFFFFF',
		fontSize: 18,
		fontWeight: '700',
	},
	hint: {
		color: 'rgba(255, 255, 255, 0.6)',
		fontSize: 13,
		lineHeight: 18,
	},
	input: {
		minHeight: 44,
		backgroundColor: '#252A31',
		borderRadius: 10,
		paddingHorizontal: 12,
		color: '#FFFFFF',
		fontSize: 15,
	},
	buttons: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'flex-end',
		gap: 18,
		marginTop: 4,
	},
	remove: {
		marginRight: 'auto',
	},
	link: {
		color: '#15E8FE',
		fontSize: 14,
	},
	save: {
		backgroundColor: '#15E8FE',
		borderRadius: 18,
		paddingVertical: 8,
		paddingHorizontal: 16,
	},
	saveText: {
		color: '#000000',
		fontSize: 14,
		fontWeight: '600',
	},
});

export default MiraiNameDialog;
