-- Um orçamento por mês, contando apenas as linhas vivas.
--
-- Um orçamento apagado mantém a lápide (deletedAt) para que o aparelho offline saiba
-- que ele sumiu; definir um novo orçamento para o mesmo mês não pode esbarrar nessa
-- lápide. Um @@unique comum do Prisma não sabe expressar o WHERE, daí a migration
-- escrita à mão — o mesmo índice parcial que o SQLite do app usa (CREATE_INDEXES em
-- app/database/schema.ts).
CREATE UNIQUE INDEX "budgets_userId_year_month_live_key"
    ON "budgets" ("userId", "year", "month")
    WHERE "deletedAt" IS NULL;
