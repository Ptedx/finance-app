/**
 * O claim pendente e o vínculo com a conta: os dois gravados, não só na memória.
 *
 * Os dois casos reais: fechar o app no meio da pergunta "puxar da conta / subir do
 * aparelho / juntar" fazia a abertura seguinte **juntar** em silêncio; e a sessão que cai
 * sozinha (refresh recusado) seguida de login em outra conta deixava o cursor antigo
 * valendo, escondendo tudo o que a conta nova tinha gravado antes dele.
 *
 * O `sync_state` é substituído por um Map: é a mesma tabela chave-valor, e o SQLite de
 * verdade não roda no jest.
 */

const mockStore = new Map<string, string>();

jest.mock('../../database/database', () => ({
	getSyncState: jest.fn(async (key: string) => mockStore.get(key) ?? null),
	setSyncState: jest.fn(async (key: string, value: string | null) => {
		if (value === null) mockStore.delete(key);
		else mockStore.set(key, value);
	}),
	clearSyncState: jest.fn(async () => {
		mockStore.clear();
	}),
}));

import { clearSyncState, getSyncState, setSyncState } from '../../database/database';
import {
	beginSessionFor,
	type ClaimCounts,
	clearPendingClaim,
	endSyncSession,
	readPendingClaim,
	savePendingClaim,
} from '../claim';

const COUNTS: ClaimCounts = {
	account: { transactions: 120, recurringTransactions: 3, budgets: 2, customCategories: 1 },
	device: {
		transactions: 40,
		recurringTransactions: 1,
		budgets: 1,
		accounts: 2,
		transfers: 3,
		debts: 0,
		customCategories: 0,
		total: 47,
	},
};

beforeEach(() => {
	mockStore.clear();
	jest.clearAllMocks();
});

describe('claim pendente', () => {
	it('sem nada gravado, não há pergunta', async () => {
		expect(await readPendingClaim()).toBeNull();
	});

	it('a pergunta sobrevive ao fechamento do app, com os dois lados', async () => {
		await savePendingClaim({ accountId: 'conta-1', counts: COUNTS });

		// Nova "abertura": a leitura vem do banco, não da memória do processo.
		const pending = await readPendingClaim();

		expect(pending).toEqual({ accountId: 'conta-1', counts: COUNTS });
		expect(pending?.counts.device.total).toBe(47);
	});

	it('respondida, a pergunta sai de cena', async () => {
		await savePendingClaim({ accountId: 'conta-1', counts: COUNTS });
		await clearPendingClaim();

		expect(await readPendingClaim()).toBeNull();
		expect(setSyncState).toHaveBeenLastCalledWith('pendingClaim', null);
	});

	it('JSON ilegível conta como "não há": a pergunta nasce de novo, o app abre', async () => {
		await setSyncState('pendingClaim', '{isto não é json');
		expect(await readPendingClaim()).toBeNull();

		await setSyncState('pendingClaim', '{"counts":{}}');
		expect(await readPendingClaim()).toBeNull();
	});
});

describe('vínculo do estado de sync com a conta', () => {
	it('primeira conta: nada a limpar, o vínculo é gravado', async () => {
		expect(await beginSessionFor('conta-1')).toBe(true);
		expect(await getSyncState('syncAccountId')).toBe('conta-1');
	});

	it('a mesma conta de novo não joga o cursor fora', async () => {
		await beginSessionFor('conta-1');
		await setSyncState('pullCursor@18', '{"transactions":900}');
		jest.clearAllMocks();

		expect(await beginSessionFor('conta-1')).toBe(false);

		expect(clearSyncState).not.toHaveBeenCalled();
		expect(await getSyncState('pullCursor@18')).toBe('{"transactions":900}');
	});

	it('conta diferente zera o cursor — senão a conta nova abre sem nada', async () => {
		await beginSessionFor('conta-1');
		await setSyncState('pullCursor@18', '{"transactions":900}');
		await savePendingClaim({ accountId: 'conta-1', counts: COUNTS });
		jest.clearAllMocks();

		expect(await beginSessionFor('conta-2')).toBe(true);

		expect(clearSyncState).toHaveBeenCalledTimes(1);
		// O cursor e o claim da outra conta vão embora; o vínculo novo fica.
		expect(await getSyncState('pullCursor@18')).toBeNull();
		expect(await readPendingClaim()).toBeNull();
		expect(await getSyncState('syncAccountId')).toBe('conta-2');
	});

	it('a sessão encerrada não deixa estado para trás — nem o "sair", nem a que cai sozinha', async () => {
		await beginSessionFor('conta-1');
		await setSyncState('pullCursor@18', '{"transactions":900}');
		await setSyncState('lastSyncedAt', '2026-10-11T12:00:00.000Z');
		await savePendingClaim({ accountId: 'conta-1', counts: COUNTS });

		await endSyncSession();

		expect(mockStore.size).toBe(0);
	});

	it('depois de encerrar, entrar na mesma conta começa do zero em vez de pular linhas', async () => {
		await beginSessionFor('conta-1');
		await setSyncState('pullCursor@18', '{"transactions":900}');
		await endSyncSession();

		expect(await beginSessionFor('conta-1')).toBe(true);
		expect(await getSyncState('pullCursor@18')).toBeNull();
	});
});
