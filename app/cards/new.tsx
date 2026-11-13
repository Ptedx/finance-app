import { useLocalSearchParams } from 'expo-router';
import CardEditScreen from '../screens/CardEditScreen';

export default function NewCard() {
	// `exemplo=1`: a trilha abriu o cadastro preenchido com o exemplo (SPD-147).
	const { exemplo } = useLocalSearchParams<{ exemplo?: string }>();
	return <CardEditScreen sampleForm={typeof exemplo === 'string' ? exemplo : undefined} />;
}
