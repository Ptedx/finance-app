/**
 * O detalhe de um lançamento cuja categoria não existe mais (E2E-33): o nome de reserva era
 * "Uncategorized" fixo em inglês; agora é `transactionsList.uncategorized` ("Sem
 * categoria"). As chaves de tradução aparecem cruas.
 */

// Estáveis entre renders, como no app (estado do contexto e o `t` do i18next): o efeito
// da tela depende deles.
const mockTransactions = [
	{ id: 'tx-1', amountCents: 20_000, category: 'apagada', date: '2026-11-12', note: '', isIncome: false },
];
const mockCategories: never[] = [];
const mockAccounts: never[] = [];
const mockT = (key: string) => key;

jest.mock('expo-router', () => ({
	Stack: { Screen: () => null },
	useLocalSearchParams: () => ({ id: 'tx-1' }),
	useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('react-native-safe-area-context', () => {
	const { View } = require('react-native');
	return { SafeAreaView: View };
});

jest.mock('react-i18next', () => ({
	useTranslation: () => ({ t: mockT }),
}));

jest.mock('../../contexts/AccountsContext', () => ({
	useAccounts: () => ({ accounts: mockAccounts }),
}));

jest.mock('../../contexts/TransactionsContext', () => ({
	useTransactions: () => ({
		transactions: mockTransactions,
		categories: mockCategories,
		removeTransaction: jest.fn(),
		removeInstallmentGroup: jest.fn(),
	}),
}));

import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import TransactionDetailScreen from '../../transaction/[id]';

jest.setTimeout(20_000);

it('categoria apagada aparece como "Sem categoria", não "Uncategorized"', async () => {
	let renderer: ReactTestRenderer | null = null;
	await act(async () => {
		renderer = create(<TransactionDetailScreen />);
	});
	const root = (renderer as unknown as ReactTestRenderer).root;
	const texts = root
		.findAll((node: ReactTestInstance) => (node.type as unknown) === 'Text')
		.map((node) => [node.props.children].flat().join(''));
	expect(texts).toContain('transactionsList.uncategorized');
	expect(texts).not.toContain('Uncategorized');
	act(() => (renderer as unknown as ReactTestRenderer).unmount());
});
