/**
 * De onde a captura tira os nomes do usuário (SPD-115): o da conta logada (`ownNames`) e o
 * "seu nome como aparece no banco" de Ajustes (`bankName`, à parte para o diário dizer qual
 * dos dois conferiu). Sem login, só o segundo existe — e era justamente
 * quando a decisão nunca conferia o nome.
 *
 * A ingestão é um dublê: a pergunta é o que a caixa de entrada entrega a ela. O que a
 * decisão faz com os nomes está em `captureMatcher.test.ts`; aqui, o fim da corrente
 * passa pelo `decide` de verdade com o que chegou.
 */

const mockIngest = jest.fn();
const mockPickAndImportOfx = jest.fn();
const mockDrain = jest.fn();
let mockAccount: { name: string } | null = null;
let mockListener: (() => void) | null = null;

jest.mock('@react-native-async-storage/async-storage', () =>
	require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('../../database/database', () => ({ setPreference: jest.fn() }));
jest.mock('../../../modules/spendr-captures', () => ({
	addCaptureListener: (listener: () => void) => {
		mockListener = listener;
		return { remove: jest.fn() };
	},
	drainCaptures: () => mockDrain(),
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
	answerCaptureDuplicate: jest.fn(),
	answerCaptureTransfer: jest.fn(),
	confirmCapture: jest.fn(),
	dismissCapture: jest.fn(),
	ingestRawCaptures: (...args: unknown[]) => mockIngest(...args),
	markCaptureTransfer: jest.fn(),
	revertCapture: jest.fn(),
	stopIgnoringApp: jest.fn(),
}));
jest.mock('../../utils/statementImport', () => ({
	pickAndImportOfx: (...args: unknown[]) => mockPickAndImportOfx(...args),
}));
jest.mock('../AccountsContext', () => ({
	useAccounts: () => ({ refresh: jest.fn(async () => undefined) }),
}));
jest.mock('../AuthContext', () => ({ useAuth: () => ({ account: mockAccount }) }));
jest.mock('../TransactionsContext', () => ({
	useTransactions: () => ({
		categories: [{ id: 'other_expense', name: 'Outros', type: 'expense' }],
		refreshData: jest.fn(async () => undefined),
	}),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { decide } from '../../utils/captureMatcher';
import { OWN_BANK_NAME_KEY } from '../../utils/ownNamePreference';
import { CapturesProvider, useCaptures } from '../CapturesContext';

const RAW = {
	packageName: 'br.com.intermedium',
	title: 'Pix enviado',
	text: 'Pix enviado',
	postedAt: 0,
};

let renderer: ReactTestRenderer;
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

const ownNamesOfCall = (index: number): string[] => mockIngest.mock.calls[index][1].ownNames;
const bankNameOfCall = (index: number): string | null | undefined =>
	mockIngest.mock.calls[index][1].bankName;

beforeEach(async () => {
	await AsyncStorage.clear();
	jest.clearAllMocks();
	mockAccount = null;
	mockListener = null;
	mockDrain.mockReturnValue([RAW]);
	mockIngest.mockResolvedValue({ inserted: 1, autoConfirmed: 0 });
	mockPickAndImportOfx.mockResolvedValue(null);
});

afterEach(() => {
	act(() => renderer?.unmount());
});

describe('os nomes que a captura recebe', () => {
	it('sem login, o nome de Ajustes chega à decisão — e o Pix Inter → Nubank vira transferência', async () => {
		await AsyncStorage.setItem(OWN_BANK_NAME_KEY, 'Maria Souza Oliveira');
		await mount();

		expect(mockIngest).toHaveBeenCalled();
		const ownNames = ownNamesOfCall(0);
		const bankName = bankNameOfCall(0);
		expect(ownNames).toEqual([]);
		expect(bankName).toBe('Maria Souza Oliveira');

		const decision = decide(
			{
				packageName: 'br.com.intermedium',
				postedAt: '2026-09-14T15:01:00.000Z',
				amountCents: 80_000,
				direction: 'out',
				kind: 'pix_out',
				counterparty: 'MARIA S OLIVEIRA',
				merchantKey: 'maria s oliveira',
				neutral: false,
			},
			{
				recent: [
					{
						id: 'nu-in',
						packageName: 'com.nu.production',
						postedAt: '2026-09-14T15:00:00.000Z',
						amountCents: 80_000,
						direction: 'in',
						kind: 'pix_in',
						merchantKey: 'maria souza oliveira',
						status: 'pending',
						relatedId: null,
						transactionId: null,
					},
				],
				rule: undefined,
				ownNames,
				bankName,
				autoConfirmThreshold: 3,
				fallbackCategoryId: null,
			}
		);
		expect(decision).toEqual({ action: 'transfer', relatedId: 'nu-in', reason: 'own_bank_name' });
	});

	it('logado, vão os dois, cada um no seu campo: o da conta e o de Ajustes', async () => {
		mockAccount = { name: 'Maria' };
		await AsyncStorage.setItem(OWN_BANK_NAME_KEY, 'MARIA S OLIVEIRA');
		await mount();

		expect(ownNamesOfCall(0)).toEqual(['Maria']);
		expect(bankNameOfCall(0)).toBe('MARIA S OLIVEIRA');
	});

	it('sem nome em Ajustes, fica só o da conta (ou nenhum)', async () => {
		mockAccount = { name: 'Maria' };
		await mount();
		expect(ownNamesOfCall(0)).toEqual(['Maria']);
		expect(bankNameOfCall(0)).toBeNull();
	});

	it('o nome é relido a cada lote: salvo agora, já vale no próximo aviso', async () => {
		await mount();
		expect(bankNameOfCall(0)).toBeNull();

		await AsyncStorage.setItem(OWN_BANK_NAME_KEY, 'MARIA S OLIVEIRA');
		await act(async () => {
			mockListener?.();
		});

		const last = mockIngest.mock.calls.length - 1;
		expect(bankNameOfCall(last)).toBe('MARIA S OLIVEIRA');
	});

	// O import de extrato não escreve `capture_decision`: recebe os dois nomes juntos em
	// `ownNames`, como sempre recebeu o da conta.
	it('o import de extrato também recebe o nome de Ajustes', async () => {
		mockAccount = { name: 'Maria' };
		await AsyncStorage.setItem(OWN_BANK_NAME_KEY, 'MARIA S OLIVEIRA');
		await mount();

		await act(async () => {
			await captures.importStatement();
		});

		expect(mockPickAndImportOfx.mock.calls[0][0].ownNames).toEqual(['Maria', 'MARIA S OLIVEIRA']);
	});
});
