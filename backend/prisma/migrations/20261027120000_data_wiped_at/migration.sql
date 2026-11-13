-- "Apagar todos os dados" passa a apagar também no servidor (DEC-35): as linhas do
-- usuário saem de verdade, sem lápide, e esta coluna guarda quando foi. O pull e o status
-- a devolvem; o push de um aparelho que ainda não sabe do apagamento volta com 409.
--
-- Só acrescenta uma coluna opcional: a API e o app anteriores continuam funcionando sem
-- ela, e toda conta existente fica com nulo ("nunca apagou").

-- AlterTable
ALTER TABLE "users" ADD COLUMN "dataWipedAt" TIMESTAMP(3);
