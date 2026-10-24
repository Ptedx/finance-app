-- Preferências do usuário (moeda, idioma, taxa do CDI, lembretes ligados) passam a
-- sincronizar: logar em outro aparelho abre o app como ele foi deixado.
--
-- Só acrescenta uma tabela: a API e o app anteriores continuam funcionando sem ela. O
-- único ALTER é o da FK, e é sobre a tabela que acabou de nascer.
--
-- `id` é a chave do AsyncStorage do app e `value` o texto guardado nela; o servidor não
-- interpreta nenhum dos dois.

-- CreateTable
CREATE TABLE "preferences" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "serverSeq" SERIAL NOT NULL,

    CONSTRAINT "preferences_pkey" PRIMARY KEY ("userId","id")
);

-- CreateIndex
CREATE UNIQUE INDEX "preferences_serverSeq_key" ON "preferences"("serverSeq");

-- CreateIndex
CREATE INDEX "preferences_userId_serverSeq_idx" ON "preferences"("userId", "serverSeq");

-- AddForeignKey
ALTER TABLE "preferences" ADD CONSTRAINT "preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Toda tabela sincronizada precisa do gatilho que dá uma serverSeq nova a cada UPDATE
-- (ver 20260722151500_server_seq); sem ele, trocar a moeda num aparelho nunca chegaria aos
-- outros, porque o cursor deles já passou daquele número.
CREATE TRIGGER preferences_bump_server_seq
    BEFORE UPDATE ON "preferences"
    FOR EACH ROW EXECUTE FUNCTION bump_server_seq();
