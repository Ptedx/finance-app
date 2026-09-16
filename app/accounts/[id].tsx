import { useLocalSearchParams } from 'expo-router';
import AccountEditScreen from '../screens/AccountEditScreen';

export default function AccountDetail() {
	const { id } = useLocalSearchParams<{ id: string }>();
	return <AccountEditScreen accountId={typeof id === 'string' ? id : undefined} />;
}
