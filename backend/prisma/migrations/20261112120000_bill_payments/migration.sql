-- Os meses das contas a pagar (SPD-146) passam a sincronizar: um registro por conta e mês,
-- pago ou pulado ("não vou pagar este mês").
--
-- Só acrescenta uma tabela: a API e o app anteriores continuam funcionando sem ela. O
-- único ALTER é o da FK, e é sobre a tabela que acabou de nascer. `bills.paidThrough`
-- continua sendo o trecho contínuo já pago, e é ele que um app anterior lê; esta tabela
-- guarda o que ele não diz (o mês pago fora de ordem, o mês pulado, o lançamento de cada
-- mês).
--
-- `month` é mês de calendário (`YYYY-MM`), texto pelo mesmo motivo de `bills.paidThrough`.
-- `amountCents` é nulo quando não se sabe o valor (o mês pulado não tem pagamento).

-- CreateTable
CREATE TABLE "bill_payments" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "month" VARCHAR(7) NOT NULL,
    "status" TEXT NOT NULL,
    "transactionId" TEXT,
    "amountCents" BIGINT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "serverSeq" SERIAL NOT NULL,

    CONSTRAINT "bill_payments_pkey" PRIMARY KEY ("userId","id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bill_payments_serverSeq_key" ON "bill_payments"("serverSeq");

-- CreateIndex
CREATE INDEX "bill_payments_userId_serverSeq_idx" ON "bill_payments"("userId", "serverSeq");

-- AddForeignKey
ALTER TABLE "bill_payments" ADD CONSTRAINT "bill_payments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Toda tabela sincronizada precisa do gatilho que dá uma serverSeq nova a cada UPDATE
-- (ver 20260722151500_server_seq); sem ele, desfazer um mês num aparelho nunca chegaria
-- aos outros, porque o cursor deles já passou daquele número.
CREATE TRIGGER bill_payments_bump_server_seq
    BEFORE UPDATE ON "bill_payments"
    FOR EACH ROW EXECUTE FUNCTION bump_server_seq();
