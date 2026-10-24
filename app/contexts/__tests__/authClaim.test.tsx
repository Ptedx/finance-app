/**
 * A pergunta "puxar da conta / subir do aparelho / juntar" atravessa o fechamento do app.
 *
 * O caso real: a conta tinha histórico, o aparelho também, a pergunta apareceu — e o
 * Android matou o processo antes da resposta. Na abertura seguinte não havia pergunta
 * nenhuma, a fila ligava e os dois conjuntos eram **juntados** em silêncio; quem queria
 * descartar o aparelho ficava com tudo somado.
 *
 * Aqui o `sync_state` é um Map (a mesma tabela chave-valor) e o resto do mundo é mock.
 * `sync/claim.ts` roda de verdade: é ele que grava a pergunta.
 */

const mockSyncState = new Map<string, string>();

jest.mock('../../api/client', () => ({
	ApiError: class ApiError extends Error {
		isOffline = false;
		isAuthExpired = false;
	},
	isApiConfigured: () => true,
	setSessionLostHandler: jest.fn(),
}));

jest.mock('../../api/tokens', () => ({
	loadTokens: jest.fn(async () => ({ accessToken: 'a', refreshToken: 'r' })),
}));

jest.mock('../../api/auth', () => ({
	fetchProfile: jest.fn(async () => ({
		id: 'conta-1',
		email: 'eu@exemplo.com',
		name: 'Eu',
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
	replaceAccountWithDevice: jest.fn(async () => ({ removed: 0, notRemoved: 0 })),
	resetCursor: jest.fn(async () => undefined),
}));

/** O acesso de leitura de notificações do Android: o módulo nativo, programável por teste. */
const mockCapture = { supported: true, enabled: false };
jest.mock('../../../modules/spendr-captures', () => ({
	isCaptureSupported: () => mockCapture.supported,
	isCaptureEnabled: () => mockCapture.enabled,
}));

const mockStorage = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
	getItem: jest.fn(async (key: string) => mockStorage.get(key) ?? null),
	setItem: jest.fn(async (key: string, value: string) => {
		mockStorage.set(key, value);
	}),
	removeItem: jest.fn(async (key: string) => {
		mockStorage.delete(key);
	}),
}));

jest.mock('../../sync/queue', () => ({
	start: jest.fn(),
	stop: jest.fn(),
	schedule: jest.fn(),
	syncImmediately: jest.fn(),
	notifyDataChanged: jest.fn(),
}));

import { act, create } from 'react-test-renderer';
import { login } from '../../api/auth';
import { clearSyncState, markEverythingDirty } from '../../database/database';
import { readPendingClaim, savePendingClaim } from '../../sync/claim';
import * as syncQueue from '../../sync/queue';
import { STORAGE_KEYS } from '../../utils/storageUtils';
import { AuthProvider, type ClaimChoice, useAuth } from '../AuthContext';

/** A fila é mock: ligá-la é o que o claim pendente tem de impedir. */
const queueStart = syncQueue.start as jest.Mock;

type Api = ReturnType<typeof useAuth>;

/** Monta o provider e devolve o valor do contexto, relido a cada render. */
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

const CLAIM = {
	accountId: 'conta-1',
	counts: {
		account: { transactions: 120, recurringTransactions: 0, budgets: 1, customCategories: 0 },
		device: {
			transactions: 40,
			recurringTransactions: 0,
			budgets: 0,
			accounts: 1,
			transfers: 0,
			debts: 0,
			customCategories: 0,
			captures: 0,
			merchantRules: 0,
			retirementGoals: 0,
			reserveGoals: 0,
			bills: 0,
			total: 41,
		},
	},
};

beforeEach(() => {
	mockSyncState.clear();
	mockStorage.clear();
	mockCapture.supported = true;
	mockCapture.enabled = false;
	jest.clearAllMocks();
});

describe('abertura com a escolha pendente', () => {
	it('a pergunta volta e a fila não liga', async () => {
		await savePendingClaim(CLAIM);

		const api = await mount();

		expect(api().pendingClaim).toBe(true);
		expect(api().claimCounts).toEqual(CLAIM.counts);
		// O defeito era exatamente este: a fila ligava e o `merge` acontecia sozinho.
		expect(queueStart).not.toHaveBeenCalled();
		expect(markEverythingDirty).not.toHaveBeenCalled();
	});

	it('sem escolha pendente, a abertura liga a fila como antes', async () => {
		const api = await mount();

		expect(api().pendingClaim).toBe(false);
		expect(queueStart).toHaveBeenCalledTimes(1);
	});

	it('escolha de outra conta é descartada em vez de reaparecer', async () => {
		await savePendingClaim({ ...CLAIM, accountId: 'outra-conta' });

		const api = await mount();

		expect(api().pendingClaim).toBe(false);
		expect(await readPendingClaim()).toBeNull();
		expect(queueStart).toHaveBeenCalledTimes(1);
	});
});

