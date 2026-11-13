-- Contadores do Mirai, o assistente (SPD-163): perguntas, tokens e custo por usuário e dia.
--
-- Só acrescenta uma tabela: a API e o app anteriores continuam funcionando sem ela. O
-- único ALTER é o da FK, e é sobre a tabela que acabou de nascer.
--
-- Não é coleção de sync: sem `serverSeq` e sem o gatilho `bump_server_seq`. Só números —
-- pergunta, resultado de ferramenta e resposta não são gravados. `day` é o dia de Brasília
-- (`YYYY-MM-DD`); o índice em `day` serve à soma do mês, que é de todos os usuários.
-- `costMicros` é em micro-US$ (US$ 1 = 1.000.000).

-- CreateTable
CREATE TABLE "assistant_usage" (
    "userId" TEXT NOT NULL,
    "day" VARCHAR(10) NOT NULL,
    "questions" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "costMicros" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "assistant_usage_pkey" PRIMARY KEY ("userId","day")
);

-- CreateIndex
CREATE INDEX "assistant_usage_day_idx" ON "assistant_usage"("day");

-- AddForeignKey
ALTER TABLE "assistant_usage" ADD CONSTRAINT "assistant_usage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
