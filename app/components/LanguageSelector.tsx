import { Ionicons } from '@expo/vector-icons';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { Language } from '../contexts/LanguageContext';
import { AVAILABLE_LANGUAGES, useLanguage } from '../contexts/LanguageContext';

interface LanguageSelectorProps {
	isVisible: boolean;
	onClose: () => void;
}

const LanguageSelector: React.FC<LanguageSelectorProps> = ({ isVisible, onClose }) => {
	const { currentLanguage, setLanguage } = useLanguage();
	const { t } = useTranslation();

	const handleSelect = async (lang: Language) => {
		try {
			await setLanguage(lang);
			onClose();
		} catch (error) {
			console.error('Error setting language:', error);
		}
	};

	const renderLanguageItem = ({ item }: { item: Language }) => {
		const isSelected = currentLanguage.code === item.code;

		return (
			<TouchableOpacity
				style={[styles.languageItem, isSelected && styles.selectedLanguageItem]}
				onPress={() => handleSelect(item)}
			>
				<View style={styles.languageInfo}>
					<View style={styles.languageTextContainer}>
						<Text style={styles.languageNativeName}>{item.nativeName}</Text>
						<Text style={styles.languageName}>{item.name}</Text>
					</View>
				</View>

				{isSelected && <Ionicons name="checkmark-circle" size={24} color="#50E3C2" />}
			</TouchableOpacity>
		);
	};

	return (
		<Modal visible={isVisible} transparent={true} animationType="slide">
			<View style={styles.modalContainer}>
				<View style={styles.modalContent}>
					<View style={styles.modalHeader}>
						<Text style={styles.modalTitle}>{t('settings.language')}</Text>
						<TouchableOpacity onPress={onClose} style={styles.closeButton}>
							<Ionicons name="close" size={24} color="#FFFFFF" />
						</TouchableOpacity>
					</View>

					<FlatList
						data={AVAILABLE_LANGUAGES}
						renderItem={renderLanguageItem}
						keyExtractor={(item) => item.code}
						contentContainerStyle={styles.languageList}
					/>
				</View>
			</View>
		</Modal>
	);
};

const styles = StyleSheet.create({
	modalContainer: {
		flex: 1,
		justifyContent: 'center',
		alignItems: 'center',
		backgroundColor: 'rgba(0, 0, 0, 0.5)',
	},
	modalContent: {
		width: '90%',
		maxHeight: '80%',
		backgroundColor: '#1E1E1E',
		borderRadius: 12,
		overflow: 'hidden',
	},
	modalHeader: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
		padding: 16,
		borderBottomWidth: 1,
		borderBottomColor: 'rgba(255, 255, 255, 0.1)',
	},
	modalTitle: {
		fontSize: 18,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	closeButton: {
		padding: 4,
	},
	languageList: {
		padding: 8,
	},
	languageItem: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
		padding: 16,
		borderBottomWidth: 1,
		borderBottomColor: 'rgba(255, 255, 255, 0.1)',
	},
	selectedLanguageItem: {
		backgroundColor: 'rgba(80, 227, 194, 0.1)',
	},
	languageInfo: {
		flexDirection: 'row',
		alignItems: 'center',
	},
	languageTextContainer: {
		marginLeft: 4,
	},
	languageNativeName: {
		fontSize: 16,
		color: '#FFFFFF',
		marginBottom: 2,
	},
	languageName: {
		fontSize: 12,
		color: 'rgba(255, 255, 255, 0.6)',
	},
});

export default LanguageSelector;
