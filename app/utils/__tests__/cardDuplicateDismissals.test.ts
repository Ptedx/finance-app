jest.mock('@react-native-async-storage/async-storage', () =>
	require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('../../database/database', () => ({ setPreference: jest.fn() }));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { setPreference } from '../../database/database';
import { isMirroredPreference } from '../../sync/preferences';
import { accountPairKey } from '../accountBinding';
import {
	CARD_DUPLICATE_DISMISSED_KEY,
	CARD_DUPLICATE_DISMISSED_MAX_LENGTH,
	dismissCardDuplicates,
	getDismissedCardDuplicates,
} from '../cardDuplicateDismissals';
import {
	BACKED_UP_PREFERENCE_KEYS,
	exportPreferences,
	importPreferences,
	STORAGE_KEYS,
	SYNCED_PREFERENCE_KEYS,
} from '../storageUtils';

/**
 * "Não é repetido" (SPD-098): o dono diz que o par marcado são duas compras de verdade, e o
 * aviso daquele par some. Guardado por par de ids numa preferência que sobe no sync e vai
 * no backup (SPD-100): noutro aparelho da conta o aviso não volta.
 */

beforeEach(async () => {
	await AsyncStorage.clear();
	(setPreference as jest.Mock).mockReset();
	(setPreference as jest.Mock).mockImplementation((key: string, value: string) => AsyncStorage.setItem(key, value));
});

describe('pares que o dono disse não serem repetidos', () => {
	it('começa sem nenhum', async () => {
		expect([...(await getDismissedCardDuplicates())]).toEqual([]);
	});

	it('guarda o par nas duas ordens e devolve a lista nova', async () => {
		const next = await dismissCardDuplicates([accountPairKey('x-padaria', 'm-padaria')]);
		expect([...next]).toEqual(['m-padaria|x-padaria']);
		expect([...(await getDismissedCardDuplicates())]).toEqual(['m-padaria|x-padaria']);
		expect(JSON.parse((await AsyncStorage.getItem(CARD_DUPLICATE_DISMISSED_KEY)) as string)).toEqual(['m-padaria|x-padaria']);
	});

	it('não repete um par já guardado', async () => {
		await dismissCardDuplicates(['a|b']);
		const next = await dismissCardDuplicates(['a|b', 'c|d']);
		expect([...next]).toEqual(['a|b', 'c|d']);
	});

	it('valor estragado conta como nenhum, em vez de quebrar a tela', async () => {
		await AsyncStorage.setItem(CARD_DUPLICATE_DISMISSED_KEY, '{nao é json');
		expect([...(await getDismissedCardDuplicates())]).toEqual([]);
		await AsyncStorage.setItem(CARD_DUPLICATE_DISMISSED_KEY, JSON.stringify(['a|b', 3, null]));
		expect([...(await getDismissedCardDuplicates())]).toEqual(['a|b']);
	});
});

describe('a resposta viaja com a conta e no backup (SPD-100)', () => {
	it('é a mesma chave de antes: o que já foi dispensado neste aparelho não se perde', () => {
		expect(STORAGE_KEYS.cardDuplicateDismissed).toBe('@spendr_card_duplicate_dismissed');
		expect(CARD_DUPLICATE_DISMISSED_KEY).toBe(STORAGE_KEYS.cardDuplicateDismissed);
	});

	it('está nas listas do sync e do backup, e o pull a escreve no aparelho', () => {
		const key = STORAGE_KEYS.cardDuplicateDismissed;
		expect(SYNCED_PREFERENCE_KEYS).toContain(key);
		expect(BACKED_UP_PREFERENCE_KEYS).toContain(key);
		expect(isMirroredPreference(key)).toBe(true);
		// O `id` da preferência no servidor tem até 64 caracteres.
		expect(key.length).toBeLessThanOrEqual(64);
	});

	it('dispensar grava pela preferência, que sobe no sync', async () => {
		const next = await dismissCardDuplicates(['a|b']);

		expect(setPreference).toHaveBeenCalledTimes(1);
		expect(setPreference).toHaveBeenCalledWith(STORAGE_KEYS.cardDuplicateDismissed, JSON.stringify([...next]));
	});

	it('par já guardado não grava de novo', async () => {
		await dismissCardDuplicates(['a|b']);
		await dismissCardDuplicates(['a|b']);

		expect(setPreference).toHaveBeenCalledTimes(1);
	});

	it('o backup leva os pares e a restauração os traz de volta', async () => {
		await dismissCardDuplicates(['a|b', 'c|d']);
		const exported = await exportPreferences();
		expect(JSON.parse(exported[STORAGE_KEYS.cardDuplicateDismissed])).toEqual(['a|b', 'c|d']);

		await AsyncStorage.clear();
		expect([...(await getDismissedCardDuplicates())]).toEqual([]);

		expect(await importPreferences(exported)).toBe(1);
		expect([...(await getDismissedCardDuplicates())]).toEqual(['a|b', 'c|d']);
	});
});

describe('o valor cabe no teto do servidor (2.000 caracteres)', () => {
	/** Ids no formato dos lançamentos (UUID v4, 36 caracteres): cada par tem 73. */
	const id = (n: number, side: string) => `${String(n).padStart(8, '0')}-0000-4000-8000-${side.repeat(12)}`;
	const pair = (n: number) => accountPairKey(id(n, 'a'), id(n, 'b'));
	const lastWritten = (): string => {
		const calls = (setPreference as jest.Mock).mock.calls;
		return calls[calls.length - 1][1] as string;
	};

	it('é o teto do servidor', () => {
		expect(CARD_DUPLICATE_DISMISSED_MAX_LENGTH).toBe(2_000);
	});

	it('com 30 pares, guarda só os mais novos que cabem: o mais novo fica, o mais velho sai', async () => {
		for (let n = 1; n <= 30; n++) await dismissCardDuplicates([pair(n)]);

		const written = lastWritten();
		expect(written.length).toBeLessThanOrEqual(CARD_DUPLICATE_DISMISSED_MAX_LENGTH);
		const kept: string[] = JSON.parse(written);
		// 26 pares de 73 caracteres, com aspas e vírgulas, dão 1.977; o 27º passaria do teto.
		expect(kept).toHaveLength(26);
		expect(kept[kept.length - 1]).toBe(pair(30));
		expect(kept[0]).toBe(pair(5));
		expect(kept).not.toContain(pair(1));
		expect([...(await getDismissedCardDuplicates())]).toEqual(kept);
	});

	it('30 pares num toque só também cabem, com os do fim do toque', async () => {
		const pairs = Array.from({ length: 30 }, (_, i) => pair(i + 1));
		const next = await dismissCardDuplicates(pairs);

		expect(lastWritten().length).toBeLessThanOrEqual(CARD_DUPLICATE_DISMISSED_MAX_LENGTH);
		expect([...next]).toEqual(pairs.slice(4));
	});

	it('um par que já estava não duplica nem empurra outro para fora', async () => {
		for (let n = 1; n <= 30; n++) await dismissCardDuplicates([pair(n)]);
		const before = lastWritten();
		(setPreference as jest.Mock).mockClear();

		const next = await dismissCardDuplicates([pair(10)]);

		expect(setPreference).not.toHaveBeenCalled();
		expect([...next]).toEqual(JSON.parse(before));
		expect([...next].filter((key) => key === pair(10))).toHaveLength(1);
	});
});
