import type React from 'react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo } from 'react-native';
import { Button, Field } from './formParts';
import Sheet from './Sheet';

/**
 * Dar nome a um cartão pelo final: "iFood/99", "Assinaturas", "Débito Inter". O nome é o
 * que aparece no gasto por cartão e no histórico; apagar volta a "final 6422".
 */
const RenameCardSheet: React.FC<{
	visible: boolean;
	last4: string;
	currentName: string | null;
	onClose: () => void;
	onSave: (name: string | null) => Promise<void>;
}> = ({ visible, last4, currentName, onClose, onSave }) => {
	const { t } = useTranslation();
	const [name, setName] = useState(currentName ?? '');

	useEffect(() => {
		if (visible) setName(currentName ?? '');
	}, [visible, currentName]);

	return (
		<Sheet visible={visible} onClose={onClose} title={t('cards.rename.title', { last4 })} subtitle={t('cards.rename.subtitle')}>
			<Field
				label={t('cards.rename.name')}
				value={name}
				onChangeText={setName}
				placeholder={t('cards.rename.placeholder')}
				maxLength={40}
				autoFocus
			/>
			<Button
				label={t('cards.rename.save')}
				icon="checkmark"
				onPress={async () => {
					await onSave(name.trim() || null);
					AccessibilityInfo.announceForAccessibility(t('cards.rename.saved'));
				}}
			/>
		</Sheet>
	);
};

export default RenameCardSheet;