describe('responder a escolha', () => {
	const answer = async (choice: ClaimChoice) => {
		await savePendingClaim(CLAIM);
		const api = await mount();
		expect(api().pendingClaim).toBe(true);

		await act(async () => {
			await api().resolveClaim(choice);
		});

		return api;
	};

	it('juntar: a pergunta é apagada e a fila liga', async () => {
		const api = await answer('merge');

		expect(markEverythingDirty).toHaveBeenCalledTimes(1);
		expect(await readPendingClaim()).toBeNull();
		expect(api().pendingClaim).toBe(false);
		expect(queueStart).toHaveBeenCalledTimes(1);
	});

	it('entrar numa conta diferente joga fora o cursor da anterior', async () => {
		// O cenário do achado 6.4: a sessão caiu sozinha (refresh recusado) e o login
		// seguinte foi em outra conta. Com o cursor antigo valendo, a conta nova abria
		// sem nada — a `serverSeq` é global por tabela, não por usuário.
		mockSyncState.set('syncAccountId', 'conta-antiga');
		mockSyncState.set('pullCursor@18', '{"transactions":900}');

		const api = await mount();
		(login as jest.Mock).mockResolvedValueOnce({
			id: 'conta-1',
			email: 'eu@exemplo.com',
			name: 'Eu',
			baseCurrency: 'BRL',
			language: 'pt',
		});

		await act(async () => {
			await api().signIn({ email: 'eu@exemplo.com', password: 'x' });
		});

		expect(clearSyncState).toHaveBeenCalled();
		expect(mockSyncState.get('pullCursor@18')).toBeUndefined();
		expect(mockSyncState.get('syncAccountId')).toBe('conta-1');
		// E a pergunta que nasceu é desta conta, não da anterior.
		expect((await readPendingClaim())?.accountId).toBe('conta-1');
	});

	it('a pergunta só é apagada depois de cumprida — interromper faz ela voltar', async () => {
		await savePendingClaim(CLAIM);
		const api = await mount();

		(markEverythingDirty as jest.Mock).mockRejectedValueOnce(new Error('processo morto'));

		await act(async () => {
			await expect(api().resolveClaim('merge')).rejects.toThrow('processo morto');
		});

		// Nada foi cumprido, então nada foi apagado: a próxima abertura pergunta de novo.
		expect(await readPendingClaim()).toEqual(CLAIM);
		expect(queueStart).not.toHaveBeenCalled();
	});
});

describe('o acesso às notificações, que não viaja com a conta', () => {
	const PROFILE = {
		id: 'conta-1',
		email: 'eu@exemplo.com',
		name: 'Eu',
		baseCurrency: 'BRL',
		language: 'pt',
	};

	/** Entra na conta a partir do modo anônimo (sem sessão guardada). */
	const signInFresh = async () => {
		const { loadTokens } = jest.requireMock('../../api/tokens') as { loadTokens: jest.Mock };
		loadTokens.mockResolvedValueOnce(null);
		const api = await mount();
		(login as jest.Mock).mockResolvedValueOnce(PROFILE);
		await act(async () => {
			await api().signIn({ email: 'eu@exemplo.com', password: 'x' });
		});
		return api;
	};

	it('primeiro login num Android sem o acesso: o aviso de captura dispensado volta a valer', async () => {
		// O aviso foi dispensado aqui (ou veio num backup). Sem o acesso, a captura não
		// funciona neste aparelho, e o aviso é o caminho que leva à tela do sistema.
		mockStorage.set(STORAGE_KEYS.captureAccessDismissed, '1');

		await signInFresh();

		expect(mockStorage.has(STORAGE_KEYS.captureAccessDismissed)).toBe(false);
	});

	it('com o acesso já ligado, nada muda', async () => {
		mockCapture.enabled = true;
		mockStorage.set(STORAGE_KEYS.captureAccessDismissed, '1');

		await signInFresh();

		expect(mockStorage.get(STORAGE_KEYS.captureAccessDismissed)).toBe('1');
	});

	it('sem o módulo (iOS, web), nada muda', async () => {
		mockCapture.supported = false;
		mockStorage.set(STORAGE_KEYS.captureAccessDismissed, '1');

		await signInFresh();

		expect(mockStorage.get(STORAGE_KEYS.captureAccessDismissed)).toBe('1');
	});

	it('entrar de novo na mesma conta não insiste', async () => {
		mockSyncState.set('syncAccountId', 'conta-1');
		mockStorage.set(STORAGE_KEYS.captureAccessDismissed, '1');

		await signInFresh();

		expect(mockStorage.get(STORAGE_KEYS.captureAccessDismissed)).toBe('1');
	});
});
