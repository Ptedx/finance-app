import { Ionicons } from '@expo/vector-icons';
import type React from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
	Alert,
	FlatList,
	Modal,
	StyleSheet,
	Text,
	TextInput,
	TouchableOpacity,
	View,
} from 'react-native';
import { useBills } from '../contexts/BillsContext';
import { useBudget } from '../contexts/BudgetContext';
import { useCaptures } from '../contexts/CapturesContext';
import type { Currency } from '../contexts/CurrencyContext';
import { AVAILABLE_CURRENCIES, useCurrency } from '../contexts/CurrencyContext';
import { useDebts } from '../contexts/DebtsContext';
import { useTransactions } from '../contexts/TransactionsContext';
import { convertAllAmounts, hasFinancialData } from '../database/database';
import { isValidRate, parseDecimalInput } from '../utils/money';

interface CurrencySelectorProps {
	isVisible: boolean;
	onClose: () => void;
}

const CurrencySelector: React.FC<CurrencySelectorProps> = ({ isVisible, onClose }) => {
	const { currentCurrency, setCurrency } = useCurrency();
	const { convertBudgets } = useBudget();
	const { refreshData } = useTransactions();
	const { refresh: refreshDebts } = useDebts();
	const { refresh: refreshBills } = useBills();
	const { refresh: refreshCaptures } = useCaptures();
	const { t } = useTranslation();

	/** O nome da moeda no idioma do app; o inglês de `AVAILABLE_CURRENCIES` se faltar tradução. */
	const nameOf = (currency: Currency): string => t(`currency.names.${currency.code}`, { defaultValue: currency.name });

	const [pendingCurrency, setPendingCurrency] = useState<Currency | null>(null);
	const [rateInput, setRateInput] = useState('');
	const [isConverting, setIsConverting] = useState(false);

	/**
	 * Switching currency used to swap the symbol and nothing else, so a ledger of
	 * R$ 100 entries silently became $ 100. Now the user is asked what should happen to
	 * the amounts already recorded.
	 */
	const handleSelect = async (currency: Currency) => {
		if (currency.code === currentCurrency.code) {
			onClose();
			return;
		}

		try {
			if (await hasFinancialData()) {
				setRateInput('');
				setPendingCurrency(currency);
				return;
			}

			await setCurrency(currency);
			onClose();
		} catch (error) {
			console.error('Error setting currency:', error);
			Alert.alert(t('currency.errorTitle'), t('currency.errorBody'));
		}
	};

	const applyCurrencyChange = async (currency: Currency, rate: number | null) => {
		setIsConverting(true);
		try {
			if (rate !== null) {
				// Amounts first: if this fails the ledger keeps its original currency and
				// its original numbers, which stay consistent with each other.
				await convertAllAmounts(rate);
				await convertBudgets(rate);
			}

			await setCurrency(currency);
			await refreshData();
			// As dívidas, as contas a pagar e a caixa de entrada só releem no próximo sync ou ao
			// voltar ao app; sem isto, a tela mostraria os valores de antes da troca. Os dados já
			// estão convertidos: uma falha aqui não é falha da conversão.
			if (rate !== null) await Promise.allSettled([refreshDebts(), refreshBills(), refreshCaptures()]);

			setPendingCurrency(null);
			onClose();
		} catch (error) {
			console.error('Error converting amounts:', error);
			Alert.alert(t('currency.conversionFailedTitle'), t('currency.conversionFailedBody'));
		} finally {
			setIsConverting(false);
		}
	};

	const handleConfirmConversion = () => {
		if (!pendingCurrency) return;

		const rate = parseDecimalInput(rateInput);

		if (!isValidRate(rate)) {
			Alert.alert(t('currency.invalidRateTitle'), t('currency.invalidRateBody'));
			return;
		}

		applyCurrencyChange(pendingCurrency, rate);
	};

	const handleKeepAmounts = () => {
		if (!pendingCurrency) return;

		Alert.alert(
			t('currency.keepTitle'),
			t('currency.keepBody', { code: pendingCurrency.code, name: nameOf(pendingCurrency) }),
			[
				{ text: t('currency.cancel'), style: 'cancel' },
				{
					text: t('currency.keepConfirm'),
					style: 'destructive',
					onPress: () => applyCurrencyChange(pendingCurrency, null),
				},
			]
		);
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
						<Text style={styles.currencyName}>{nameOf(item)}</Text>
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
						<Text style={styles.modalTitle}>{t('currency.title')}</Text>
						<TouchableOpacity
							onPress={onClose}
							style={styles.closeButton}
							accessibilityRole="button"
							accessibilityLabel={t('currency.close')}
						>
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

			{/* Conversion prompt, shown only when there is already data to convert */}
			<Modal visible={pendingCurrency !== null} transparent animationType="fade">
				<View style={styles.rateOverlay}>
					<View style={styles.rateCard}>
						<Text style={styles.rateTitle}>
							{currentCurrency.code} → {pendingCurrency?.code}
						</Text>
						<Text style={styles.rateExplanation}>
							{t('currency.rateExplanation', { name: nameOf(currentCurrency) })}
						</Text>

						<Text style={styles.rateLabel}>
							{t('currency.rateLabel', { from: currentCurrency.code, to: pendingCurrency?.code ?? '' })}
						</Text>
						<TextInput
							style={styles.rateInput}
							value={rateInput}
							onChangeText={setRateInput}
							placeholder={t('currency.ratePlaceholder')}
							placeholderTextColor="rgba(255, 255, 255, 0.3)"
							keyboardType="decimal-pad"
							autoFocus
							editable={!isConverting}
						/>

						<TouchableOpacity
							style={[styles.ratePrimaryButton, isConverting && styles.disabledButton]}
							onPress={handleConfirmConversion}
							disabled={isConverting}
						>
							<Text style={styles.ratePrimaryButtonText}>
								{isConverting ? t('currency.converting') : t('currency.convert')}
							</Text>
						</TouchableOpacity>

						<TouchableOpacity
							style={styles.rateSecondaryButton}
							onPress={handleKeepAmounts}
							disabled={isConverting}
						>
							<Text style={styles.rateSecondaryButtonText}>{t('currency.symbolOnly')}</Text>
						</TouchableOpacity>

						<TouchableOpacity
							style={styles.rateSecondaryButton}
							onPress={() => setPendingCurrency(null)}
							disabled={isConverting}
						>
							<Text style={styles.rateCancelText}>{t('currency.cancel')}</Text>
						</TouchableOpacity>
					</View>
				</View>
			</Modal>
		</Modal>
	);
};

