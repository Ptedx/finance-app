/**
 * A sessão no diário (SPD-014), do lado do AuthContext: a abertura com ou sem sessão, o
 * login que deu certo ou não, a escolha de dados no login (o claim) e o "sair". Nunca o
 * e-mail, o nome, o id da conta nem o token.
 *
 * Os mesmos dublês de `authClaim.test.tsx`; o diário é um `log` que só anota.
 */

const mockSyncState = new Map<string, string>();

jest.mock('../../diagnostics/log', () => ({ ...jest.requireActual('../../diagnostics/log'), log: jest.fn() }));

jest.mock('../../api/client', () => ({
	ApiError: class ApiError extends Error {
		isOffline = false;
		isAuthExpired = false;
	},
	isApiConfigured: () => true,
	setSessionLostHandler: jest.fn(),
}));

jest.mock('../../api/tokens', () => ({
	loadTokens: jest.fn(async () => ({ accessToken: 'access-secreto', refreshToken: 'refresh-secreto' })),
}));

const PROFILE = {
	id: 'conta-secreta-1',
	email: 'eu@exemplo.com',
	name: 'Fulano de Tal',
	baseCurrency: 'BRL',
	language: 'pt',
};

jest.mock('../../api/auth', () => ({
	fetchProfile: jest.fn(async () => ({
		id: 'conta-secreta-1',
		email: 'eu@exemplo.com',
		name: 'Fulano de Tal',
		baseCurrency: 'BRL',
		language: 'pt',
	})),
	login: jest.fn(),
	register: jest.fn(),
	logout: jest.fn(async () => undefined),
	updateProfile: jest.fn(async () => undefined),
}));

jest.mock('../../api/sync', () => ({
	fetchSyncStatus: jest.fn(async () => ({
		hasData: true,
		counts: { transactions: 120, recurringTransactions: 0, budgets: 1, customCategories: 0 },
	})),
}));

