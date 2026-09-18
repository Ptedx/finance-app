-- Contas, cartões e transferências (v7 do app), e a conta de origem + parcelamento
-- nos lançamentos. Tudo anulável nos lançamentos: uma linha anterior ao v7 continua
-- válida, e um aparelho anterior ao v7 continua sincronizando sem mandar os campos.

-- CreateEnum
CREATE TYPE "AccountKind" AS ENUM ('checking', 'savings', 'investment', 'cash', 'credit_card');

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "accountId" TEXT,
ADD COLUMN     "installmentCount" INTEGER,
ADD COLUMN     "installmentGroup" TEXT,
ADD COLUMN     "installmentIndex" INTEGER;

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "AccountKind" NOT NULL,
    "bankName" TEXT,
    "color" TEXT NOT NULL,
    "last4" TEXT,
    "closingDay" INTEGER,
    "dueDay" INTEGER,
    "creditLimitCents" BIGINT,
    "packageName" TEXT,
    "accountKey" TEXT,
    "openingBalanceCents" BIGINT NOT NULL,
    "openingBalanceDate" VARCHAR(10) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "serverSeq" SERIAL NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("userId","id")
);

-- CreateTable
CREATE TABLE "transfers" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fromAccountId" TEXT,
    "toAccountId" TEXT,
    "amountCents" BIGINT NOT NULL,
    "date" VARCHAR(10) NOT NULL,
    "note" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "serverSeq" SERIAL NOT NULL,

    CONSTRAINT "transfers_pkey" PRIMARY KEY ("userId","id")
);

-- CreateIndex
CREATE UNIQUE INDEX "accounts_serverSeq_key" ON "accounts"("serverSeq");

-- CreateIndex
CREATE INDEX "accounts_userId_serverSeq_idx" ON "accounts"("userId", "serverSeq");

-- CreateIndex
CREATE UNIQUE INDEX "transfers_serverSeq_key" ON "transfers"("serverSeq");

-- CreateIndex
CREATE INDEX "transfers_userId_serverSeq_idx" ON "transfers"("userId", "serverSeq");

-- CreateIndex
CREATE INDEX "transfers_userId_date_idx" ON "transfers"("userId", "date");

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- serverSeq precisa avançar em toda gravação, como nas demais tabelas sincronizadas
-- (ver a migration 20260722151500_server_seq). A função já existe; só os gatilhos.
CREATE TRIGGER accounts_bump_server_seq
    BEFORE UPDATE ON "accounts"
    FOR EACH ROW EXECUTE FUNCTION bump_server_seq();

CREATE TRIGGER transfers_bump_server_seq
    BEFORE UPDATE ON "transfers"
    FOR EACH ROW EXECUTE FUNCTION bump_server_seq();
