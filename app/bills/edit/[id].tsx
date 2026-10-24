import { useLocalSearchParams } from 'expo-router';
import BillEditScreen from '../../screens/BillEditScreen';

export default function EditBill() {
	const { id } = useLocalSearchParams<{ id: string }>();
	return <BillEditScreen billId={typeof id === 'string' ? id : undefined} />;
}
