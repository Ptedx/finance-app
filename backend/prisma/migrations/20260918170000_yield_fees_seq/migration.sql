-- v16 do app: quanto do CDI uma conta rende e os encargos da parcela de uma dívida.
-- Só acrescenta colunas: a API e o app anteriores continuam funcionando.

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "yieldCdiBp" INTEGER;

-- AlterTable
ALTER TABLE "debts" ADD COLUMN     "feeCents" BIGINT NOT NULL DEFAULT 0;

-- O gatilho que dá uma serverSeq nova a cada UPDATE (ver 20260722151500_server_seq)
-- faltava nas duas tabelas criadas depois dele. Sem ele, editar a meta ou uma dívida num
-- aparelho nunca chegava aos outros: o pull pagina por serverSeq, e só a criação ganhava
-- uma.
CREATE TRIGGER retirement_goals_bump_server_seq
    BEFORE UPDATE ON "retirement_goals"
    FOR EACH ROW EXECUTE FUNCTION bump_server_seq();

CREATE TRIGGER debts_bump_server_seq
    BEFORE UPDATE ON "debts"
    FOR EACH ROW EXECUTE FUNCTION bump_server_seq();
