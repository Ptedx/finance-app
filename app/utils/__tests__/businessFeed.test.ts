jest.mock('@react-native-async-storage/async-storage', () =>
	require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('../../database/database', () => ({ setPreference: jest.fn() }));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { setPreference } from '../../database/database';
import type { Account } from '../../database/schema';
import { businessAccountOf, businessLabelOf, isBusinessNotice, planBusinessFeed } from '../businessFeed';
import { getBusinessFeeds, setBusinessFeed } from '../businessFeedPreference';
import { BACKED_UP_PREFERENCE_KEYS, STORAGE_KEYS, SYNCED_PREFERENCE_KEYS } from '../storageUtils';

/**
 * Os avisos da conta PJ (SPD-074, DEC-34). O Nubank escreve "da conta Nu Empresas" no aviso
 * da PJ, e o usuário diz qual ficha é essa conta.
 */

const NUBANK = 'com.nu.production';
const INTER = 'br.com.intermedium';
const KEY = STORAGE_KEYS.businessFeeds;

const account = (overrides: Partial<Account>): Account => ({
	id: 'x',
	name: 'Conta',
	kind: 'checking',
	role: 'main',
	envelopeMonthlyCents: null,
	network: null,
	bankName: null,
	color: '#000',
	last4: null,
	closingDay: null,
	dueDay: null,
	closingDaysBefore: null,
	creditLimitCents: null,
	cardNames: null,
	packageName: null,
	accountKey: null,
	openingBalanceCents: 0,
	openingBalanceDate: '2026-09-01',
	sortOrder: 0,
	archived: false,
	updatedAt: '',
	...overrides,
});

const pjBound = account({ id: 'pj', name: 'Nubank PJ', bankName: 'Nu', packageName: NUBANK });
const pf = account({ id: 'pf', name: 'Nubank PF', bankName: 'Nubank' });
const nuCard = account({ id: 'card', name: 'Nubank · final 1234', kind: 'credit_card', bankName: 'Nubank', last4: '1234' });

beforeEach(async () => {
	await AsyncStorage.clear();
	(setPreference as jest.Mock).mockReset();
	(setPreference as jest.Mock).mockImplementation((key: string, value: string) => AsyncStorage.setItem(key, value));
});

describe('aviso da conta PJ', () => {
	it('o Pix da Nu Empresas é aviso da PJ', () => {
		expect(
			isBusinessNotice({
				packageName: NUBANK,
				title: 'Pix de R$ 50,00 enviado!',
				text: 'Pix de R$ 50,00 da conta Nu Empresas foi realizado com sucesso.',
			})
		).toBe(true);
	});

	it('o aviso sem a marca é da conta pessoal', () => {
		expect(
			isBusinessNotice({ packageName: NUBANK, title: 'Transferência recebida', text: 'Você recebeu uma transferência de R$ 50,00.' })
		).toBe(false);
	});

	it('a marca só vale no app do banco que a escreve', () => {
		expect(isBusinessNotice({ packageName: INTER, title: 'Pix', text: 'Pix para Nu Empresas de R$ 10,00' })).toBe(false);
		expect(businessLabelOf(NUBANK)).toBe('Nu Empresas');
		expect(businessLabelOf(INTER)).toBeNull();
		expect(businessLabelOf(null)).toBeNull();
	});
});

describe('qual ficha é a PJ', () => {
	it('começa sem nenhuma, e valor estragado vale como nenhuma', async () => {
		expect(await getBusinessFeeds()).toEqual({});
		await AsyncStorage.setItem(KEY, '[1,2');
		expect(await getBusinessFeeds()).toEqual({});
		await AsyncStorage.setItem(KEY, JSON.stringify({ [NUBANK]: 'pj', outro: 3 }));
		expect(await getBusinessFeeds()).toEqual({ [NUBANK]: 'pj' });
	});

	it('guarda pela preferência, que sobe no sync', async () => {
		const feeds = await setBusinessFeed(NUBANK, 'pj');

		expect(feeds).toEqual({ [NUBANK]: 'pj' });
		expect(setPreference).toHaveBeenCalledWith(KEY, JSON.stringify(feeds));
		expect(await getBusinessFeeds()).toEqual(feeds);
	});

	it('viaja no sync e no backup', () => {
		expect(SYNCED_PREFERENCE_KEYS).toContain(KEY);
		expect(BACKED_UP_PREFERENCE_KEYS).toContain(KEY);
		expect(KEY.length).toBeLessThanOrEqual(64);
	});

	it('a ficha marcada só vale viva, sem arquivar e conta corrente', () => {
		const feeds = { [NUBANK]: 'pj' };
		expect(businessAccountOf([pjBound, pf], feeds, NUBANK)?.id).toBe('pj');
		expect(businessAccountOf([{ ...pjBound, archived: true }, pf], feeds, NUBANK)).toBeNull();
		expect(businessAccountOf([{ ...pjBound, deletedAt: '2026-10-27T00:00:00.000Z' }, pf], feeds, NUBANK)).toBeNull();
		expect(businessAccountOf([pf], feeds, NUBANK)).toBeNull();
		expect(businessAccountOf([nuCard], { [NUBANK]: 'card' }, NUBANK)).toBeNull();
		expect(businessAccountOf([pjBound, pf], {}, NUBANK)).toBeNull();
	});
});

describe('"Avisos da Nu Empresas entram aqui"', () => {
	it('na PJ que recebia tudo do app, o resto dos avisos passa para a única outra conta do banco', () => {
		expect(planBusinessFeed([pjBound, pf, nuCard], 'pj')).toEqual({ packageName: NUBANK, label: 'Nu Empresas', moveFeedTo: pf });
	});

	it('com a PF já ligada ao app, só marca a PJ', () => {
		const pfBound = { ...pf, packageName: NUBANK };
		const pjLoose = { ...pjBound, packageName: null };

		expect(planBusinessFeed([pjLoose, pfBound], 'pj')).toEqual({ packageName: NUBANK, label: 'Nu Empresas', moveFeedTo: null });
	});

	it('com três contas do banco não escolhe para onde vai o resto', () => {
		const third = account({ id: 'conjunta', name: 'Nubank conjunta', bankName: 'Nubank' });

		expect(planBusinessFeed([pjBound, pf, third], 'pj')?.moveFeedTo).toBeNull();
	});

	it('banco que não marca o aviso da PJ não oferece nada', () => {
		const inter = account({ id: 'inter', name: 'Inter', bankName: 'Inter', packageName: INTER });

		expect(planBusinessFeed([inter], 'inter')).toBeNull();
	});

	it('conta de banco nenhum ligado ao app, ou cartão, não oferece nada', () => {
		expect(planBusinessFeed([pf], 'pf')).toBeNull();
		expect(planBusinessFeed([pjBound, nuCard], 'card')).toBeNull();
	});
});
