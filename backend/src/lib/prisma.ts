import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { env } from './env.js';

const pool = new Pool({ connectionString: env.databaseUrl });
const adapter = new PrismaPg(pool);

/** Cliente único do processo: um Pool por requisição esgotaria as conexões do Postgres. */
export const prisma = new PrismaClient({ adapter });

export const disconnectPrisma = async (): Promise<void> => {
	await prisma.$disconnect();
	await pool.end();
};
