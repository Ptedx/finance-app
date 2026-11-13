/**
 * O cabeçalho do dia em Lançamentos (E2E-46): o estilo tinha `textTransform: 'capitalize'`,
 * que põe maiúscula em toda palavra — "17 De Novembro De 2026". Só a primeira letra do
 * texto vai em maiúscula: "17 de novembro de 2026", "Hoje", "Ontem".
 */

jest.mock('expo-router', () => ({
	useRouter: () => ({ push: jest.fn() }),
	useLocalSearchParams: () => ({}),
}));

jest.mock('react-native-safe-area-context', () => {
	const { View } = require('react-native');
	// A folha da troca de categoria (SPD-178) fica montada, fechada, e lê as margens.
	return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) };
});

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

// Os textos de hoje e ontem como estão no pt.ts; o resto, a chave crua.
const mockTexts: Record<string, string> = { 'transactionsList.today': 'Hoje', 'transactionsList.yesterday': 'Ontem' };
jest.mock('react-i18next', () => ({
	useTranslation: () => ({ t: (key: string) => mockTexts[key] ?? key }),
}));

jest.mock('../../components/PeriodSelector', () => () => null);
jest.mock('../../components/TransactionItem', () => () => null);
jest.mock('../../components/TransferItem', () => () => null);

// "Hoje" fixo em 19/11/2026, para o dia 17 sair por extenso em qualquer fuso e qualquer dia.
jest.mock('../../utils/dateUtils', () => ({
	...jest.requireActual('../../utils/dateUtils'),
	todayISO: () => '2026-11-19',
}));

const tx = (id: string, date: string) => ({ id, date, isIncome: false, amountCents: 1_000, category: 'outros', accountId: null, note: '' });
const mockTransactions = [tx('hoje', '2026-11-19'), tx('ontem', '2026-11-18'), tx('dia17', '2026-11-17')];
const mockEmpty: never[] = [];

jest.mock('../../contexts/TransactionsContext', () => ({
	useTransactions: () => ({ transactions: mockTransactions, categories: mockEmpty, isLoading: false, refreshData: jest.fn() }),
}));
jest.mock('../../contexts/AccountsContext', () => ({
	useAccounts: () => ({ accounts: mockEmpty, activeAccounts: mockEmpty, periodTransfers: mockEmpty }),
}));
jest.mock('../../contexts/PeriodContext', () => ({
	usePeriod: () => ({ startDate: '2026-11-01', endDate: '2026-11-30', selectedMonth: 11 }),
}));

import { StyleSheet, type TextStyle } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { configureDateLocale } from '../../utils/dateUtils';
import TransactionListScreen from '../TransactionListScreen';

let renderer: ReactTestRenderer | null = null;

const isHostText = (node: ReactTestInstance): boolean => (node.type as unknown) === 'Text';

/** O texto como a tela o desenha: com `capitalize`, cada palavra começa em maiúscula. */
const shown = (node: ReactTestInstance): string => {
	const text = [node.props.children].flat().join('');
	const style = StyleSheet.flatten(node.props.style) as TextStyle | undefined;
	return style?.textTransform === 'capitalize' ? text.replace(/(^|\s)(\S)/g, (_, space, letter) => space + letter.toUpperCase()) : text;
};

const titles = (): string[] => (renderer as ReactTestRenderer).root.findAll(isHostText).map(shown);

beforeAll(() => configureDateLocale('pt-BR'));

afterEach(() => {
	act(() => renderer?.unmount());
	renderer = null;
});

describe('cabeçalho do dia em Lançamentos (E2E-46)', () => {
	it('data por extenso só com a primeira letra em maiúscula; Hoje e Ontem como estão', async () => {
		await act(async () => {
			renderer = create(<TransactionListScreen />);
		});
		const shownTitles = titles();
		expect(shownTitles).toContain('17 de novembro de 2026');
		expect(shownTitles).not.toContain('17 De Novembro De 2026');
		expect(shownTitles).toContain('Hoje');
		expect(shownTitles).toContain('Ontem');
	});
});
