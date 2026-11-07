/**
 * "Apagar a conta" (SPD-084) do lado do AuthContext: o que acontece no disco é de
 * `utils/accountDeletion.ts`; aqui a pergunta é a tela — quando ela volta ao modo anônimo.
 *
 * Apagada (agora ou antes, em outro aparelho): sai, sem o `/auth/logout`, que falharia
 * com as sessões já apagadas no servidor. Sessão que caiu: sai também, como qualquer
 * outro 401 faria. Senha errada ou sem rede: continua conectada.
 *
 * Os mesmos dublês de `authDiagnostics.test.tsx`.
 */

const mockSyncState = new Map<string, string>();

jest.mock('../../diagnostics/log', () => ({
	...jest.requireActual('../../diagnostics/log'),
	log: jest.fn(),
}));

jest.mock('../../api/client', () => ({
	ApiError: class ApiError extends Error {
		isOffline = false;
		isAuthExpired = false;
	},
	isApiConfigured: () => true,
	setSessionLostHandler: jest.fn(),
}));

jest.mock('../../api/tokens', () => ({
	loadTokens: jest.fn(async () => ({ accessToken: 'access', refreshToken: 'refresh' })),
}));

jest.mock('../../api/auth', () => ({
	fetchProfile: jest.fn(async () => ({
		id: 'conta-1',
		email: 'eu@exemplo.com',
		name: 'Fulano',
		baseCurrency: 'BRL',
		language: 'pt',
	})),
	login: jest.fn(),
	register: jest.fn(),
	logout: jest.fn(async () => undefined),
	updateProfile: jest.fn(async () => undefined),
}));

jest.mock('../../api/sync', () => ({
	fetchSyncStatus: jest.fn(),
}));

jest.mock('../../database/database', () => ({
	clearSyncedData: jest.fn(async () => undefined),
	countLocalData: jest.fn(),
	markEverythingDirty: jest.fn(async () => undefined),
	getSyncState: jest.fn(async (key: string) => mockSyncState.get(key) ?? null),
	setSyncState: jest.fn(async (key: string, value: string | null) => {
		if (value === null) mockSyncState.delete(key);
		else mockSyncState.set(key, value);
	}),
	clearSyncState: jest.fn(async () => {
		mockSyncState.clear();
	}),
}));

jest.mock('../../sync/engine', () => ({
	pullAll: jest.fn(async () => 0),
	replaceAccountWithDevice: jest.fn(),
	resetCursor: jest.fn(async () => undefined),
}));

jest.mock('../../../modules/spendr-captures', () => ({
	isCaptureSupported: () => false,
	isCaptureEnabled: () => false,
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
	getItem: jest.fn(async () => null),
	setItem: jest.fn(async () => undefined),
	removeItem: jest.fn(async () => undefined),
}));

jest.mock('../../sync/queue', () => ({
	start: jest.fn(),
	stop: jest.fn(),
	schedule: jest.fn(),
	syncImmediately: jest.fn(),
	notifyDataChanged: jest.fn(),
}));

jest.mock('../../utils/accountDeletion', () => ({
	deleteAccountAndData: jest.fn(),
}));

import { act, create } from 'react-test-renderer';
import { logout } from '../../api/auth';
import * as syncQueue from '../../sync/queue';
import { deleteAccountAndData } from '../../utils/accountDeletion';
import { AuthProvider, useAuth } from '../AuthContext';

type Api = ReturnType<typeof useAuth>;

const mount = async (): Promise<() => Api> => {
	let latest: Api | null = null;
	const Probe = () => {
		latest = useAuth();
		return null;
	};
	await act(async () => {
		create(
			<AuthProvider>
				<Probe />
			</AuthProvider>
		);
	});
	return () => {
		if (!latest) throw new Error('provider não montou');
		return latest;
	};
};

const deletion = deleteAccountAndData as jest.Mock;

beforeEach(() => {
	jest.clearAllMocks();
	mockSyncState.clear();
});

describe('a conta saiu do servidor', () => {
	it.each([
		['apagada agora', { ok: true, alreadyGone: false, deviceWiped: true }],
		['já apagada em outro aparelho', { ok: true, alreadyGone: true, deviceWiped: true }],
		['apagada, com o aparelho pela metade', { ok: true, alreadyGone: false, deviceWiped: false }],
	])('%s: a tela volta ao modo anônimo, sem pedir logout ao servidor', async (_label, outcome) => {
		const api = await mount();
		expect(api().account).not.toBeNull();
		deletion.mockResolvedValueOnce(outcome);

		let result: unknown;
		await act(async () => {
			result = await api().deleteAccount('minha-senha');
		});

		expect(deletion).toHaveBeenCalledWith('minha-senha');
		expect(result).toEqual(outcome);
		expect(api().account).toBeNull();
		expect(syncQueue.stop).toHaveBeenCalled();
		expect(logout).not.toHaveBeenCalled();
	});
});

describe('a conta continua', () => {
	it.each([
		['senha errada', 'wrong_password'],
		['sem rede', 'unavailable'],
	])('%s: continua conectada', async (_label, reason) => {
		const api = await mount();
		deletion.mockResolvedValueOnce({ ok: false, reason });

		let result: unknown;
		await act(async () => {
			result = await api().deleteAccount('minha-senha');
		});

		expect(result).toEqual({ ok: false, reason });
		expect(api().account).not.toBeNull();
		expect(syncQueue.stop).not.toHaveBeenCalled();
	});

	it('a sessão caiu no meio: sai, como qualquer outro 401 faria', async () => {
		const api = await mount();
		deletion.mockResolvedValueOnce({ ok: false, reason: 'session_lost' });

		await act(async () => {
			await api().deleteAccount('minha-senha');
		});

		expect(api().account).toBeNull();
		expect(logout).not.toHaveBeenCalled();
	});
});
