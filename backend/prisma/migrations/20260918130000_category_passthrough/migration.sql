-- Repasse: a terceira natureza de categoria (v14 do app). Dinheiro que só passou pela
-- conta desconta da receita em vez de contar como gasto.

-- AlterEnum
ALTER TYPE "CategoryNature" ADD VALUE 'passthrough';
