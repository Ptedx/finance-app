-- O papel de cada conta no mês (v8 do app) e o valor mensal do envelope.
-- Contas já gravadas ganham o papel pelo tipo, o mesmo padrão de uma conta nova.

-- CreateEnum
CREATE TYPE "AccountRole" AS ENUM ('main', 'card', 'envelope', 'reserve', 'external');

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "envelopeMonthlyCents" BIGINT,
ADD COLUMN     "role" "AccountRole" NOT NULL DEFAULT 'main';

-- O UPDATE dispara `accounts_bump_server_seq`, e é o que se quer: os aparelhos
-- recebem o papel no próximo pull.
UPDATE "accounts"
   SET "role" = CASE
         WHEN "kind" = 'credit_card' THEN 'card'::"AccountRole"
         WHEN "kind" IN ('savings', 'investment') THEN 'reserve'::"AccountRole"
         ELSE 'main'::"AccountRole"
       END;
