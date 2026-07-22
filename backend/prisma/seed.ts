import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

/**
 * Não há nada global para semear.
 *
 * As categorias padrão pertencem a cada usuário e são criadas no registro (ver
 * `register` em src/controllers/auth.controller.ts), com os mesmos ids fixos que o app
 * usa localmente. A versão anterior deste arquivo inventava um "system user" dono das
 * categorias padrão — o que impediria o usuário de renomear ou apagar as suas, coisa
 * que o app permite hoje.
 *
 * O arquivo continua existindo para o `prisma db seed` não falhar e para servir de
 * ponto de entrada caso surja algum dado realmente global.
 */
const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
	const users = await prisma.user.count();
	console.log(`Nada a semear. Usuários cadastrados: ${users}.`);
}

main()
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(async () => {
		await prisma.$disconnect();
		await pool.end();
	});
