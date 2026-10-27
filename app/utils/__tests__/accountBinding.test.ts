import type { Account } from '../../database/schema';
import { accountPairKey, duplicateAccountPairs, feedOwnerOf, isFed } from '../accountBinding';

const INTER = 'br.com.intermedium';

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

const interApp = account({ id: 'inter-app', name: 'Inter', bankName: 'Inter', packageName: INTER });
const interHand = account({ id: 'inter-pf', name: 'Inter PF', bankName: 'Inter', role: 'envelope' });

describe('quem recebe as compras do banco', () => {
	it('é a própria conta quando ela tem o app', () => {
		expect(feedOwnerOf([interApp, interHand], interApp)?.id).toBe('inter-app');
	});

	it('é a outra ficha do mesmo banco quando esta não tem o app', () => {
		expect(feedOwnerOf([interApp, interHand], interHand)?.id).toBe('inter-app');
	});

	it('não existe quando nenhuma ficha do banco está ligada a um app', () => {
		expect(feedOwnerOf([interHand], interHand)).toBeNull();
	});

	it('não existe com duas fichas ligadas: não há "a" conta do banco', () => {
		const outra = account({ id: 'inter-2', name: 'Inter PJ', bankName: 'Inter', packageName: 'br.com.inter.pj' });
		expect(feedOwnerOf([interApp, outra, interHand], interHand)).toBeNull();
	});

	it('conta com chave de extrato também é alimentada', () => {
		expect(isFed(account({ accountKey: 'inter:0001' }))).toBe(true);
		expect(isFed(interHand)).toBe(false);
	});
});

describe('fichas que parecem a mesma conta', () => {
	it('acha o par: uma ligada ao app, a outra cadastrada à mão', () => {
		const pairs = duplicateAccountPairs([interApp, interHand]);

		expect(pairs).toHaveLength(1);
		expect(pairs[0].fed.id).toBe('inter-app');
		expect(pairs[0].loose.id).toBe('inter-pf');
	});

	it('"Nu" e "Nubank" são o mesmo banco escrito de dois jeitos', () => {
		const pairs = duplicateAccountPairs([
			account({ id: 'nu', name: 'Nu', bankName: 'Nu', packageName: 'com.nu.production' }),
			account({ id: 'nubank-pf', name: 'Nubank PF', bankName: 'Nubank' }),
		]);

		expect(pairs).toHaveLength(1);
		expect(pairs[0].loose.id).toBe('nubank-pf');
	});

	it('com três fichas do banco não sugere nada: PF, PJ e conjunta existem', () => {
		expect(
			duplicateAccountPairs([
				interApp,
				interHand,
				account({ id: 'inter-3', name: 'Inter PJ', bankName: 'Inter' }),
			])
		).toHaveLength(0);
	});

	it('cartão e conta corrente do mesmo banco não são o mesmo par', () => {
		expect(
			duplicateAccountPairs([
				interApp,
				account({ id: 'inter-card', name: 'Cartão Inter', kind: 'credit_card', role: 'card', bankName: 'Inter' }),
			])
		).toHaveLength(0);
	});

	it('duas fichas sem app nenhum não viram sugestão: pode ser PF e PJ', () => {
		expect(
			duplicateAccountPairs([interHand, account({ id: 'inter-2', name: 'Inter PJ', bankName: 'Inter' })])
		).toHaveLength(0);
	});

	it('ficha arquivada ou apagada fica fora', () => {
		expect(duplicateAccountPairs([interApp, { ...interHand, archived: true }])).toHaveLength(0);
		expect(
			duplicateAccountPairs([interApp, { ...interHand, deletedAt: '2026-09-10T00:00:00.000Z' }])
		).toHaveLength(0);
	});

	it('conta sem banco não casa com nada', () => {
		expect(
			duplicateAccountPairs([
				account({ id: 'carteira', name: 'Carteira', kind: 'cash' }),
				account({ id: 'cofre', name: 'Cofre', kind: 'cash' }),
			])
		).toHaveLength(0);
	});
});

describe('"são contas diferentes" (SPD-072)', () => {
	const nuPj = account({ id: 'nu', name: 'Nubank PJ', bankName: 'Nu' });
	const nuPf = account({ id: 'nubank-pf', name: 'Nubank PF', bankName: 'Nubank', packageName: 'com.nu.production' });

	it('a chave do par é a mesma nas duas ordens', () => {
		expect(accountPairKey('nu', 'nubank-pf')).toBe(accountPairKey('nubank-pf', 'nu'));
		expect(accountPairKey('a', 'b')).not.toBe(accountPairKey('a', 'c'));
	});

	it('o par que o usuário disse serem contas diferentes não volta a ser sugerido', () => {
		expect(duplicateAccountPairs([nuPj, nuPf])).toHaveLength(1);
		expect(duplicateAccountPairs([nuPj, nuPf], [accountPairKey('nubank-pf', 'nu')])).toHaveLength(0);
	});

	it('a resposta vale só para aquele par: outro banco continua sugerido', () => {
		const pairs = duplicateAccountPairs([nuPj, nuPf, interApp, interHand], [accountPairKey('nu', 'nubank-pf')]);

		expect(pairs).toHaveLength(1);
		expect(pairs[0].loose.id).toBe('inter-pf');
	});
});

describe('a conta que recebe os avisos da PJ não é sugerida para juntar (SPD-074)', () => {
	const pjBusiness = account({ id: 'pj', name: 'Nubank PJ', bankName: 'Nu' });
	const pfBound = account({ id: 'pf', name: 'Nubank PF', bankName: 'Nubank', packageName: 'com.nu.production' });

	it('PF ligada ao app e PJ marcada para os avisos da Nu Empresas: as duas recebem avisos, não há par', () => {
		expect(duplicateAccountPairs([pjBusiness, pfBound])).toHaveLength(1);
		expect(duplicateAccountPairs([pjBusiness, pfBound], [], ['pj'])).toHaveLength(0);
	});

	it('a marca de uma conta de outro banco não muda o par', () => {
		expect(duplicateAccountPairs([pjBusiness, pfBound], [], ['inter'])).toHaveLength(1);
	});
});
