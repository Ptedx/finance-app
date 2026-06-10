export const formatDate = (dateString: string): string => {
	const date = new Date(dateString);
	return date.toLocaleDateString('en-US', {
		month: 'short',
		day: 'numeric',
	});
};

export const formatFullDate = (dateString: string): string => {
	const date = new Date(dateString);
	return date.toLocaleDateString('en-US', {
		year: 'numeric',
		month: 'long',
		day: 'numeric',
	});
};

export const getISODate = (date: Date): string => {
	// Get year, month, and day in the device's local timezone
	const year = date.getFullYear();
	const month = (date.getMonth() + 1).toString().padStart(2, '0'); // Months are 0-indexed
	const day = date.getDate().toString().padStart(2, '0');

	// Format as YYYY-MM-DD
	return `${year}-${month}-${day}`;
};

export const getCurrentMonthRange = (): { startDate: string; endDate: string } => {
	const today = new Date();
	const startDate = new Date(today.getFullYear(), today.getMonth(), 1);
	const endDate = new Date(today.getFullYear(), today.getMonth() + 1, 0);

	return {
		startDate: getISODate(startDate),
		endDate: getISODate(endDate),
	};
};

export const getMonthRange = (
	month: number,
	year: number
): { startDate: string; endDate: string } => {
	const startDate = new Date(year, month - 1, 1);
	const endDate = new Date(year, month, 0);

	return {
		startDate: getISODate(startDate),
		endDate: getISODate(endDate),
	};
};

export const getMonthName = (month: number): string => {
	const date = new Date(2000, month - 1, 1);
	return date.toLocaleString('en-US', { month: 'long' });
};

export const getCurrentMonthName = (): string => {
	const date = new Date();
	return date.toLocaleString('en-US', { month: 'long' }).toUpperCase();
};

export const getCurrentYear = (): number => {
	return new Date().getFullYear();
};

export default {
	formatDate,
	formatFullDate,
	getISODate,
	getCurrentMonthRange,
	getMonthRange,
	getMonthName,
	getCurrentMonthName,
	getCurrentYear,
};
