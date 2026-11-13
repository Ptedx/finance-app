/**
 * Quem apaga este aparelho quando o sync descobre que a conta foi apagada em outro
 * (SPD-083, DEC-35), e o aviso ao usuário.
 *
 * O motor do sync não importa `utils/dataWipe.ts` (que importa a fila, que importa o
 * motor): ele recebe quem apaga por `setAccountWipedHandler`, como o cliente HTTP recebe
 * quem encerra a sessão. É o `SyncProvider` que registra, ao montar.
 *
 * O aviso é um só, depois do apagar, e não segura nada: o `Alert` do React Native não
 * espera resposta. Ele aparece uma vez porque o apagar acontece uma vez — com a marca
 * guardada, o mesmo `dataWipedAt` não apaga de novo (`wipeElsewhere.test.ts`).
 */

const mockCalls: string[] = [];

jest.mock('../../utils/dataWipe', () => ({
	wipeDevice: jest.fn(async () => {
		mockCalls.push('wipe');
	}),
}));

jest.mock('../engine', () => ({
	setAccountWipedHandler: jest.fn(),
}));

jest.mock('i18next', () => ({
	t: (key: string) => key,
}));

import { Alert } from 'react-native';
import { wipeDevice } from '../../utils/dataWipe';
import { setAccountWipedHandler } from '../engine';
import { applyRemoteWipe, startRemoteWipes } from '../remoteWipe';

const WIPED_AT = '2026-10-27T10:00:00.000Z';

let alert: jest.SpyInstance;

beforeEach(() => {
	jest.clearAllMocks();
	mockCalls.length = 0;
	alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {
		mockCalls.push('alert');
	});
});

afterEach(() => alert.mockRestore());

describe('o apagar que veio de outro aparelho', () => {
	it('apaga com a marca do servidor e só depois avisa, uma vez', async () => {
		await applyRemoteWipe(WIPED_AT);

		expect(wipeDevice).toHaveBeenCalledWith(WIPED_AT);
		expect(mockCalls).toEqual(['wipe', 'alert']);
		expect(alert).toHaveBeenCalledTimes(1);
		expect(alert).toHaveBeenCalledWith(
			'dataWipe.wipedElsewhereTitle',
			'dataWipe.wipedElsewhereMessage'
		);
	});

	it('o apagar falhou: nenhum aviso, e a falha sobe para o sync tentar de novo', async () => {
		(wipeDevice as jest.Mock).mockRejectedValueOnce(new Error('disco cheio'));

		await expect(applyRemoteWipe(WIPED_AT)).rejects.toThrow('disco cheio');

		expect(alert).not.toHaveBeenCalled();
	});
});

describe('o registro no motor do sync', () => {
	it('registra o apagar e, ao parar, tira o registro', () => {
		const stop = startRemoteWipes();
		expect(setAccountWipedHandler).toHaveBeenCalledWith(applyRemoteWipe);

		stop();
		expect(setAccountWipedHandler).toHaveBeenLastCalledWith(null);
	});
});
