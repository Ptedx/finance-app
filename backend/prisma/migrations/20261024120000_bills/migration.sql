-- Contas a pagar (aluguel, luz, escola…) passam a sincronizar.
--
-- Só acrescenta uma tabela: a API e o app anteriores continuam funcionando sem ela. O
-- único ALTER é o da FK, e é sobre a tabela que acabou de nascer.
--
-- `amountCents` é nulo de propósito: nulo quer dizer "o valor varia". `paidThrough` é um
-- mês de calendário (`YYYY-MM`), texto pelo mesmo motivo de `debts.openingBalanceDate`.

-- CreateTable
CREATE TABLE "bills" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dueDay" INTEGER NOT NULL,
    "amountCents" BIGINT,
    "accountId" TEXT,
    "category" TEXT,
    "matchHint" TEXT,
    "debtId" TEXT,
    "paidThrough" VARCHAR(7),
    "paidByRef" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "serverSeq" SERIAL NOT NULL,

    CONSTRAINT "bills_pkey" PRIMARY KEY ("userId","id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bills_serverSeq_key" ON "bills"("serverSeq");

-- CreateIndex
CREATE INDEX "bills_userId_serverSeq_idx" ON "bills"("userId", "serverSeq");

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Toda tabela sincronizada precisa do gatilho que dá uma serverSeq nova a cada UPDATE
-- (ver 20260722151500_server_seq); sem ele, marcar uma conta como paga num aparelho
-- nunca chegaria aos outros, porque o cursor deles já passou daquele número.
CREATE TRIGGER bills_bump_server_seq
    BEFORE UPDATE ON "bills"
    FOR EACH ROW EXECUTE FUNCTION bump_server_seq();
