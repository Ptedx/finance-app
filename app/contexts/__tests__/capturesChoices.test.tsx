/**
 * As escolhas aprendidas nos avisos ambíguos (SPD-123) chegam à ingestão e voltam das
 * respostas da revisão: o contexto só repassa. As regras em si estão em
 * `captureAmbiguityFlow.test.ts`.
 */

const mockIngest = jest.fn();
const mockConfirm = jest.fn();
const mockAnswerDirection = jest.fn();
const mockResolveInvoice = jest.fn();
const mockSetPreference = jest.fn();

jest.mock('@react-native-async-storage/async-storage', () =>
	require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('../../database/database', () => ({
	setPreference: (...args: unknown[]) => mockSetPreference(...args),
}));
jest.mock('../../../modules/spendr-captures', () => ({
	addCaptureListener: () => ({ remove: jest.fn() }),
	drainCaptures: () => [{ packageName: 'com.example.bank', title: 'Aviso', text: 'Texto inventado', postedAt: 0 }],
	isCaptureEnabled: () => true,
	isCaptureSupported: () => true,
	openCaptureSettings: jest.fn(),
}));
jest.mock('../../database/captures', () => ({
	countPendingCaptures: jest.fn(async () => 0),
	getIgnoredApps: jest.fn(async () => []),
	getLastNotificationPostedAt: jest.fn(async () => null),
	getPendingCaptures: jest.fn(async () => []),
	getResolvedCaptures: jest.fn(async () => []),
	pruneResolvedCaptures: jest.fn(async () => undefined),
}));
jest.mock('../../hooks/useAfterPull', () => ({ useAfterPull: jest.fn() }));
jest.mock('../../utils/businessFeedPreference', () => ({
	getBusinessFeeds: jest.fn(async () => ({})),
}));
jest.mock('../../utils/captureActions', () => ({
	answerCaptureDirection: (...args: unknown[]) => mockAnswerDirection(...args),
	answerCaptureDuplicate: jest.fn(),
	answerCaptureTransfer: jest.fn(),
	confirmCapture: (...args: unknown[]) => mockConfirm(...args),
	dismissCapture: jest.fn(),
	ingestRawCaptures: (...args: unknown[]) => mockIngest(...args),
	markCaptureTransfer: jest.fn(),
	resolveInvoicePaymentCapture: (...args: unknown[]) => mockResolveInvoice(...args),
	revertCapture: jest.fn(),
	stopIgnoringApp: jest.fn(),
}));
jest.mock('../../utils/statementImport', () => ({ pickAndImportOfx: jest.fn(async () => null) }));
jest.mock('../AccountsContext', () => ({
	useAccounts: () => ({ refresh: jest.fn(async () => undefined) }),
}));
jest.mock('../AuthContext', () => ({ useAuth: () => ({ account: null }) }));
jest.mock('../TransactionsContext', () => ({
	useTransactions: () => ({
		categories: [{ id: 'other_expense', name: 'Outros', type: 'expense' }],
		refreshData: jest.fn(async () => undefined),
	}),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { captureChoiceStore } from '../../utils/captureChoicePreference';
import { STORAGE_KEYS } from '../../utils/storageUtils';
import { CapturesProvider, useCaptures } from '../CapturesContext';

let renderer: ReactTestRenderer | undefined;
let captures: ReturnType<typeof useCaptures>;

const Probe = () => {
	captures = useCaptures();
	return null;
};

const mount = async () => {
	await act(async () => {
		renderer = create(
			<CapturesProvider>
				<Probe />
			</CapturesProvider>
		);
	});
};

beforeEach(async () => {
	await AsyncStorage.clear();
	jest.clearAllMocks();
	mockIngest.mockResolvedValue({ inserted: 1, autoConfirmed: 0 });
	mockConfirm.mockResolvedValue({ id: 'cap-1' });
	mockResolveInvoice.mockResolvedValue(true);
});

afterEach(() => {
	act(() => renderer?.unmount());
	renderer = undefined;
});

describe('as escolhas aprendidas passam pelo contexto', () => {
	it('a ingestão recebe as escolhas guardadas', async () => {
		await AsyncStorage.setItem(STORAGE_KEYS.captureChoices, JSON.stringify({ 'banco|purchase_no_kind': 'conta-a' }));
		await mount();

		expect(mockIngest).toHaveBeenCalled();
		expect(mockIngest.mock.calls[0][1].captureChoices).toEqual({ 'banco|purchase_no_kind': 'conta-a' });
	});

	it('confirmar, responder a direção e o pagamento da fatura levam o lugar das regras', async () => {
		await mount();

		await act(async () => {
			await captures.confirm('cap-1', 'other_expense', 'conta-a');
			await captures.answerDirection('cap-2', 'in');
			await captures.resolveInvoicePayment('cap-3', null);
		});

		expect(mockConfirm.mock.calls[0]).toEqual(['cap-1', 'other_expense', expect.any(Array), 'conta-a', captureChoiceStore]);
		expect(mockAnswerDirection).toHaveBeenCalledWith('cap-2', 'in', captureChoiceStore);
		expect(mockResolveInvoice).toHaveBeenCalledWith('cap-3', null, captureChoiceStore);
	});

	it('o pagamento da fatura lançado fica desfazível; o recusado não', async () => {
		await mount();

		await act(async () => {
			await captures.resolveInvoicePayment('cap-3', 'conta-a');
		});
		expect(captures.lastAction).toMatchObject({ kind: 'transfer', ids: ['cap-3'] });

		mockResolveInvoice.mockResolvedValue(false);
		await act(async () => {
			captures.clearUndo();
			await captures.resolveInvoicePayment('cap-4', 'cartao-b');
		});
		expect(captures.lastAction).toBeNull();
	});

	it('a escolha gravada vira preferência (sobe no sync e vai no backup)', async () => {
		await captureChoiceStore.write({ 'banco|pix_direction|enviou/recebeu': 'in' });
		expect(mockSetPreference).toHaveBeenCalledWith(
			STORAGE_KEYS.captureChoices,
			JSON.stringify({ 'banco|pix_direction|enviou/recebeu': 'in' })
		);
	});
});
