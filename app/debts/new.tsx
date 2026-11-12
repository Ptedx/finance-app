import { useLocalSearchParams } from 'expo-router';
import DebtEditScreen from '../screens/DebtEditScreen';

export default function NewDebt() {
	// `exemplo=1`: a trilha abriu o cadastro preenchido com o exemplo (SPD-147).
	const { exemplo } = useLocalSearchParams<{ exemplo?: string }>();
	return <DebtEditScreen sampleForm={typeof exemplo === 'string' ? exemplo : undefined} />;
}
