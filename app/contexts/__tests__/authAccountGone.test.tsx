/**
 * A conta não existe mais (401 `account_gone`) do lado do AuthContext (SPD-084): o que
 * acontece no disco é de `leaveDeletedAccount` (`utils/accountDeletion.ts`); aqui a
 * pergunta é a tela — quando ela volta ao modo anônimo e quando aparece o aviso.
 *
 * O cliente HTTP avisa o motivo. A conta apagada: os dados saem deste aparelho (se ele já
 * sincronizava com ela), a sessão termina sem o `/auth/logout` e o aviso aparece uma vez.
 * Qualquer outro 401: só sai, como sempre. E na abertura do app — o caso do aparelho que
 * apagou a conta e foi fechado antes de terminar —, a restauração não encerra a sessão por
 * conta própria: quem encerra é quem apaga, depois de saber se apaga.
 *
 * Os mesmos dublês de `authDeleteAccount.test.tsx`.
 */

const mockSyncState = new Map<string, string>();

jest.mock('../../diagnostics/log', () => ({
	...jest.requireActual('../../diagnostics/log'),
	log: jest.fn(),
}));

jest.mock('../../api/client', () => ({
	ApiError: class ApiError extends Error {
		isOffline = false;
		isAuthExpired = true;
		code: string;
		constructor(errorCode: string) {
			super(errorCode);
			this.code = errorCode;
		}
		get isAccountGone() {
			return this.code === 'account_gone';
		}
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
	leaveDeletedAccount: jest.fn(),
}));

jest.mock('i18next', () => ({
	t: (key: string) => key,
}));

import { Alert } from 'react-native';
import { act, create } from 'react-test-renderer';
import { fetchProfile, logout } from '../../api/auth';
import { ApiError, setSessionLostHandler } from '../../api/client';
import { clearSyncState } from '../../database/database';
import * as syncQueue from '../../sync/queue';
import { leaveDeletedAccount } from '../../utils/accountDeletion';
import { AuthProvider, useAuth } from '../AuthContext';

type Api = ReturnType<typeof useAuth>;
type Loss = { reason: 'session_lost' } | { reason: 'account_gone'; accessToken: string };

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

/** O aviso do cliente HTTP, como ele chega: sem ninguém esperar. */
const clientReports = async (loss: Loss) => {
	const handler = (setSessionLostHandler as jest.Mock).mock.calls.at(-1)?.[0] as (
		loss: Loss
	) => void;
	await act(async () => {
		handler(loss);
	});
};

const gone: Loss = { reason: 'account_gone', accessToken: 'access' };
const leave = leaveDeletedAccount as jest.Mock;
const apiError = (code: string) => new (ApiError as unknown as new (code: string) => Error)(code);

let alert: jest.SpyInstance;

beforeEach(() => {
	jest.clearAllMocks();
	mockSyncState.clear();
	alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

afterEach(() => alert.mockRestore());

describe('o cliente HTTP avisa que a conta foi apagada', () => {
	it('os dados saíram daqui: a tela volta ao modo anônimo e o aviso aparece uma vez', async () => {
		const api = await mount();
		leave.mockResolvedValueOnce('wiped');

		await clientReports(gone);

		expect(leave).toHaveBeenCalledWith('access');
		expect(api().account).toBeNull();
		expect(syncQueue.stop).toHaveBeenCalled();
		expect(logout).not.toHaveBeenCalled();
		expect(alert).toHaveBeenCalledTimes(1);
		expect(alert).toHaveBeenCalledWith('dataWipe.accountGoneTitle', 'dataWipe.accountGoneMessage');
	});

	it('aparelho que nunca sincronizou com a conta: sai, sem aviso de dados apagados', async () => {
		const api = await mount();
		leave.mockResolvedValueOnce('signed_out');

		await clientReports(gone);

		expect(api().account).toBeNull();
		expect(alert).not.toHaveBeenCalled();
	});

	it('o apagar falhou: sai, e o aviso manda terminar por "Apagar todos os dados"', async () => {
		const api = await mount();
		leave.mockResolvedValueOnce('wipe_failed');

		await clientReports(gone);

		expect(api().account).toBeNull();
		expect(alert).toHaveBeenCalledTimes(1);
		expect(alert).toHaveBeenCalledWith('dataWipe.accountGoneTitle', 'account.deleteSuccessPartial');
	});

	it('a sessão já tinha acabado (o "Apagar a conta" daqui, um segundo 401): nada muda, nenhum aviso', async () => {
		const api = await mount();
		leave.mockResolvedValueOnce('already_ended');

		await clientReports(gone);

		expect(api().account).not.toBeNull();
		expect(syncQueue.stop).not.toHaveBeenCalled();
		expect(alert).not.toHaveBeenCalled();
	});

	it('dois 401 da mesma conta: um aviso só', async () => {
		await mount();
		leave.mockResolvedValueOnce('wiped').mockResolvedValueOnce('already_ended');

		await clientReports(gone);
		await clientReports(gone);

		expect(alert).toHaveBeenCalledTimes(1);
	});

	it('o tratamento falhou de vez: a sessão sai do mesmo jeito, com os dados aqui', async () => {
		const api = await mount();
		leave.mockRejectedValueOnce(new Error('banco travado'));
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

		await clientReports(gone);

		expect(api().account).toBeNull();
		expect(alert).not.toHaveBeenCalled();
		warn.mockRestore();
	});
});

describe('qualquer outro 401', () => {
	it('só sai, como sempre: nada é apagado e não há aviso', async () => {
		const api = await mount();

		await clientReports({ reason: 'session_lost' });

		expect(api().account).toBeNull();
		expect(leave).not.toHaveBeenCalled();
		expect(alert).not.toHaveBeenCalled();
	});
});

describe('na abertura do app', () => {
	it('o perfil volta com `account_gone`: a restauração não encerra nada sozinha, quem encerra é quem apaga', async () => {
		// O aparelho que apagou a conta e foi fechado antes de apagar os dados: o estado de
		// sync dele ainda está aqui, e é por ele que se sabe que os dados são da conta.
		mockSyncState.set('lastSyncedAt', '2026-10-27T09:00:00.000Z');
		(fetchProfile as jest.Mock).mockRejectedValueOnce(apiError('account_gone'));
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

		const api = await mount();

		expect(api().isLoading).toBe(false);
		expect(api().account).toBeNull();
		expect(syncQueue.start).not.toHaveBeenCalled();
		expect(clearSyncState).not.toHaveBeenCalled();
		expect(mockSyncState.get('lastSyncedAt')).toBe('2026-10-27T09:00:00.000Z');

		leave.mockResolvedValueOnce('wiped');
		await clientReports(gone);

		expect(leave).toHaveBeenCalledTimes(1);
		expect(alert).toHaveBeenCalledWith('dataWipe.accountGoneTitle', 'dataWipe.accountGoneMessage');
		warn.mockRestore();
	});

	it('outro 401 no perfil: encerra como antes', async () => {
		(fetchProfile as jest.Mock).mockRejectedValueOnce(apiError('invalid_token'));
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

		const api = await mount();

		expect(api().account).toBeNull();
		expect(clearSyncState).toHaveBeenCalled();
		warn.mockRestore();
	});
});
