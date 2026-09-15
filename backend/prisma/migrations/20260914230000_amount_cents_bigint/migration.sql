-- AlterTable
--
-- `amountCents` passa de INTEGER (teto 2.147.483.647, ou R$ 21 milhões) para BIGINT.
-- O app aceita até 10^15 centavos (MAX_CENTS em app/utils/money.ts), e com a coluna
-- menor que o campo um valor entre os dois tetos era gravado no aparelho e recusado no
-- sync — sem aviso, e travando o push daquele aparelho. O teto agora é o mesmo nos
-- dois lados (MAX_AMOUNT_CENTS em src/schemas/sync.ts).
--
-- Alargar o tipo preserva todo valor existente e não dispara os gatilhos de
-- `serverSeq`: nenhuma linha muda de conteúdo, então nenhum aparelho precisa rebaixá-la.
ALTER TABLE "transactions" ALTER COLUMN "amountCents" SET DATA TYPE BIGINT;
ALTER TABLE "recurring_transactions" ALTER COLUMN "amountCents" SET DATA TYPE BIGINT;
ALTER TABLE "budgets" ALTER COLUMN "amountCents" SET DATA TYPE BIGINT;
ALTER TABLE "passive_incomes" ALTER COLUMN "amountCents" SET DATA TYPE BIGINT;
