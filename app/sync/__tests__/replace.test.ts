import { chunkChanges, COLLECTIONS, type Collection, mergePages, replacementStamp, tombstonesFor } from '../replace';
import type { SyncChanges } from '../types';

const tx = (id: string, updatedAt: string, deletedAt: string | null = null) => ({
	id,
	amountCents: 1_000,
	category: 'food',
	date: '2025-03-01',
	note: null,
	isIncome: false,
	updatedAt,
	deletedAt,
});

const noLocal = (): Record<Collection, Set<string>> => Object.fromEntries(COLLECTIONS.map((c) => [c, new Set<string>()])) as Record<Collection, Set<string>>;

describe('o carimbo da substituição', () => {
	it('é agora quando a conta é mais velha que o relógio', () => {
		const server = { transactions: [tx('a', '2025-03-01T10:00:00.000Z')] } as Partial<SyncChanges>;
		expect(replacementStamp(server, '2026-09-18T12:00:00.000Z')).toBe('2026-09-18T12:00:00.000Z');
	});

	it('passa da linha mais nova da conta quando o relógio do celular está atrasado', () => {
		const server = { transactions: [tx('a', '2026-09-18T12:05:00.000Z')] } as Partial<SyncChanges>;
		expect(replacementStamp(server, '2026-09-18T12:00:00.000Z')).toBe('2026-09-18T12:05:00.001Z');
	});
});

describe('as lápides', () => {
	const stamp = '2026-09-18T12:00:00.000Z';

	it('apaga o que só a conta tem, com o conteúdo dela e o carimbo', () => {
		const server = { transactions: [tx('old', '2025-03-01T10:00:00.000Z'), tx('both', '2025-03-01T10:00:00.000Z')] } as Partial<SyncChanges>;
		const local = noLocal();
		local.transactions.add('both');
		const result = tombstonesFor(server, local, stamp);
		expect(result.transactions).toEqual([{ ...tx('old', '2025-03-01T10:00:00.000Z'), updatedAt: stamp, deletedAt: stamp }]);
	});

	it('não mexe no que o aparelho também tem, nem apagado aqui', () => {
		const server = { categories: [{ id: 'food', name: 'Food', color: '#fff', icon: 'x', type: 'expense', updatedAt: '2025-01-01T00:00:00.000Z' }] } as unknown as Partial<SyncChanges>;
		const local = noLocal();
		local.categories.add('food');
		expect(tombstonesFor(server, local, stamp).categories).toEqual([]);
	});

	it('o que já está apagado na conta não sobe de novo', () => {
		const server = { transactions: [tx('gone', '2025-03-01T10:00:00.000Z', '2025-03-02T10:00:00.000Z')] } as Partial<SyncChanges>;
		expect(tombstonesFor(server, noLocal(), stamp).transactions).toEqual([]);
	});

	it('cobre todas as coleções', () => {
		const server = Object.fromEntries(COLLECTIONS.map((c) => [c, [{ id: `${c}-1`, updatedAt: '2025-01-01T00:00:00.000Z' }]])) as unknown as Partial<SyncChanges>;
		const result = tombstonesFor(server, noLocal(), stamp) as unknown as Record<Collection, Array<{ id: string }>>;
		for (const collection of COLLECTIONS) expect(result[collection].map((row) => row.id)).toEqual([`${collection}-1`]);
	});
});

describe('as páginas do pull', () => {
	it('juntam tudo, e a mesma linha em duas páginas fica com a versão mais nova', () => {
		const merged = mergePages([
			{ transactions: [tx('a', '2025-01-01T00:00:00.000Z'), tx('b', '2025-01-01T00:00:00.000Z')] },
			{ transactions: [tx('a', '2025-02-01T00:00:00.000Z', '2025-02-01T00:00:00.000Z')] },
		] as Array<Partial<SyncChanges>>);
		expect(merged.transactions?.map((row) => [row.id, row.deletedAt])).toEqual([
			['a', '2025-02-01T00:00:00.000Z'],
			['b', null],
		]);
	});
});

describe('as remessas', () => {
	it('respeitam o limite por coleção e não misturam coleções', () => {
		const rows = Array.from({ length: 1_200 }, (_, index) => tx(`t${index}`, '2025-01-01T00:00:00.000Z'));
		const chunks = chunkChanges({ categories: [], transactions: rows, recurringTransactions: [], budgets: [] } as unknown as SyncChanges, 500);
		expect(chunks.map((chunk) => chunk.transactions.length)).toEqual([500, 500, 200]);
		expect(chunks.every((chunk) => chunk.categories.length === 0)).toBe(true);
	});
});
