import { useLocalSearchParams } from 'expo-router';
import DebitCardScreen from '../../../screens/DebitCardScreen';

export default function DebitCardDetail() {
	const { accountId, last4 } = useLocalSearchParams<{ accountId: string; last4: string }>();
	return (
		<DebitCardScreen
			accountId={typeof accountId === 'string' ? accountId : ''}
			last4={typeof last4 === 'string' ? last4 : ''}
		/>
	);
}
