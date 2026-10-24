-- Diário de diagnóstico do aparelho (DEC-03): o app envia, quando o usuário está logado,
-- os eventos que guardou; o servidor só recebe e guarda por 30 dias (a limpeza é da API,
-- na subida e a cada 24 h). Lido por SQL, na VM, para investigar.
--
-- Só acrescenta uma tabela: a API e o app anteriores continuam funcionando sem ela. O
-- único ALTER é o da FK, e é sobre a tabela que acabou de nascer.
--
-- Não é coleção de sync: sem `serverSeq` e sem o gatilho `bump_server_seq`. A chave
-- (userId, id) faz o reenvio do mesmo evento ser ignorado (`ON CONFLICT DO NOTHING`).
-- O índice em `at` sozinho serve à limpeza, que corta por data sem olhar o usuário.

-- CreateTable
CREATE TABLE "diagnostic_events" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "level" TEXT NOT NULL,
    "area" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "data" JSONB,
    "rawText" TEXT,
    "appVersion" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "installId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "diagnostic_events_pkey" PRIMARY KEY ("userId","id")
);

-- CreateIndex
CREATE INDEX "diagnostic_events_userId_at_idx" ON "diagnostic_events"("userId", "at");

-- CreateIndex
CREATE INDEX "diagnostic_events_at_idx" ON "diagnostic_events"("at");

-- AddForeignKey
ALTER TABLE "diagnostic_events" ADD CONSTRAINT "diagnostic_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
