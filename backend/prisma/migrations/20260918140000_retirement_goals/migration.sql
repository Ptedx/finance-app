-- A meta de aposentadoria (v14 do app): uma linha por usuário, de id fixo.

-- CreateTable
CREATE TABLE "retirement_goals" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "targetMonthlyCents" BIGINT NOT NULL,
    "reinvestBp" INTEGER NOT NULL,
    "expectedYieldBp" INTEGER NOT NULL,
    "outsideCapitalCents" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "serverSeq" SERIAL NOT NULL,

    CONSTRAINT "retirement_goals_pkey" PRIMARY KEY ("userId","id")
);

-- CreateIndex
CREATE UNIQUE INDEX "retirement_goals_serverSeq_key" ON "retirement_goals"("serverSeq");

-- CreateIndex
CREATE INDEX "retirement_goals_userId_serverSeq_idx" ON "retirement_goals"("userId", "serverSeq");

-- AddForeignKey
ALTER TABLE "retirement_goals" ADD CONSTRAINT "retirement_goals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
