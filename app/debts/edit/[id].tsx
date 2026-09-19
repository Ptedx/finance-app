import { useLocalSearchParams } from 'expo-router';
import DebtEditScreen from '../../screens/DebtEditScreen';

export default function EditDebt() {
	const { id } = useLocalSearchParams<{ id: string }>();
	return <DebtEditScreen debtId={typeof id === 'string' ? id : undefined} />;
}