const styles = StyleSheet.create({
	rateOverlay: {
		flex: 1,
		backgroundColor: 'rgba(0, 0, 0, 0.7)',
		justifyContent: 'center',
		alignItems: 'center',
		padding: 24,
	},
	rateCard: {
		width: '100%',
		backgroundColor: '#1E1E1E',
		borderRadius: 12,
		padding: 20,
	},
	rateTitle: {
		fontSize: 20,
		fontWeight: '700',
		color: '#FFFFFF',
		textAlign: 'center',
		marginBottom: 8,
	},
	rateExplanation: {
		fontSize: 13,
		color: 'rgba(255, 255, 255, 0.7)',
		textAlign: 'center',
		marginBottom: 20,
		lineHeight: 18,
	},
	rateLabel: {
		fontSize: 14,
		color: '#15E8FE',
		marginBottom: 8,
	},
	rateInput: {
		borderWidth: 1,
		borderColor: 'rgba(255, 255, 255, 0.2)',
		borderRadius: 8,
		padding: 12,
		backgroundColor: 'rgba(255, 255, 255, 0.1)',
		color: '#FFFFFF',
		fontSize: 22,
		fontWeight: '600',
		marginBottom: 20,
	},
	ratePrimaryButton: {
		backgroundColor: '#15E8FE',
		paddingVertical: 14,
		borderRadius: 8,
		alignItems: 'center',
		marginBottom: 10,
	},
	ratePrimaryButtonText: {
		color: '#000000',
		fontSize: 16,
		fontWeight: '600',
	},
	rateSecondaryButton: {
		paddingVertical: 12,
		alignItems: 'center',
	},
	rateSecondaryButtonText: {
		color: '#FFFFFF',
		fontSize: 14,
		fontWeight: '500',
	},
	rateCancelText: {
		color: 'rgba(255, 255, 255, 0.5)',
		fontSize: 14,
	},
	disabledButton: {
		opacity: 0.6,
	},
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
