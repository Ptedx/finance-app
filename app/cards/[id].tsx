import { useLocalSearchParams } from 'expo-router';
import CardDetailScreen from '../screens/CardDetailScreen';

export default function CardDetail() {
	const { id } = useLocalSearchParams<{ id: string }>();
	return <CardDetailScreen cardId={typeof id === 'string' ? id : ''} />;
}
