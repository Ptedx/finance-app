import { useLocalSearchParams } from 'expo-router';
import DebtDetailScreen from '../screens/DebtDetailScreen';

export default function DebtDetail() {
	const { id } = useLocalSearchParams<{ id: string }>();
	return <DebtDetailScreen debtId={typeof id === 'string' ? id : ''} />;
}
