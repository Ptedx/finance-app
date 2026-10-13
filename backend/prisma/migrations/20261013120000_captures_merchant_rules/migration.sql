-- v19 do app: a caixa de entrada de capturas e as regras aprendidas passam a sincronizar.
--
-- O motivo é um caso real: o app foi desinstalado e duas semanas de compras capturadas,
-- que esperavam revisão só no aparelho, foram embora. Estando logado numa conta, isso é
-- perda de dado.
--
-- Só acrescenta duas tabelas: a API e o app anteriores continuam funcionando sem elas.
--
-- `postedAt` e `createdAt` são TEXT, e não TIMESTAMP, de propósito — ver o comentário em
-- schema.prisma: o app ordena e fatia esse texto, e um round-trip por timestamp o
-- reescreveria. `direction`, `status`, `question` e `treatAs` são TEXT em vez de enum pelo
-- mesmo motivo de `debts.kind`: um valor novo do parser não pode virar migração, e muito
-- menos fazer o servidor recusar a linha.

-- CreateTable
CREATE TABLE "captures" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "packageName" TEXT NOT NULL,
    "appLabel" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "postedAt" TEXT NOT NULL,
    "amountCents" BIGINT NOT NULL,
    "direction" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "counterparty" TEXT,
    "merchantKey" TEXT,
    "cardLast4" TEXT,
    "status" TEXT NOT NULL,
    "question" TEXT,
    "relatedFingerprint" TEXT,
    "suggestedCategory" TEXT,
    "transactionId" TEXT,
    "autoConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "accountId" TEXT,
    "transferId" TEXT,
    "installments" INTEGER,
    "createdAt" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "serverSeq" SERIAL NOT NULL,

    CONSTRAINT "captures_pkey" PRIMARY KEY ("userId","id")
);

-- CreateTable
CREATE TABLE "merchant_rules" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "categoryId" TEXT,
    "treatAs" TEXT NOT NULL DEFAULT 'transaction',
    "confirmations" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "serverSeq" SERIAL NOT NULL,

    CONSTRAINT "merchant_rules_pkey" PRIMARY KEY ("userId","id")
);

-- CreateIndex
CREATE UNIQUE INDEX "captures_serverSeq_key" ON "captures"("serverSeq");

-- CreateIndex
CREATE INDEX "captures_userId_serverSeq_idx" ON "captures"("userId", "serverSeq");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_rules_serverSeq_key" ON "merchant_rules"("serverSeq");

-- CreateIndex
CREATE INDEX "merchant_rules_userId_serverSeq_idx" ON "merchant_rules"("userId", "serverSeq");

-- AddForeignKey
ALTER TABLE "captures" ADD CONSTRAINT "captures_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_rules" ADD CONSTRAINT "merchant_rules_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Toda tabela sincronizada precisa do gatilho que dá uma serverSeq nova a cada UPDATE
-- (ver 20260722151500_server_seq); sem ele, revisar uma captura num aparelho — confirmar,
-- descartar, marcar como duplicada — nunca chegaria aos outros, porque o cursor deles já
-- passou daquele número.
CREATE TRIGGER captures_bump_server_seq
    BEFORE UPDATE ON "captures"
    FOR EACH ROW EXECUTE FUNCTION bump_server_seq();

CREATE TRIGGER merchant_rules_bump_server_seq
    BEFORE UPDATE ON "merchant_rules"
    FOR EACH ROW EXECUTE FUNCTION bump_server_seq();
