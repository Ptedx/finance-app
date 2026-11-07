jest.mock('@react-native-async-storage/async-storage', () =>
	require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import AsyncStorage from '@react-native-async-storage/async-storage';
import { accountPairKey } from '../accountBinding';
import {
	CARD_DUPLICATE_DISMISSED_KEY,
	dismissCardDuplicates,
	getDismissedCardDuplicates,
} from '../cardDuplicateDismissals';

/**
 * "Não é repetido" (SPD-098): o dono diz que o par marcado são duas compras de verdade, e o
 * aviso daquele par some. Guardado neste aparelho, por par de ids.
 */

beforeEach(async () => {
	await AsyncStorage.clear();
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