jest.mock('../../database/database', () => ({
	clearSyncedData: jest.fn(async () => undefined),
	countLocalData: jest.fn(async () => ({
		transactions: 40,
		recurringTransactions: 0,
		budgets: 0,
		accounts: 1,
		transfers: 0,
		debts: 0,
		customCategories: 0,
		total: 41,
	})),
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
	replaceAccountWithDevice: jest.fn(async () => ({ removed: 3, notRemoved: 1 })),
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

import { act, create } from 'react-test-renderer';
import { fetchProfile, login, logout, register } from '../../api/auth';
import { loadTokens } from '../../api/tokens';
import { countLocalData, markEverythingDirty } from '../../database/database';
import { log } from '../../diagnostics/log';
import { replaceAccountWithDevice } from '../../sync/engine';
import { AuthProvider, useAuth } from '../AuthContext';

const logMock = log as jest.Mock;

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

const events = () =>
	logMock.mock.calls.map(([area, event, options]) => ({ area, event, level: options?.level, data: options?.data }));

/** Um erro do cliente HTTP, pela forma. */
const httpError = (status: number, code: string) =>
	Object.assign(new Error('E-mail eu@exemplo.com ou senha inválidos'), { name: 'ApiError', status, code });

/** Nada do usuário em nenhum evento. */
const expectNothingPersonal = () => {
	expect(JSON.stringify(logMock.mock.calls)).not.toMatch(/exemplo|Fulano|conta-secreta|secreto|senha-secreta/);
};

let warnSpy: jest.SpyInstance;

beforeEach(() => {
	mockSyncState.clear();
	jest.clearAllMocks();
	warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => warnSpy.mockRestore());

describe('abertura', () => {
	it('com sessão guardada: restaurada', async () => {
		await mount();

		expect(events()).toEqual([
			{
				area: 'session',
				event: 'session_restore',
				level: undefined,
				data: { outcome: 'restored', profileLoaded: true, staleClaimCleared: false },
			},
		]);
		expectNothingPersonal();
	});

	it('sem sessão: anônimo', async () => {
		(loadTokens as jest.Mock).mockResolvedValueOnce(null);
		await mount();

		expect(events()).toEqual([
			expect.objectContaining({ event: 'session_restore', data: { outcome: 'anonymous', configured: true } }),
		]);
	});

	it('o perfil recusado derruba a sessão: o diário diz o status', async () => {
		(fetchProfile as jest.Mock).mockRejectedValueOnce(httpError(401, 'invalid_token'));
		await mount();

		expect(events()).toEqual([
			expect.objectContaining({
				event: 'session_restore',
				level: 'warn',
				data: { outcome: 'failed', error: 'ApiError', status: 401, offline: false, code: 'invalid_token' },
			}),
		]);
		expectNothingPersonal();
	});
});

describe('login e a escolha de dados', () => {
	const signIn = async () => {
		(loadTokens as jest.Mock).mockResolvedValueOnce(null);
		const api = await mount();
		logMock.mockClear();
		await act(async () => {
			await api().signIn({ email: 'eu@exemplo.com', password: 'senha-secreta' });
		});
		return api;
	};

	it('os dois lados com dados: login ok e a pergunta', async () => {
		(login as jest.Mock).mockResolvedValueOnce(PROFILE);
		await signIn();

		expect(events()).toEqual([
			{ area: 'session', event: 'session_login', level: undefined, data: { method: 'login' } },
			{
				area: 'session',
				event: 'session_claim',
				level: undefined,
				data: { outcome: 'ask', firstSession: true, accountHasData: true, deviceRows: 41 },
			},
		]);
		expectNothingPersonal();
	});

	it('conta vazia: tudo sobe sem perguntar', async () => {
		const { fetchSyncStatus } = jest.requireMock('../../api/sync') as { fetchSyncStatus: jest.Mock };
		fetchSyncStatus.mockResolvedValueOnce({ hasData: false, counts: {} });
		(login as jest.Mock).mockResolvedValueOnce(PROFILE);
		await signIn();

		expect(events()[1].data).toMatchObject({ outcome: 'account_empty', accountHasData: false });
	});

	it('aparelho vazio: a conta desce sem perguntar', async () => {
		(countLocalData as jest.Mock).mockResolvedValueOnce({ total: 0 });
		(login as jest.Mock).mockResolvedValueOnce(PROFILE);
		await signIn();

		expect(events()[1].data).toMatchObject({ outcome: 'device_empty', deviceRows: 0 });
	});

	it('senha errada: login_failed com o status, sem o e-mail', async () => {
		(login as jest.Mock).mockRejectedValueOnce(httpError(401, 'invalid_credentials'));
		(loadTokens as jest.Mock).mockResolvedValueOnce(null);
		const api = await mount();
		logMock.mockClear();

		await act(async () => {
			await expect(api().signIn({ email: 'eu@exemplo.com', password: 'senha-secreta' })).rejects.toThrow();
		});

		expect(events()).toEqual([
			{
				area: 'session',
				event: 'session_login_failed',
				level: 'warn',
				data: { method: 'login', error: 'ApiError', status: 401, offline: false, code: 'invalid_credentials' },
			},
		]);
		expectNothingPersonal();
	});

	it('criar conta: login ok pelo cadastro', async () => {
		(register as jest.Mock).mockResolvedValueOnce(PROFILE);
		(loadTokens as jest.Mock).mockResolvedValueOnce(null);
		const api = await mount();
		logMock.mockClear();

		await act(async () => {
			await api().signUp({ email: 'eu@exemplo.com', password: 'senha-secreta', name: 'Fulano de Tal' });
		});

		expect(events()).toEqual([expect.objectContaining({ event: 'session_login', data: { method: 'register' } })]);
		expectNothingPersonal();
	});

	it('responder "subir deste aparelho": o que a substituição fez', async () => {
		(login as jest.Mock).mockResolvedValueOnce(PROFILE);
		const api = await signIn();
		logMock.mockClear();

		await act(async () => {
			await api().resolveClaim('upload');
		});

		expect(events()).toEqual([
			{
				area: 'session',
				event: 'session_claim_resolved',
				level: undefined,
				data: expect.objectContaining({ choice: 'upload', removed: 3, notRemoved: 1 }),
			},
		]);
	});

	it('a resposta que falha: claim_failed com a escolha', async () => {
		(login as jest.Mock).mockResolvedValueOnce(PROFILE);
		const api = await signIn();
		logMock.mockClear();
		(markEverythingDirty as jest.Mock).mockRejectedValueOnce(new RangeError('processo morto'));

		await act(async () => {
			await expect(api().resolveClaim('merge')).rejects.toThrow('processo morto');
		});

		expect(events()).toEqual([
			expect.objectContaining({ event: 'session_claim_failed', level: 'error', data: { choice: 'merge', error: 'RangeError' } }),
		]);
		expect(replaceAccountWithDevice).not.toHaveBeenCalled();
	});
});

describe('sair', () => {
	it('logout registrado', async () => {
		const api = await mount();
		logMock.mockClear();

		await act(async () => {
			await api().signOut();
		});

		expect(events()).toEqual([expect.objectContaining({ event: 'session_logout', data: { ok: true } })]);
	});

	it('logout que falha também', async () => {
		(logout as jest.Mock).mockRejectedValueOnce(httpError(0, 'offline'));
		const api = await mount();
		logMock.mockClear();

		await act(async () => {
			await expect(api().signOut()).rejects.toThrow();
		});

		expect(events()).toEqual([
			expect.objectContaining({
				event: 'session_logout',
				level: 'warn',
				data: { ok: false, error: 'ApiError', status: 0, offline: true, code: 'offline' },
			}),
		]);
		expectNothingPersonal();
	});
});
