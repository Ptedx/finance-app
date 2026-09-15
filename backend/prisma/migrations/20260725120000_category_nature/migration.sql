-- CreateEnum
CREATE TYPE "CategoryNature" AS ENUM ('essential', 'discretionary');

-- AlterTable
--
-- A coluna entra com DEFAULT, então toda linha já gravada vira 'discretionary' sem
-- backfill. É a mesma escolha da migração v5 do SQLite do app: chamar de essencial um
-- gasto que o usuário nunca classificou inflaria as "necessidades" dele por conta própria.
ALTER TABLE "categories" ADD COLUMN     "nature" "CategoryNature" NOT NULL DEFAULT 'discretionary';

-- As categorias padrão de despesa que nascem essenciais, espelhando
-- ESSENTIAL_DEFAULT_CATEGORY_IDS em app/database/schema.ts, para que uma conta criada
-- antes desta versão classifique igual a uma criada depois. As lápides ficam de fora:
-- reescrever uma linha apagada só a faria ressurgir no pull de todo mundo.
--
-- O UPDATE dispara o gatilho `categories_bump_server_seq`, e isso é o comportamento
-- desejado: a linha mudou de verdade, então os aparelhos precisam recebê-la no próximo
-- pull em vez de ficarem com a natureza antiga.
UPDATE "categories"
   SET "nature" = 'essential'
 WHERE "id" IN ('food', 'transport', 'utilities', 'health', 'education')
   AND "deletedAt" IS NULL;
