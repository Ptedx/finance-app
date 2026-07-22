# Spendr — Backend

API de sincronização do app. Express 5 + Prisma 7 + Postgres, em `api-finance.valtre.com.br`.

O app é **offline-first**: toda escrita vai primeiro para o SQLite do aparelho e a UI
nunca espera a rede. Esta API é o ponto de encontro entre aparelhos e o que faz os dados
sobreviverem a uma reinstalação — não é a fonte da verdade durante o uso.

## Desenvolvimento

```bash
cp .env.example .env      # preencha JWT_SECRET
docker compose up -d postgres
npm install
npx prisma migrate deploy
npm run dev               # :3009

ngrok http 3009           # para o celular alcançar a API
# e no .env do app (raiz do repo):
#   EXPO_PUBLIC_API_URL=https://xxxx.ngrok-free.app
```

Sem `EXPO_PUBLIC_API_URL` o app funciona 100% offline e a tela de conta some — é o
comportamento pretendido, não uma falha.

## Deploy na VM

O nginx vive no repositório `imovelsearcher`; o bloco de `api-finance.valtre.com.br` já
está lá, **comentado**, com o passo a passo. Resumo:

```bash
# 1. DNS de api-finance.valtre.com.br -> IP da VM
# 2. na VM, dentro deste diretório:
docker compose up -d --build          # api em :3012, migrations aplicam sozinhas
# 3. emitir o certificado (o bloco :80 do nginx já responde ao desafio ACME)
# 4. descomentar o bloco HTTPS em imovelsearcher/nginx/nginx.conf
docker exec imovelsearcher-proxy nginx -s reload
curl https://api-finance.valtre.com.br/health
```

O bloco HTTPS só pode ser descomentado **depois** do certificado existir: o nginx se
recusa a subir apontando para um `fullchain.pem` inexistente, e isso derrubaria todos os
outros sites do arquivo junto.

## Protocolo de sincronização

Dois campos que parecem redundantes e não são:

| Campo | Origem | Serve para |
|---|---|---|
| `updatedAt` | relógio de quem editou | resolver conflito (last-write-wins) |
| `serverSeq` | sequência do Postgres | paginar o pull |

Separá-los não é preciosismo. Um aparelho que passou dias offline empurra linhas com
`updatedAt` no passado; um cursor baseado nesse campo passaria por cima delas e os outros
aparelhos **nunca** as veriam. A `serverSeq` é atribuída na ordem de gravação, e um
trigger `BEFORE UPDATE` a avança também nas edições — `@default(autoincrement())` sozinho
só dispara no INSERT, e uma linha editada sumiria do pull.

Apagar é lápide (`deletedAt`), nunca `DELETE`: a linha precisa sobreviver para que um
aparelho offline saiba que ela se foi, em vez de reenviá-la achando que é nova.

### Endpoints

| Método | Rota | |
|---|---|---|
| `POST` | `/api/auth/register` | cria a conta e semeia as 15 categorias padrão |
| `POST` | `/api/auth/login` | |
| `POST` | `/api/auth/refresh` | rotaciona o refresh token |
| `POST` | `/api/auth/logout` | revoga o refresh token |
| `GET`/`PATCH` | `/api/me` | perfil, moeda e idioma |
| `GET` | `/api/sync/status` | se a conta já tem dados (decide o fluxo do primeiro login) |
| `GET` | `/api/sync/pull?cursor=...` | delta desde o cursor |
| `POST` | `/api/sync/push` | envia as linhas pendentes |
| `GET` | `/health` | consulta o banco de propósito |

`GET /api/sync/pull` sem cursor devolve tudo. O cursor é um objeto por coleção:
`{"categories":15,"transactions":10,"recurringTransactions":0,"budgets":1}`.

### Decisões que não são óbvias

- **`amountCents Int`, nunca Decimal.** Espelha o SQLite do app coluna a coluna. Toda
  conversão na borda seria mais um lugar onde um centavo se perde.
- **Datas de calendário são `VarChar(10)`.** O app trata `date` como dia local; virar
  `DateTime` UTC jogaria um lançamento do dia 31 às 22h para o mês seguinte.
- **`category` não é foreign key.** Aparelhos não sincronizam em ordem — o celular pode
  enviar um lançamento numa categoria que o tablet criou e ainda não subiu. Uma FK
  rígida recusaria um dado legítimo. O push valida e reancora em `uncategorized`, que é
  o que o app já faz ao apagar uma categoria.
- **PK composta `(userId, id)`.** É o que deixa as categorias padrão manterem os ids
  fixos (`food`, `salary`) que ficam gravados em `Transaction.category`: o `food` de um
  usuário é outra linha que o de outro, e cada um pode renomear ou apagar o seu.
- **Refresh token opaco, guardado como hash.** Um JWT de refresh não dá para revogar sem
  uma lista de bloqueio — que é a tabela que existiria de qualquer jeito.
