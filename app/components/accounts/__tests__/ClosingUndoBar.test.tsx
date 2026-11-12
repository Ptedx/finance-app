/**
 * A barra "Desfazer" logo depois de encerrar uma conta ou um cartão (SPD-154). Aqui só a
 * tela: a volta dos números, com o banco de verdade, está em `accountsCloseSql.test.tsx`, e a
 * janela de 8 segundos em `accountClosing.test.ts`.
 *
 * O que se confere: a barra aparece só para a conta que acabou de ser encerrada; o toque
 * desfaz aquela conta e anuncia; fora da janela, avisa que o caminho é Reabrir; sair da tela
 * tira o "Desfazer". As chaves de tradução aparecem cruas.
 */

const mockUndoClose = jest.fn(async (_id: string) => undefined);
const mockDismiss = jest.fn();
const mockState: { closingUndo: unknown } = { closingUndo: null };

jest.mock('react-i18next', () => ({
	useTranslation: () => ({
		t: (key: string, params?: Record<string, unknown>) =>
			params ? `${key} ${JSON.stringify(params)}` : key,
	}),
}));

jest.mock('../../../contexts/AccountsContext', () => ({
	useAccounts: () => ({
		closingUndo: mockState.closingUndo,
		undoClose: mockUndoClose,
		dismissClosingUndo: mockDismiss,
	}),
}));

import { AccessibilityInfo, Alert } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import ClosingUndoBar from '../ClosingUndoBar';

const announceSpy = jest
	.spyOn(AccessibilityInfo, 'announceForAccessibility')
	.mockImplementation(() => undefined);
const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
jest.spyOn(console, 'error').mockImplementation(() => undefined);

const RESERVA_UNDO = {
	accountId: 'reserva',
	openingBalanceCents: 0,
	openingBalanceDate: '2026-09-30',
	transferId: 't-1',
	closedAt: new Date(2026, 10, 11, 12, 0, 0).getTime(),
};

let renderer: ReactTestRenderer | null = null;
const render = (accountId: string, scope: 'accounts.edit' | 'cards.edit' = 'accounts.edit') => {
	act(() => {
		renderer = create(<ClosingUndoBar accountId={accountId} scope={scope} />);
	});
	if (!renderer) throw new Error('não montou');
	return renderer;
};
const texts = (tree: ReactTestRenderer) =>
	tree.root
		.findAll((node) => (node.type as unknown) === 'Text')
		.map((node) => [node.props.children].flat().join(''));
const undoButton = (tree: ReactTestRenderer) =>
	tree.root.findByProps({ accessibilityLabel: 'accounts.edit.undoClose' });

beforeEach(() => {
	jest.clearAllMocks();
	mockState.closingUndo = null;
});

afterEach(() => {
	act(() => renderer?.unmount());
	renderer = null;
});

describe('a barra "Desfazer" depois de encerrar (SPD-154)', () => {
	it('sem encerramento agora, não aparece', () => {
		const tree = render('reserva');
		expect(tree.toJSON()).toBeNull();
	});

	it('aparece só para a conta que acabou de ser encerrada', () => {
		mockState.closingUndo = RESERVA_UNDO;
		expect(render('corrente').toJSON()).toBeNull();
		act(() => renderer?.unmount());
		const tree = render('reserva');
		expect(texts(tree)).toEqual(['accounts.edit.closed', 'accounts.edit.undoClose']);
	});

	it('no cartão, os textos são os do cartão', () => {
		mockState.closingUndo = { ...RESERVA_UNDO, accountId: 'nubank' };
		const tree = render('nubank', 'cards.edit');
		expect(texts(tree)).toEqual(['cards.edit.closed', 'cards.edit.undoClose']);
	});

	it('o toque desfaz o encerramento daquela conta e anuncia', async () => {
		mockState.closingUndo = RESERVA_UNDO;
		const tree = render('reserva');
		await act(async () => {
			await undoButton(tree).props.onPress();
		});
		expect(mockUndoClose).toHaveBeenCalledWith('reserva');
		expect(announceSpy).toHaveBeenCalledWith('accounts.edit.closeUndone');
		expect(alertSpy).not.toHaveBeenCalled();
	});

	it('fora da janela (o desfazer recusou): avisa que o caminho é Reabrir', async () => {
		mockState.closingUndo = RESERVA_UNDO;
		mockUndoClose.mockRejectedValueOnce(
			new Error('Desfazer o encerramento não está mais disponível')
		);
		const tree = render('reserva');
		await act(async () => {
			await undoButton(tree).props.onPress();
		});
		expect(alertSpy).toHaveBeenCalledWith(
			'accounts.edit.undoClose',
			'accounts.edit.undoCloseExpired'
		);
		expect(announceSpy).not.toHaveBeenCalledWith('accounts.edit.closeUndone');
	});

	it('sair da tela tira o "Desfazer"; sem encerramento desta conta, não mexe em nada', () => {
		mockState.closingUndo = RESERVA_UNDO;
		render('corrente');
		act(() => renderer?.unmount());
		renderer = null;
		expect(mockDismiss).not.toHaveBeenCalled();

		render('reserva');
		act(() => renderer?.unmount());
		renderer = null;
		expect(mockDismiss).toHaveBeenCalledTimes(1);
	});
});
