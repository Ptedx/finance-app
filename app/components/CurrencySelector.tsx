import { Ionicons } from '@expo/vector-icons';
import type React from 'react';
import { FlatList, Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { Currency } from '../contexts/CurrencyContext';
import { AVAILABLE_CURRENCIES, useCurrency } from '../contexts/CurrencyContext';

interface CurrencySelectorProps {
	isVisible: boolean;
	onClose: () => void;
}

const CurrencySelector: React.FC<CurrencySelectorProps> = ({ isVisible, onClose }) => {
	const { currentCurrency, setCurrency } = useCurrency();

	const handleSelect = async (currency: Currency) => {
		try {
			await setCurrency(currency);
			onClose();
		} catch (error) {
			console.error('Error setting currency:', error);
		}
	};

	const renderCurrencyItem = ({ item }: { item: Currency }) => {
		const isSelected = currentCurrency.code === item.code;

		return (
			<TouchableOpacity
				style={[styles.currencyItem, isSelected && styles.selectedCurrencyItem]}
				onPress={() => handleSelect(item)}
			>
				<View style={styles.currencyInfo}>
					<Text style={styles.currencySymbol}>{item.symbol}</Text>
					<View style={styles.currencyTextContainer}>
						<Text style={styles.currencyName}>{item.name}</Text>
						<Text style={styles.currencyCode}>{item.code}</Text>
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
						<Text style={styles.modalTitle}>Select Currency</Text>
						<TouchableOpacity onPress={onClose} style={styles.closeButton}>
							<Ionicons name="close" size={24} color="#FFFFFF" />
						</TouchableOpacity>
					</View>

					<FlatList
						data={AVAILABLE_CURRENCIES}
						renderItem={renderCurrencyItem}
						keyExtractor={(item) => item.code}
						contentContainerStyle={styles.currencyList}
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
	currencyList: {
		padding: 8,
	},
	currencyItem: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
		padding: 16,
		borderBottomWidth: 1,
		borderBottomColor: 'rgba(255, 255, 255, 0.1)',
	},
	selectedCurrencyItem: {
		backgroundColor: 'rgba(80, 227, 194, 0.1)',
	},
	currencyInfo: {
		flexDirection: 'row',
		alignItems: 'center',
	},
	currencySymbol: {
		fontSize: 20,
		fontWeight: '600',
		color: '#FFFFFF',
		width: 30,
		textAlign: 'center',
	},
	currencyTextContainer: {
		marginLeft: 12,
	},
	currencyName: {
		fontSize: 16,
		color: '#FFFFFF',
		marginBottom: 2,
	},
	currencyCode: {
		fontSize: 12,
		color: 'rgba(255, 255, 255, 0.6)',
	},
});

export default CurrencySelector;
