-- v17 do app: a meta da reserva de emergência e a conta de reserva "só investimento".
-- Só acrescenta: a API e o app anteriores continuam funcionando.

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "reservePurpose" TEXT;

-- CreateTable
CREATE TABLE "reserve_goals" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "targetMonths" INTEGER NOT NULL,
    "customMonthlyCostCents" BIGINT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "serverSeq" SERIAL NOT NULL,

    CONSTRAINT "reserve_goals_pkey" PRIMARY KEY ("userId","id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reserve_goals_serverSeq_key" ON "reserve_goals"("serverSeq");

-- CreateIndex
CREATE INDEX "reserve_goals_userId_serverSeq_idx" ON "reserve_goals"("userId", "serverSeq");

-- AddForeignKey
ALTER TABLE "reserve_goals" ADD CONSTRAINT "reserve_goals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Toda tabela sincronizada precisa do gatilho que dá uma serverSeq nova a cada UPDATE
-- (ver 20260722151500_server_seq); sem ele, editar a meta num aparelho não chega aos outros.
CREATE TRIGGER reserve_goals_bump_server_seq
    BEFORE UPDATE ON "reserve_goals"
    FOR EACH ROW EXECUTE FUNCTION bump_server_seq();
