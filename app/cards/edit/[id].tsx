import { useLocalSearchParams } from 'expo-router';
import CardEditScreen from '../../screens/CardEditScreen';

export default function EditCard() {
	const { id } = useLocalSearchParams<{ id: string }>();
	return <CardEditScreen cardId={typeof id === 'string' ? id : undefined} />;
}
