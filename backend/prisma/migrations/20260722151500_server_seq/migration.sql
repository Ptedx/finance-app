-- DropIndex
DROP INDEX "budgets_userId_updatedAt_idx";

-- DropIndex
DROP INDEX "categories_userId_updatedAt_idx";

-- DropIndex
DROP INDEX "recurring_transactions_userId_updatedAt_idx";

-- DropIndex
DROP INDEX "transactions_userId_updatedAt_idx";

-- AlterTable
ALTER TABLE "budgets" ADD COLUMN     "serverSeq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "categories" ADD COLUMN     "serverSeq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "recurring_transactions" ADD COLUMN     "serverSeq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "serverSeq" SERIAL NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "budgets_serverSeq_key" ON "budgets"("serverSeq");

-- CreateIndex
CREATE INDEX "budgets_userId_serverSeq_idx" ON "budgets"("userId", "serverSeq");

-- CreateIndex
CREATE UNIQUE INDEX "categories_serverSeq_key" ON "categories"("serverSeq");

-- CreateIndex
CREATE INDEX "categories_userId_serverSeq_idx" ON "categories"("userId", "serverSeq");

-- CreateIndex
CREATE UNIQUE INDEX "recurring_transactions_serverSeq_key" ON "recurring_transactions"("serverSeq");

-- CreateIndex
CREATE INDEX "recurring_transactions_userId_serverSeq_idx" ON "recurring_transactions"("userId", "serverSeq");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_serverSeq_key" ON "transactions"("serverSeq");

-- CreateIndex
CREATE INDEX "transactions_userId_serverSeq_idx" ON "transactions"("userId", "serverSeq");


-- ---------------------------------------------------------------------------
-- serverSeq tem que avançar em TODA gravação, não só no INSERT.
--
-- O DEFAULT de uma coluna SERIAL só é avaliado ao inserir. Sem o gatilho abaixo, uma
-- linha *editada* manteria a sequência antiga: o aparelho que fez a edição enxergaria
-- a mudança, e todos os outros — cujo cursor já passou daquele número — nunca mais.
-- O gatilho fecha esse buraco no banco, onde nenhum caminho de escrita pode esquecê-lo.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION bump_server_seq() RETURNS trigger AS $$
BEGIN
    -- pg_get_serial_sequence descobre a sequence da própria tabela em que o gatilho
    -- está rodando, então a mesma função serve para as quatro.
    NEW."serverSeq" := nextval(pg_get_serial_sequence(TG_TABLE_NAME, 'serverSeq'));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER categories_bump_server_seq
    BEFORE UPDATE ON "categories"
    FOR EACH ROW EXECUTE FUNCTION bump_server_seq();

CREATE TRIGGER transactions_bump_server_seq
    BEFORE UPDATE ON "transactions"
    FOR EACH ROW EXECUTE FUNCTION bump_server_seq();

CREATE TRIGGER recurring_transactions_bump_server_seq
    BEFORE UPDATE ON "recurring_transactions"
    FOR EACH ROW EXECUTE FUNCTION bump_server_seq();

CREATE TRIGGER budgets_bump_server_seq
    BEFORE UPDATE ON "budgets"
    FOR EACH ROW EXECUTE FUNCTION bump_server_seq();
