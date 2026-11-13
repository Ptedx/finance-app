import type React from 'react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text } from 'react-native';
import { Button, Field } from './cards/formParts';
import Sheet from './cards/Sheet';

/**
 * "Seu nome como aparece no banco" (SPD-115, DEC-36): o nome que o app procura nos avisos
 * de Pix para saber que o dinheiro foi de uma conta sua para outra. A tela de Ajustes abre
 * esta folha e guarda o que for salvo (`utils/ownNamePreference.ts`); a regra que compara
 * os nomes está em `utils/ownName.ts`, e o texto da folha conta o essencial dela.
 *
 * Salvar com o campo vazio tira o nome.
 */
const OwnNameSheet: React.FC<{
	visible: boolean;
	/** O nome salvo, ou `null` se não há. */
	value: string | null;
	onClose: () => void;
	onSave: (name: string) => Promise<void>;
}> = ({ visible, value, onClose, onSave }) => {
	const { t } = useTranslation();
	const [draft, setDraft] = useState('');
	const [saving, setSaving] = useState(false);

	// Cada abertura começa do que está salvo.
	useEffect(() => {
		if (visible) setDraft(value ?? '');
	}, [visible, value]);

	const save = async () => {
		setSaving(true);
		try {
			await onSave(draft);
		} finally {
			setSaving(false);
		}
	};

	return (
		<Sheet
			visible={visible}
			onClose={onClose}
			confirmDiscard={draft.trim() !== (value ?? '')}
			title={t('ownName.title')}
			subtitle={t('ownName.subtitle')}
		>
			<Field
				label={t('ownName.field')}
				hint={t('ownName.hint')}
				placeholder={t('ownName.placeholder')}
				value={draft}
				onChangeText={setDraft}
				autoCapitalize="characters"
				autoCorrect={false}
				autoComplete="off"
				maxLength={80}
				returnKeyType="done"
				onSubmitEditing={save}
			/>
			<Text style={styles.note}>{t('ownName.withAccount')}</Text>
			<Button label={t('ownName.save')} icon="checkmark" onPress={save} disabled={saving} />
		</Sheet>
	);
};

const styles = StyleSheet.create({
	note: {
		fontSize: 13,
		lineHeight: 18,
		color: 'rgba(255,255,255,0.6)',
	},
});

export default OwnNameSheet;
