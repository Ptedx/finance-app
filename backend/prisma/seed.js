import 'dotenv/config';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
// Categoria padrao do projeto
const DEFAULT_CATEGORIES = [
    { id: 'food', name: 'Alimentação', color: '#EF4444', icon: 'restaurant' },
    { id: 'transport', name: 'Transporte', color: '#3B82F6', icon: 'bus' },
    { id: 'salary', name: 'Salário', color: '#10B981', icon: 'cash' },
    { id: 'entertainment', name: 'Lazer', color: '#8B5CF6', icon: 'game-controller' },
    { id: 'bills', name: 'Contas', color: '#F59E0B', icon: 'document-text' },
    { id: 'health', name: 'Saúde', color: '#EC4899', icon: 'medkit' },
    { id: 'education', name: 'Educação', color: '#6366F1', icon: 'book' },
    { id: 'shopping', name: 'Compras', color: '#14B8A6', icon: 'cart' },
    { id: 'uncategorized', name: 'Sem Categoria', color: '#9CA3AF', icon: 'help' },
];
async function main() {
    console.log('Seeding database...');
    // Create a default system user to own default categories
    const systemUser = await prisma.user.upsert({
        where: { email: 'system@spendr.app' },
        update: {},
        create: {
            email: 'system@spendr.app',
            name: 'System User',
            passwordHash: 'none', // System user doesn't login
        },
    });
    for (const category of DEFAULT_CATEGORIES) {
        await prisma.category.upsert({
            where: { id: category.id },
            update: {},
            create: {
                id: category.id,
                name: category.name,
                color: category.color,
                icon: category.icon,
                isDefault: true,
                userId: systemUser.id,
            },
        });
    }
    console.log('Database seeded successfully!');
}
main()
    .then(async () => {
    await prisma.$disconnect();
})
    .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
});
//# sourceMappingURL=seed.js.map