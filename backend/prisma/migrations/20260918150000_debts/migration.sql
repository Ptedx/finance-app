-- Dívidas (v15 do app): financiamento, consórcio e empréstimo. Só acrescenta: a API
-- anterior e o app 1.0 continuam funcionando com esta tabela no banco.

-- CreateTable
CREATE TABLE "debts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "system" TEXT NOT NULL,
    "openingBalanceCents" BIGINT NOT NULL,
    "openingBalanceDate" VARCHAR(10) NOT NULL,
    "installmentCents" BIGINT NOT NULL,
    "remainingAtOpening" INTEGER NOT NULL,
    "installmentsTotal" INTEGER NOT NULL,
    "dueDay" INTEGER NOT NULL,
    "rateBp" INTEGER NOT NULL,
    "adminFeeBp" INTEGER,
    "accountId" TEXT,
    "category" TEXT,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "serverSeq" SERIAL NOT NULL,

    CONSTRAINT "debts_pkey" PRIMARY KEY ("userId","id")
);

-- CreateIndex
CREATE UNIQUE INDEX "debts_serverSeq_key" ON "debts"("serverSeq");

-- CreateIndex
CREATE INDEX "debts_userId_serverSeq_idx" ON "debts"("userId", "serverSeq");

-- AddForeignKey
ALTER TABLE "debts" ADD CONSTRAINT "debts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
