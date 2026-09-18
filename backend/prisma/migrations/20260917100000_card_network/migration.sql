-- Bandeira do cartão (v9 do app). A normalização de tipo e papel dos cartões é feita
-- no aparelho, que marca as linhas corrigidas como sujas e as sobe no próximo sync.

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "network" TEXT;
