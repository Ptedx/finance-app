/**
 * A tradução das preferências (`preferences`) entre a linha do Postgres e o formato do fio.
 *
 * A mais simples das coleções: chave e texto, sem nada a converter. Fica fora do controller
 * pelo mesmo motivo de `billWire.ts` — o que quebra em silêncio é o `undefined`: uma lápide
 * ausente na chegada tem de virar `null` na coluna, senão o Prisma mantém a lápide antiga
 * no update e a preferência que voltou a valer nunca se propaga.
 *
 * Nada neste arquivo importa Prisma nem a configuração do servidor — é o que permite
 * testá-lo sem banco e sem variáveis de ambiente.
 */

/** A preferência como ela chega no push, já validada (espelha `PreferencePayload`). */
export interface IncomingPreference {
	/** A chave do AsyncStorage do app. */
	id: string;
	value: string;
	updatedAt: string;
	deletedAt?: string | null | undefined;
}

/** As colunas da preferência, sem `id` e `userId`: o upsert os põe no `create`. */
export interface PreferenceColumns {
	value: string;
	updatedAt: Date;
	deletedAt: Date | null;
}

/** A linha como o Postgres a devolve, no que o fio precisa dela. */
export interface StoredPreference extends PreferenceColumns {
	id: string;
}

export const preferenceColumns = (row: IncomingPreference): PreferenceColumns => ({
	value: row.value,
	updatedAt: new Date(row.updatedAt),
	deletedAt: row.deletedAt ? new Date(row.deletedAt) : null,
});

export const preferenceToWire = (row: StoredPreference) => ({
	id: row.id,
	value: row.value,
	updatedAt: row.updatedAt.toISOString(),
	deletedAt: row.deletedAt === null ? null : row.deletedAt.toISOString(),
});
