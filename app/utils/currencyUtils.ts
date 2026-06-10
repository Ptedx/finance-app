let currentCurrencyCode = 'USD';
let currentCurrencySymbol = '$';

export const setCurrencyForFormatting = (currencyCode: string, currencySymbol: string): void => {
	currentCurrencyCode = currencyCode;
	currentCurrencySymbol = currencySymbol;
};

export const formatCurrency = (amount: number): string => {
	return new Intl.NumberFormat('en-US', {
		style: 'currency',
		currency: currentCurrencyCode,
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
		// Override the currency symbol to use our stored symbol
		// This handles displaying the symbol correctly across all currencies
	})
		.format(amount)
		.replace(/^\D+/, currentCurrencySymbol);
};

export const parseAmount = (input: string): number => {
	// Remove all non-numeric characters except decimal point
	const cleaned = input.replace(/[^0-9.]/g, '');

	// Ensure there's only one decimal point
	const parts = cleaned.split('.');
	if (parts.length > 2) {
		return Number.parseFloat(`${parts[0]}.${parts[1]}`);
	}

	return Number.parseFloat(cleaned) || 0;
};

export const validateAmount = (input: string): boolean => {
	// Check if the input is a valid number
	const amount = parseAmount(input);
	return !Number.isNaN(amount) && amount > 0;
};

export default { formatCurrency, parseAmount, validateAmount, setCurrencyForFormatting };
